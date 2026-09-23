/**
 * 「出包」这件事只有一个形状：
 *
 *   pack:<外壳>:<目标>[:<架构>][:slim]
 *
 *   --host   electron|tauri    外壳
 *   --target mac|windows       目标平台（必填：不再有"当前机器"这种含糊入口，同一个命令在谁的机器上
 *                              run 出来的产物必须一样）
 *   --arch   arm64|x64         目标架构；mac 省略时取本机架构，windows 省略时取 x64
 *   --mode   bundled|slim      运行时模式；省略 = bundled
 *   --cross                    目标平台与构建机不同时，显式确认走交叉工具链
 *   --dry-run                  只打印计划
 *   --prepare-only             Tauri 的 beforeBuildCommand 用：只跑准备步骤，不打最终包
 *
 * 这个模块只做两件事：把参数变成"要执行的命令序列"，以及在跑任何东西之前把不可能的组合说清楚。
 * 真正 spawn 在 scripts/pack.mjs —— 分开是为了让测试直接断言计划与报错，不用真的打一个包。
 */

/** 目标 → Rust target triple。bridge / node/python runtime 全都认这个值（经 PI_DESKTOP_TARGET_TRIPLE）。 */
const TRIPLES = {
  "mac/arm64": "aarch64-apple-darwin",
  "mac/x64": "x86_64-apple-darwin",
  "windows/x64": "x86_64-pc-windows-msvc",
  "windows/arm64": "aarch64-pc-windows-msvc",
};

export const PACK_HOSTS = ["electron", "tauri"];
export const PACK_TARGETS = ["mac", "windows"];
export const PACK_ARCHES = { mac: ["arm64", "x64"], windows: ["x64", "arm64"] };
export const PACK_MODES = ["bundled", "slim"];
/** package.json 里每个 `pack:*` 入口都必须匹配这条规则（tests/packPlan.test.ts 会逐个校验）。 */
export const PACK_SCRIPT_RULE = /^pack:(electron|tauri):(mac|windows)(?::(arm64|x64))?(?::slim)?$/;

const PLATFORM_OF_TARGET = { mac: "darwin", windows: "win32" };
const TARGET_OF_PLATFORM = { darwin: "mac", win32: "windows" };

export class PackPlanError extends Error {
  /** @param {string} message @param {string[]} [hints] 可操作的下一步，逐行打印 */
  constructor(message, hints = []) {
    super(message);
    this.name = "PackPlanError";
    this.hints = hints;
  }
}

/** 打包期说 `slim`，运行期说 `system`：同一个事实的两个名字，只在这里翻译一次。 */
export function runtimeModeEnv(mode) {
  return mode === "slim" ? "system" : "bundled";
}

function pick(value, allowed, flag) {
  if (!allowed.includes(value)) {
    throw new PackPlanError(`${flag} 只能是 ${allowed.join(" / ")}，收到 "${value}"`);
  }
  return value;
}

/** 默认架构：mac 跟本机走，windows 固定 x64（仓库里只有 x64 的交叉链）。 */
export function defaultArch(target, hostArch) {
  if (target === "mac") {
    return hostArch === "x64" ? "x64" : "arm64";
  }
  return "x64";
}

export function tripleFor(target, arch) {
  return TRIPLES[`${target}/${arch}`];
}

/** 没有目标参数时的兜底（Tauri 的 beforeBuildCommand 走这条）：构建机自己的三元组。 */
export function hostTriple(platform, arch) {
  if (platform === "darwin" || platform === "win32") {
    return tripleFor(TARGET_OF_PLATFORM[platform], arch === "arm64" ? "arm64" : "x64");
  }
  return `${arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`;
}

/** triple → 平台名（'darwin' / 'win32' / 'linux'）。用来判断"目标是不是构建机自己"。 */
export function platformOfTriple(triple) {
  if (!triple) {
    return "";
  }
  if (triple.includes("windows")) {
    return "win32";
  }
  if (triple.includes("apple-darwin")) {
    return "darwin";
  }
  return "linux";
}

/**
 * 解析命令行。认不出来的参数不改写也不报错，原样放进 `passthrough` 交给打包器 ——
 * npm 会把第一个 `--` 吃掉，所以 `npm run pack:… -- --publish never` 到我们这里只剩 `--publish never`。
 */
export function parsePackArgs(argv) {
  const flags = { cross: false, dryRun: false, prepareOnly: false };
  const values = {};
  const passthrough = [];
  const named = { "--host": "host", "--target": "target", "--arch": "arch", "--mode": "runtimeMode" };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      passthrough.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--cross") {
      flags.cross = true;
      continue;
    }
    if (arg === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (arg === "--prepare-only") {
      flags.prepareOnly = true;
      continue;
    }
    if (named[arg]) {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new PackPlanError(`${arg} 需要一个值`);
      }
      values[named[arg]] = value;
      index += 1;
      continue;
    }
    passthrough.push(arg);
  }

  return { ...flags, ...values, passthrough };
}

