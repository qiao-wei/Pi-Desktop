/**
 * 「出包」的规则只有一个形状：`pack:<外壳>:<目标>[:<架构>][:slim]`。
 *
 * 这个文件锁两件事：
 *  1. 入口名字和它实际调用的参数必须一致 —— 名字是给人看的、参数是给机器看的，两者一旦漂开，
 *     就会出现"名字写着 x64、实际出了 arm64"这种最难发现的事故；另外顺带守住"每个入口都只有一行、
 *     不再有 && 链、也不再在 Windows 上写出 `VAR=x cmd` 这种 cmd 不认的前缀"。
 *  2. 不可能的组合必须在跑任何构建之前报错并给出下一步（bundled 交叉、非 mac 上打 mac 包、universal）。
 *
 * 计划和报错都是纯函数（scripts/lib/packPlan.mjs），所以这里不需要真的打包。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  PACK_ARCHES,
  PACK_SCRIPT_RULE,
  PackPlanError,
  buildPackPlan,
  parsePackArgs,
  platformOfTriple,
  runtimeModeEnv,
  tripleFor,
} from "../scripts/lib/packPlan.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const readJson = (relative) => JSON.parse(readFileSync(resolve(repoRoot, relative), "utf8"));
const packScripts = () => {
  const scripts = readJson("package.json").scripts;
  return Object.entries(scripts).filter(([name]) => name.startsWith("pack:"));
};

/** assert.throws 不把错误交回来，而这些用例标题就是错误本身。 */
function planError(run) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof PackPlanError, `期望 PackPlanError，收到 ${error}`);
    return error;
  }
  assert.fail("应当拒绝这个组合，但它通过了");
}

/** 每个入口都必须是 `node scripts/pack.mjs …` 一行，不能是 && 链，也不能带内联 env 前缀。 */
test("每个 pack:* 入口都是同一形状的一行，不含 && 链或内联 env", () => {
  const entries = packScripts();
  assert.ok(entries.length >= 10, `入口太少，可能被误删：${entries.map(([name]) => name).join(", ")}`);
  for (const [name, command] of entries) {
    assert.match(name, PACK_SCRIPT_RULE, `${name} 不符合 pack:<外壳>:<目标>[:<架构>][:slim]`);
    assert.match(command, /^node scripts\/pack\.mjs /, `${name} 必须走同一个入口`);
    assert.ok(!command.includes("&&"), `${name} 不能再是 && 链：${command}`);
    assert.ok(!/^[A-Z][A-Z0-9_]*=/.test(command), `${name} 不能内联 env（Windows 的 cmd 不认）：${command}`);
  }
});

/** 名字 ↔ 参数：把入口的命令行参数喂给计划器，计划自己报出来的名字必须与入口名字逐字相同。 */
test("入口名字与实际生效的目标/架构/模式逐字一致", () => {
  for (const [name, command] of packScripts()) {
    const args = parsePackArgs(command.replace(/^node scripts\/pack\.mjs /, "").split(" "));
    // 用与目标同平台、但架构与本机不同的上下文，确保默认值不参与"名字↔参数"的对账。
    const onTargetPlatform = args.target === "mac" ? "darwin" : "win32";
    const plan = buildPackPlan(args, { platform: onTargetPlatform, arch: "x64", commandExists: () => true });

    assert.equal(plan.summary, name, `${name} 的参数算出来是 ${plan.summary}`);
    assert.equal(plan.triple, tripleFor(plan.target, plan.arch), `${name} 的三元组没跟上架构`);
    assert.equal(plan.env.PI_DESKTOP_TARGET_TRIPLE, plan.triple, `${name} 必须把三元组下发给 runtime/bridge 构建`);
    assert.equal(plan.env.PI_DESKTOP_RUNTIME_MODE, runtimeModeEnv(plan.runtimeMode), `${name} 的模式没下发成运行期用语`);
    assert.equal(platformOfTriple(plan.triple), onTargetPlatform, `${name} 的三元组与目标平台不一致`);

    // 打包器那一步必须带齐同一个目标：名字说 arm64，打包器就不能用 --x64，否则 runtime 与外壳会错位。
    // （Tauri 用 --target <triple>，electron-builder 用 --mac/--win + --arm64/--x64。）
    const packager = plan.steps.at(-1).args.join(" ");
    if (plan.host === "tauri") {
      assert.ok(packager.includes(`--target ${plan.triple}`), `${name} 的打包器没点名目标三元组：${packager}`);
    } else {
      assert.ok(packager.includes(`--${plan.target === "mac" ? "mac" : "win"}`), `${name} 的平台开关不对：${packager}`);
      assert.ok(packager.includes(plan.arch === "arm64" ? "--arm64" : "--x64"), `${name} 的架构开关不对：${packager}`);
    }
  }
});

