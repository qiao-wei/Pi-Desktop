---
id: ADR-005
title: "域装配由容器接管，依赖声明是生成物而不是手写清单"
type: adr
status: approved
owner: "@qiaowei"
created: 2026-10-26
updated: 2026-10-26
related: [ADR-001, ADR-003]
code_refs:
  - server/domainContainer.mjs
  - server/domainTable.mjs
  - server/domains.mjs
  - scripts/architecture/lib/domainDeps.mjs
  - scripts/architecture/lib/domainRules.mjs
  - architecture/policy.json
  - docs/specs/architecture-extensibility.md
tags: [architecture, dependency-injection, governance, bridge]
summary: "桥侧的域装配从「手写顺序 + Object.assign 夹块」改成容器 + 生成表 + 启动时四项校验；排序只认建厂期读取（闭包读取不参与）；provides 不声明而是运行时核对；248 份手写纯转发一并拆掉。"
reviewers: ["@qiaowei"]
---

# ADR-005：域装配由容器接管，依赖声明是生成物而不是手写清单

## 背景

`server/index.mjs` 拆成 15 个域之后，装配（谁在谁之前建、每个域建厂期要读哪些名字）编码在
`server/domains.mjs` 的 **450 行**里：一串 `const X = createY(state, deps)` 加约 200 行手写的
`Object.assign(deps, { … })` 夹块，把「下一个工厂建厂期会解构的名字」逐个喂饱。

这条契约没有牙：`deps` 是无类型对象（`any`），漏填一个名字不会有任何类型错误，工厂解构到
`undefined` 后会静静烂进闭包——只在某条没人跑过的请求路径上炸。`tests/domainAssembly.test.ts`
当时写了两条不变式去守这种写法（「立即解构不能取到 `undefined`」「转发名不能被当对象用」），
其中一条正是在修一个已经上线过的真 bug（见 `e2e/README.md`）。

同时全仓有 **248 份**同款纯转发闭包 `const x = /** @type {any} */ ((...args) => deps.x(...args))`
——它们是 `@type {any}` 堆（250 处）的主要来源，等价于「把 `deps.x` 换个名字再抄一遍」。

问题是：**怎么让依赖有牙，而不再多一份会漂的第二真源？**

## 决策

1. **唯一装配点**：`server/domainContainer.mjs`。启动时按域表建域，做四件事：名字闸（读未声明的名字立刻抛）、
   建厂期就绪校验（建厂期读到的名字必须已有值）、发布（返回值整包进共享袋，重名即抛）、合并导出。
   全部 fail-fast：装错了桥起不来，而且报错指名域与名字。
2. **依赖声明是生成物**：`server/domainTable.mjs` 每域一行 `{ id, create, eager, lazy }`，由
   `scripts/architecture/lib/domainDeps.mjs`（TypeScript 解析器）从各域模块的真实读取生成，
   `npm run architecture:write` 写、`architecture:check` 逐字节校验。手改会被打回。
3. **排序只认建厂期读取**：`eager` 是排序约束，`lazy`（闭包里的读取）只是名字闸的白名单，**不参与排序**。
4. **`provides` 不声明，运行时核对**：容器记录每个域真实返回的键；重名即抛，声明的名字最终没有值也抛。
   `requires ⊆ ⋃provides` 因此是对**真实值**的核对，比对名字的静态核对更强。
5. **不再手写纯转发**：跨域读取在调用点直接写 `deps.x(...)`；248 份转发全部删除，`domain-deps` 规则
   咬住「再长出来」。

## 理由

- **排序约束只有建厂期读取**。把闭包读取也算进去会凭空造出 130+ 条反向边和一个真环
  （`promptStream` 读 `sessionSnapshots.buildSnapshot`，`sessionSnapshots` 读 `promptStream.abortSession`），
  而闭包读取对建厂顺序没有任何要求——按它排序只会得到「顺序被搅乱、收益为零」。
  实测 15 个域的 **63 个建厂期读取全是外部注入的常量**：域之间建厂期零依赖（0 条内部边、无环）。
- **不做自动拓扑排序**。自动排序需要先知道「谁提供什么」，也就是要手写 330 个 `provides`——那是一份新的
  手抄漂移面，而且它要解决的问题今天不存在（零条建厂期内部依赖）。容器改为校验：建厂期读到还没就绪的
  名字就**当场抛**。注意排序错误时容器**点不出提供者的名字**（那个域还没建，袋里没它的导出；表只记
  「谁读」不记「谁提供」），所以消息给的是动作：去 `server/` 里找哪个域 `return` 了它。顺序仍是表里
  一行的位置——**显式 diff，且有校验**。之所以必须当场抛而不是汇总到末尾，是因为返回值是 `undefined`
  时真正炸的是**调用点**（`deps.findProject is not a function`）：拿到的报错会与装配无关。
