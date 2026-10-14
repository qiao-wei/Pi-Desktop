// 「用户自己的 node/python 优先，内置载荷只补缺」这条规则的判定半边。
//
// 判定错了会静默走偏：把 macOS 的 Command Line Tools python 当成「用户已有」会让 pip 永远
// 装不上现代包；把内置 node 所在的目录当成系统 node 则会让内置载荷在第二次启动后失效
// （第一次前插上去的那条 PATH 被自己当成了证据）。所以这里逐条锁住：
//   1. 什么算「用户的解释器」（工具链目录排除、探测而不是 existsSync）
//   2. 判定前必须先把我们自己的前插项摘掉
//   3. 判定结果怎么变成 PATH（前插 vs 追加）

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  isToolchainDir,
  probeRuntime,
  runtimeCandidates,
  selectAgentRuntimes,
  stripPathEntries,
} from "../server/agentEnv.mjs";

/**
 * 一个「机器上真的有这个解释器」的探测：按候选路径给答案，并复刻真实探测的版本形状规则
 * （node 要 `v<数字>.`，python 要 `Python 3.`）。
 */
function probeAnswering(answers) {
  const calls = [];
  const probe = (candidate, kind) => {
    calls.push(`${kind}:${candidate.path}`);
    const answer = answers[candidate.path];
    const pattern = kind === "node" ? /^v\d+\./ : /^Python 3\./;
    if (typeof answer === "string" && pattern.test(answer)) {
      return { ok: true, version: answer };
    }
    return { ok: false, version: "" };
  };
  probe.calls = calls;
  return probe;
}

const NODE_OK = "v22.16.0";
const PYTHON_OK = "Python 3.13.13";

test("机器上已有 node 和 python 时，两个都用系统的那份", () => {
  const probe = probeAnswering({
    "/home/me/.nvm/versions/node/v22.16.0/bin/node": NODE_OK,
    "/home/me/.pyenv/shims/python3": PYTHON_OK,
  });
  const selection = selectAgentRuntimes({
    pathValue: "/home/me/.nvm/versions/node/v22.16.0/bin:/home/me/.pyenv/shims:/usr/bin:/bin",
    bundled: {
      node: { bin: "/app/node-runtime/bin/node", npmCli: "/app/node-runtime/lib/node_modules/npm/bin/npm-cli.js" },
      python: { bin: "/app/python-runtime/bin/python3.13", home: "/app/python-runtime" },
    },
    platform: "darwin",
    probe,
  });

  assert.equal(selection.node.source, "system");
  assert.equal(selection.node.path, "/home/me/.nvm/versions/node/v22.16.0/bin/node");
  assert.equal(selection.node.version, NODE_OK);
  assert.equal(selection.python.source, "system");
  assert.equal(selection.python.path, "/home/me/.pyenv/shims/python3");
  // 判断用的 PATH 原样保留（便于诊断），工具链目录是在枚举候选时排除的。
  assert.equal(selection.judgingPath, "/home/me/.nvm/versions/node/v22.16.0/bin:/home/me/.pyenv/shims:/usr/bin:/bin");
});

test("macOS 的 /usr/bin/python3 是 Command Line Tools，不算「用户已有」", () => {
  const probe = probeAnswering({ "/usr/bin/python3": PYTHON_OK });
  const selection = selectAgentRuntimes({
    pathValue: "/usr/bin:/bin:/usr/sbin:/sbin",
    bundled: { python: { bin: "/app/python-runtime/bin/python3.13", home: "/app/python-runtime" } },
    platform: "darwin",
    probe,
  });

  assert.equal(selection.python.source, "bundled");
  assert.deepEqual(probe.calls, [], "连探测都不做：CLT 的 stub 一跑就可能弹安装窗");
});

test("Linux 的 /usr/bin/python3 是发行版真环境，算数", () => {
  const probe = probeAnswering({ "/usr/bin/python3": PYTHON_OK });
  const selection = selectAgentRuntimes({
    pathValue: "/usr/bin:/bin",
    bundled: { python: { bin: "/app/python-runtime/bin/python3.13" } },
    platform: "linux",
    probe,
  });

  assert.equal(selection.python.source, "system");
  assert.equal(selection.python.path, "/usr/bin/python3");
});