/**
 * 目标三元组是一条跨进程契约：出包脚本写 env，三个构建脚本读。这里锁的是“两端都在、且优先级固定”
 * —— 真正跑一遍构建太重，而这条契约一旦断掉，症状是“按 mac 剪包却打 Windows 包”这种默默错位。
 * 断言前先剔掉注释：文档里也会提到这两个变量名，否则注释能让断言的最后一道防线假绿。
 */
test("三元组的另一端：三个构建脚本读同一个变量，且出包脚本给的值优先", () => {
  const codeOnly = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const file of ["scripts/build-node-runtime.mjs", "scripts/build-python-runtime.mjs", "scripts/build-bridge-runtime.mjs"]) {
    const code = codeOnly(readFileSync(resolve(repoRoot, file), "utf8"));
    assert.match(
      code,
      /process\.env\.PI_DESKTOP_TARGET_TRIPLE[^\n]*\|\|[^\n]*process\.env\.TAURI_ENV_TARGET_TRIPLE/,
      `${file} 必须把出包脚本下发的三元组排在 Tauri 自己导出的前面`,
    );
  }
});

test("两条外壳 × 两个目标 × 两种模式都有入口，mac 两个架构都在，windows 只有 x64", () => {
  const names = packScripts().map(([name]) => name);
  for (const host of ["electron", "tauri"]) {
    for (const mode of ["", ":slim"]) {
      for (const arch of PACK_ARCHES.mac) {
        assert.ok(names.includes(`pack:${host}:mac:${arch}${mode}`), `缺 pack:${host}:mac:${arch}${mode}`);
      }
      assert.ok(names.includes(`pack:${host}:windows${mode}`), `缺 pack:${host}:windows${mode}`);
    }
    assert.ok(!names.some((name) => name.includes("windows:arm64")), "windows 目前只出 x64，别留没验证过的入口");
  }
  assert.ok(!names.some((name) => name.includes("universal")), "universal 已不支持，不该有入口");
});

test("bundled 链：前端 → 运行时 → bridge → 门禁 → 打包器", () => {
  const plan = buildPackPlan(parsePackArgs(["--host", "electron", "--target", "mac", "--arch", "arm64"]), {
    platform: "darwin",
    arch: "arm64",
  });
  const labels = plan.steps.map((step) => step.label).join(" → ");
  const at = (needle) => plan.steps.findIndex((step) => step.label.includes(needle));

  assert.ok(at("tsc -b") === 0 && at("vite build") === 1, `前端两步最先：${labels}`);
  assert.ok(at("python:build") > at("vite build") && at("node:build") > at("python:build"), labels);
  assert.ok(at("bridge:build") > at("node:build"), `bridge 需要 runtime 先就位：${labels}`);
  assert.ok(at("sidecar:verify") > at("bridge:build"), `门禁必须对着组装好的 bridge 跑：${labels}`);
  assert.equal(at("electron-builder"), plan.steps.length - 1, `打包器必须最后：${labels}`);
  assert.equal(plan.env.PI_DESKTOP_PACK_PREPARED, "1", "Tauri 的 beforeBuildCommand 要靠它空转");
});

