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

const base = require("./electron-builder.json");

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

const systemRuntimes = (process.env.PI_DESKTOP_RUNTIME_MODE ?? "").trim().toLowerCase() === "system";

module.exports = systemRuntimes ? slim(base) : base;