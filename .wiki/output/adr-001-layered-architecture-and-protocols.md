---
id: ADR-001
title: "引入可校验的分层架构与边界协议"
type: adr
status: approved
owner: "@qiaowei"
created: 2026-10-22
updated: 2026-10-22
related: []
code_refs:
  - architecture/policy.json
  - scripts/architecture/check.mjs
  - src/shared/protocol/version.ts
  - src/lib/bridge/transport.ts
  - server/piKernel.mjs
tags: [architecture, protocol, governance]
summary: "把分层、边界协议与债务登记变成可机械校验的东西，并说明为什么借用 ZCode 的机制而不是它的规模。"
reviewers: ["@qiaowei"]
---

# ADR-001：引入可校验的分层架构与边界协议

## 背景

Pi Desktop 已经长到 6.2 万行生产代码（`src` + `server` + `src-electron`），其中两处已经开始
失控：`src/app/App.tsx` 9,198 行、`server/index.mjs` 8,698 行。同时存在几个具体的、已经发生过
或随时会发生的失效模式：

1. **桥的 18k 行 `.mjs` 完全不进类型检查**（`tsconfig.json` 的 `include` 只有 `src`，
   `allowJs: false`），改错字段名到运行期才知道。
2. **渲染进程与桥之间没有契约对象**：类型手写在 `src/lib/api.ts`，
   两边靠人肉同步；桥是打进包里的，但 dev 渲染进程可能连到**别人的**桥，字段缺失表现为
   `undefined` 静默降级。
3. **宿主命令名写在三处**（preload 白名单、`host-commands.js`、调用点），没有任何东西比对。
4. **桥对内核的两个非公共入口按相对路径深引**，跨 5 次版本 bump 没动过，但签名漂移是静默的。
5. **没有任何架构约束机制**：没有 lint、没有架构文档、没有依赖方向检查，
   `docs/reference/design-meta.md` 还是一份 Meta 设计系统分析（名实不符）。

参考对象 `~/Downloads/Zcode` 是 112 万行、20 个包的生产系统，有一套成熟的架构治理
（`architecture-policy.yaml` 35KB + `architecture:check/adopt/baseline` + 治理 skill +
1.8MB 上游快照 + `max-lines: 800` + vitest pools + e2e 分层）。

## 决策

**借用 ZCode 的机制，不借用它的规模。** 具体落成三件事：

1. **分层模型 + 机械校验**：`architecture/policy.json` 声明层、模块、允许的依赖方向；
   `scripts/architecture/check.mjs` 用 TypeScript parser 建真实 import 图来校验
   （层方向、循环、未登记文件、bridge 闭包、行数棘轮、例外期限）。
2. **四条边界各有协议对象**：bridge / shell / kernel-adapter / storage，
   每条都有契约文件、版本源、一致性测试和"换实现"步骤（见 `protocols.md`）。
3. **文档与策略双向钉死**：`docs/architecture/*.md` 里的表格由 policy **生成**并逐字节校验，
   同时 policy 又要与真实代码对齐——文档不能撒谎，策略也不能凭空声明。

## 比 ZCode 走得更远的四点

1. **文档即策略（doc-regions）**：ZCode 的 policy.yaml 与 docs/*.md 是两个世界，
   可以各自漂移；我们让文档的表格由 policy 生成并校验。
2. **债务带期限与棘轮（ratchet）**：ZCode 的 `max-lines` 允许把存量文件永久 downgrade 成
   warning；我们的例外必须带 `deadline` 与只降不升的 `ceiling`，过期即失败，
   降到上限以下则**要求删除例外**。
3. **共享内核成为可校验的不变式（bridge-closure）**：`src/shared` 同时进渲染进程与 sidecar
   是 Pi Desktop 的独有事实；把它变成"bridge 可达即必须 bridgeSafe"的规则，
   堵住"dev 能跑、打包后崩"这一类只在出包时暴露的错误。
4. **协议表面双向冻结（protocol-surface）**：客户端调用点、桥路由、冻结表面三方一致，
   新路由不登记就红；ZCode 的 channel 是手写且不与路由做一致性校验的。

## 备选方案

- **直接搬 ZCode 的 policy.yaml + adopt/baseline 全套**：成本与收益不匹配。
  Pi Desktop 没有多团队、多端、上游合并的现实需求；35KB 策略 + 1.8MB 快照会让
  一个小团队把时间花在治理本身。
- **只写文档不写检查器**：文档会在一周内过期，而过期的架构文档比没有更糟（教人忽略它）。
- **只加 lint（max-lines 等）不做分层**：能治大文件，治不了上面 2/3/4 三个真正的失效模式。
- **把 `server/` 迁到 TypeScript**：正确但体量太大，且会破坏"桥零构建步骤"这一既有优点
  （sidecar 直接拷贝源码）。先做契约与边界，迁移作为后续独立决策。

## 后果

- **好**：破坏分层、越界引用内核、命令名不一致、协议漂移、文档漂移都会在 `npm test` 里失败；
  内核升级的失败面收敛到一个文件；渲染进程可以注入假 transport 做端到端单测（此前不可能）。
- **代价**：新增 `architecture/policy.json` 与 `scripts/architecture/*`（约 800 行工具代码）；
  新路由/新协议端点需要跑一次 `architecture:write`；17 个超标文件进入债务登记（带期限）。
- **仍待办**：`server/*.mjs` 的类型检查（决策 2 之外的最大风险）、`App.tsx` 与
  `server/index.mjs` 的拆分（已登记棘轮）、`docs/` 与 `.wiki/output/` 的落盘流程
  （docs/ 有写保护，需要显式开启）。