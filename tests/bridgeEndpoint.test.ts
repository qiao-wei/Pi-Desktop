/**
 * The bridge owns its listening port; every host discovers it. Dev used to probe ports itself
 * while the packaged shells pinned 6474, so the same conflict behaved two ways - and only the
 * pinned one died silently.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const rules = await import(pathToFileURL(resolve(import.meta.dirname, "../server/bridgeListen.mjs")).href);
const repoRoot = resolve(import.meta.dirname, "..");
const read = (relative) => readFileSync(join(repoRoot, relative), "utf8");

// 三处宿主共用的名字：JS 两处能从模块里读，rust 读不到，所以这里定一个常量做对照。
const HOST_PI_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";

// A sync cleanup would delete the directory while an async body is still mid-flight, so a spawn
// would fail on a path that "existed" a moment ago.
async function withTemp(body) {
  const root = mkdtempSync(join(tmpdir(), "pi-desktop-endpoint-"));
  try {
    return await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the preferred port is 6474 unless someone names one", () => {
  assert.equal(rules.preferredPort({}), rules.DEFAULT_PREFERRED_PORT);
  assert.equal(rules.preferredPort({ PI_DESKTOP_PORT: "9000" }), 9000);
  assert.equal(rules.preferredPort({ ENGBUDDY_PORT: "9001" }), 9001);
  // 0 is a real request ("any port"), not a missing value.
  assert.equal(rules.preferredPort({ PI_DESKTOP_PORT: "0" }), 0);
  assert.equal(rules.isPortExplicit({ PI_DESKTOP_PORT: "0" }), true);
  assert.equal(rules.isPortExplicit({ PI_DESKTOP_PORT: "  " }), false);
  // Garbage must not become "port NaN".
  assert.equal(rules.preferredPort({ PI_DESKTOP_PORT: "http" }), rules.DEFAULT_PREFERRED_PORT);
  assert.equal(rules.preferredPort({ PI_DESKTOP_PORT: "70000" }), rules.DEFAULT_PREFERRED_PORT);
});

test("only an unnamed port may fall back", () => {
  const busy = Object.assign(new Error("address already in use"), { code: "EADDRINUSE" });
  assert.equal(rules.shouldRetryWithEphemeralPort(busy, false), true);
  // An operator who asked for 6474 specifically must hear that it did not get it.
  assert.equal(rules.shouldRetryWithEphemeralPort(busy, true), false);
  assert.equal(rules.shouldRetryWithEphemeralPort(Object.assign(new Error("noperm"), { code: "EACCES" }), false), false);
});

test("urls are built for the host family in use", () => {
  assert.equal(rules.bridgeUrlFor("127.0.0.1", 6474), "http://127.0.0.1:6474");
  assert.equal(rules.bridgeUrlFor("::1", 8080), "http://[::1]:8080");
});

test("the announcement survives log noise and chunk boundaries", () => {
  assert.equal(rules.parseBridgeUrlLine("PI_DESKTOP_BRIDGE_URL=http://127.0.0.1:6474"), "http://127.0.0.1:6474");
  assert.equal(rules.parseBridgeUrlLine("[bridge] PI_DESKTOP_BRIDGE_URL=http://127.0.0.1:5000\r"), "http://127.0.0.1:5000");
  assert.equal(rules.parseBridgeUrlLine("Pi Desktop bridge running at http://127.0.0.1:6474"), "");
  assert.equal(rules.parseBridgeUrlLine(undefined), "");

  const watcher = rules.createBridgeUrlWatcher({ timeoutMs: 1000 });
  assert.equal(watcher.feed("some noise PI_DESKTOP_BRIDGE="), "");
  assert.equal(watcher.feed("PI_DESKTOP_BRIDGE_URL=http://127.0.0.1:12"), ""); // no newline yet
  assert.equal(watcher.feed("2\n"), "http://127.0.0.1:122");
  return watcher.promise.then((url) => assert.equal(url, "http://127.0.0.1:122"));
});

test("a bridge that dies or stays quiet fails the watcher instead of hanging the host", async () => {
  const died = rules.createBridgeUrlWatcher({ timeoutMs: 5000 });
  died.feed("boom\n");
  died.closed("exit code 1");
  await assert.rejects(died.promise, /bridge exited before announcing its port: exit code 1/);

  let fire = null;
  const slow = rules.createBridgeUrlWatcher({
    timeoutMs: 1234,
    setTimer: (fn, ms) => {
      fire = fn;
      return 1;
    },
    clearTimer: () => {},
  });
  assert.equal(typeof fire, "function", "the watcher must arm a timeout");
  fire();
  await assert.rejects(slow.promise, /did not announce its port within 1234ms/);
});

test("the bridge recomputes every url from the port it actually bound", () => {
  const source = read("server/index.mjs");
  const listen = source.slice(source.indexOf("function startListening"), source.indexOf("startListening(requestedPort)"));

  assert.match(listen, /server\.listen\(listenPort, host, \(\) => \{/);
  // apiBase is read while serving requests (attachment links, agent url), so it must follow reality.
  assert.match(listen, /port = typeof bound === "object" && bound \? bound\.port : listenPort/);
  assert.match(listen, /apiBase = bridgeUrlFor\(host, port\)/);
  assert.match(listen, /console\.log\(bridgeUrlAnnouncement\(apiBase\)\)/);
  assert.match(source, /^let apiBase = bridgeUrlFor\(host, port\);$/m);
  assert.match(source, /if \(shouldRetryWithEphemeralPort\(error, portWasRequested\)\)/);
});

test("no host may invent a port any more", () => {
  const dev = read("scripts/dev.mjs");
  const sidecar = read("src-electron/sidecar.js");
  const rust = read("src-tauri/src/lib.rs");

  for (const [name, source] of [["scripts/dev.mjs", dev], ["src-electron/sidecar.js", sidecar], ["src-tauri/src/lib.rs", rust]]) {
    assert.ok(!/PI_DESKTOP_PORT[^\n]*6474/.test(source), `${name} must stop pinning the api port`);
  }

  // JS hosts share the one implementation; rust cannot import it, so its literal must be compared
  // against the module it has to agree with - that comparison is the seam.
  assert.match(dev, /bridgeListen\.mjs/);
  // The probe itself must be gone (the comment above the import may still explain what it did).
  assert.doesNotMatch(dev, /function canBind|from "node:net"/);
  assert.match(sidecar, /shellPaths\.bridgeListen/);
  assert.match(sidecar, /createBridgeUrlWatcher/);
  // rust cannot import the module, so compare its literal against the shared one.
  assert.ok(rust.includes(JSON.stringify(rules.BRIDGE_URL_PREFIX)), "the rust host must watch the same announcement");
  assert.match(rust, /command\.stdout\(Stdio::piped\(\)\)/);
  assert.ok(!dev.includes(rules.BRIDGE_URL_PREFIX) && !sidecar.includes(rules.BRIDGE_URL_PREFIX), "JS hosts must not duplicate the wire format");
});

test("每个宿主都要把「内置 SDK 在哪」交给会自己 spawn 子进程的包", () => {
  const dev = read("scripts/dev.mjs");
  const sidecar = read("src-electron/sidecar.js");
  const rust = read("src-tauri/src/lib.rs");

  // 这是 pi-subagents 的私有契约（包自己声明要用它认宿主），写错一个字母的后果是「设了但没用」，
  // 而且它只会报一句看不出所以然的 neither is available，所以三处宿主必须同名。
  // 行为归 tests/hostPiPackageRoot.test.ts 管，这里只守「三个宿主不发散」这条缝。
  assert.equal(
    HOST_PI_PACKAGE_ROOT_ENV,
    "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT",
    "改名就要同步改三处宿主，所以这个名字被钉在这里",
  );
  assert.ok(sidecar.includes(HOST_PI_PACKAGE_ROOT_ENV));
  assert.match(dev, /hostPiPackageRootEnv/, "dev 直接 spawn 桥、不经过 shell，得自己带上");
  assert.ok(rust.includes(HOST_PI_PACKAGE_ROOT_ENV), "rust 不能 import JS，只能比字面量");
});

test("渲染层在模块加载时定一次基地址，优先级里必须有 dev 烘进来的环境值", async () => {
  const apiModule = pathToFileURL(join(repoRoot, "src/lib/api.ts")).href;
  const { pickApiBase } = await import(apiModule);

  // 宿主注入 > 构建/开发时烘进的环境值 > 默认端口。中间那层一丢，端口降级时窗口就会去敲别人的桥。
  assert.equal(pickApiBase({ injected: "http://127.0.0.1:51234", env: "http://127.0.0.1:54433" }), "http://127.0.0.1:51234");
  assert.equal(pickApiBase({ injected: "  ", env: "http://127.0.0.1:54433/" }), "http://127.0.0.1:54433");
  assert.equal(pickApiBase({}), "http://127.0.0.1:6474");

  // “定一次”的可执行定义：加载之后再改 window 上的注入值，已定的地址不能跟着变。
  globalThis.window = { __PI_DESKTOP_API_BASE__: "http://127.0.0.1:11111" };
  try {
    const once = await import(`${apiModule}?once=${process.pid}`);
    assert.equal(once.getApiBase(), "http://127.0.0.1:11111");
    globalThis.window = { __PI_DESKTOP_API_BASE__: "http://127.0.0.1:22222" };
    assert.equal(once.getApiBase(), "http://127.0.0.1:11111", "地址必须在加载时定死，不能每请求重新取");
  } finally {
    delete globalThis.window;
  }

  // 请求路径上不能再出现“每请求解析 / 轮询等注入”：那是把错地址放大成卡死的地方。
  const source = read("src/lib/api.ts");
  assert.ok(!/currentApiBase|resolveApiBase/.test(source), "per-request resolution turns a wrong port into a hang");
  assert.ok(!/setTimeout\(resolve, 100\)/.test(source), "the renderer must not poll for an injected address");
  assert.ok(source.includes("const base = API_BASE;"), "请求要走常量地址");
});

test("tauri 先把地址定下来，再开窗", () => {
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.deepEqual(config.app.windows, [], "自动建窗会让注入永远晚于页面脚本");

  const rust = read("src-tauri/src/lib.rs");
  const at = (needle) => {
    const index = rust.indexOf(needle);
    assert.ok(index >= 0, `src-tauri/src/lib.rs 里找不到 ${needle}`);
    return index;
  };

  // 源码顺序不等于执行顺序：只看 setup 这一段里的先后。
  const setupAt = rust.indexOf(".setup(|app| {");
  assert.ok(setupAt >= 0, "src-tauri/src/lib.rs 里找不到 setup");
  const setupBody = rust.slice(setupAt, rust.indexOf(".invoke_handler(", setupAt));
  const inSetup = (needle) => {
    const index = setupBody.indexOf(needle);
    assert.ok(index >= 0, `setup 里找不到 ${needle}`);
    return index;
  };
  assert.ok(inSetup("start_bridge") < inSetup("create_main_window"), "必须先起桥、拿到地址，再建窗");
  // 只看 start_bridge 自己：setup 里新增的 `Ok((child, url))` 分支会在文件里更早出现。
  const bridgeAt = rust.indexOf("fn start_bridge(");
  assert.ok(bridgeAt >= 0, "src-tauri/src/lib.rs 里找不到 start_bridge");
  const bridgeBody = rust.slice(bridgeAt, rust.indexOf("fn await_bridge_url(", bridgeAt));
  assert.ok(
    bridgeBody.indexOf("await_bridge_url(stdout)") < bridgeBody.indexOf("Ok((child, url))"),
    "start_bridge 必须等到公告地址才返回",
  );
  // 桥起不来必须弹框后退出：`?` 冒到 run() 的 expect 就是 panic，用户看到的是闪一下没了。
  assert.match(setupBody, /Err\(error\)[\s\S]*?rfd::MessageDialog::new\(\)/);
  assert.match(setupBody, /Err\(error\)[\s\S]*?std::process::exit\(1\)/);
  assert.ok(rust.includes("initialization_script"), "地址要用 initialization_script 给到页面");
  assert.ok(rust.includes("window.__PI_DESKTOP_API_BASE__"), "注入的全局名要和 Electron preload 一致");
  assert.ok(!rust.includes(".eval("), "开窗后 eval 注入的晚到地址已经没人看了");
  // 拿到公告之后还要继续抽干 stdout，否则管道背压会把桥堵死。
  assert.ok(rust.includes('eprintln!("[bridge] {line}")'), "stdout 必须持续被读走");
});

test("dev 在桥被迫离开首选端口时把它吼出来", () => {
  const dev = read("scripts/dev.mjs");
  assert.ok(dev.includes("已被占用"), "降级必须可见，不能只在日志里默默换端口");
  assert.ok(dev.includes("VITE_PI_DESKTOP_API_BASE"), "提示要点名渲染层真正用的那条通道");
});

test("electron hands the shell the port the bridge announced", { skip: process.platform === "win32" }, async () => {
  await withTemp(async (root) => {
    // The rules file travels with the bridge; the shell imports that copy rather than a second
    // implementation it could drift from.
    mkdirSync(join(root, "bridge", "server"), { recursive: true });
    copyFileSync(join(repoRoot, "server/bridgeListen.mjs"), join(root, "bridge", "server", "bridgeListen.mjs"));

    const executable = (path, body) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, body, { mode: 0o755 });
      chmodSync(path, 0o755);
      return path;
    };
    const launcher = executable(
      join(root, "pi-desktop-server"),
      "#!/bin/sh\nprintf 'Pi Desktop bridge running at http://127.0.0.1:4321\\nPI_DESKTOP_BRIDGE_URL=http://127.0.0.1:4321\\n'\nsleep 20\n",
    );
    executable(join(root, "python-runtime", "bin", "python3.13"), "#!/bin/sh\nexit 0\n");
    executable(join(root, "node-runtime", "bin", "node"), "#!/bin/sh\nexit 0\n");
    mkdirSync(join(root, "node-runtime", "lib", "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(join(root, "node-runtime", "lib", "node_modules", "npm", "bin", "npm-cli.js"), "");
    writeFileSync(join(root, "capabilities.defaults.json"), "{}");

    const { startBridge, stopBridge } = require("../src-electron/sidecar.js");
    const { child, url } = await startBridge(
      {
        mode: "test",
        root,
        sidecar: launcher,
        sidecarArgs: [],
        piCli: { binary: launcher },
        bridgeListen: join(root, "bridge", "server", "bridgeListen.mjs"),
        skills: root,
        capabilitiesDefaults: join(root, "capabilities.defaults.json"),
        pythonRuntime: join(root, "python-runtime"),
        nodeRuntime: join(root, "node-runtime"),
      },
      { info() {}, warn() {} },
    );
    try {
      assert.equal(await url, "http://127.0.0.1:4321");
    } finally {
      stopBridge(child);
    }
  });
});

test("a packaged app that never announces its port reports why", () => {
  const main = read("src-electron/main.js");
  // Discovery failure must reach the user, not become an empty window.
  assert.match(main, /bridgeApiBase = await bridge\.url/);
  assert.match(main, /waitForBridge\(bridgeApiBase\)/);
  assert.match(main, /reportStartupFailure\(error\)/);
  assert.match(main, /--pi-desktop-api-base=\$\{bridgeApiBase\}/);
  const preload = read("src-electron/preload.js");
  assert.match(preload, /exposeInMainWorld\("__PI_DESKTOP_API_BASE__"/);
});
