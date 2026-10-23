---
title: "架构硬化实施计划（含协议工作项与 ZCode 对照）"
type: doc
status: draft
owner: "@qiaowei"
created: 2026-10-22
updated: 2026-10-22
code_refs:
  - architecture/policy.json
  - scripts/architecture/check.mjs
  - tsconfig.json
  - server/index.mjs
  - src/app/App.tsx
  - src/shared/protocol/index.ts
  - src/lib/bridge/transport.ts
tags: [architecture, plan, tech-debt, protocol]
summary: "7 组工作项（A 类型与边界 / B 拆大文件 / C 协议可替换性 / D 报文与内核 / E 门禁工具 / F e2e / G 文档），每项带可执行验收命令；附与 ZCode 的逐维度对照与「计划完成后是否更好」的判定。"
---

# 架构硬化实施计划

## 0. 「完成」的判定规则（防止做一点就宣称做完）

1. 一项只有在**验收命令真跑通、关键输出贴回本文件**之后才允许标 ✅。
2. 动运行时代码的项，必须同时贴 `npm test` 汇总行（tests / pass / fail / skipped）。
3. 存量债务只能**棘轮**（只降不升）计入，禁止永久白名单；例外必须带 `deadline`。
4. 每项完成往 `.wiki/log.md` 追加 `## [YYYY-MM-DD] step | <标题>`。
5. 顺序不可跳：A 组的类型保护先行，因为它会让 B/C/D 的改动在编译期暴露错误。

## 1. 基线（2026-10-22 实测，全部可复现）

| 指标 | PiDesktop | ZCode | 命令 |
| --- | --- | --- | --- |
| 生产代码 | 192 文件 / 62,818 行 | 5,490 文件 / 1,084,736 行 | `find`+`wc -l` |
| 测试代码 | 160 文件 / 35,131 行（比 0.56） | 3,656 个 `.test.ts`（其中 e2e 567） | 同上 |
| `npm test` 耗时 / 结果 | 25.6s；2000 项 / 1999 过 / 1 skip（skip = 文档未落盘） | vitest（未计时） | `time npm test` |
| node 侧类型保护 | **无**（`include:["src"]`，`allowJs:false`）；`server/` 开 checkJs = **128 条**诊断 / tsc 1.7s | 52 份 tsconfig，逐进程边界，全 TS | 见 A1 |
| `src-electron/*.js` | 394 行，无类型检查 | 同 ZCode 的 preload/main 边界 | 见 A1 |
| lint / format | **零配置** | `.oxlintrc.json`（`max-lines: error` 800） | `ls -a \| grep oxlint` |
| 测试门禁 | 打包工作流勾选框（`run_tests: default true`，可取消） | husky `prepare`（`.github/` 不存在于快照） | `package-electron.yml:70` |
| 协议可替换性 | 声明 4 条边界；**只有 bridge 被测试换过实现**（`FakeTransport`）；shell/kernel 无注入点；`PerfProbe` 是隐式协议 | `packages/rpc/` 12+ 文件：`IMessagePassingProtocol`、ACK/replay 的 `persistent-protocol`、`channels.shared`、proxy-channel；多传输（MessagePort / connection） | `tests/bridgeTransport.test.ts` |
| 协议真源 | 96 条路由双向冻结 + 版本握手 | policy.yaml 声明模块/路由；channel 名与路由未做交叉校验 | `npm run architecture:check` |
| 报文形状 | 单边声明（`BootstrapResponse` 在 `src/lib/api.ts`） | 共享 TS 类型（同进程可共享） | 见 D1 |
| 债务政策 | 棘轮 + `deadline` + 只降不升（16 条） | 永久 warn 白名单 + 上游准入闸 + 1.8MB 快照 | `policy.json` exceptions |
| 文档 | 1 篇坏文档（`docs/plan.md` 无 frontmatter）+ 3 篇草稿未落盘 | 21 篇架构 + 4 ADR + 89 篇测试文档 + `CONTEXT.md` 词表 | `project_wiki format=index` |
| 改动影响分析 | 无（`npm test` 25.6s，全跑可接受） | `dep:graph` / `dep:refs` / `run-affected-unit-tests` | — |
| 直连绕过 | `fetch(` 1 处（`assistant-ui/elements/image.tsx` 取图片 blob，非桥）；`localStorage` **20 处** | 服务访问统一走 hooks（`useWorkspaceServices`） | `grep -rn` |

## 2. 工作项

### A 组 — 类型与进程边界

**A1 `node` 侧类型保护（最高优先）** ✅
- 做什么：新建 `tsconfig.node.json`（`allowJs + checkJs + noEmit + allowImportingTsExtensions`）覆盖 `server/**/*.mjs` + `src-electron/*.js` + `scripts/**/*.mjs`；诊断按 **文件 + 错误码** 记进 `architecture/generated/node-typecheck-baseline.json`；checker 加规则 `node-typecheck`（任何一项超基线即红，低于基线提示 `--write` 收紧）；加 `npm run typecheck:node` 并纳入 `npm test`。
  - `allowImportingTsExtensions` 是必须项：`server/index.mjs` 直接 import `../src/shared/*.ts`（Node 类型擦除要求扩展名），不开会报 9 条 TS5097 假错。
- 验收：`npm run typecheck:node` 退出码 0 且计数 = 基线；在 `server/` 写 `const x=123; x.nope();` 必须红。
- 不达标长什么样：只在 CI 跑一次、或把诊断塞进 ignore 列表而不计数。

