---
title: "Pi Desktop 分层架构"
type: doc
status: approved
owner: "@qiaowei"
created: 2026-10-22
updated: 2026-10-22
code_refs:
  - architecture/policy.json
  - scripts/architecture/check.mjs
  - scripts/architecture/lib/graph.mjs
tags: [architecture, layers, boundaries]
summary: "Pi Desktop 的分层模型、模块归属、依赖规则与债务登记；表格由 architecture/policy.json 生成，并与代码双向校验。"
---

# Pi Desktop 分层架构

这份文档不是描述性的，是**可执行的**：下面每一张表都由 `architecture/policy.json` 生成，
`npm test` 会逐字节比对；同时 `architecture/policy.json` 又要与真实 import 图、真实 bridge
路由、真实 invoke 调用点对齐。所以它不可能写成一句"我们希望是这样"而永远没人发现。

```
npm run architecture:check     # 校验（npm test 会跑）
npm run architecture:write     # 重新生成表格、协议表面与债务快照
```

## 1. 为什么要有这份东西

Pi Desktop 的规模不需要 ZCode 那套 35KB 的策略文件（那是 110 万行、多团队、多端的合规成本），
但它确实需要 ZCode 真正重要的三件东西：**层方向可机械校验**、**契约有唯一出口**、
**债务被登记而不是被遗忘**。这份文档 + `scripts/architecture/` 就是那三件事的最小实现。

它同时利用了一个 Pi Desktop 独有的事实：`src/shared/` 是**两个运行时共用的内核**——
`scripts/build-bridge-runtime.mjs` 会把 `server/` 和 `src/shared/` 一起装进 sidecar。
ZCode 的 UI 包与 agent 包之间没有这种共享内核；我们把它变成一条可校验的不变式
（规则 `bridge-closure`：凡是 bridge 运行时能走到的模块，必须是被一起复制进去的层）。

## 2. 分层模型

依赖方向只有一个：**上面的层可以 import 下面的层，反之不行**（同层之间允许）。
`type`-only import 豁免——编译后它不存在，既不会造成初始化环，也带不过任何运行时耦合。

<!-- architecture:begin layers -->
<!-- architecture:end layers -->

## 3. 模块归属

每个源码文件必须属于一个已登记模块，否则规则 `unregistered-file` 直接失败
——新代码不能靠"放进一个没人管的目录"来绕开约束。

<!-- architecture:begin modules -->
<!-- architecture:end modules -->

## 4. 依赖规则（检查器实际拦的东西）

| 规则 | 拦什么 | 为什么 |
| --- | --- | --- |
| `layer-direction` | 向上 import（含跨运行时：bridge 的 kernel 不许碰 adapters） | 分层只有在被机械校验时才存在；"注意别反向依赖"从来没有生效过 |
| `module-cycle` | 文件级运行时循环依赖 | 循环 = import 顺序决定行为，这类 bug 只在启动或某个分支上炸 |
| `unregistered-file` | 落在所有模块之外的源码文件 | 让新代码无法逃逸既有规则 |
| `bridge-closure` | 从 bridge 入口可达、但不在 sidecar 里的模块 | `src/i18n`、`src/lib` 不进 sidecar；dev 能跑、打包后崩，是这类错误唯一的报错方式 |
| `max-lines` | 超过该 glob 上限、且超过已登记**棘轮上限**的文件 | 债务只降不升（见第 6 节） |
| `protocol-version` | `src/shared/protocol/version.ts` 与 `server/protocolVersion.mjs` 不等 | 两侧必须同一个版本号，否则握手闸门是假的 |
| `protocol-surface` | 客户端调了 bridge 不认的路由，或 bridge 有未登记路由 | 协议表面双向冻结，见 `protocols.md` |
| `protocol-core` | `bridgeEndpoints.ts` 里手写文档的端点，bridge 实际不应答 | 手写的那部分不许说谎 |
| `shell-commands` | preload 白名单 ≠ 协议声明 ≠ `invoke()` 调用点 | 三个曾经各写一份、没人比对的名单 |
| `kernel-boundary` | `server/` 里除 `piKernel.mjs` 外直接 import `@earendil-works/*` | 内核升级只该改一个文件 |
| `exceptions` | 过期未处理 / 已经没必要的例外 | 例外是带期限的待办，不是永久豁免 |
| `docs-regions` | 本文档生成的表格与 policy 不一致 | 文档与代码不允许各说各话 |

## 5. 边界协议

层与层之间不互相认识，而是通过**协议**相连；每个协议都有契约文件、版本源、一致性测试与
"换实现"的明确做法，见 **[`protocols.md`](./protocols.md)**。

<details>
<summary>当前协议表面（由检查器统计）</summary>

<!-- architecture:begin surface -->
<!-- architecture:end surface -->

</details>

## 6. 债务登记

超过行数上限的文件不是被"忽略"，而是登记在案：带棘轮上限（只降不升）、负责人和**最迟处理日期**。
日期一过，`exceptions` 规则开始报错——债务因此是排过期的，而不是像 ZCode 的 `max-lines` 白名单
那样永久 downgrade 成 warning。

<!-- architecture:begin debt -->
<!-- architecture:end debt -->

## 7. 怎么改（改动配方）

- **新增一个源文件**：放进上面任一根目录即可（属于所属模块）；没有合适模块时，先在
  `architecture/policy.json` 里登记模块，再放文件。
- **新增一个 bridge 路由**：加进 `server/index.mjs` 后跑 `npm run architecture:write`
  ——路由会进冻结表面。想让它同时进"人读的核心清单"，就在
  `src/shared/protocol/bridgeEndpoints.ts` 里加一条。
- **改协议形状（不兼容）**：同一个改动里同时 bump `src/shared/protocol/version.ts` 与
  `server/protocolVersion.mjs`（`protocol-version` 规则会强制）；加字段不用 bump。
- **拆大文件**：拆完跑 `npm run architecture:write`，棘轮上限自动收紧；拆到上限以下时，
  `exceptions` 规则会**要求你删掉那条例外**。
- **加一个新宿主（第三个壳）**：实现 `HOST_COMMAND_IDS` 的 ipc 面，调用点不动
  （见 `protocols.md` 的 shell 边界）。
- **升级 pi 内核**：只动 `server/piKernel.mjs`；`tests/kernelAdapter.test.ts` 会逐个核实
  它 re-export 的入口都还在。

## 8. 被测试钉住的不变式

| 不变式 | 钉住它的测试 |
| --- | --- |
| 层方向 / 无环 / 文件已登记 / bridge 闭包 / 行数棘轮 / 例外未过期 / 文档未漂移 | `tests/architecture.test.ts` |
| 协议版本两侧相等、协议表面双向一致、握手分类正确 | `tests/bridgeProtocol.test.ts` |
| 换 transport 后上层无感（可替换性本身） | `tests/bridgeTransport.test.ts` |
| `piKernel.mjs` 的每个 re-export 都真实存在 | `tests/kernelAdapter.test.ts` |