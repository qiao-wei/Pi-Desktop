## [2026-10-22] draft | 分层架构与边界协议（ADR-001 + architecture.md + protocols.md）

产出：`.wiki/output/architecture.md`、`.wiki/output/protocols.md`、`.wiki/output/adr-001-layered-architecture-and-protocols.md`。
落盘目标：`docs/architecture/architecture.md`、`docs/architecture/protocols.md`、`docs/adr/ADR-001-layered-architecture-and-protocols.md`（需 `/pw allow-docs-write on`）。
配套代码：`architecture/policy.json`、`scripts/architecture/`、`src/shared/protocol/`、`server/piKernel.mjs`、`src/lib/bridge/transport.ts`、`src/lib/shell/host.ts`。
## [2026-10-22] draft | 架构可校验化 + 边界协议（代码已落盘）

已落盘（代码）：`architecture/policy.json`、`architecture/generated/bridge-surface.json`、`scripts/architecture/{check,land-docs}.mjs`+`lib/`、`src/shared/protocol/*`（version/hostCommands/bridgeEndpoints）、`src/lib/bridge/transport.ts`、`src/lib/shell/host.ts`、`src/lib/localePreferences.ts`、`server/{piKernel,protocolVersion}.mjs`；`server/index.mjs` 加 `GET /api/protocol` + bootstrap/ambient 带 protocolVersion；i18n→lib 反向依赖已反转。

待落盘（文档，需人工确认）：`npm run architecture:land-docs` 会把 .wiki/output 的三份草稿拷进 docs/ 并生成区域。

校验状态：tsc 干净；npm test 2000 项 / 1999 过 / 1 skip（就是"文档在盘上"那条，落盘后自动生效）；architecture:check 只剩 docs-regions x2。

## [2026-10-22] implement | 架构加固 A1–A3 / C1–C8 / D1–D3 / E2–E4（代码已落盘，全部可校验）

完成项（每项都有验收命令跑过，输出抄进 `.wiki/output/plan-architecture-hardening.md`）：
- A1 node 侧类型保护（`tsconfig.node-runtime.json` + 基线棘轮 + 规则 `node-typecheck`），A2 诊断 150 → 52，A3 进程边界登记（规则 `process-boundary`，顺手修了 `**` 不匹配零段导致的 61 条假红）。
- C1 接缝登记表 `src/shared/protocol/seams.ts` + 规则 `protocol-seam` / `no-bypass`（两条都用负例证明会咬）。
- C2 `setHostShell()`（并把「宿主在不在场」的三份实现统一成 `hasHostShell()`），C3 `createKernelAdapter()`，C4 `PerfPort` 转正（消掉一个真实循环依赖），C5 存储端口 + schema 前向兼容闸（`localStorage` 收口到 1 处），C6 `LocalePreferencePort` 移到 contracts 层，C7 第二套真 transport（`src/lib/bridge/loopback.ts`，抓到一处 ETag 语义分歧），C8 接缝矩阵进生成文档。
- D1 报文字段集共享真源 + 桥自检，D2 内核签名 tripwire，D3 上游准入闸（`upstream-snapshot.json` ≈3KB，含负例测试）。
- E2 打包工作流测试硬门，E3 测试隔离池（连续 5 次全绿），E4 `architecture:why`。
- G2 `DESIGN.md` 加定位说明，G3 新增 `CONTEXT.md` 领域词表，G4 `ADR-002` / `ADR-003` 草稿（在 `.wiki/output/`）。

仍未完成（不做假账）：B1（`server/index.mjs` 按路由域拆，仍在 8712 行棘轮上）、B2（`App.tsx` 拆四块）、B3、E1（oxlint/oxfmt，需新增依赖，待确认）、F1/F2（playwright e2e，从 0 起）、G1（文档落盘，需 `/pw allow-docs-write on`）。

校验状态：`tsc -b` 干净；`npm test` 2048 项 + 34 项串行全绿（1 skip = 架构文档在盘上那条）；`npm run architecture:check` 只剩 `docs-regions` ×2（就是 G1 那三份文档还没落盘）；`npm run upstream:check` ok。

## [2026-10-22] split | 棘轮驱动的第一次真拆分：server/customModels.mjs → server/modelListing.mjs

触发原因：A2 给 `customModels.mjs` 补类型 JSDoc 后文件涨到 1431 行、超过其 ceiling 1406。规则要求「拆，不要抬上限」。
做法：拆出 `server/modelListing.mjs`（385 行：端点探测 `requestModelListing` / `plan` / 报文解析 / `mergeListingRows`，以及随之搬走的
`normalizeBaseUrl`、`prettifyModelId`、`toPositiveInt`、`MODEL_ID_PATTERN`、`DEFAULT_CONTEXT_WINDOW`、`DEFAULT_MAX_TOKENS`）。
依赖方向单向（customModels → modelListing，反向不 import），既有调用方（`server/index.mjs` + 3 个测试）通过再导出零改动。
结果：`customModels.mjs` 1431 → 1081 行（ceiling 自动下调至 1082，例外条目保留因为仍高于目录上限 900）；`tsc -b` 干净；`npm test` 2048+34 全绿。
教训：为凑行数把散文重新折行 = 假账，已回滚；正确做法是「一行式 JSDoc + 真拆分」。