**A2 诊断清零（棘轮 → 0）** ✅ **0 条（2026-10-23 完成，基线文件已被自动删除）**
- 终局：150 → 128 → **82**（打开 `strictNullChecks: true` 后的真实数）→ … → **0**。`npm run typecheck:node` 退出码 **0**；`npm run architecture:write` 删掉了 `architecture/generated/node-typecheck-baseline.json`；规则 `node-typecheck` 现在的要求是「没有基线 = 必须保持 0 条」，任何新诊断当场红。
- 最后清零的都在这几个文件：`server/index.mjs`（42 条）、`customModels.mjs`、`gitWorktree.mjs`、`mcpConfig.mjs`、`mcpImport.mjs`、`modelListing.mjs`、`modelLogin.mjs`、`openDiff.mjs`、`runProjectCommand.mjs`、`src-electron/main.js`、`src-electron/sidecar.js`。
- 反复用到的写法（写进 `MEMORY.md` 了）：加宽**过窄的 JSDoc**而不是 `@ts-ignore`；`Boolean(x)` 不做类型收窄（用 `x ? … : false`）；`.mjs` 里的解构参数要写 `@param {{…}} [opts] = {}`，否则推断退化；注入的实现写成 `typeof import("node:child_process").execFile`；返回值形状用**判别联合**（`runProjectCommand` 现在返回 `{launcher:"background",logPath,pid,command,cwd} | {launcher:string,scriptPath,logPath?:undefined,pid?:undefined}`）。
- **本轮自己制造的一类 bug（已修并回顾）**：两个相邻 JSDoc 块时 TS 只认**最后一块**，前一块的 `@param` 被静默丢弃 —— 一个批量合并脚本按「首块无标签才合并」的规则跑过，剩下 8 个文件出现残缺的 `** @param` 产物，已逐个修回。
- 顺带抓到的真实 bug：`server/modelListing.mjs` 里一次编辑把 `plan = listingPlan(api, baseUrl, apiKey);` 整行删掉了（被测试抓出）；`requestModelListing` 的失败支改成判别联合（`ok: false, error: string`）后，调用方不必再写 `?? ""` 兜底，`providerDiscoveryWiring` 里那条断言也回到了最直白的 `warning = listing.error;`。
- 之前的检查器自身漏洞、口径修正记录保留在下面（都是真发生过的）。
- 现状分解（**已从 150 降到 34**，按错误码：TS2339 13 / TS2345 10 / TS2322 5 / TS2353 5 / TS2769 1；分布：`server/index.mjs` 25、`server/openDiff.mjs` 5、其余 4 个文件各 1）。
- 已清零的文件：`server/conflictPrompt.mjs`(20)、`customModels.mjs`(16)、`mcpImport.mjs`(11)、`runProjectCommand.mjs`(8)、`capabilitySkillSelection.mjs`、`agentShimFiles.mjs`、`gitInfo.mjs`、`gitWorktree.mjs`、`modelLogin.mjs`、`commitMessage.mjs`、`sessionWorkspace.mjs`、`projectCommandRuns.mjs`、`openDiff.mjs`(部分)、`agentEnv.mjs`、以及 **`scripts/` 全部 19 条**与 **`src-electron/` 全部 4 条**。
- 方法（两次踩坑后固定下来的）：**先读函数体再写 JSDoc**。凭印象猜 `@param` 形状会制造新错误（踩过两次）；把过松/写错的 JSDoc 换成真实形状（`NodeJS.Platform`、`typeof readFileSync`、`typeof process.kill`、联合类型）才有效。
- 过程中发现并修掉的**真实不一致**（不是纯类型问题）：`scripts/lib/packPlan.mjs` 的 steps 混用 `{pkg}` / `{bin}` 两种形状（消费方 `scripts/pack.mjs:28` 用 `step.pkg ? … : step.bin`）；`scripts/lib/bridgeRuntime.mjs` 的 `versions` 里多塞了一个 `__appVersion`（它不是依赖）。
- 做什么：按错误码分批清零（TS2353 → TS2339 → 其余），每批跑 `--write` 收紧基线；`deadline: 2027-03-31`；清到 0 后**删除基线文件**（0 条不需要棘轮）。
- 验收：`npm run typecheck:node` 输出 `0 diagnostics`，且 `architecture/generated/node-typecheck-baseline.json` 不存在（规则在基线缺失时要求 0 条）。
- 为什么这项决定「比 ZCode 好」：ZCode 全 TS 天生为 0；我们是从 128 降到 0，且过程中不许涨 —— 结论持平，但我们的**下降过程可审计**。
- **检查器自身的漏洞（已修，2026-10-22）**：过滤只认 `NODE_TYPECHECK_ROOTS`（`server/`、`scripts/`、`src-electron/`），于是
  `tsc` 打印 **34** 条而基线只记 **33** 条 —— 被 `server/index.mjs` 间接 import 的 `src/shared/sessionTitle.ts:360`（TS2322）
  谁都看不见。**门禁少算一条 = 能悄悄放过一条新错误。** 改成「repo 内、非 `.d.ts`、非 node_modules 的都算」，基线记 34；
  负例验证：往 `src/shared/sessionTitle.ts` 追加 `const __probe = 1; __probe.nope();` → `[node-typecheck] src/shared/sessionTitle.ts:394 TS2339 … (this file+code is already at its baseline of 0)`（roots 之外的文件现在会红）。测试 `tests/nodeTypecheck.test.ts` 加了一条「roots 之外的文件必须出现在诊断里」的守卫。
- **口径修正（诚实标注）**：A1 的计划验收写的是「`npm run typecheck:node` 退出码 0」。只有诊断清零后这才是对的 ——
  当前 `tsc -p tsconfig.node-runtime.json` 因为基底还有 34 条而退出码 2；**真正的门禁是规则 `node-typecheck`**（与基线比对，
  `npm run architecture:check` 里跑）。A2 到 0 时两件事自然合一（基线文件会被自动删除，规则要求 0 条）。

**A3 进程边界 tsconfig 收口** ✅
- 做什么：4 份 tsconfig 对应 4 个执行边界：`tsconfig.json`(renderer) / `tsconfig.node.json`(bridge+electron+scripts) / `tsconfig.node` 内的 `src-electron` 单独 include 段 / Rust 侧不适用（`src-tauri`）。每份在 `architecture/policy.json` 的 `processBoundaries` 里登记，checker 校验「每个进程目录都被某份 tsconfig 覆盖」。
- 验收：新增一个 `src-electron/whatever.js` 并写入类型错误 → `typecheck:node` 必须红。
- 对照：ZCode 52 份（多进程 + e2e + remote-main 需要）；我们 4 份覆盖同等边界，数量少是因为进程拓扑简单，非能力缺失。

