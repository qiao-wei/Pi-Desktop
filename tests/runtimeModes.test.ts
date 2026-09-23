// 两种打包模式的运行时解析：bundled（现状，自带 node/python）与 system（精简版，用机器上的）。
//
// 这一组用例锁的是「不内置运行时」这件事的四条前提：
//   1. 模式判定：显式 env 优先，否则看产物里到底有没有那两个目录（构建配置和运行期读同一个事实）
//   2. 找得到机器上的 node（含 macOS GUI 应用看不到登录 shell PATH 的兜底）， 以及 bundled 模式下
//      用户自己装的 CLI 所在的目录（只读 profile 级的非交互登录 shell）
//   3. 桥的启动环境在 system 模式下不再设 PI_DESKTOP_BUNDLED_*（那是让技能走系统解释器的开关）
//   4. 从 bundled 升级到 system 时，清掉指向已删除 runtime 的旧 launcher

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { removeBundledShims, runtimeShimSpecs } from "../server/agentShimFiles.mjs";

const require = createRequire(import.meta.url);

const { resolveRuntimeMode, resolveNodeOnPath, systemHostPath, loginShellPath, joinPathValues, bundledNodePaths } =
  require("../src-electron/paths.js");
const { bridgeEnv } = require("../src-electron/sidecar.js");

