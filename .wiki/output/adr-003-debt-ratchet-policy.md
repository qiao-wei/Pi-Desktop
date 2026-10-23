---
id: ADR-003
title: "债务棘轮：例外必须带 deadline 与只降不升的 ceiling"
type: adr
status: approved
owner: "@qiaowei"
created: 2026-10-22
updated: 2026-10-22
related: [ADR-001]
code_refs:
  - architecture/policy.json
  - scripts/architecture/check.mjs
  - tests/architecture.test.ts
tags: [architecture, governance, debt]
summary: "架构债务登记成带 deadline 与只降不升 ceiling 的例外；超上限必须拆文件，到期未处理即失败。"
---

# ADR-003：债务棘轮与例外政策

## 背景

任何架构规则一上线就会撞到既有代码：`server/index.mjs` 8.7k 行、`src/app/App.tsx` 9.2k 行，一
次性拆完不现实。常见做法是加一份「白名单 / 忽略清单」，但那种清单有两个必然结局：

1. **永久化**：没人回头删，因为没有任何机制会提醒；
2. **成为垃圾桶**：新代码直接加进清单（比写规矩便宜），规则于是慢慢失效。

ZCode 的处理是 `max-lines: warn` + 永久白名单——他们自己也知道，所以 35KB 的 policy 里带着一份
长期清单。

## 决策

例外写在 `architecture/policy.json` 的 `exceptions`，每条必须带四个字段：

```json
{ "rule": "max-lines", "file": "server/index.mjs", "ceiling": 8712,
  "deadline": "2027-03-31", "owner": "@qiaowei",
  "reason": "按路由域拆分为 server/routes/*.mjs，见 .wiki/output/plan-architecture-hardening.md#B1" }
```

规则 `exceptions` 的语义：

- **`ceiling` 只降不升**：文件涨过 ceiling 即违规，提示「拆掉，不要抬上限」。`architecture:write`
  在文件变小时**自动下调** ceiling（棘轮只朝一个方向转）。
- **`deadline` 过期即违规**：不再有「以后再说」。
- **条目失效也是违规**：文件已经降到目录上限之下、或已经不匹配该规则时，例外条目本身要删掉
  （否则清单会攒下一堆不再成立的豁免，读起来像噪声）。

## 后果

- 债务变成**有期限、可见、会自己收紧**的东西；`docs/architecture/architecture.md` 的债务表由
  policy 生成，所以「欠了多少」永远等于 policy 里的事实。
- 代价：改动大文件时可能撞到「加一行就得删一行」（`server/index.mjs` 现在正是这个状态）。这是有意
  的压力——正是在提醒该拆了，而不是给上限加一行。
- 已产生的一次真实效果：给 `server/gitInfo.mjs` 加 JSDoc 触发上限后，按规矩拆出
  `server/gitCommit.mjs`（1256 → 1176 行），而不是抬 ceiling。

## 备选方案

- **`warn` 级 + 永久白名单**（ZCode 现状）：警告会被忽略，白名单会积灰。否。
- **一次性还清**（先拆完再上线规则）：规则存在的前提是现在就能跑；且拆 18k 行期间没有任何机器保护。
  否。