test("Windows 的 WindowsApps 存根按目录整体跳过", () => {
  // 候选路径由 `path.join` 拼出来，所以在 macOS 上跑 win32 用例时键也要用同样的拼法。
  const localAppData = "C:\\Users\\me\\AppData\\Local";
  const nodeDir = "C:\\nodejs";
  const pythonDir = "C:\\Python313";
  const path = `${join(localAppData, "Microsoft", "WindowsApps")};${nodeDir};${pythonDir}`;
  const probe = probeAnswering({
    [join(nodeDir, "node.exe")]: NODE_OK,
    [join(pythonDir, "python.exe")]: PYTHON_OK,
  });
  const selection = selectAgentRuntimes({ pathValue: path, platform: "win32", probe });

  assert.equal(selection.node.source, "system");
  assert.equal(selection.node.path, join(nodeDir, "node.exe"));
  assert.equal(selection.python.source, "system");
  assert.equal(selection.python.path, join(pythonDir, "python.exe"));
  assert.ok(
    probe.calls.every((call) => !/WindowsApps/i.test(call)),
    "不能去 spawn WindowsApps 里的别名，那会拉起 Microsoft Store",
  );
});

test("探测而不是 existsSync：存在的文件也可能是 stub / 坏掉的 shim", () => {
  const probe = probeAnswering({
    // 排在前面的是坏 shim：探测失败要落到下一个候选，而不是认定「用户有 python」。
    "/broken/python3": false,
    "/opt/homebrew/bin/python3": PYTHON_OK,
  });
  const selection = selectAgentRuntimes({
    pathValue: "/broken:/opt/homebrew/bin",
    platform: "darwin",
    probe,
  });

  assert.equal(selection.python.path, "/opt/homebrew/bin/python3");
  // node 也会被枚举一遍（两个运行时都要判定），这里只关心 python 的顺序。
  assert.deepEqual(
    probe.calls.filter((call) => call.startsWith("python:")),
    ["python:/broken/python3", "python:/broken/python", "python:/opt/homebrew/bin/python3"],
  );
});

test("python2 这种「能跑但不是我们要的」也拒绝", () => {
  const probe = probeAnswering({ "/usr/local/bin/python": "Python 2.7.18" });
  const selection = selectAgentRuntimes({ pathValue: "/usr/local/bin", platform: "darwin", probe });

  assert.equal(selection.python.source, "missing");
});

