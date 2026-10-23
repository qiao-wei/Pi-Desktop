---
id: ADR-002
title: "协议版本握手与兼容策略：newer 也算不兼容"
type: adr
status: approved
owner: "@qiaowei"
created: 2026-10-22
updated: 2026-10-22
related: [ADR-001]
code_refs:
  - src/shared/protocol/version.ts
  - server/protocolVersion.mjs
  - src/lib/api.ts
  - server/index.mjs
  - tests/bridgeProtocol.test.ts
tags: [architecture, protocol, versioning]
summary: "桥与渲染进程各自声明协议版本，握手在搬 MB 级快照之前发生；比渲染进程新的桥同样判为不兼容。"
reviewers: ["@qiaowei"]
---

# ADR-002：协议版本握手与兼容策略

## 背景

桥（`server/`）与渲染进程（`src/`）是一起打包的，但**运行时不保证同版本**：

- dev 下渲染进程可能被指到上一次构建残留的桥（或没跑 `bridge:sync` 的桥）；
- 打包壳里的 sidecar 与渲染 bundle 分别构建，中间可以有窗口期；
- 用户可能装了两个版本的 app，端口恰好被另一个进程占着。

在此之前 HTTP 表面不声明自己是哪个修订版。字段被改名或删掉时，渲染进程收到的是 `undefined`——UI
以「静默降级」的方式错下去（少一列、少一块面板），排查时看到的是渲染错误，不是协议错误。

## 决策

1. **两侧各有一个字面量**：渲染进程 `src/shared/protocol/version.ts` 的 `PROTOCOL_VERSION`，桥侧
   `server/protocolVersion.mjs`。检查器规则 `protocol-version` 要求两者相等；测试也钉一遍。
2. **握手先行**：`GET /api/protocol` 是最便宜的一条（不构建快照），渲染进程在搬 MB 级 bootstrap
   之前先问它；bootstrap 与 ambient 的响应体里也带 `protocolVersion`，`fetchBootstrap` /
   `fetchAmbientBootstrap` 会 `assertProtocolVersion()`，不一致**抛错**并走既有错误横幅。
3. **分类函数是纯函数，且 `newer` 也不兼容**：`checkProtocolCompatibility()` 返回
   `ok | missing | older | newer`。「桥比渲染进程新」时字段可能只是多、类型可能已经变——渲染进程只
   认识自己构建时的形状，**「大概还能用」正是把协议变更变成静默错渲染的那个假设**。
4. **不兼容才 bump**：加字段不 bump（旧渲染进程忽略它），删字段/改语义/改类型必须 bump。

## 后果

- 版本不对时用户看到一句可操作的话，而不是半截界面；dev 的「指向旧桥」从疑难杂症变成一句话。
- 代价：每次不兼容改动要动两个字面量 + 重新构建两侧。这是有意的摩擦。
- 未做：自动生成版本号（从路由表面哈希推出）被否掉——它会让「加一个字段」也 bump，而那是兼容的，
  频繁 bump 会训练人忽略它。

## 备选方案

- **只靠内容协商 / 字段嗅探**：无法区分「字段为空」与「字段被删」。否。
- **只比 major 版本**：本项目没有 major/minor 之分，两个运行时是一体的；引入语义化版本只会增加
  「什么算 minor」的争论。