### B 组 — 拆大文件

> **B 组执行记录（2026-10-23，真实数字，未达标的地方照写）**
>
> | 文件 | 起始 | 现在 | 状态 |
> | --- | --- | --- | --- |
> | `server/index.mjs` | 8,804（JSDoc 之后；原 8,711） | **7,929** | 🟡 未到 1,200 —— 落地了 9 个领域模块 + 两次叶子清扫 |
> | `src/app/App.tsx` | 9,189 | **3,365** | 🟡 未到 800 —— 落地 13 个 `src/app/*.tsx`，剩余主体是 `App()` 自身（约 3.2k 行，要拆必须做组件内分区/注入） |
>
> **`server/index.mjs` 这一轮怎么降的**：先补完 JSDoc 把文件推到 8,804（超过 ceiling 8,712），棘轮不允许抬上限，于是按「一簇一文件」往外搬。
> 1. 叶子清扫：`diagnosticsHelpers` / `skillHelpers` / `capabilityMetadata` / `httpHelpers` / `modelHelpers` / `attachmentHelpers` / `sessionHelpers` / `runtimeTrust`（8,804 → 8,108）；
> 2. 第二波：`conversationParts` / `packageHelpers` / `smallHelpers`（8,108 → 7,930）；
> 3. 边界（写进 `.scratch/movable.mjs`）：**共享可变状态不能跟着走**。`runtime` / `projects` / `activeProjectId` / `diagnosticWriting` 这些被闭包外引用时会拦下来 —— `runtime` 引用的模块必须留着；纯函数/常量搬出去由入口 import 回来是安全的（`const` 与函数可以走，`let`/`var` 不可以）。最大可搬簇一度只有 29 行，说明剩下的核心是**一个互相咬合的请求处理内核**，继续拆需要注入化改造（`RuntimeContext` 之类），不是机械搬运。
>
> **`src/app/App.tsx` 这一轮拆出的 13 块**：`TitleBarChrome`(274) / `SettingsDialogs`(512) / `ExtensionUiSurface`(425) / `UsagePopover`(219) / `Sidebar`(1,284) / `SidebarDialogs`(268) / `CapabilitySurfaces`(503) / `PanelResizeHandle`(38) / `CapabilitiesPage`(563) / `CapabilitiesMcp`(629) / `CapabilityDetail`(635) / `SlashMenu`(94) / `SkillImportSurfaces`(228) / `ComposerControls`(130) / `AttachmentHoverCard`(78)。
> 每块都**零改动调用点**（原文件 `import` 回来），逐块验证：`npx tsc -b` 干净 + `npm test` 全绿 + `architecture:check` 只剩 docs-regions。
>
> **没达标的两条，以及为什么**：`App.tsx` 剩 3,365 行、`Sidebar.tsx` 1,284 行，仍各带一条 `max-lines` 例外（ceiling 已冻结）。原因是 `App()` 与 `ProjectSidebar()` 分别是 3.2k / 1.0k 行的**单个组件函数**，要继续降必须在组件内部做分区（拆子组件 + 传状态），那是设计改动，不是搬文件。这一轮**没有**动它们 —— 记为未完成。

**B1 `server/index.mjs` 按路由域拆** 🟡（8,804 → **7,929**：9 个领域模块 + 叶子清扫；未到 1,200，原因是剩下的请求内核共享可变状态，需注入化）

> **已发生的一次拆分（2026-10-22）**：给 `server/customModels.mjs` 补 JSDoc 把文件推到 1431 行、超过 ceiling 1406，
> 按规则「拆，不要抬上限」拆出 **`server/modelListing.mjs`**（385 行：端点探测、报文解析、列表合并，以及随之搬走的
> `normalizeBaseUrl` / `prettifyModelId` / `toPositiveInt` / `MODEL_ID_PATTERN` / 两个默认值常量）。
> `customModels.mjs` 1431 → **1081 行**（仍高于目录上限 900，所以例外条目保留、ceiling 自动下调到 1082）；
> 依赖方向单向（`customModels → modelListing`，反向不 import，无环），既有调用方通过再导出零改动。
> 中途踩的坑：我一度为了凑行数把散文注释「重新折行」（把多行并成一行），那是**假账**（可读性变差、信息没多没少），
> 已回滚，改成「一行式 JSDoc + 真拆分」。
- 做什么：8,711 行 `if` 链 → `server/routes/<domain>.mjs` 导出 handler 表；`bridge-surface.json` 的 96 条路由是现成的验收器（漏挂立刻红）。
- 验收：`wc -l server/index.mjs` ≤ 1,200；`npm run architecture:check` 无 `protocol-surface` 违规；`npm test` pass ≥ 1999。
- 现状提醒：`server/index.mjs` 现在 8,711 行、ceiling 8,712 —— **加一行就得删一行**，这个压力是有意的（见 ADR-003）。

**B2 `App.tsx` 拆四块** 🟡（9,189 → **3,365**；拆出 15 块，设置弹层/侧栏/能力页/标题栏/扩展 UI/用量/输入框控件都各成一文件；**未到 800**，剩余主体是 `App()` 自身）
- 做什么：侧栏 / Git 面板 / 设置弹层 / composer 四块各自成 `src/features/*` 或 `src/components/*`；**一块一验**，不做一次性大搬迁。
- 验收：`wc -l src/app/App.tsx` ≤ 800（**未达成**，见上）；四块的测试文件存在且 `npm test` 全绿（✅ 已满足）。
- 配套：`tests/lib/appSource.ts`（`appSource()` / `appEntrySource()`）—— 拆分后，把「这段代码在 App 里」的结构性断言从钉死 `App.tsx` 改成读整个 `src/app/`；共 45 个测试文件按此调整，否则每次合法拆分都会假红。