// 真实探测（会真的 spawn）：版本形状、退出码、以及「按绝对路径缓存」这三条决定了判定的
// 准确性——macOS 的 CLT stub 和 WindowsApps 别名都是「文件存在但不能跑」。
test("真实探测只认能跑且版本对的解释器，结果按路径缓存", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-probe-"));
  try {
    const node = join(root, "node");
    const oldPython = join(root, "python3");
    const broken = join(root, "broken");
    const cacheProbe = join(root, "cache-probe");
    for (const [file, body] of [
      [node, "#!/bin/sh\necho v22.16.0\n"],
      [oldPython, "#!/bin/sh\necho 'Python 2.7.18'\n"],
      [broken, "#!/bin/sh\nexit 127\n"],
      [cacheProbe, "#!/bin/sh\necho v20.0.0\n"],
    ]) {
      writeFileSync(file, body, "utf8");
      chmodSync(file, 0o755);
    }

    assert.deepEqual(probeRuntime({ path: node }, "node"), { ok: true, version: "v22.16.0" });
    assert.equal(probeRuntime({ path: oldPython }, "python").ok, false, "Python 2 不算");
    assert.equal(probeRuntime({ path: broken }, "node").ok, false, "退出码非 0 不算");

    // 同一个路径的答案按绝对路径缓存：内容变了也不再重新 spawn。
    assert.equal(probeRuntime({ path: cacheProbe }, "node").ok, true);
    writeFileSync(cacheProbe, "#!/bin/sh\nexit 127\n", "utf8");
    chmodSync(cacheProbe, 0o755);
    assert.equal(probeRuntime({ path: cacheProbe }, "node").ok, true, "按绝对路径缓存");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("我们自己的前插项在判定前先摘掉", () => {
  const bundledNodeBin = "/app/node-runtime/bin/node";
  const agentDir = "/home/me/.pi/agent";
  const probe = probeAnswering({ [bundledNodeBin]: NODE_OK });
  const selection = selectAgentRuntimes({
    // 上一次启动组装出来的 PATH：shim 目录 + 内置 node bin 在最前面。
    pathValue: `${join(agentDir, "bin")}:${join(bundledNodeBin, "..")}:/usr/bin:/bin`,
    ownDirs: [join(agentDir, "bin"), join(bundledNodeBin, ".."), join(agentDir, "node", "bin"), join(agentDir, "python", "bin")],
    bundled: { node: { bin: bundledNodeBin } },
    platform: "darwin",
    probe,
  });

  assert.equal(selection.node.source, "bundled", "内置 node 不能当成系统 node，否则第二次启动就不再用它");
  assert.deepEqual(probe.calls, [], "摘干净了就没有候选可探");
});

test("slim 打包（forceSystem）永远不退回内置载荷", () => {
  const selection = selectAgentRuntimes({
    pathValue: "/usr/bin:/bin",
    bundled: { node: { bin: "/app/node-runtime/bin/node" } },
    forceSystem: true,
    platform: "darwin",
    probe: probeAnswering({}),
  });

  assert.equal(selection.node.source, "missing");
  assert.equal(selection.python.source, "missing");
});

test("没有内置载荷可用时是 missing，而不是假装 system", () => {
  const selection = selectAgentRuntimes({
    pathValue: "/usr/bin:/bin",
    platform: "darwin",
    probe: probeAnswering({}),
  });

  assert.equal(selection.node.source, "missing");
  assert.equal(selection.python.source, "missing");
});

test("工具链目录表：macOS 按前缀，Windows 按目录名，Linux 不排除", () => {
  assert.equal(isToolchainDir("/usr/bin", "darwin"), true);
  assert.equal(isToolchainDir("/usr/bin/", "darwin"), true);
  assert.equal(isToolchainDir("/usr/local/bin", "darwin"), false, "Homebrew 是用户装的");
  assert.equal(isToolchainDir("/Library/Developer/CommandLineTools/usr/bin", "darwin"), true);
  assert.equal(isToolchainDir("/Applications/Xcode.app/Contents/Developer/usr/bin", "darwin"), true);
  assert.equal(isToolchainDir("/usr/bin", "linux"), false);
  assert.equal(isToolchainDir("C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps", "win32"), true);
  assert.equal(isToolchainDir("C:\\Program Files\\nodejs", "win32"), false);
});

test("候选枚举：PATH 顺序、名字优先、去重、跳过工具链目录", () => {
  const candidates = runtimeCandidates("python", "/usr/bin:/opt/homebrew/bin:/opt/homebrew/bin", "darwin");
  assert.deepEqual(
    candidates.map((candidate) => candidate.path),
    [join("/opt/homebrew/bin", "python3"), join("/opt/homebrew/bin", "python")],
  );

  // Windows 上只认带扩展名的可执行文件（`node` 那种 cmd 脚本 CreateProcess 起不来）。
  assert.deepEqual(
    runtimeCandidates("node", "C:\\nodejs;C:\\nodejs", "win32").map((candidate) => candidate.path),
    [join("C:\\nodejs", "node.exe")],
  );
});

test("stripPathEntries 归一化尾斜杠与 Windows 大小写", () => {
  assert.equal(stripPathEntries("/a/bin:/b/bin:/c", ["/a/bin/", "/b/bin"], "darwin"), "/c");
  assert.equal(stripPathEntries("C:\\Agent\\bin;D:\\x", ["c:\\agent\\bin\\"], "win32"), "D:\\x");
});