function withTemp(fn) {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-mode-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 一个假的登录 shell：把收到的参数逐行记进 <root>/args.txt，并按 marker 协议回一条 PATH。
// 前面那行横幅是故意的 —— 真实 rc 文件会往 stdout 打印东西，回读必须能吃下。
function fakeLoginShell(root, reportedPath) {
  const shell = join(root, "fake-login-shell");
  writeFileSync(
    shell,
    [
      "#!/bin/sh",
      `for a in "$@"; do printf '%s\\n' "$a"; done >> '${join(root, "args.txt")}'`,
      "echo 'Switched to claude environment'",
      `printf '%s%s\\n' '__PI_DESKTOP_LOGIN_PATH__' '${reportedPath}'`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(shell, 0o755);
  return shell;
}

/** 上面那个假 shell 收到的第一个参数（也就是登录 shell 的 flag）。 */
function loginShellArgs(root) {
  return readFileSync(join(root, "args.txt"), "utf8").trim().split("\n");
}

/** 造一个「产物」目录：显式决定带不带两个 runtime。 */
function scaffoldRuntimes(root, { node = true, python = true } = {}) {
  if (node) {
    const bin = join(root, "node-runtime", "bin", "node");
    mkdirSync(join(root, "node-runtime", "bin"), { recursive: true });
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(bin, 0o755);
  }
  if (python) {
    const bin = join(root, "python-runtime", "bin", "python3.13");
    mkdirSync(join(root, "python-runtime", "bin"), { recursive: true });
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(bin, 0o755);
  }
  return { pythonRuntime: join(root, "python-runtime"), nodeRuntime: join(root, "node-runtime") };
}

test("带齐两个 runtime 判成 bundled，缺任一个判成 system", () => {
  // 每个断言一个新目录：同一个 root 里“造过”的 runtime 不会因为下一次参数就消失。
  const modeOf = (options) => withTemp((root) => resolveRuntimeMode(scaffoldRuntimes(root, options), {}));
  assert.equal(modeOf({}), "bundled");
  assert.equal(modeOf({ python: false }), "system");
  assert.equal(modeOf({ node: false }), "system");
  assert.equal(modeOf({ node: false, python: false }), "system");
});

test("显式模式覆盖推断（两种方向都要）", () =>
  withTemp((root) => {
    const dirs = scaffoldRuntimes(root);
    assert.equal(resolveRuntimeMode(dirs, { PI_DESKTOP_RUNTIME_MODE: "system" }), "system");
    assert.equal(resolveRuntimeMode(dirs, { PI_DESKTOP_RUNTIME_MODE: " System " }), "system");

    const slim = scaffoldRuntimes(root, { node: false, python: false });
    assert.equal(resolveRuntimeMode(slim, { PI_DESKTOP_RUNTIME_MODE: "bundled" }), "bundled");
    // 认不出来的值不能静默改成 system，退回推断。
    assert.equal(resolveRuntimeMode(dirs, { PI_DESKTOP_RUNTIME_MODE: "nonsense" }), "bundled");
  }));

test("在 PATH 里找 node：跳过空段和目录，返回真文件", () =>
  withTemp((root) => {
    const bin = join(root, "tools", "bin");
    mkdirSync(bin, { recursive: true });
    const node = join(bin, "node");
    writeFileSync(node, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // 同名目录不算可执行文件。
    mkdirSync(join(root, "decoy", "node"), { recursive: true });

    assert.equal(resolveNodeOnPath(`::${join(root, "decoy")}:${bin}`, "darwin"), node);
    assert.equal(resolveNodeOnPath("", "darwin"), null);
    assert.equal(resolveNodeOnPath(join(root, "decoy"), "darwin"), null);
  }));

test("win32 找的是 node.exe，且用 ; 分段", () =>
  withTemp((root) => {
    mkdirSync(root, { recursive: true });
    const node = join(root, "node.exe");
    writeFileSync(node, "", "utf8");
    assert.equal(resolveNodeOnPath(`${join(root, "missing")};${root}`, "win32"), node);
    assert.equal(resolveNodeOnPath(`${root}:${root}`, "win32"), null, "win32 下 : 不是分隔符");
  }));

test("bundled 模式下登录 shell 读不出来就原样透传 GUI 的 PATH", () => {
  const env = { PATH: "/usr/bin:/bin", SHELL: "/definitely/missing" };
  assert.equal(systemHostPath({ runtimeMode: "bundled", env, platform: "darwin" }), "/usr/bin:/bin");
});

test("bundled 模式也回读登录 shell，但只问非交互的 -lc", { skip: process.platform === "win32" }, () =>
  withTemp((root) => {
    // `~/.local/bin` 是 pipx / 各类 CLI 安装器的落点（bsk 就在那里），brew 在 /opt/homebrew/bin。
    // 两者都写在 .zprofile 里，所以不需要读 .zshrc 就能拿到。
    const shell = fakeLoginShell(root, "/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin:/bin");
    const merged = systemHostPath({
      runtimeMode: "bundled",
      env: { PATH: "/usr/bin:/bin", SHELL: shell },
      platform: "darwin",
    });

    assert.equal(merged, "/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin:/bin");
    assert.equal(loginShellArgs(root)[0], "-lc", "bundled 不该为 .zshrc（nvm use）付启动时间");
  }));

test("system 模式仍然问交互式的 -lic（nvm / pyenv 的 node 只在 .zshrc 里）", { skip: process.platform === "win32" }, () =>
  withTemp((root) => {
    const shell = fakeLoginShell(root, "/usr/bin:/bin");
    systemHostPath({
      runtimeMode: "system",
      env: { PATH: "/usr/bin:/bin", SHELL: shell },
      platform: "darwin",
    });

    assert.equal(loginShellArgs(root)[0], "-lic", "少了 -i 就找不到 nvm 装的 node");
  }));

test("system 模式下 PATH 里已经有 node 就不再问登录 shell", () =>
  withTemp((root) => {
    mkdirSync(root, { recursive: true });
    const node = join(root, "node");
    writeFileSync(node, "", "utf8");
    const path = `/usr/bin:${root}`;
    // SHELL 指向一个不存在的东西：只要还能看到 node，就绝不该走到那一步。
    assert.equal(systemHostPath({ runtimeMode: "system", env: { PATH: path, SHELL: "/missing" }, platform: "darwin" }), path);
  }));

test("PI_DESKTOP_HOST_PATH 能直接指定，两种模式都认", () => {
  const bundled = { PATH: "/usr/bin", PI_DESKTOP_HOST_PATH: "/opt/custom/bin:/usr/bin" };
  assert.equal(systemHostPath({ runtimeMode: "bundled", env: bundled, platform: "darwin" }), "/opt/custom/bin:/usr/bin");
  assert.equal(
    systemHostPath({
      runtimeMode: "system",
      env: { PATH: "/usr/bin", PI_DESKTOP_HOST_PATH: "/opt/custom/bin:/usr/bin" },
      platform: "darwin",
    }),
    "/opt/custom/bin:/usr/bin",
  );
});

// macOS GUI 应用拿不到登录 shell 的 PATH（launchctl 的 PATH 是空的），nvm / pyenv / /opt/homebrew
// 装的 node 只能靠回读登录 shell 的 PATH 才看得见。这里用一个假 shell 验证回读与污染处理。
test("system 模式下找得到登录 shell 里的 node（rc 输出污染也要能吃下）", { skip: process.platform === "win32" }, () =>
  withTemp((root) => {
    const bin = join(root, "nvm-bin");
    mkdirSync(bin, { recursive: true });
    const node = join(bin, "node");
    writeFileSync(node, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(node, 0o755);

    const shell = fakeLoginShell(root, `${bin}:/usr/bin:/bin`);
    const env = { PATH: "/usr/bin:/bin", SHELL: shell };
    assert.equal(loginShellPath(env, "darwin"), `${bin}:/usr/bin:/bin`);

    const merged = systemHostPath({ runtimeMode: "system", env, platform: "darwin" });
    assert.equal(merged, `${bin}:/usr/bin:/bin`, "登录 shell 的值在前，且不重复");
    // 真的能从这条 PATH 里解析出 node —— 这才是这一整段存在的理由。
    assert.equal(resolveNodeOnPath(merged, "darwin"), node);
    // 并且把它交给子进程时，node 确实可以被执行。
    assert.equal(execFileSync("/bin/sh", ["-c", "command -v node"], { env: { PATH: merged } }).toString().trim(), node);
  }));

test("登录 shell 读不出来时不能编造 PATH", { skip: process.platform === "win32" }, () =>
  withTemp((root) => {
    const silent = join(root, "silent-shell");
    writeFileSync(silent, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    chmodSync(silent, 0o755);
    assert.equal(loginShellPath({ PATH: "/usr/bin", SHELL: silent }, "darwin"), null);
    assert.equal(
      systemHostPath({ runtimeMode: "system", env: { PATH: "/usr/bin:/bin", SHELL: silent }, platform: "darwin" }),
      "/usr/bin:/bin",
    );
  }));

test("PATH 合并去重且保序", () => {
  assert.equal(joinPathValues(["/a/bin:/usr/bin", "/usr/bin:/bin"], "darwin"), "/a/bin:/usr/bin:/bin");
  assert.equal(joinPathValues(["", ":/x::", "/x"], "darwin"), "/x");
  assert.equal(joinPathValues(["C:\\A;C:\\B", "c:\\a;D:\\E"], "win32"), "C:\\A;C:\\B;D:\\E");
});

test("精简环境下 bridgeEnv 说清楚缺的是 Node，且不再设 BUNDLED_*", () =>
  withTemp((root) => {
    const launcher = join(root, "pi-desktop-server");
    writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(launcher, 0o755);
    const base = {
      mode: "packaged",
      root,
      sidecar: launcher,
      sidecarArgs: [],
      piCli: { binary: launcher },
      skills: root,
      capabilitiesDefaults: join(root, "capabilities.defaults.json"),
      pythonRuntime: join(root, "python-runtime"),
      nodeRuntime: join(root, "node-runtime"),
    };

    assert.throws(
      () => bridgeEnv({ ...base, runtimeMode: "system", systemNode: null, hostPath: "/usr/bin:/bin" }),
      /找不到 Node\.js[\s\S]*Node\.js 22/,
      "精简版的失败要能直接照做，不是一句 missing runtime",
    );

    // 本进程自己也跑在某个宿主里（可能带着上一层的 PI_DESKTOP_*），所以要拿基线对比，
    // 而不是断言整个 env 里没有这些 key。
    const inflated = Object.keys(process.env).filter((key) => key.startsWith("PI_DESKTOP_BUNDLED_"));
    const saved = Object.fromEntries(inflated.map((key) => [key, process.env[key]]));
    for (const key of inflated) {
      delete process.env[key];
    }
    try {
      const ok = bridgeEnv({
        ...base,
        runtimeMode: "system",
        systemNode: "/usr/local/bin/node",
        hostPath: "/usr/local/bin:/usr/bin",
      });
      assert.equal(ok.env.PI_DESKTOP_RUNTIME_MODE, "system");
      for (const key of Object.keys(ok.env)) {
        assert.ok(!key.startsWith("PI_DESKTOP_BUNDLED_"), `${key} 不该出现在 system 模式里`);
      }
      assert.equal(
        ok.env.PATH.split(":").slice(0, 2).join(":"),
        `${join(ok.env.PI_CODING_AGENT_DIR, "bin")}:/usr/local/bin`,
      );
    } finally {
      Object.assign(process.env, saved);
    }
  }));

test("win32 精简包缺 Node 时报的是这件事，而不是 'launcher is missing: null'", () =>
  withTemp((root) => {
    // win32 下 sidecar 就是解析出来的 node，所以缺 node 时它是 null。
    assert.throws(
      () =>
        bridgeEnv({
          mode: "packaged",
          root,
          sidecar: null,
          sidecarArgs: [],
          piCli: { runtime: null, entry: join(root, "bridge", "server", "index.mjs") },
          skills: root,
          capabilitiesDefaults: join(root, "capabilities.defaults.json"),
          pythonRuntime: join(root, "python-runtime"),
          nodeRuntime: join(root, "node-runtime"),
          runtimeMode: "system",
          systemNode: null,
          hostPath: "C:\\Windows\\system32",
        }),
      /找不到 Node\.js/,
    );
  }));

test("bundled 模式仍然严格：少了 runtime 文件直接报错", () =>
  withTemp((root) => {
    scaffoldRuntimes(root, { node: false, python: false });
    const launcher = join(root, "pi-desktop-server");
    writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(launcher, 0o755);
    assert.throws(
      () =>
        bridgeEnv({
          mode: "packaged",
          root,
          sidecar: launcher,
          sidecarArgs: [],
          piCli: { binary: launcher },
          skills: root,
          capabilitiesDefaults: join(root, "capabilities.defaults.json"),
          pythonRuntime: join(root, "python-runtime"),
          nodeRuntime: join(root, "node-runtime"),
          runtimeMode: "bundled",
          hostPath: "/usr/bin",
        }),
      /Bundled Python runtime is missing its executable/,
      "bundled 版不能因为机器上碰巧有 python 就悄悄换掉隔离的运行时",
    );
  }));

test("旧 bundled 安装写下的 launcher 会被清掉，用户自己的文件留着", () =>
  withTemp((root) => {
    const names = runtimeShimSpecs("darwin").map((spec) => spec.name);
    assert.deepEqual(names.slice(0, 4), ["node", "nodejs", "npm", "npx"]);
    assert.ok(names.includes("python3.13") && names.includes("pip3.13"));
    assert.deepEqual(runtimeShimSpecs("win32").slice(0, 2).map((spec) => spec.name), ["node.cmd", "nodejs.cmd"]);

    writeFileSync(join(root, "node"), '#!/bin/sh\nexport PI_DESKTOP_BUNDLED_NODE_BIN=/x\n', "utf8");
    writeFileSync(join(root, "pip3"), '#!/bin/sh\nexport PI_DESKTOP_BUNDLED_PYTHON_BIN=/y\n', "utf8");
    // 用户自己放的：内容里没有我们的标记，不能被删。
    writeFileSync(join(root, "python3"), "#!/bin/sh\nexec /usr/bin/python3 \"$@\"\n", "utf8");
    // 升级后残留的悬空软链：目标带 -runtime，算我们的。
    symlinkSync("/gone/node-runtime/bin/node", join(root, "npm"));

    const warned = [];
    const removed = removeBundledShims({
      dir: root,
      platform: "darwin",
      readFileSync,
      readlinkSync,
      rmSync,
      join,
      warn: (message) => warned.push(message),
    });

    assert.deepEqual(
      removed.map((path) => path.slice(root.length + 1)).sort(),
      ["node", "npm", "pip3"],
    );
    assert.ok(readFileSync(join(root, "python3"), "utf8").includes("exec /usr/bin/python3"));
    assert.deepEqual(warned, []);
  }));

test("清理动作不会因为某个文件读不了而中断", () =>
  withTemp((root) => {
    writeFileSync(join(root, "node"), "PI_DESKTOP_BUNDLED_NODE_BIN=1\n", "utf8");
    const removed = removeBundledShims({
      dir: root,
      platform: "darwin",
      readFileSync: () => {
        throw new Error("EACCES");
      },
      readlinkSync: () => {
        throw new Error("EINVAL");
      },
      rmSync,
      join,
      warn: () => {},
    });
    assert.deepEqual(removed, []);
    assert.ok(readFileSync(join(root, "node"), "utf8"), "读不到就不动它");
  }));

test("bundledNodePaths 仍指向 node-runtime（用于给打包配置对账）", () => {
  const dirs = { nodeRuntime: "/app/Resources/node-runtime" };
  assert.equal(bundledNodePaths(dirs).bin, "/app/Resources/node-runtime/bin/node");
});