**B3 棘轮同步收紧** 🟡（机械部分已全部落地并**真咬过**：`exceptions` 规则抓到 `src/app/CapabilitiesPage.tsx` 拆到 564 行后例外失效 → `architecture:write` 直接删除该条；`CapabilitiesMcp`/`CapabilityDetail`/`SidebarDialogs`/`ComposerControls` 等拆出来后就落在 700 以内，不需要新例外。**未达成**的验收条件：exceptions 里仍有 `server/index.mjs`（7,930）与 `src/app/App.tsx`（3,365）以及本轮新增的 `src/app/Sidebar.tsx`（1,284）。）
- 做什么：B1/B2 每完成一块跑 `architecture:write`（ceiling 自动下调），拆到限下后从 `policy.json` 的 exceptions 删除该条（规则会在条目失效时报错）。
- 验收：exceptions 里不再出现 `server/index.mjs` 与 `src/app/App.tsx`。

### C 组 — 协议与可替换性（核心：应答「每层都要有协议」）

**C1 接缝登记表 + 可校验规则** ✅
- 做了什么：`src/shared/protocol/seams.ts` 登记 6 条边界，每条 `{ id, crosses, contract, production, portModule, assemblyPoint, install, swapTest, why }`（`portModule` 是后加的：插槽可能和生产实现不在同一文件，perf 就是——`perf-port.ts` 持有插槽，`perf.ts` 是生产实现）。checker 两条新规则：
  - `protocol-seam`：五个文件都必须存在；`install` 必须是 `portModule` 的导出（真的有一扇门）；`swapTest` 必须**真的调用** `install(`（只声明接口不算）；装配点与插槽不同文件时必须真的装配；`registry ↔ policy.protocols` 双向一一对应（两处清单不许各自漂移）。
  - `no-bypass`：策略里 `bypassGuards` 声明 `{ id, regex, scope, allowed[{file,why}], why }`，先 strip 注释再扫。三条守卫：`localStorage`（只许 `src/lib/storage.ts`）、`fetch(`（只许 `transport.ts` + 1 处图片 blob，带原因）、`invoke(`（只许 `src/lib/shell/host.ts`）。
  - 一个真踩到的坑：`\blocalStorage\b` 会命中**字符串里的散文**（登记表里介绍这条边界的文字），于是假红。守卫正则改成 `\blocalStorage\b\s*[?.\[]`——只匹配真的在用（`localStorage.getItem`、`globalThis.localStorage?.x`）。
- 验收（实测过，非推断）：①把接缝登记表里的 `install: "setHostShell"` 改成拼错的 `setHostShellTypo` → `[protocol-seam] seam shell: src/lib/shell/host.ts does not export setHostShellTypo()` + `tests/hostShell.test.ts never calls setHostShellTypo()`；②在 `src/lib/open-target.ts` 加 `window.localStorage.getItem("x")` → `[no-bypass] src/lib/open-target.ts:27 uses local-storage outside its seam`。两次都用 `/tmp` 备份还原（没碰 git）。
- 测试：`tests/protocolSeams.test.ts` 6 条（文件存在 / install 是导出 / swapTest 真的调用 / 装配点真的装配 / registry↔policy 一致 / 未证明的协议必须写缺口原因）。

**C2 `HostShell` 协议（shell 层）** ✅
- 现状：`invokeHost()` 是函数，模块顶层直接 `import { invoke } from "@tauri-apps/api/core"` → **没有换实现入口**；12 个调用点散布在 App.tsx / systemNotification / shell-appearance / open-target。
- 做什么：`src/shared/protocol/hostCommands.ts` 加 `HostShell` 接口；`src/lib/shell/host.ts` 改成 `setHostShell(port)` + 默认 Tauri 实现；12 个调用点零改动。
- 验收：`tests/hostShell.test.ts` 9 条全绿——假宿主驱动**真实调用点**（`syncShellAppearance` / `showSystemNotification` / `openTarget`）并断言命令与参数；没有宿主时 `invokeHost()` 给出 `no host shell installed`（不再是 Tauri 内部的 undefined 崩溃）。
- 额外发现并修掉的两件事：
  1. **「宿主在不在场」有三份实现**：`App.tsx:isTauriRuntime()`（嗅 `__TAURI__` / `__TAURI_INTERNALS__`）、`systemNotification.hasShellBridge()`、`open-target` 里的内联嗅探。现在统一为 `hasHostShell()`（协议的一部分）——三份实现在「装了假宿主」时会给出不同答案，而那正是可替换性要避免的。
  2. **默认宿主不能是模块加载时的快照**：我第一版写成 `let shell = defaultShell()`（eager），结果是「在 import 之后注入 `__TAURI_INTERNALS__` 的宿主永远被判为不在场」。`tests/shellAppearance.test.ts` 抓到了（它先 import 再 stub window）——改成懒解析（`installed === undefined` 时每次调用问默认实现），既有测试不用改就恢复绿。

**C3 `KernelPort`（kernel 层）** ✅
- 现状：`piKernel.mjs` 是 re-export 门面，改实现 = 改文件；测试只断言「导出存在」，不换实现。
- 做什么：门面导出 `createKernelAdapter()`；桥里少数使用点（`describeModel`、`initTheme`、trust 判定）改为经 adapter 注入，默认 = 真内核。
- 验收：`tests/kernelAdapter.test.ts` 6 条（21 个 re-export 逐项存在 / 两个非公共深引的 arity 未漂移 / 假内核驱动 `supportedThinkingLevelsFor` / `createKernelAdapter` 只覆盖点名字段 / 换回来无残留 / 安装点真的有这三个函数）。
- 踩到的坑（被自己的 `node-typecheck` 当场抓住）：`export { x } from "..."` **不产生局部绑定**，所以 adapter 里的简写 `{ getSupportedThinkingLevels }` 报 4 条 TS18004。改成 `import { x } …; export { x };` 之后干净——这是 A1 的规则第一次抓到新代码里的真错误。
- 连带：`server/index.mjs` 只改一行（`getSupportedThinkingLevels(model)` → `supportedThinkingLevelsFor(model)`），行数 8711，仍在棘轮 ceiling 之下（ceiling 8712，所以这个文件现在是「加一行就得删一行」的状态，B1 要处理）。

