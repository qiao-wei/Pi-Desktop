---
title: "Pi Desktop 边界协议"
type: doc
status: approved
owner: "@qiaowei"
created: 2026-10-22
updated: 2026-10-22
code_refs:
  - src/shared/protocol/version.ts
  - src/shared/protocol/hostCommands.ts
  - src/shared/protocol/bridgeEndpoints.ts
  - src/lib/bridge/transport.ts
  - src/lib/shell/host.ts
  - server/piKernel.mjs
  - server/sqlite.mjs
tags: [architecture, protocol, boundaries]
summary: "Pi Desktop 七条边界（bridge / shell / kernel-adapter / sqlite storage / perf / local-store / locale）的契约、版本策略与换实现步骤，以及每条边界的可替换性证据。"
reviewers: ["@qiaowei"]
---

# 边界协议

每一处"里外不通"的地方都有一个协议对象：契约文件（形状）、版本源（什么时候变）、
一致性测试（谁来钉）、以及**换掉一侧时需要动什么**。没有"约定俗成"，因为约定会在第三次改动时失效。

<!-- architecture:begin protocols -->
<!-- architecture:end protocols -->

## 1. bridge：渲染进程 ↔ 桥

**契约**：`src/shared/protocol/bridgeEndpoints.ts`（人读的核心）+ 冻结表面
`architecture/generated/bridge-surface.json`（机器读的全量，双向校验）

**版本**：`src/shared/protocol/version.ts` 的 `PROTOCOL_VERSION`，与桥侧的
`server/protocolVersion.mjs` 必须相等（`protocol-version` 规则）。
不兼容改动才 bump；加字段不 bump。

**为什么需要版本号**：核心里那句注释是实情——桥是打进包里的，但 dev 的渲染进程可以被指到
**别人的桥**上（上一次构建残留的、或没跑 `bridge:sync` 的）。在此之前 HTTP 表面不声明自己
是哪个修订版，于是"字段没了"到前端就是 `undefined`，UI 静默降级而不是报错。

**握手路径**：`GET /api/protocol`（最便宜的一条，不构建快照）；
bootstrap 与 ambient 响应也各自带 `protocolVersion`，`fetchBootstrap`/`fetchAmbientBootstrap`
会 `assertProtocolVersion()` —— 不一致直接抛，走既有错误横幅。分类函数是纯函数
`checkProtocolCompatibility()`：`missing` / `older` / `newer` / `ok`，**newer 也不算兼容**
（渲染进程只认识自己构建时的形状，"大概还能用"正是把协议变更变成静默错渲染的那个假设）。

**换实现（可替换性）**：全部走 `BridgeTransport`（`src/lib/bridge/transport.ts`）：

```ts
interface BridgeTransport {
  apiBase: string;
  request<T>(path, init?): Promise<T | null>;   // 304 → null，其余非 ok 抛错
  lastEtag(path): string | undefined;           // 条件请求的 tag
  stream<T>(path, body, onEvent, opts?): Promise<void>;  // NDJSON 逐行
  fireAndForget(path, body): void;              // 遥测，永不抛
}
```

- 换 mock / 换 WebSocket / 换别的宿主协议：`setBridgeTransport(...)`，上层零改动。
- 边界之上的代码（features / components / app）**不认识 HTTP**：它们只用 `fetchJson`、
  `postJson`、`streamNdjson`、`fetchBootstrap` 这些薄封装。
- 换掉之后要重新钉的东西：`tests/bridgeTransport.test.ts`（协议语义）与
  `tests/bridgeProtocol.test.ts`（版本与表面）。

## 2. shell：渲染进程 ↔ 窗口宿主

**契约**：`src/shared/protocol/hostCommands.ts`（命令 id + 参数 + 返回 + 用途）

**镜像**：`src-electron/preload.js` 的白名单是 `.js` 且被注入（不走打包），无法 import
这个 TS 模块，所以两边靠 `tests/architecture.test.ts` 解析比对：preload 白名单 == 声明 ==
`invoke()` 调用点。

**为什么值得单独立一份**：同一份 `dist/` 要跑在 Tauri 与 Electron 两个壳上，靠的是
"渲染进程只说 `invoke(command, args)`（Tauri 的形状），Electron 的 preload 用 `ipcRenderer`
实现它"。这个技巧只有在调用点**不能自己编命令名**时才是安全的——之前命令名散在
preload 白名单、`host-commands.js` 处理器、渲染进程调用点三处，没有任何东西比对它们。

**换实现**：调用点只认 `src/lib/shell/host.ts` 的 `invokeHost(id, args?)` / `invokeHostQuietly()`，
参数类型来自协议。加第三个宿主 = 实现这 9 个 id 的 ipc 面 + 调用 `invokeHost`，组件不动。

## 3. kernel-adapter：桥 ↔ pi 内核

**契约**：`server/piKernel.mjs` —— 桥对 `@earendil-works/*` 的**唯一**引用点
（`kernel-boundary` 规则：`server/` 里其它文件直接 import 就该失败）。

