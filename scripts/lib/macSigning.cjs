"use strict";

// macOS 签名档位 —— 这块只有一个决定点。
//
// 为什么要有"档位"：以前「签不签 / 用哪张证书 / 要不要时间戳 / 要不要公证」四件事全由环境隐式决定。
// 2026-09-30 实测的因果链：钥匙串里恰好有一张自签证书（`Pi Desktop Local`）→ electron-builder
// 先找 `Developer ID Application` 没找到 → 走 macCodeSign.js 里那条"非 Apple 证书"兜底分支 →
// 于是 240 个 Electron 文件（含 220 个伪本地化 locale.pak）+ 我们自己 74 个二进制**逐个**真签名，
// 每个都带 `--timestamp`，每个都要联网问一次 Apple 的时间戳服务器（实测 0.76s，不带则 0.05s）
// ≈ 4 分钟。没人声明过档位，也就没人能说清一个产物到底是什么签名。
//
// 为什么是 .cjs：electron-builder 的配置（src-electron/electron-builder.config.cjs）是 CJS，
// 必须**同步** require 到同一份表；packPlan.mjs 与测试是 ESM，import 一个 CJS 是原生支持的。
// 两边各写一份表就等于没有决定点 —— 档位必须只有一份。
//
// 档位只有两个。中间的"自签证书"档被明确砍掉：它对本机不如 ad-hoc（慢 15 倍、要联网、还依赖
// 钥匙串里恰好有什么），对别人又没用（自签不可能通过公证，Gatekeeper 照样拦）。
//   local   ad-hoc 签名，不取时间戳、不公证；本机自用 / 开发验收（默认，不需要任何 env）
//   release Developer ID 真签名 + 时间戳 + 公证；对外分发
//
// 档位从命令行来（`npm run pack:electron:mac:arm64 -- --sign release`），由 scripts/pack.mjs
// 下发成 PI_DESKTOP_SIGN；这里读 env 是给"绕过 pack 直接跑 electron-builder"留的口子，默认 local。

/** 合法档位。报错文案与校验都从这里取，不允许在别的文件里再列一遍。 */
const SIGN_TIERS = ["local", "release"];

/**
 * electron-builder 的本地化白名单：`locale.pak` 这类资源不进 asar，会被逐个签名（见文件头），
 * 220 个伪本地化（`_FEMININE` / `_MASCULINE` / `_NEUTER`）纯属白跑。应用自己的文案只有 en/zh
 * （src/i18n），Chromium 内置界面缺哪个语言就回退 en（`en.lproj` 必须留着）。
 *
 * 只对 **mac** 生效（写进 `mac.electronLanguages`），因为这是唯一验证过的平台：mac 的白名单就是
 * 对这些目录名逐字匹配的（`zh_CN.lproj` 保住了，`zh_CN_FEMININE.lproj` / `en_GB.lproj` 删掉）。
 * Windows 的 `locales/*.pak` 用连字符（`en-US.pak` / `zh-CN.pak`），要在那边也打开裁剪的话，白名单
 * 得加上连字符写法 —— 但一旦白名单全落空，Chromium 会因为没有 fallback pak 而直接 CHECK 失败，
 * 所以那边必须先在 Windows 上出一次包确认（`en-US` 那种 fallback 一定要留）。
 */
const ELECTRON_LANGUAGES = ["en", "zh_CN", "zh_TW"];

/**
 * release 档的默认证书限定词。用"类型"当限定词有两个作用：
 *  1. electron-builder 是拿它去**子串匹配** `security find-identity -v -p codesigning` 的输出行，
 *     而 Developer ID 证书的行长这样：`"Developer ID Application: Foo (TEAMID)"`；
 *  2. macCodeSign.js 的"非 Apple 证书"兜底分支同样要先过限定词，所以限定词一给，那张自签证书
 *     就再也选不上了 —— 这正是我们要堵的洞（不给限定词时它会静默顶上）。
 * 注意不能带冒号：macCodeSign.js 的 checkPrefix 会拒绝以 Apple 前缀开头的名字。
 */
const DEFAULT_RELEASE_IDENTITY = "Developer ID Application";

/**
 * 档位 → 实际传给 electron-builder 的 mac 配置。`undefined` 表示"不写这个键，用 electron-builder
 * 自己的默认值"，不是"关掉"：release 的时间戳默认就是开的，公证默认就按 env 自动判定。
 */