**C4 `PerfPort`（目前的隐式协议）** ✅
- 现状：`__piDesktopPerf` 挂在 globalThis，声明在 `src/vite-env.d.ts`，实现细节写在 `transport.ts` 内 → 无声明、无装配点、无测试。
- 做什么：声明 `PerfPort { enabled, mark }` 进 protocol 层；装配点在 `src/lib/perf.ts`；transport 不再自己摸 global。
- 验收：`tests/perfPort.test.ts` 4 条——其中最关键的一条装假 `PerfPort`、用 stub 的 `fetch` 驱动**真实 HTTP transport** 的 `/api/bootstrap` 请求，断言 `bootstrap.fetch` 的 mark 落到了假探针上（并且非 bootstrap 路径不被计时）。
- 顺带消掉一个真实循环依赖：`transport.ts` 之所以摸 `globalThis.__piDesktopPerf`，是因为 `perf.ts → api.ts`，`api.ts` 不能回头 import `perf.ts`。现在插槽在 `src/lib/perf-port.ts`（只依赖协议类型），两个方向都能 import，环没了。
- 仍未做的（诚实标注）：内存里那批已废弃的注释（`src/lib/perf.ts:11-12` 里教人用 `localStorage.setItem("pi-desktop.perf","1")` 开测量）——现在开关读的是存储端口，注释里的用法仍然有效（端口默认就是 localStorage），所以没改；但「开发开关」和「用户偏好」共用一套存储这件事本身还没有分类。

**C5 `PreferencesPort` + 迁移** ✅（迁移表现在为空，机制与测试已就位）
- 现状：`localStorage` 20 处，key `pi-desktop.ui.v1`，**无迁移路径**（改结构 = 老用户数据静默失效）。
- 做什么：声明 `PreferencesPort { read, write }`；`localStorage` 收口到 1 处；加 `v1 → v2` 迁移函数表 + 迁移测试。
- 做了：`src/shared/protocol/storage.ts`（`KeyValueStorePort` + `STORAGE_SCHEMA_VERSION` + `STORAGE_MIGRATIONS` + `checkStorageVersion` / `migrateStorage` / `storageMismatchMessage`）；`src/lib/storage.ts` 是**唯一**碰 `localStorage` 的文件（默认 `localStorage`，无 DOM 回退内存实现，`setStoragePort()` 可换）；5 个真实调用点全部改走端口（`ui-preferences` / `persistence` / `perf` / `api` / `main.tsx`）。
- 验收：`tests/storagePort.test.ts` 12 条（真实调用点被假端口驱动并对调用序列断言 / 脏数据回落 / 快照读写清 / schema fresh 打标 / **比本版本新时拒绝读取** / 落后时按表逐级迁移 / 缺一级迁移抛错 / 无端口时默认可用 / 启动检查幂等）。
- 与计划的两处偏差（都有理由，不是缩水）：
  1. 计划写「加 v1 → v2 迁移函数表 + 迁移测试」，但**当前没有任何破坏性变更**，硬造一个 v1→v2 迁移是编造需求。改成：机制（逐级迁移 + 缺级抛错 + 幂等打标）由测试用**合成迁移**证明可用，表本身为空，并留一条断言「表变空即提醒补测试」。
  2. 顺手修掉一个真实缺口：`ui-preferences.loadUiPreferences()` 里那句 `typeof window === "undefined"` 早退，让模块在 node 里根本读不到端口（等于绕过了自己的协议）。删掉早退——「有没有 DOM」由端口回答。
  - 另外补上计划没写但同类的问题：**前向兼容闸**（比本版本新的存档 = 拒绝读 + 启动警告），这是「key 里带 v1 但没人校验」那个装饰性版本号的直接后果。
- `grep -rn "localStorage" src` 现在的匹配全部是注释/字符串：真实调用只剩 `src/lib/storage.ts` 一处。

**C6 `LocalePort` 收尾** ✅
- 现状：注入点已有（`configureLocalePreference`），但声明在 `src/i18n/index.ts`（foundation 层），协议应在 protocol 层；测试只用了「卸载」没换实现。
- 做的时候发现计划写错了层：`LocalePreferencePort` **不能**放 protocol 层——层序是 `contracts → foundation → protocol → …`，而 i18n 是 foundation，向上 import protocol 会被 `layer-direction` 判红。正确落点是 **contracts 层**（`src/types/protocols.ts`，任何层都能向下拿）。已改到这里，`src/i18n/index.ts` 只 `import type` 再导出（不再自己声明一份）。
- 验收：`tests/localePort.test.ts` 4 条（真实适配器把语言写进存储端口 / 假实现驱动 i18n 真实读写 / 卸载后仍可用 / 契约只在 contracts 层声明）。踩到的坑：`setLocale()` 在「没变化」时会提前返回，所以用例必须先取当前语言再切到另一侧，否则是假绿。

**C7 第二个真实传输实现** ✅
- 为什么：现在只有 `FakeTransport`（测试内）证明可替换 —— 那是"测试里成立"，不是"能换"。ZCode 的 rpc 有 MessagePort 与 connection 两种真实传输。
- 做了：`src/lib/bridge/loopback.ts` —— 真正的第二实现（不碰 `fetch`/`Response`/TCP），请求以**可序列化报文**跨过 `dispatch`（宿主那一半注入，MessagePort 宿主实现 `dispatch` 即可），语义与 HTTP 版逐条对齐（JSON 体、`304 → null`、`lastEtag`、NDJSON 分帧含坏行 → error 事件）。
- 验收：`tests/bridgeLoopback.test.ts` 7 条，全程把 `globalThis.fetch` 换成「一调就抛」的地雷：`fetchBootstrap`（握手顺序 `/api/protocol` → `/api/bootstrap`）、ETag/304、`postJson` 的序列化、`streamNdjson` 的 NDJSON 事件、错误体抽人话、诊断 fire-and-forget、以及「整套流程 fetch 一次都没被调用」。
- **它立刻抓到一个真语义分歧**：我的第一版 loopback 会自动把存下来的 ETag 附到下一个请求上，于是 `fetchBootstrap({ force: true })` 也变成条件请求 → 304 → `null`（HTTP 版不会：条件请求是**调用方**的决定，`lastEtag()` 只负责读）。两个实现因此在一个要紧的用例上不一致——这正是「有第二套实现」的收益，已修并写进注释。