/** 准备步骤（两条外壳共用）：前端 → 运行时（仅 bundled）→ bridge → 能力包门禁。 */
function prepareSteps({ runtimeMode, gate }) {
  const steps = [
    { label: "前端类型检查（tsc -b）", pkg: ["typescript", "bin/tsc"], args: ["-b"] },
    { label: "前端构建（vite build）", pkg: ["vite", "bin/vite.js"], args: ["build"] },
  ];
  if (runtimeMode === "bundled") {
    steps.push({ label: "内置 Python runtime（python:build）", bin: "scripts/build-python-runtime.mjs", args: [] });
    steps.push({ label: "内置 Node runtime（node:build）", bin: "scripts/build-node-runtime.mjs", args: [] });
  }
  steps.push({ label: "组装 bridge（bridge:build）", bin: "scripts/build-bridge-runtime.mjs", args: [] });
  if (gate) {
    steps.push({ label: "能力包门禁（sidecar:verify）", bin: "scripts/verify-sidecar-extensions.mjs", args: [] });
  }
  return steps;
}

/** 交叉时 bridge 已按目标平台剪过平台包，在构建机上启动它验证本来就不可靠 —— 跳过并说明。 */
const CROSS_GATE_NOTE =
  "交叉构建跳过 sidecar:verify：bridge 已按目标平台剪过平台包（例如 darwin 的 esbuild 二进制已被删），" +
  "在构建机上启动它验证不具备意义。目标平台上的首发/回归测试是这条链的替代保障。";

function bundledCrossError(target) {
  return new PackPlanError(
    `bundled 模式无法交叉构建到 ${target}：内置 Node/Python runtime 必须由目标原生的解释器组装并验收。`,
    [
      "在目标平台的原生机器（或 CI runner）上跑同一条命令；",
      "或先做「预构建 runtime + 哈希发布」，让交叉侧只下载不组装；",
      "或用 slim 模式交叉（不带 runtime，README「打包」一节有能力对照表）。",
    ],
  );
}

/**
 * @param {ReturnType<typeof parsePackArgs>} options
 * @param {{platform?: string, arch?: string, env?: Record<string, string|undefined>, commandExists?: (name: string) => boolean}} [context]
 */
export function buildPackPlan(options, context = {}) {
  const state = {
    platform: context.platform ?? process.platform,
    hostArch: context.arch ?? process.arch,
    env: context.env ?? process.env,
    commandExists: context.commandExists ?? (() => false),
  };
  return options.prepareOnly ? buildPreparePlan(options, state) : buildFullPlan(options, state);
}

/** Tauri 的 beforeBuildCommand：读父进程/overlay 给的模式与目标三元组，只跑准备步骤。 */
function buildPreparePlan(options, { platform, hostArch, env }) {
  if (env.PI_DESKTOP_PACK_PREPARED === "1") {
    return {
      kind: "prepare",
      steps: [],
      env: {},
      notes: ["准备步骤已由 scripts/pack.mjs 跑过（PI_DESKTOP_PACK_PREPARED=1），这里直接跳过。"],
      dryRun: options.dryRun,
      passthrough: [],
      summary: "准备步骤（已跳过）",
    };
  }

  const runtimeMode = pick(options.runtimeMode ?? "bundled", PACK_MODES, "--mode");
  const triple =
    env.PI_DESKTOP_TARGET_TRIPLE?.trim() || env.TAURI_ENV_TARGET_TRIPLE?.trim() || hostTriple(platform, hostArch);
  const cross = platformOfTriple(triple) !== platform;

  return {
    kind: "prepare",
    steps: prepareSteps({ runtimeMode, gate: !cross }),
    env: { PI_DESKTOP_TARGET_TRIPLE: triple, PI_DESKTOP_RUNTIME_MODE: runtimeModeEnv(runtimeMode) },
    notes: cross ? [CROSS_GATE_NOTE] : [],
    dryRun: options.dryRun,
    passthrough: [],
    summary: `准备步骤（${runtimeMode} / ${triple}）`,
  };
}