test("slim 链与 bundled 的差别只有两个 runtime 步骤", () => {
  const bundled = buildPackPlan(parsePackArgs(["--host", "tauri", "--target", "mac", "--arch", "arm64"]), { platform: "darwin", arch: "arm64" });
  const slim = buildPackPlan(parsePackArgs(["--host", "tauri", "--target", "mac", "--arch", "arm64", "--mode", "slim"]), {
    platform: "darwin",
    arch: "arm64",
  });
  const bundledLabels = bundled.steps.map((step) => step.label);
  const slimLabels = slim.steps.map((step) => step.label);

  assert.deepEqual(
    bundledLabels.filter((label) => !slimLabels.includes(label)),
    ["内置 Python runtime（python:build）", "内置 Node runtime（node:build）"],
  );
  assert.ok(slimLabels.some((label) => label.includes("sidecar:verify")), "精简包同样要过门禁");
  assert.ok(slim.steps.at(-1).args.includes("src-tauri/tauri.slim.conf.json"), "精简产物必须用 overlay 摘掉 runtime");
  assert.equal(slim.env.PI_DESKTOP_RUNTIME_MODE, "system");
});

test("交叉：bundled 在动手之前拒绝，并给出三条可走的路", () => {
  const error = planError(() =>
    buildPackPlan(parsePackArgs(["--host", "electron", "--target", "windows", "--cross"]), { platform: "darwin", arch: "arm64" }),
  );

  assert.match(error.message, /bundled 模式无法交叉构建到 windows/);
  assert.equal(error.hints.length, 3, "三条出路要都在：原生机器 / 预构建 runtime / slim");
  assert.ok(error.hints.some((hint) => hint.includes("slim")), error.hints.join("\n"));
  assert.ok(error.hints.some((hint) => hint.includes("预构建")), error.hints.join("\n"));
});

test("交叉：slim 放行，跳过门禁并说明原因，Tauri 换成 cargo-xwin", () => {
  const electron = buildPackPlan(parsePackArgs(["--host", "electron", "--target", "windows", "--mode", "slim", "--cross"]), {
    platform: "darwin",
    arch: "arm64",
    commandExists: () => false,
  });
  assert.ok(!electron.steps.some((step) => step.label.includes("sidecar:verify")), "交叉时不跑门禁");
  assert.ok(electron.notes.some((note) => note.includes("跳过 sidecar:verify")), "跳过必须说出来，不能静默");
  assert.ok(electron.notes.some((note) => note.includes("wine")), "缺 wine 要提前提示，别等构建跑到一半才失败");
  const electronArgs = electron.steps.at(-1).args;
  assert.ok(electronArgs.includes("--win") && electronArgs.includes("--x64"), electronArgs.join(" "));
  assert.ok(electronArgs.includes("src-electron/electron-builder.config.cjs"), electronArgs.join(" "));

  const tauri = buildPackPlan(parsePackArgs(["--host", "tauri", "--target", "windows", "--mode", "slim", "--cross"]), {
    platform: "darwin",
    arch: "arm64",
  });
  const packager = tauri.steps.at(-1).args;
  assert.deepEqual(packager.slice(packager.indexOf("--target"), packager.indexOf("--target") + 2), ["--target", "x86_64-pc-windows-msvc"]);
  assert.ok(packager.includes("--runner") && packager.includes("cargo-xwin"), packager.join(" "));
  assert.ok(packager.includes("--config") && packager.includes("src-tauri/tauri.slim.conf.json"));
});

test("没有 --cross 时不给交叉，报错本身告诉你怎么交叉", () => {
  const error = planError(() =>
    buildPackPlan(parsePackArgs(["--host", "tauri", "--target", "windows"]), { platform: "darwin", arch: "arm64" }),
  );
  assert.match(error.message, /不是同一平台/);
  assert.ok(error.hints.some((hint) => hint.includes("--cross")), error.hints.join("\n"));
  assert.ok(error.hints.some((hint) => hint.includes("pack:tauri:windows")), "提示里要给一条能直接粘的命令");
});

