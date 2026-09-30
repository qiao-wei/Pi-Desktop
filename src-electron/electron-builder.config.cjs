"use strict";

// Packaging config for both runtime modes, out of one source of truth.
//
//   electron-builder --config src-electron/electron-builder.config.cjs                       # bundled（现状）
//   PI_DESKTOP_RUNTIME_MODE=system electron-builder --config src-electron/electron-builder.config.cjs   # 精简
//
// The mode is NOT baked into the artifact: `src-electron/paths.js` infers it from whether the
// runtime directories made it into the bundle, so this file only decides what gets copied.
// Keeping the entry list in `electron-builder.json` (and stripping from it) means a new resource
// cannot be added to one mode and forgotten in the other.
//
// The macOS signing tier is likewise resolved in one place (`scripts/lib/macSigning.cjs`) and only
// carried over here — 以前这块是"钥匙串里恰好有什么证书"决定的，产物会静默变成另一个档位。
// 为什么这个 wrapper 是 CJS：electron-builder 只支持同步加载配置，所以档位表也必须是 CJS。

const base = require("./electron-builder.json");
const { resolveMacSigning } = require("../scripts/lib/macSigning.cjs");

/** Resource subtrees that only exist in the bundled mode. */
const SHIPPED_RUNTIMES = new Set(["python-runtime", "node-runtime"]);

function withoutShippedRuntimes(entries) {
  return (entries ?? []).filter((entry) => !SHIPPED_RUNTIMES.has(entry.to));
}

function slim(config) {
  return {
    ...config,
    extraResources: withoutShippedRuntimes(config.extraResources),
    mac: { ...config.mac, extraResources: withoutShippedRuntimes(config.mac?.extraResources) },
    win: { ...config.win, extraResources: withoutShippedRuntimes(config.win?.extraResources) },
  };
}

/**
 * 签名档位 → mac 段。`undefined` 一律不写键：release 的时间戳默认就是开的、公证默认按 env 自动
 * 判定，写成 `undefined` 是"用默认值"，不是"关掉"（osx-sign 那边只要没给值就补一个裸
 * `--timestamp`）。
 *
 * `electronLanguages` 只写在 mac 段：白名单是对 mac 的 `.lproj` 目录名逐字校过的（220 个伪本地化
 * 删到 3 个，每个剩下的都要被单独签名并联网取时间戳）；Windows 的 `locales/*.pak` 用另一套命名，
 * 那边要先在 Windows 上出一次包验证过再打开（理由见 scripts/lib/macSigning.cjs）。
 */
function withMacSigning(config) {
  const signing = resolveMacSigning(process.env);
  return {
    ...config,
    mac: {
      ...config.mac,
      identity: signing.identity,
      hardenedRuntime: signing.hardenedRuntime,
      electronLanguages: signing.electronLanguages,
      ...(signing.timestamp === undefined ? {} : { timestamp: signing.timestamp }),
      ...(signing.notarize === undefined ? {} : { notarize: signing.notarize }),
    },
  };
}

const systemRuntimes = (process.env.PI_DESKTOP_RUNTIME_MODE ?? "").trim().toLowerCase() === "system";

const configured = withMacSigning(base);

module.exports = systemRuntimes ? slim(configured) : configured;