**C8 接缝矩阵生成进文档** ✅（生成器就绪；文档落盘仍卡在 G1）
- 做什么：`render.mjs` 增加「接缝表」（边界 × 契约 × 生产实现 × 装配点 × 换实现测试），写进 `docs/architecture/protocols.md` 的生成区域；加审计脚本断言矩阵无空格。
- 做了：`render.mjs` 新增 `seams` 区域（边界 × 跨越什么 × 契约 × 真实现 × 装配点 × 换实现 × 证据测试），从 `src/shared/protocol/seams.ts` 渲染；`protocols` 表新增「可替换性证据」列——有 seam 的写 `install()（规则 protocol-seam 强制）`，没有的写 **未证明** + 缺口原因（SQLite 那条就是），所以「宣称有协议却没有注入点」会在文档里显形。
- 验收状态：生成器与规则就绪；`docs/architecture/protocols.md` 里还没有 `<!-- architecture:begin seams -->` 区域，因为**文档落盘被写保护挡住**（见 G1）。这是当前 `architecture:check` 仅剩的 2 条违规。

### D 组 — 报文形状与内核

**D1 报文形状同源 + 字段集断言** ✅
- 做了什么：新建 `src/shared/protocol/bridgeMessages.ts`（在 `src/shared` → 桥也能 import，`bridge-closure` 保证它无浏览器依赖）：声明 `BOOTSTRAP_REQUIRED_FIELDS` / `BOOTSTRAP_OPTIONAL_FIELDS` / `AMBIENT_*` 与 `missingBridgeFields()` / `assertBridgePayload()`。
- **两向闭合**（这是关键，单向断言抓不住「桥偷偷少发字段」）：
  1. 桥侧运行时自检：`sendBootstrapJson()` 与 ambient 出口都调 `assertBridgePayload(...)`，少了必填字段就 `console.warn` 点名；自检**返回原对象**，所以 `sendJson(res, 200, assertBridgePayload(...))` 这句没法在绕过检查的同时还发得出去。
  2. 测试三向比对：登记表 ↔ `src/lib/api.ts` 里 `BootstrapResponse` / `AmbientBootstrap` 的字段（解析接口体）↔ 桥确实调用了自检。
- 验收：`tests/bridgeMessages.test.ts` 7 条全绿（含「缺字段点名」「自检不抛、仍返回快照」「可选字段缺席不算缺」）。
- 诚实标注两处：
  - **刻意的两侧不对称**已写成显式断言：`protocolVersion` 在客户端接口里是可选（客户端靠**校验后抛错**处理缺失，而不是假装它一定在），在桥侧算必填（桥必须每次发）。测试同时钉住这两件事，而不是把差异抹平。
  - 字段集比对与声明顺序无关（顺序不是契约），否则挪一行就红一次、变成噪声——但「加字段/删字段」两个方向都会红。
- 未做的部分：`BootstrapResponse` 接口本身仍留在 `src/lib/api.ts`（没有搬进 protocol 层）。原因说清楚：它引用 `AppSnapshot`、`ProjectSummary` 等十几个领域类型，搬动会连带 `ExtensionWebUi*` 那一族；而这一项要解决的真问题是「桥和前端字段集不同源」，用共享的字段集登记表已经解决。搬类型是整洁度收益，不是正确性收益。

**D2 内核签名 tripwire** ✅
- 做了：`tests/kernelAdapter.test.ts` 断言两个非公共深引的 `arity === 1`，并加注释说明为什么（它们不在包的 `exports` 里，**没有任何类型保护会替我们看住它们**）。
- 验收：把 `resolveProjectTrusted` 包一层改变 arity → `tests/upstreamAdmission.test.ts` 的负例已证明这类漂移会红（`resolveProjectTrusted changed arity: 1 → 2`）。

**D3 内核升级准入闸** ✅
- 为什么：ZCode 有 `upstream-admission.mjs` + 1.8MB 快照；我们只有「导出存在」的弱断言，跨 5 次 bump 未验证过签名漂移。
- 做了：`scripts/architecture/upstream-admission.mjs`（`--check` / `--write`）+ `architecture/generated/upstream-snapshot.json` + `npm run upstream:check` / `upstream:write`；快照记录 21 个导出（名字 + 种类 + **arity**）与两条深引的相对路径 + 它们导出的符号集。
- 验收：`tests/upstreamAdmission.test.ts` 7 条——真快照与现场比对无漂移（`upstream-admission: ok (kernel 1.4.0, 21 exports)`）；**并且闸门自己有负例**：删导出 → red / arity 变 → red / 出现未准入导出 → red / 深引符号变 → red / 深引不再被跟踪 → red。
- **负例逼出一个真补丁**：原实现只遍历现场（fresh）的深引清单，于是「某条深引被删掉」（跟踪范围悄悄变小）不会被发现。已改成两个方向都走。
- 规模对照（要写清）：快照约 3KB vs ZCode 的 1.88MB，因为我们对一个包取 21 个名字；如果哪天它涨到人读不动 diff，正确的修法是**少依赖**，不是更大的快照。
- 未做：`npm run bridge:sync` 前强制过闸（sync 脚本没接；现在闸挂在 `npm test` 上，比 sync 更频繁地跑）。
- 验收：伪造一次版本变更（改快照里的 arity）→ 闸必须红并给出 diff。
- 规模对照：ZCode 快照 1.8MB（上游面大），我们的公开面 21 个导出 → 快照应 < 20KB。

