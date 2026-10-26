/**
 * The seam registry: every boundary, with the four files that make it a *swap* rather than a
 * comment.
 *
 * A protocol is only real if an implementation can be replaced **without touching call sites**, and
 * the only way to know that is true is for a test to install a fake through the same door production
 * uses. So each entry names:
 *
 * - `contract` - where the interface lives (the protocol layer, pure types);
 * - `production` - the real implementation;
 * - `assemblyPoint` - the file that installs it (there must be exactly one);
 * - `install` - the function called at that assembly point;
 * - `swapTest` - the test that installs a fake through that function and drives **real call sites**
 *   through it.
 *
 * `scripts/architecture/check.mjs` verifies all five exist, that `install` is actually called at the
 * assembly point, and that the swap test really mentions it - so "we have a protocol" cannot be
 * claimed without a test that proves it. `docs/architecture/protocols.md` renders this table from
 * here (region `seams`), which keeps the document and the code from drifting apart.
 */

export interface ProtocolSeam {
  /** Boundary id, matching `docs/architecture/protocols.md`. */
  readonly id: string;
  /** One line: what crosses this boundary. */
  readonly crosses: string;
  readonly contract: string;
  readonly production: string;
  /**
   * Where the installed implementation is held: the module that owns the mutable slot and exports
   * the `install` function. Usually the production module; `perf` is split in two on purpose (the
   * implementation lives in `perf.ts` but the slot has to live apart from it to avoid a module cycle).
   */
  readonly portModule: string;
  /** Where production assembles it. When it differs from `portModule`, it must call `install(`. */
  readonly assemblyPoint: string;
  /** The setter/installer function name; must be an exported binding of `portModule`. */
  readonly install: string;
  readonly swapTest: string;
  /** What the swap buys us - the reason this is a protocol and not a module. */
  readonly why: string;
}

export const PROTOCOL_SEAMS: readonly ProtocolSeam[] = [
  {
    id: "bridge",
    crosses: "HTTP + NDJSON between renderer and bridge",
    contract: "src/shared/protocol/bridgeEndpoints.ts",
    production: "src/lib/bridge/transport.ts",
    portModule: "src/lib/bridge/transport.ts",
    assemblyPoint: "src/lib/api.ts",
    install: "setBridgeTransport",
    swapTest: "tests/bridgeTransport.test.ts",
    why: "两个运行时之间的唯一通道；换实现（MessagePort / in-process）不该动任何一个调用点",
  },
  {
    id: "shell",
    crosses: "host commands (window chrome, pickers, notifications)",
    contract: "src/shared/protocol/hostCommands.ts",
    production: "src/lib/shell/host.ts",
    portModule: "src/lib/shell/host.ts",
    assemblyPoint: "src/lib/shell/host.ts",
    install: "setHostShell",
    swapTest: "tests/hostShell.test.ts",
    why: "同一份 renderer 跑在 Tauri 与 Electron 上；再加第三个宿主是换实现，不是改组件",
  },
  {
    id: "local-store",
    crosses: "persisted UI state (preferences, snapshot, dev switches)",
    contract: "src/shared/protocol/storage.ts",
    production: "src/lib/storage.ts",
    portModule: "src/lib/storage.ts",
    assemblyPoint: "src/main.tsx",
    install: "installStoragePort",
    swapTest: "tests/storagePort.test.ts",
    why: "唯一碰 localStorage 的地方；换宿主存储、或在无 DOM 环境测试，都只换这一处",
  },
  {
    id: "perf",
    crosses: "perf marks from the request path",
    contract: "src/shared/protocol/perf.ts",
    production: "src/lib/perf.ts",
    portModule: "src/lib/perf-port.ts",
    assemblyPoint: "src/lib/perf.ts",
    install: "setPerfPort",
    swapTest: "tests/perfPort.test.ts",
    why: "原本是 globalThis 上的隐式协议；转正后测试可以断言请求路径量了什么，而不是断言全局存在",
  },
  {
    id: "locale",
    crosses: "the saved UI language (read at startup, written from settings)",
    contract: "src/types/protocols.ts",
    production: "src/lib/localePreferences.ts",
    portModule: "src/lib/localePreferences.ts",
    assemblyPoint: "src/main.tsx",
    install: "installLocalePreferencePort",
    swapTest: "tests/localePort.test.ts",
    why: "i18n 是 foundation 层，不许自己读存储（曾经是全仓唯一的层反向依赖）；契约因此放在 contracts 层，插槽在 src/i18n/index.ts 的 configureLocalePreference()",
  },
  {
    id: "kernel-adapter",
    crosses: "the pi kernel (coding agent) as the bridge uses it",
    contract: "server/piKernel.mjs",
    production: "server/piKernel.mjs",
    portModule: "server/piKernel.mjs",
    assemblyPoint: "server/piKernel.mjs",
    install: "createKernelAdapter",
    swapTest: "tests/kernelAdapter.test.ts",
    why: "内核升级只该撞在这一个文件上；含两个非公共深引，签名漂移必须在这里被抓住",
  },
];

/** Ids in the same order as the document table; used by the docs generator and the checker. */
export const PROTOCOL_SEAM_IDS = PROTOCOL_SEAMS.map((seam) => seam.id);