**为什么**：其中两个入口（`resolveProjectTrusted`、`hasTrustRequiringProjectResources`）
不在内核的公共 `exports` 里，只能按相对路径进 `dist/`。这种耦合在版本升级时会静默失效，
所以把它锁进一个名字就说明了性质的文件：坏了就在启动那一刻坏，错误面就是这份 re-export 清单。

**换实现 / 升级**：bump 内核版本 → 只改这一个文件；`tests/kernelAdapter.test.ts` 逐项核实
每个 re-export 仍然存在（不要用"它在 docs 里出现过"当证据）。

## 4. storage：桥 ↔ SQLite

**契约**：`server/sqlite.mjs` —— 唯一出现 `node:sqlite` 的地方，并在这里补齐调用方需要的
两个便利方法（`query`、`transaction`，含嵌套 SAVEPOINT）。一致性测试：`tests/bridgeSqlite.test.ts`。

**换实现**：换驱动（或换成别的存储）只改这个文件；调用方只认识它交出去的 API 形状。

## 5. perf：渲染进程 ↔ 性能探针

**契约**：`src/shared/protocol/perf.ts`（`PerfPort { enabled, mark }`）

**为什么它原来不算协议**：探针是 `globalThis.__piDesktopPerf` 上的一个隐式约定——声明在
`src/vite-env.d.ts`，实现细节写在 `src/lib/bridge/transport.ts` 里，没有装配点也没有测试。它之所以
是全局，只因 `perf.ts` 已经 import 了 `api.ts`（`reportDiagnostic`），反向 import 会成环。

**换实现**：插槽在 `src/lib/perf-port.ts`（只依赖协议类型，所以两侧都能 import，环没了），
`setPerfPort(probe)` 换实现；生产实现的装配在 `src/lib/perf.ts`。`tests/perfPort.test.ts` 装假探针并
用 stub 的 `fetch` 驱动**真实 HTTP transport** 的 `/api/bootstrap`，断言 mark 落在假探针上。

## 6. local-store：渲染进程 ↔ 本地存储

**契约**：`src/shared/protocol/storage.ts`（`KeyValueStorePort` + `STORAGE_SCHEMA_VERSION` + `STORAGE_MIGRATIONS`）

**为什么需要**：`localStorage` 曾在 5 个模块里被直接调用（UI 偏好、会话快照、性能开关、诊断开关、
StrictMode 开关），key 里那个 `v1` 从来没被校验过 → 老版本读到新版本的存档时，不认识的字段被
`...defaults` 静默丢掉。现在有两个机制：端口（唯一实现 `src/lib/storage.ts`，规则 `no-bypass` 强制）
与**前向兼容闸**（存档版本比本版本新 → 拒绝读取 + 启动警告，而不是半读）。

**换实现**：`setStoragePort(port)`；启动时 `installStoragePort()` 校验/迁移 schema。迁移表当前为空
（没有破坏性变更），逐级迁移与「缺一级就抛」由 `tests/storagePort.test.ts` 用合成迁移证明。

## 7. locale：渲染进程 ↔ 语言偏好

**契约**：`src/types/protocols.ts`（`LocalePreferencePort`）——注意它**不在** protocol 层：i18n 是
foundation，向上 import protocol 会被 `layer-direction` 判红，所以契约放在更低的 contracts 层。

**换实现**：实现 `LocalePreferencePort` 并用 `installLocalePreferencePort()` 接上；插槽是
`src/i18n/index.ts` 的 `configureLocalePreference()`（传 `undefined` 即卸下）。测试用假实现驱动 i18n
真实的读写路径。

## 8. 版本策略总览

<!-- architecture:begin seams -->
<!-- architecture:end seams -->

## 9. 版本表

| 边界 | 版本载体 | 不兼容时怎么被发现 |
| --- | --- | --- |
| bridge | `PROTOCOL_VERSION`（两侧字面量） | 启动握手 + `protocol-version` 规则 + `tests/bridgeProtocol.test.ts` |
| shell | 命令 id 集合（形状即契约） | `shell-commands` 规则（三方比对） |
| kernel-adapter | re-export 清单 + arity | `upstream-admission` 准入闸 + `tests/kernelAdapter.test.ts` |
| storage | `openSqliteDatabase` 返回形状 | `tests/bridgeSqlite.test.ts`（**未证明可替换**，缺注入点，见下表） |
| perf | `PerfPort` 形状 | `protocol-seam` 规则 + `tests/perfPort.test.ts` |
| local-store | `STORAGE_SCHEMA_VERSION` + 迁移表 | `protocol-seam` + 前向兼容闸 + `tests/storagePort.test.ts` |
| locale | `LocalePreferencePort` 形状 | `protocol-seam` + `tests/localePort.test.ts` |

**可替换性的判定标准**（本项目从此按这个判）：一处边界只有满足 **假实现 + 一个装配点 + 调用点零改动
+ 一条绿测试** 才算有协议；只声明 `interface` 不算。下表由 `src/shared/protocol/seams.ts` 生成，规则
`protocol-seam` 逐条校验（文件存在、`install` 是导出、swap 测试真的调用它、装配点真的装配）。

**一条经验**：能被机械校验的版本才叫版本，写在文档里的叫愿望。