test("macOS 目标只能在 macOS 上构建", () => {
  const error = planError(() =>
    buildPackPlan(parsePackArgs(["--host", "tauri", "--target", "mac", "--arch", "arm64", "--cross"]), { platform: "linux", arch: "x64" }),
  );
  assert.match(error.message, /只能在 macOS 上构建/);
});

test("universal 被明确拒绝，并说明为什么（runtime 是单架构目录）", () => {
  const error = planError(() =>
    buildPackPlan(parsePackArgs(["--host", "electron", "--target", "mac", "--arch", "universal"]), { platform: "darwin", arch: "arm64" }),
  );
  assert.match(error.message, /universal/);
  assert.ok(error.hints.some((hint) => hint.includes("分架构 runtime")), error.hints.join("\n"));
});

test("认不出来的参数原样转交打包器，不污染准备步骤", () => {
  const plan = buildPackPlan(parsePackArgs(["--host", "electron", "--target", "mac", "--arch", "arm64", "--publish", "never"]), {
    platform: "darwin",
    arch: "arm64",
  });
  assert.deepEqual(plan.passthrough, ["--publish", "never"]);
  assert.deepEqual(plan.steps.at(-1).args.slice(-2), ["--publish", "never"]);
  assert.equal(plan.steps.filter((step) => step.args.includes("--publish")).length, 1, "只贴给打包器那一步");
});

test("Tauri 的 beforeBuildCommand 走同一个准备入口，overlay 只声明 slim", () => {
  const scripts = readJson("package.json").scripts;
  assert.equal(scripts["tauri:prepare"], "node scripts/pack.mjs --prepare-only");

  const base = readJson("src-tauri/tauri.conf.json");
  assert.equal(base.build.beforeBuildCommand, "npm run tauri:prepare");
  assert.ok(!/python:build|node:build|bridge:build/.test(base.build.beforeBuildCommand), "准备链不能再抄一份在这里");

  const slim = readJson("src-tauri/tauri.slim.conf.json");
  assert.match(slim.build.beforeBuildCommand, /--mode slim/);
  assert.ok(!/python:build|node:build|bridge:build/.test(slim.build.beforeBuildCommand), "overlay 只声明差异");
  assert.equal(slim.bundle.resources["binaries/node-runtime"], null);
});

test("--prepare-only：按三元组与模式跑准备步骤，已经跑过时空转", () => {
  const run = buildPackPlan(parsePackArgs(["--prepare-only", "--mode", "slim"]), { platform: "darwin", arch: "arm64", env: {} });
  assert.equal(run.summary, "准备步骤（slim / aarch64-apple-darwin）");
  assert.ok(run.steps.some((step) => step.label.includes("sidecar:verify")));
  assert.equal(run.env.PI_DESKTOP_RUNTIME_MODE, "system");

  const cross = buildPackPlan(parsePackArgs(["--prepare-only"]), {
    platform: "darwin",
    arch: "arm64",
    env: { TAURI_ENV_TARGET_TRIPLE: "x86_64-pc-windows-msvc" },
  });
  assert.equal(cross.env.PI_DESKTOP_TARGET_TRIPLE, "x86_64-pc-windows-msvc", "Tauri 导出的三元组要接住");
  assert.ok(!cross.steps.some((step) => step.label.includes("sidecar:verify")), "交叉的准备步骤不跑门禁");
  assert.ok(cross.notes.some((note) => note.includes("跳过 sidecar:verify")));

  const already = buildPackPlan(parsePackArgs(["--prepare-only"]), {
    platform: "darwin",
    arch: "arm64",
    env: { PI_DESKTOP_PACK_PREPARED: "1" },
  });
  assert.deepEqual(already.steps, [], "同一个包里准备步骤只跑一次");
});