const TIER_SPECS = {
  local: {
    identity: "-",
    // ad-hoc 签名下 codesign 本来就不取时间戳（实测 0.017s、签名里没有 Timestamp 字段）；
    // 显式写出来是为了让"本地档从不联网"这件事在配置里看得见，而不是靠"反正会被忽略"。
    timestamp: "none",
    // ad-hoc + hardened runtime 会启用 library validation，拒绝 Team ID 不同的预签名 Electron
    // framework（electron-builder 的 schema 就是这么写的，官方给的解法就是关掉它或加
    // disable-library-validation）。本地档要的是"一定起得来、通知一定送得到"，所以按官方解法关掉；
    // release 档单独开、单独验。
    hardenedRuntime: false,
    notarize: false,
    label: "local（ad-hoc 签名，不取时间戳、不公证）",
  },
  release: {
    identity: DEFAULT_RELEASE_IDENTITY,
    timestamp: undefined,
    hardenedRuntime: true,
    notarize: undefined,
    label: "release（Developer ID 真签名 + 时间戳 + 公证）",
  },
};

/**
 * 公证凭证的两条路。两种外壳的变量名不完全一样（electron-builder 认
 * `APPLE_APP_SPECIFIC_PASSWORD`，Tauri 认 `APPLE_PASSWORD`），这里按"任一种齐备即算有"。
 * API key 那条要求三个都在，是 electron-builder 的硬要求（只给一部分它会直接抛错）。
 */
const CREDENTIAL_MODES = [
  { mode: "apple-id", required: [["APPLE_ID"], ["APPLE_APP_SPECIFIC_PASSWORD", "APPLE_PASSWORD"], ["APPLE_TEAM_ID"]] },
  { mode: "api-key", required: [["APPLE_API_KEY"], ["APPLE_API_KEY_ID"], ["APPLE_API_ISSUER"]] },
];

const readEnv = (env, name) => String(env?.[name] ?? "").trim();

/**
 * 解析档位。空 = local（不给参数就能出包，这是最常见的一条路）；
 * 给了但拼错则直接抛错 —— 静默退回 local 会让人拿着"以为签了"的包去分发。
 */
function resolveSignTier(env = process.env) {
  const raw = readEnv(env, "PI_DESKTOP_SIGN").toLowerCase();
  if (raw === "") {
    return "local";
  }
  if (!SIGN_TIERS.includes(raw)) {
    throw new Error(`PI_DESKTOP_SIGN=${raw} 不是有效档位，只能是 ${SIGN_TIERS.join(" / ")}`);
  }
  return raw;
}

/** 本单会怎么签 —— 打包配置、出包日志、文档三处都念这一份。 */
function resolveMacSigning(env = process.env) {
  const tier = resolveSignTier(env);
  const spec = TIER_SPECS[tier];
  const customIdentity = readEnv(env, "PI_DESKTOP_SIGN_IDENTITY");
  return {
    tier,
    label: spec.label,
    // 只有 release 允许换证书名；local 永远是 "-"，否则"本地档"又会变成"看钥匙串有什么"。
    identity: tier === "release" && customIdentity !== "" ? customIdentity : spec.identity,
    timestamp: spec.timestamp,
    hardenedRuntime: spec.hardenedRuntime,
    notarize: spec.notarize,
    electronLanguages: [...ELECTRON_LANGUAGES],
  };
}

/**
 * 公证凭证齐不齐。release 档缺凭证时，electron-builder 只会 `log.warn("skipped macOS
 * notarization")` 然后照常出包 —— 得到一个"签了但没公证"的包（codesign 检查全过、Gatekeeper
 * 照样拦），最容易当成成功。所以缺凭证必须在出包**之前**报错，这个判断就是那个门。
 */
function notarizationCredentials(env = process.env) {
  const states = CREDENTIAL_MODES.map(({ mode, required }) => {
    const missing = required.filter((names) => !names.some((name) => readEnv(env, name) !== "")).map((names) => names[0]);
    return { mode, missing };
  });
  const complete = states.find((state) => state.missing.length === 0);
  if (complete) {
    return { ready: true, mode: complete.mode, missing: [] };
  }
  // 两套都没齐：挑缺得最少的那套报，避免两套变量各报一半、让人看不出该补哪一套。
  const best = states.reduce((a, b) => (a.missing.length <= b.missing.length ? a : b));
  return { ready: false, mode: null, missing: best.missing, tried: best.mode };
}

/** 出包日志/notes 用的一行话（`--dry-run` 里要能一眼看出这单会怎么签）。 */
function describeMacSigning(env = process.env) {
  const signing = resolveMacSigning(env);
  if (signing.tier === "release") {
    const credentials = notarizationCredentials(env);
    const credentialText =
      credentials.ready
        ? `凭证 OK（${credentials.mode}）`
        : `缺凭证：${credentials.missing.join(" / ")}`;
    return `${signing.label}：证书限定词 ${signing.identity}；${credentialText}。公证要上传 Apple 排队，几分钟起步。`;
  }
  return `${signing.label}：本机可用（含系统通知）；要分发请走 --sign release。`;
}

module.exports = {
  DEFAULT_RELEASE_IDENTITY,
  ELECTRON_LANGUAGES,
  SIGN_TIERS,
  describeMacSigning,
  notarizationCredentials,
  resolveMacSigning,
  resolveSignTier,
};