function buildFullPlan(options, { platform, hostArch, commandExists }) {
  const host = pick(options.host, PACK_HOSTS, "--host");
  const target = pick(options.target, PACK_TARGETS, "--target");
  const runtimeMode = pick(options.runtimeMode ?? "bundled", PACK_MODES, "--mode");

  if (options.arch === "universal") {
    throw new PackPlanError("universal（fat 二进制）已不支持。", [
      "内置 Node/Python runtime 是单架构目录，装不进 fat 包 —— 要支持得先做「分架构 runtime + 运行期按 arch 选择」。",
      "用 --arch arm64 或 --arch x64 分别出包。",
    ]);
  }
  const arch = options.arch
    ? pick(options.arch, PACK_ARCHES[target], `--arch（${target} 支持）`)
    : defaultArch(target, hostArch);
  const triple = tripleFor(target, arch);

  if (target === "mac" && platform !== "darwin") {
    throw new PackPlanError(`macOS 目标只能在 macOS 上构建（当前是 ${platform}）：dmg、签名、公证都绑 mac。`, [
      "在 Mac 上跑这条命令；Windows/Linux 上请改打 --target windows。",
    ]);
  }

  const cross = PLATFORM_OF_TARGET[target] !== platform;
  if (cross && !options.cross) {
    const example = `npm run pack:${host}:${target}${arch !== defaultArch(target, hostArch) ? `:${arch}` : ""} -- --cross`;
    throw new PackPlanError(`${target} 目标与构建机（${platform}）不是同一平台。`, [
      `确认要交叉构建就加 --cross（例如 ${example}）；`,
      "不加 --cross 的语义是「这条命令在目标平台的机器上跑」。",
    ]);
  }
  if (!cross && options.cross) {
    throw new PackPlanError(`构建机就是 ${target}，不需要 --cross。`);
  }
  if (cross && runtimeMode === "bundled") {
    throw bundledCrossError(target);
  }
  if (cross && host === "tauri" && arch !== "x64") {
    throw new PackPlanError(
      `Tauri 的 Windows 交叉链目前只声明了 x86_64（cargo-xwin），--arch ${arch} 没有对应的 runner。`,
      ["用 --arch x64 交叉，或到目标平台原生构建。"],
    );
  }

  const notes = [];
  if (cross) {
    notes.push(CROSS_GATE_NOTE);
    if (host === "electron" && !commandExists("wine")) {
      notes.push(
        "PATH 里没找到 wine：electron-builder 在非 Windows 主机上打 Windows 目标通常会调用 wine（rcedit/NSIS）。" +
          "构建若失败就先装 wine（或配置 toolsets.wine）。",
      );
    }
  }
  if (runtimeMode === "bundled" && arch !== defaultArch(target, hostArch)) {
    notes.push(
      `bundled 且目标架构（${arch}）≠ 本机架构：内置 runtime 需要该架构的原生源码，用 ` +
        "PI_DESKTOP_NODE_SOURCE_DIR / PI_DESKTOP_PYTHON_SOURCE_DIR 指过去；验收时目标解释器要能在构建机上跑起来。",
    );
  }

  const steps = [
    ...prepareSteps({ runtimeMode, gate: !cross }),
    host === "tauri" ? tauriPackager({ runtimeMode, triple, cross }) : electronPackager({ target, arch }),
  ];

  return {
    kind: "pack",
    host,
    target,
    arch,
    runtimeMode,
    cross,
    triple,
    steps: withPassthrough(steps, options.passthrough),
    env: {
      PI_DESKTOP_TARGET_TRIPLE: triple,
      PI_DESKTOP_RUNTIME_MODE: runtimeModeEnv(runtimeMode),
      // Tauri 会把 beforeBuildCommand 跑一遍；准备步骤已经在上面自己跑过了，用这个开关让它空转。
      PI_DESKTOP_PACK_PREPARED: "1",
    },
    notes,
    dryRun: options.dryRun,
    passthrough: options.passthrough,
    summary: `pack:${host}:${target}${options.arch ? `:${arch}` : ""}${runtimeMode === "slim" ? ":slim" : ""}`,
  };
}

function electronPackager({ target, arch }) {
  return {
    label: `electron-builder（${target}/${arch}）`,
    pkg: ["electron-builder", "cli.js"],
    args: ["--config", "src-electron/electron-builder.config.cjs", target === "mac" ? "--mac" : "--win", arch === "arm64" ? "--arm64" : "--x64"],
  };
}

function tauriPackager({ runtimeMode, triple, cross }) {
  const args = ["build", "--bundles", triple.includes("windows") ? "nsis" : "app,dmg", "--target", triple];
  if (cross) {
    // Rust 没有 Windows 的 sysroot：交叉靠 cargo-xwin 提供 MSVC 的导入库。
    args.push("--runner", "cargo-xwin");
  }
  if (runtimeMode === "slim") {
    args.push("--config", "src-tauri/tauri.slim.conf.json");
  }
  return { label: `tauri build（${triple}${cross ? " / cargo-xwin" : ""}）`, pkg: ["@tauri-apps/cli", "tauri.js"], args };
}

/** `--` 之后的参数只贴给打包器那一步，不污染准备步骤。 */
function withPassthrough(steps, passthrough) {
  if (!passthrough.length) {
    return steps;
  }
  const last = steps[steps.length - 1];
  return [...steps.slice(0, -1), { ...last, args: [...last.args, ...passthrough] }];
}