### E 组 — 门禁与工具

**E1 `oxlint` + `oxfmt`** ⬜
- 做什么：装 oxlint + oxfmt（不引 eslint 全家桶）；`.oxlintrc.json` 的 `max-lines: ["error", {max: 800}]`，路径降级清单**从 `policy.json` 的棘轮生成**（避免两处手抄漂移）；加 `npm run lint` / `format`。
- 验收：`npx oxlint .` 0 error；`npx oxfmt --check src server` 通过。

**E2 打包工作流测试硬门** ✅
- 做了：删掉 `run_tests` 输入；`verify` 作业不再带 `if:`；出包作业条件从 `(verify == success || verify == skipped)` 改成 `verify == success`。
- 验收：`tests/packagingTestGate.test.ts` 3 条（没有跳过开关 / verify 无条件跑 / 出包要求测试成功且 skipped 不算通过）。踩到的坑：第一版断言被自己写的说明注释绊倒（注释里写着「曾经是 `if: inputs.run_tests`」）—— 检查文本的规则要先剔注释，这条经验在 `no-bypass` 里也用过。

**E3 测试隔离池（消实测 flake）** ✅
- 实测证据：`tests/bundledRuntimeSelection.test.ts`（真 spawn 解释器探测）在 160 文件并行下偶发 5s 超时；单独跑 909ms 通过。
- 做什么：把「spawn 真实进程 / 抢真实端口 / 探测真实解释器」的测试登记到隔离池（串行或独占运行）；`npm test` 汇总行必须稳定无 fail。
- 验收：连续 5 次 `npm test` 全绿（记录 5 次结果）。

**E4 `architecture:why <file>`** ✅
- 做了：`scripts/architecture/why.mjs` + `npm run architecture:why <file> [--json]`：层级 / 模块 / 是否进 sidecar / 行数与棘轮 ceiling / 所属协议 / 被谁依赖（区分**仅类型**依赖）/ 依赖谁。
- 验收：`npm run architecture:why src/lib/api.ts` 列出 16 个调用方（其中 7 个是 `import type`，移动文件时是重要区分）；`tests/architectureWhy.test.ts` 6 条。
- 这一项是给 B1/B2 用的工具：拆 9,198 行的 `App.tsx` 时，「谁依赖它」比 grep 可靠（grep 漏 `import type`、动态 `import()`、re-export）。

### F 组 — e2e 分层（当前为 0）

**F1 playwright 最小真 e2e（4 条）** ⬜
1. 桥冷启动 + 一轮流式对话（真 server + 假内核，headless）
2. 协议版本不匹配 → UI 给出可操作文案（不是白屏）
3. 打包壳冒烟（Electron webview 或 Tauri 起窗 + 渲染首屏）
4. trust 闸：未信任项目下请求被拒且文案正确
- 验收：`npm run e2e` 4/4 绿；CI 作业存在。

**F2 e2e 进 CI** ⬜：独立作业，失败即红。
- 规模对照（结论要写清）：ZCode 567 个 e2e（桌面）/ 3,656 个测试文件，因为它是 1.08M 行多进程桌面应用；我们按**关键路径 4 条**起步，不追数量，触发条件是「出现一次线上级回归且单测没抓到」时再加一条。

### G 组 — 文档与定位

**G1 三份草稿落盘** ⬜（阻塞项，唯一需要用户动作的一项）
- 阻塞原因：`docs/` 有写保护；需要 `/pw allow-docs-write on` 后 `npm run architecture:land-docs`。
- 现状补充（2026-10-23）：`docs/architecture/` 目录还不存在；三份草稿与生成区域的**一致性已经用 checker 自己的 `writeRegion`/`readRegion` 在 `/tmp/landsim` 预演过**（`protocols ✓ 一致 / seams ✓ 一致`），所以解锁后是一条命令的事，不会在落盘时才发现区域对不上。
- 验收：`tests/architecture.test.ts` 的 skip 自动生效；`npm run architecture:check` 的 `docs-regions` 归零。

**G2 `DESIGN.md` 定位修正** 🟡（部分）：在 `DESIGN.md` 的 frontmatter 之后插了 15 行定位说明 —— 明确「这是 Meta 参考、不是本项目规范」，并给出本项目真正的规范落点（`CONTEXT.md` 词表 + `docs/architecture/*`）。**未做**的部分：683 行正文没有按 PiDesktop 逐节改写，也没有移入 `docs/reference/`（那要动 `docs/`，卡 G1 的写权限）。

**G3 `CONTEXT.md` 领域词表** ✅（根目录 `CONTEXT.md`，含 `_Avoid_` 反例与代码落点）
- 为什么：ZCode 有 `CONTEXT.md`（5.5KB，含 `_Avoid_` 反例），我们没有 → 术语靠口语约定，新人和 agent 都会用错。
- 做什么：本项目的领域词表（turn / session / project / capability package / bridge / sidecar / 宿主 / 信任闸），每条给「是什么 / 不是什么（_Avoid_）/ 代码落点」。
- 验收：`project_wiki format=lint` 无新增问题；词表条目都带 `code_refs`。

**G4 两份 ADR** 🟡（草稿在 `.wiki/output/adr-002-protocol-version-and-compatibility.md`（56 行）与 `.wiki/output/adr-003-debt-ratchet-policy.md`（62 行）；落盘同样卡 G1 的 `docs/` 写权限）：`ADR-002` 协议版本握手与兼容策略（newer 也不兼容）；`ADR-003` 债务棘轮与例外政策（deadline + 只降不升 vs 永久白名单）。

## 3. 与 ZCode 逐维度对照：计划完成后是否更好

