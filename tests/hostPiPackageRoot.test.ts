// 宿主 SDK 路径交接。
//
// pi-subagents（以及任何会自己 spawn Node 子进程的包）要从 `~/.pi/agent/npm/node_modules`
// 里 import `@earendil-works/pi-coding-agent`，而 Node 的 ESM 查找只会向上走父目录，永远到不了
// app 包里的那一份；它自己的报错会退化成一句看不懂的 "neither is available"。宿主是唯一知道
// 路径的一方，所以由 bridgeEnv 把它交过去。
//
// 这组用例锁四件事：
//   1. 打包布局（<root>/bridge/node_modules）和开发布局（<root>/node_modules）都认得
//   2. 两份都在时以打包那份为准
//   3. 目录缺失 / 清单名字不对 / 清单是坏 JSON → 不设变量（宁可不设，也不能指向一个坏路径，
//      否则包的报错会从 "neither is available" 变成更难查的 "does not provide"）
//   4. 外面已经设过就不覆盖（launchctl / wrapper / 自备 SDK 的人比这里的猜测更清楚）

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);

const { bridgeEnv, hostPiPackageRoot } = require("../src-electron/sidecar.js");

const ENV_KEY = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";
const PACKAGE_SEGMENTS = ["@earendil-works", "pi-coding-agent"];
const REPO_ROOT = resolve(import.meta.dirname, "..");

function withTemp(fn) {
  const root = mkdtempSync(join(tmpdir(), "pi-host-sdk-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 一个能跑通 bridgeEnv 的最小 shellPaths；用 system 模式省掉 bundled 的运行时校验。 */
function shellPathsFor(root) {
  const launcher = join(root, "pi-desktop-server");
  writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(launcher, 0o755);
  return {
    mode: "packaged",
    root,
    sidecar: launcher,
    sidecarArgs: [],
    piCli: { binary: launcher },
    skills: root,
    capabilitiesDefaults: join(root, "capabilities.defaults.json"),
    pythonRuntime: join(root, "python-runtime"),
    nodeRuntime: join(root, "node-runtime"),
    runtimeMode: "system",
    systemNode: "/usr/local/bin/node",
    hostPath: "/usr/local/bin:/usr/bin",
  };
}

/** 造一份 SDK 安装；只有清单，判身份已经够了。 */
function plantSdk(root, segments, manifest = { name: "@earendil-works/pi-coding-agent" }) {
  const dir = join(root, ...segments);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  return dir;
}

/** bridgeEnv 读本进程的环境变量，跑之前先把可能存在的那个键摘掉再还原。 */
function withoutInherited(fn) {
  const saved = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  try {
    return fn();
  } finally {
    if (saved === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = saved;
    }
  }
}

test("打包布局：认出 bridge/node_modules 里的 SDK 并把路径交给包", () =>
  withTemp((root) =>
    withoutInherited(() => {
      const sdk = plantSdk(root, ["bridge", "node_modules", ...PACKAGE_SEGMENTS]);
      const { env } = bridgeEnv(shellPathsFor(root));
      assert.equal(env[ENV_KEY], sdk);
    }),
  ));

test("开发布局：root/node_modules 里的 SDK 同样认得", () =>
  withTemp((root) =>
    withoutInherited(() => {
      const sdk = plantSdk(root, ["node_modules", ...PACKAGE_SEGMENTS]);
      const { env, cwd } = bridgeEnv(shellPathsFor(root));
      assert.equal(env[ENV_KEY], sdk);
      assert.equal(cwd, root, "顺手确认没把 cwd 等其它契约改坏");
    }),
  ));

test("两份都在时以打包那份为准", () =>
  withTemp((root) =>
    withoutInherited(() => {
      const packaged = plantSdk(root, ["bridge", "node_modules", ...PACKAGE_SEGMENTS]);
      plantSdk(root, ["node_modules", ...PACKAGE_SEGMENTS]);
      assert.equal(bridgeEnv(shellPathsFor(root)).env[ENV_KEY], packaged);
    }),
  ));

test("没有可用的 SDK 时不设这个变量", () =>
  withTemp((root) =>
    withoutInherited(() => {
      const env = bridgeEnv(shellPathsFor(root)).env;
      assert.equal(env[ENV_KEY], undefined, "目录不存在时不能凭空造一个路径");
    }),
  ));

test("清单名字不对的目录不被当成 SDK", () =>
  withTemp((root) =>
    withoutInherited(() => {
      plantSdk(root, ["bridge", "node_modules", ...PACKAGE_SEGMENTS], { name: "something-else" });
      assert.equal(bridgeEnv(shellPathsFor(root)).env[ENV_KEY], undefined);
    }),
  ));

test("清单是坏 JSON 时既不抛异常也不设变量", () =>
  withTemp((root) =>
    withoutInherited(() => {
      plantSdk(root, ["bridge", "node_modules", ...PACKAGE_SEGMENTS], "{ not json");
      const paths = { root };
      assert.equal(hostPiPackageRoot(paths), null);
      assert.equal(bridgeEnv(shellPathsFor(root)).env[ENV_KEY], undefined);
    }),
  ));

test("外面已经设过就不覆盖", () =>
  withTemp((root) =>
    withoutInherited(() => {
      plantSdk(root, ["bridge", "node_modules", ...PACKAGE_SEGMENTS]);
      process.env[ENV_KEY] = "/custom/sdk";
      try {
        assert.equal(bridgeEnv(shellPathsFor(root)).env[ENV_KEY], "/custom/sdk");
      } finally {
        delete process.env[ENV_KEY];
      }
    }),
  ));

test("空白的继承值不算设过", () =>
  withTemp((root) =>
    withoutInherited(() => {
      const sdk = plantSdk(root, ["bridge", "node_modules", ...PACKAGE_SEGMENTS]);
      process.env[ENV_KEY] = "   ";
      try {
        assert.equal(bridgeEnv(shellPathsFor(root)).env[ENV_KEY], sdk);
      } finally {
        delete process.env[ENV_KEY];
      }
    }),
  ));

test("仓库自身的开发布局解析出的是真实存在、能 import 的 SDK 根", () => {
  // 防止「变量设上了但指向一个跑不通的目录」这种假成功。
  const root = hostPiPackageRoot({ root: REPO_ROOT });
  assert.equal(root, join(REPO_ROOT, "node_modules", ...PACKAGE_SEGMENTS));
  assert.ok(existsSync(join(root, "dist", "index.js")), "SDK 入口要真的在");
});