- **生成而不是手写声明**。313 个名字（63 个建厂期 + 250 个闭包读取）手抄必然出错，而它们 100% 可从
  模块文本推导。生成物的价值不在于省人力，
  而在于它同时是**名字闸的白名单**和**完整性校验的输入**：少一个多一个都会红，于是「声明」与「实际」
  不可能各自漂移。与 `architecture/generated/bridge-surface.json` 同一套做法。
- **删掉转发层**。转发与直接读 `deps.x` 的语义完全相同（都是调用时取值），但转发看起来像本地函数
  （`x.get(...)` 这类误用就是由此而来，那条测试就是在守它），而且掩盖了「这是跨域依赖」这个事实。

## 被拒的方案

| 方案 | 为什么不 |
| --- | --- |
| 容器 **自己**做拓扑排序（声明 `provides` + 自动排序） | 需要手写 330 个 `provides`；今天零条建厂期内部依赖，收益为零，成本是一份新的漂移面 |
| 让域**手写** `requires` 声明（从提取器抄一遍） | 同一事实的两份副本；生成 + 逐字节校验已经把漂移压到零 |
| 保留转发闭包（只是把它变得更有类型） | 248 份手抄副本、`any` 依旧、误用依旧；容器已经提供了名字闸，转发不再承担任何职责 |
| 用成熟 DI 框架 | 这里只需要「启动时四项检查」；框架会带来生命周期/作用域/装饰器等语言，而它们不解决本仓的任何问题 |
| 把常量通道（34 键 `scope`）也收进域声明 | 那是**外部注入**（路径/环境/共享结构），不是域导出；混在一起会让「谁提供什么」变得不可判 |

## 后果

- `server/domains.mjs` **450 → 23 行**；`@type {any}` 转发堆消失；装配错误从「某条路径上炸」变成
  「启动 throw + 指名域与名字」。
- 新增一个域 = 写模块 + `npm run architecture:write`（表里多一行，import 也是生成的）。（原先散在
  `server/domains.mjs` 里那批 ~200 名字的解构也在同一批清理中消失。）
- **A1b 原文的「显式化接口」只落到其中一支**：落在「声明 `requires`（生成）」这支，不是「显式收参数」这支
  ——`buildSnapshot` 仍从袋里读 `findProject`，调用方仍写 `deps.buildSnapshot(...)`。袋子就是容器给的接口，
  名字闸保证它只能读声明过的名字；若将来要改成参数注入，表里的 `requires` 就是现成的输入。
- **A1 迁移路径的 ①–⑤ 已完成**（容器、删转发、按域声明、常量通道明确区分、入口只剩按名字取 3 个名字）；
  **⑥ 未做**：渲染侧 app-model 段的同类装配尚未收敛到同一容器。
- **有意的行为差异**：常量通道在容器里**全局可见**（今天是渐进式 `Object.assign`，只看得见「此刻已在袋里」
  的名字）。这只会把「读不到」变成「读得到」，不会破坏今天能跑的读；等价性论述不声称逐字节相同。
- 依赖治理现在是**两条腿**：静态（`domain-deps` 规则：表 vs 真实读取、无动态读取、无转发、表必须有人读）+
  运行时（容器：名字闸、就绪、重名、完整性）。缺一条都会退化成「检查器没在工作」。
- 渲染侧 app-model 段的同类装配**尚未**收敛到同一容器（spec 群 A 的第 ⑥ 步）；两侧今天仍是各自一套，
  等真要做时以本 ADR 的容器为参照，而不是再发明一遍。

## 相关文档

- spec：`docs/specs/architecture-extensibility.md`（群 A「已落地」段含四处有意偏差 + 两条未做）
- 词表：`CONTEXT.md`「域与依赖（桥侧装配）」
- 规则表：`docs/architecture/architecture.md` §4 的 `domain-deps` / §7 的「新增一个域」配方
- 词表：`CONTEXT.md`「域与依赖（桥侧装配）」——域 / 域表 / 建厂期读取 vs 闭包读取 / 名字闸 / 纯转发 / 域容器
- 规则：`architecture/policy.json` 的 `domainDeps`；检查器 `scripts/architecture/lib/domainRules.mjs`