| 维度 | ZCode | 我们现状 | 计划完成后 | 判定 |
| --- | --- | --- | --- | --- |
| 进程/语言边界类型保护 | 52 份 tsconfig，全 TS，0 诊断 | 无（128 条脏） | A1+A2+A3：4 份边界 tsconfig，诊断 0，过程可审计 | **持平偏好**（我们的下降过程有审计，ZCode 天生为 0） |
| 每层协议 + 可替换性 | `packages/rpc` 完整（ACK/replay/flow control/proxy），多真实传输 | 声明 4 条，只有 1 条被换过；shell/kernel 无注入点 | C1–C8：6 条接缝全部有假实现测试 + 第二真实传输 + 反绕规则 + 矩阵生成 | **更好**（ZCode 的接缝靠纪律，我们的靠规则；ACK/replay 对 loopback 无用，明确不抄） |
| 协议真源与漂移防护 | policy.yaml 声明；channel 名与路由无交叉校验 | 96 条路由双向冻结 + 字节级文档校验 | + D1 报文字段集断言 + C8 接缝矩阵 | **更好** |
| 债务管理 | 永久 warn 白名单 + 上游准入闸 + 1.8MB 快照 | 棘轮+deadline（更强）但**无准入闸**（更弱） | D3 补准入闸（快照 <20KB） | **更好**（棘轮 + 期限 + 准入闸三者齐备） |
| 门禁强度 | oxlint(max-lines error) + husky；CI 无法从快照证实 | 零 lint；测试门可取消 | E1+E2：lint error + 测试硬门 + architecture:check | **更好**（且我们的门禁含架构规则，ZCode 无同类交叉校验） |
| 测试规模/分层 | 3,656 测试文件（567 e2e），隔离池 | 160 文件 0.56，无 e2e，有实测 flake | F1/F2 4 条 e2e + E3 隔离池 | **持平**（数量上不追，理由与触发条件已写明） |
| 文档体系 | 21 架构 + 4 ADR + 89 测试文档 + 词表 | 1 坏文档 + 3 草稿 | G1–G4：生成并校验的架构/协议文档 + 2 ADR + 词表 | **更好**（篇数少但每篇与代码双向校验） |
| 改动影响分析 | dep:graph/dep:refs/affected-tests | 无（全量 25.6s） | E4 补 `architecture:why` | **持平**（全量跑得动；触发条件：`npm test` > 3min 或 CI > 15min） |
| 工具链成本 | pnpm+turbo+husky+release-it+52 tsconfig | 零依赖单包 | 只加 oxlint/oxfmt/playwright | **更好**（复杂度/收益比） |

**结论：实现本计划后，上表 9 个维度中 6 个更好、3 个持平、无一项更差。** 因此满足「实现后架构比 ZCode 好」的动手条件。

**明确不抄 ZCode 的部分（附触发条件）**

| 不抄 | 理由 | 何时再考虑 |
| --- | --- | --- |
| rpc 的 ACK/replay/flow-control 可靠性层 | 本机 loopback 桥，丢包/乱序不是现实故障；加了只是复杂度 | 桥跨网络（远程宿主）时 |
| 1,110 级别 e2e / 测试复刻 | 规模由 1.08M 行多进程应用决定；我们按关键路径起步 | 出现单测抓不到的线上级回归 |
| pnpm workspace + turbo + husky + release-it | 单包零依赖，25.6s 全量测试不需要增量缓存 | 拆成多包或 CI > 15min |
| 52 份 tsconfig | 进程拓扑只有 4 个边界 | 新增进程（如 remote main） |
| 35KB policy.yaml | 我们的模块/规则规模用 433 行 JSON 表达完整 | 规则数翻倍且需要 per-path 复用 |
| 空壳 package（android / share-ui / formal-proof） | 那是债务不是优点 | 永不 |

## 5. 本轮最终验证（2026-10-23，命令与输出照抄）

```
$ npx tsc -b                    → 无输出（干净）
$ npm run typecheck:node        → exit 0，0 条诊断（基线文件已删除）
$ npm run architecture:check    → architecture: 2 violation(s) in 1 rule(s): docs-regions=2
$ npm run upstream:check        → upstream-admission: ok (kernel 1.4.0, 21 exports)
$ npm test                      → run-tests: parallel pool -> ok / serial pool -> ok
                                  ℹ tests 2049 / pass 2048 / fail 0 / skipped 1
                                  ℹ tests 34   / pass 34   / fail 0
$ 生产代码（server+src+src-electron） → 64,863 行（硬化前 62,818；增量主要是拆文件后的 import/导出与契约模块）
$ 测试代码（tests/*.test.ts*）        → 36,787 行（硬化前 35,131）
```

`docs-regions=2` 是**唯一**剩下的违规，就是 G1：`docs/architecture/{architecture,protocols}.md` 还没落盘（`docs/` 有写保护，需要 `/pw allow-docs-write on`）。草稿在 `.wiki/output/`，并且已用 checker 自己的 `writeRegion`/`readRegion` 在 `/tmp/landsim` 验过能一致落盘（见 G1 条目）。

**A2 达标的副作用**：`node-typecheck` 由「不许超过基线」变成「基线不存在 → 必须 0 条」，这是全项目最硬的一道门。

**本轮新产生的债务（不隐匿）**：`architecture/policy.json` 的 exceptions 里新增了 `src/app/Sidebar.tsx`（ceiling 1,285），`src/app/App.tsx` 的 ceiling 从 9,190 收紧到 3,366（仍是例外，但只有降）；本轮拆出去的 `CapabilitiesPage`（拆到 564）例外被 `exceptions` 规则判为失效并自动删除。

```
A1 → A2 → A3         类型保护先行（后续改动的编译期安全网）
B1 → B2 → B3         拆文件，每块收紧棘轮
C1 → C2/C4/C5/C6 → C3 → C7 → C8   先立规则与轻接缝，kernel 最重放最后
D1 → D2 → D3         报文同源 → 签名 → 准入闸
E1 → E2 → E3 → E4
F1 → F2
G1（需人工开写保护）→ G2 → G3 → G4
```

依赖关系：A 组是其余各组的编译期安全网；C1 必须先做（否则换实现没有规则钉）；C3 依赖 D2（签名先钉住再注入）；G1 依赖人工开关，不阻塞其余。