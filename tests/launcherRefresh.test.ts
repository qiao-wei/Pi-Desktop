// 桥启动时对 `~/.pi/agent/bin` 里那批 launcher 的刷新，是**模块顶层**跑的（`server/index.mjs`
// 的 bootstrap 块）。所以它的正确性不在那几个纯函数里，而在"顶层代码跑的时候，它依赖的绑定
// 是不是已经初始化了"——2026-09-21 就踩了一次：`const RUNTIME_SHIM_SPECS` 被放在 bootstrap
// 之后，`ensureBundledNodeShims()` 一访问就撞上 TDZ，整块刷新被外层 catch 吃掉，只在 stderr
// 留一行 `could not refresh ... launchers`。纯函数测试全绿，但新装的 bundled 包一个 node/npm/
// python launcher 都不会写。
//
// 所以这里真的把桥起起来（约 0.5s），对着它写出来的文件断言。

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { runtimeShimSpecs } from "../server/agentShimFiles.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

async function freePort() {
  return new Promise((resolve_, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve_(port));
    });
  });
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 造一个"自带运行时"的假安装：只需要这几个路径存在（桥用 existsSync 判）。 */
function fakeRuntimes() {
  const root = tempDir("pi-fake-runtime-");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const node = join(bin, "node");
  const python = join(bin, "python3");
  const npmCli = join(root, "npm-cli.js");
  for (const file of [node, python, npmCli]) {
    writeFileSync(file, "#!/bin/sh\nexit 0\n", "utf8");
  }
  chmodSync(node, 0o755);
  chmodSync(python, 0o755);
  return { root, node, python, npmCli };
}

async function startBridge(env, agentDir) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(repoRoot, "server", "index.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_DESKTOP_PORT: String(port),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const stop = async () => {
    if (child.exitCode !== null) {
      return;
    }
    const exited = new Promise((resolve_) => child.once("exit", resolve_));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve_) => setTimeout(resolve_, 3000))]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  };

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`桥在就绪前退出（code=${child.exitCode}）\n${stdout}\n${stderr}`);
    }
    if (/bridge running at http:\/\/127\.0\.0\.1:\d+/.test(stdout)) {
      return { stdout: () => stdout, stderr: () => stderr, stop };
    }
    await new Promise((resolve_) => setTimeout(resolve_, 50));
  }
  await stop();
  throw new Error(`等桥就绪超时\n${stdout}\n${stderr}`);
}

/** launcher 刷新失败只会打这一行，不会让桥挂掉——正是它让 bug 藏了那么久。 */
function assertRefreshed(stderr) {
  assert.ok(
    !stderr.includes("could not refresh"),
    `启动时 launcher 刷新失败：${stderr.split("\n").filter((line) => line.includes("pi-desktop")).join(" / ") || stderr}`,
  );
}

test("bundled 启动会把整套 node/python/pi launcher 写出来（不再撞模块顶层 TDZ）", async (t) => {
  const agentDir = tempDir("pi-agent-bundled-");
  const runtimes = fakeRuntimes();
  t.after(async () => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(runtimes.root, { recursive: true, force: true });
  });

  const bridge = await startBridge(
    {
      PI_DESKTOP_RUNTIME_MODE: "",
      PI_DESKTOP_BUNDLED_NODE_BIN: runtimes.node,
      PI_DESKTOP_BUNDLED_NPM_CLI: runtimes.npmCli,
      PI_DESKTOP_BUNDLED_PYTHON_BIN: runtimes.python,
    },
    agentDir,
  );
  await bridge.stop();
  assertRefreshed(bridge.stderr());

  const bin = join(agentDir, "bin");
  const expected = ["pi", ...runtimeShimSpecs(process.platform).map((spec) => spec.name)];
  assert.deepEqual(
    readdirSync(bin).sort(),
    expected.sort(),
    "应该有 pi + node/nodejs/npm/npx + python/pip 那套",
  );
  for (const name of ["node", "npm", "python3", "pip3"]) {
    assert.ok(readFileSync(join(bin, name), "utf8").includes("PI_DESKTOP_BUNDLED_"), `${name} 应指向内置运行时`);
  }
  assert.ok(readFileSync(join(bin, "pi"), "utf8").includes("--pi-cli"), "pi launcher 应带 --pi-cli");
});

test("system 启动会清掉 bundled 留下的 launcher，同时重写 pi、不碰用户自己的文件", { skip: process.platform === "win32" }, async (t) => {
  const agentDir = tempDir("pi-agent-system-");
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const bin = join(agentDir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "node"), "#!/bin/sh\nexport PI_DESKTOP_BUNDLED_NODE_BIN=/gone\n", "utf8");
  writeFileSync(join(bin, "python3"), '#!/bin/sh\nexec /usr/bin/python3 "$@"\n', "utf8");
  symlinkSync("/gone/node-runtime/bin/node", join(bin, "npm"));

  const bridge = await startBridge({ PI_DESKTOP_RUNTIME_MODE: "system" }, agentDir);
  await bridge.stop();
  assertRefreshed(bridge.stderr());

  assert.deepEqual(
    readdirSync(bin).sort(),
    ["pi", "python3"],
    "node/npm（我们的）该删，python3（用户的）该留",
  );
  assert.ok(readFileSync(join(bin, "python3"), "utf8").includes('exec /usr/bin/python3'), "用户自己的文件不能被改");
  assert.ok(!readFileSync(join(bin, "pi"), "utf8").includes("PI_DESKTOP_BUNDLED_"), "pi launcher 不该再指向内置运行时");
});