## [2026-10-22] fix | node-typecheck 漏数一条（门禁少算 = 能放过新错误）

现象：`npx tsc -p tsconfig.node-runtime.json` 打印 34 条错误，基线只记 33 条。
原因：`scripts/architecture/lib/typecheck.mjs` 的 `isCheckedFile` 只认 `NODE_TYPECHECK_ROOTS`（`server/` `scripts/` `src-electron/`），
而被 `server/index.mjs` 间接 import 的 `src/shared/sessionTitle.ts:360`（TS2322）因此从不进计数。
修复：改成「repo 内、非 `.d.ts`、非 node_modules 都算」；基线 → 34。
负例验证：往 `src/shared/sessionTitle.ts` 追加一行非法属性访问 → `[node-typecheck] … TS2339 (already at its baseline of 0)` → 红；已还原（/tmp 备份，未碰 git）。
守卫：`tests/nodeTypecheck.test.ts` 新增「roots 之外（但被 roots import）的文件必须出现在诊断里」。

## [2026-10-23] typecheck | A2 清零：node 侧 128 → 0，基线文件删除

`npm run typecheck:node` 现在退出码 0、0 条诊断；`npm run architecture:write` 删掉了 `architecture/generated/node-typecheck-baseline.json`，
规则 `node-typecheck` 因此变成「没有基线 → 必须保持 0 条」，任何新诊断当场红（全项目最硬的一道门）。
收尾清的是 `server/index.mjs`（42 条，占总量的七成）、`src-electron/main.js`、`src-electron/sidecar.js`，以及 `modelListing` / `modelLogin` /
`gitWorktree` / `mcpConfig` / `openDiff` / `runProjectCommand` 的剩余条目。方法固定为「先读函数体再写 JSDoc」。
顺带修掉两个真 bug：`server/modelListing.mjs` 里被误删的 `plan = listingPlan(...)` 调用（测试抓出）；`requestModelListing` 的失败支改成判别
联合（`{ok:false, error:string}`）后，上游不必再写 `?? ""` 兜底。

## [2026-10-23] split | B1/B2 大文件拆分：index.mjs 8,804→7,929；App.tsx 9,189→3,365

`server/index.mjs`：叶子清扫（8 个领域模块）+ 第二波（3 个）落地，边界写在 `.scratch/movable.mjs` 里 —— **共享可变状态不能跟着走**：
`runtime` / `projects` / `activeProjectId` / `diagnosticWriting` 被闭包外引用时必须留在入口；`const` 与函数搬出去由入口 import 回来是安全的。
最大可搬簇一度只剩 29 行 → 剩下的核心是互相咬合的请求内核，继续拆需要注入化改造，不是机械搬运。**未到 1,200，记为未完成。**

`src/app/App.tsx`：按簇拆出 15 个文件（标题栏 / 设置弹窗 / 侧栏 / 侧栏对话框 / 能力页 / MCP / 能力详情 / 斜杠菜单 / 技能导入 / 扩展 UI 面板 /
用量浮层 / 输入框控件 / 附件卡 / 面板手柄）。每块**调用点零改动**，逐块验证。**未到 800**：剩余主体是 3.2k 行的单个 `App()` 函数。
配套新增 `tests/lib/appSource.ts`：45 个测试文件里「这段代码在 App.tsx 里」的结构性断言改成读整个 `src/app/`，否则每次合法拆分都会假红。

## [2026-10-23] fix | 抽取工具的事故与补救（差点丢代码）

`.scratch/extract-*.mjs` 是**就地改写源文件**的工具，我拿它当「探测器」跑了十几个 seed，输出写 `/tmp/probe.tsx`，结果 `src/app/App.tsx`
被真的改掉了 14 处（1,135 行代码被换成 `/* moved to /tmp/probe.tsx */`），而 `/tmp/probe.tsx` 每次都被覆盖 —— 前几次搬走的 chunk 只存在于 diff 里。
补救：以 `git show HEAD:src/app/App.tsx` 为基底，按 diff 里**合法**的新增行（C2 shell 协议迁移的 8 处）手工重做，再扫出被回退成裸 `invoke(...)`
的 6 处窗口控制（在搬到别处的 chunk 里，diff 看不见）—— 修完 `git diff` 只剩 17 insertions / 26 deletions，全绿。
两条教训已写进工具与记忆：①抽取工具默认加 `--dry`（只算闭包不写文件），真写之前自动 `cp` 备份到 `/tmp/<file>.bak-<ts>`；②**探测跑法绝不能用会写文件的工具**。

## [2026-10-23] ratchet | B3：exceptions 规则真咬了一次

`src/app/CapabilitiesPage.tsx` 从 1,734 拆到 564 行后，`exceptions` 规则报
`[exceptions] src/app/CapabilitiesPage.tsx is down to 564 lines (limit 700); delete its max-lines exception`，`architecture:write` 直接删除该条。
拆出来的 `CapabilitiesMcp`(629) / `CapabilityDetail`(635) / `SidebarDialogs`(268) / `SkillImportSurfaces`(228) / `SlashMenu`(94) / `ComposerControls`(130) /
`AttachmentHoverCard`(78) 都落在 700 以内，不需要新例外。`src/app/` 下现在只剩两条例外：`App.tsx`（3,365，ceiling 已收紧）与新增的 `Sidebar.tsx`（1,284）。
