---
title: "Spec：桥与流式层的架构可扩展性（不含新功能）"
type: spec
status: draft
owner: "@qiaowei"
created: 2026-10-26
updated: 2026-10-26
tracker: "未发布（`/setup-matt-pocock-skills` 未运行；gh 未登录）"
code_refs:
  - server/domains.mjs
  - server/index.mjs
  - server/promptStream.mjs
  - server/httpHelpers.mjs
  - server/sqlite.mjs
  - server/cors.mjs
  - src/lib/bridge/transport.ts
  - src/lib/bridge/loopback.ts
  - src/shared/chatStreamProjection.ts
  - src/shared/protocol/bridgeEndpoints.ts
  - architecture/policy.json
tags: [spec, architecture, bridge, streaming, di, extensibility]
reviewers: ["@qiaowei"]
---

# Spec：桥与流式层的架构可扩展性（不含新功能）

**范围**：只做架构层面的优化，**不新增用户可见功能**，但结构必须让将来的「重连 / 多端」实现得了。
**术语**：本文用项目词表（`CONTEXT.md`）的既有词（bridge / sidecar / host / session / turn / protocol / seam / 冻结表面 / 棘轮）；新增词在「实施决定 D11」里定义并落 `CONTEXT.md`。
**遵循的 ADR**：ADR-001（一处边界只有「假实现 + 装配点 + 调用点零改动 + 一条绿测试」才算有协议）、ADR-002（不兼容才 bump `PROTOCOL_VERSION`，**加字段不 bump**，`newer` 也算不兼容）、ADR-003（债务例外必须带 `deadline` 与只降不升的 `ceiling`）。

---

## Problem Statement

**从使用者视角**（今天的真实症状，不是假想）：

1. 多窗口时，不持有流的那个窗口拿不到 token，只能**每秒拉一次全量快照**（0.3–0.9 MB × 会话已有多长），会话越长越慢；而且要靠 `idleStreamMs` / `stallReconcileMs` 这类启发式掩盖「流不可恢复」。
2. 断开一次（切后台、网络抖动、窗口重启）就**丢掉正在生成的回答**，而且**没有可重新订阅的对象**——想接着看只能重新提交，那会重复起一轮、把对话写坏（`POST /api/prompt` 至今没有幂等键）。
3. 「传输坏了」和「业务失败」在界面上是同一个红框（坏行被降级成 `{type:"error", message:<原始行>}`），用户分不清这是不是自己该重试。
4. 长回合遇到慢的渲染进程时，桥会把待发数据**无限缓冲**（`res.write()` 的返回值被丢弃）。

**从维护者视角**（结构代价）：

5. 域的跨域依赖**看不见**：136 个注入键装在一个可变袋子里，248 处 `=> deps.x(...)` 转发闭包签名里不体现、类型是 `any`、失败形态是运行期 `deps.x is not a function`。创建顺序即依赖图，且没有任何东西校验它；两个域导出同名函数时，谁赢由展开顺序静默决定。连**定义 `buildSnapshot` 的那个模块自己**（658 行）也从袋子里转发 `findProject`。
6. **同一个浅缝在渲染进程还有一个孪生**：`src/app/useAppModel.ts` 的 `const deps = {} as AppDeps`，接着 7 段 hook 依次 `Object.assign(deps, …)`，而 `AppDeps` 是那 7 段返回类型的**交叉**——每个 hook 都得知道全部。与桥的 `const deps = {}` 是同一模式。
7. 约 100 条路由是一条**顺序敏感**的线性 `if` 链，路由身份编码在函数名里（`handle_get_api_projects_git_diff`）而匹配靠字面量比较；协议表面的发现依赖解析源码文本。
8. `storage` 边界（Bridge ↔ SQLite）的可替换性至今是**「未证明」**：没有注入点，换驱动只能改文件。
9. 结果是：一旦要上重连/多端，上面每一条都会把「加一层」变成「重写一遍」。

---

## Solution

不改变任何用户可见行为，把结构改成「将来加一档、加一条订阅、加一个通道 = 填值/换实现」而不是重写：

- 每一帧带**单调递增、不跳号的序号**——这是续订唯一不能回溯补加的凭证；
- **提交与订阅分开**：新增一条「只订阅、不提交」的入口，`/api/prompt` 的语义与报文**一个字节不改**（新字段属加字段，按 ADR-002 不 bump 版本）；
- **断开的行为变成按档位查表的值**，默认值就是今天的行为；
- **待发字节上限是协议里声明的值**，并真的处理背压（`drain`）；
- 传输错误与业务失败**可区分**；
- 域的依赖由容器在**启动时**校验（拓扑排序 + 完整性 + 名字闸），**桥与渲染进程共用同一种装配**，路由成为数据；
- 模块不再把「进程内不变化的东西」也走一遍可变袋子（快照模块的接口显式收它真正用到的那几个事实，9 处同款转发闭包随之删除）；
- `storage` 边界由「未证明」变「已证明」。

---

## User Stories

1. 作为 Pi Desktop 使用者，我想在切后台或网络抖动后**接着看**同一个正在生成的回答，而不是丢一段或者重新提交，以便不浪费已经在跑的 token。
2. 作为使用者的第二个窗口，我想只拿到**新增的那几帧**，而不是每秒重新解析整个会话快照，以便长会话不再越来越卡。
3. 作为使用者，我想在流断掉时被告知「这是传输问题，可以重试」而不是「业务失败」，以便决定该重试还是该改输入。
4. 作为使用者，我想在长回合 + 慢渲染时应用不会因为无界缓冲而吃掉内存，以便长时间挂着不出事。
5. 作为将来的手机/远程客户端，我想只凭「我收到 N 了」就能续订，以便不需要一个可以重新提交的通道。
6. 作为将来的远程客户端，我想让桥在握手时就告诉我它支持哪个投递档位，而不是让我猜或者静默降级。
7. 作为第二个设备，我想知道「谁能中止这一轮」有唯一的、协议里写明的答案，以便两台设备不会互相打断。
8. 作为维护者，我想在某条请求路径炸之前就知道某个域缺依赖，以便不必等 e2e 或线上才发现。
9. 作为维护者，我想让「创建顺序 = 依赖图」这件事由容器解析而不是靠书写先后，以便挪动代码不会静默改变行为。
10. 作为维护者，我想让两个域导出同名函数时**启动即报错**，而不是靠展开顺序决定胜负。
11. 作为维护者，我想让域的 `create` 只拿得到自己声明的依赖，以便 248 处转发闭包可以按域逐个删掉。
12. 作为维护者，我想能**单独构造一个域**来测它，而不是复现 15 个工厂的创建顺序。
13. 作为维护者，我想新增一条路由只改数据而不改一条 100 行的 `if` 链，以便新增入口不必担心被后缀匹配器吞掉。
14. 作为维护者，我想让路由的优先级是显式字段而不是书写顺序，以便重排代码不改语义。
15. 作为维护者，我想让冻结表面由路由表**直接生成**，以便双向校验不再依赖源码文本形态。
16. 作为维护者，我想让 `storage` 边界有一条真的 swap 测试，以便换驱动时有一张网。
17. 作为维护者，我想让「桥内部结构」和「跨边界的可替换缝」在文档与策略里分开登记，以便不稀释协议表的含义。
18. 作为将来接手的人，我想读到为什么「桥不上 WebSocket、不引入第二套 RPC、也不做 ack」被有意拒绝了，以便不再提一遍。
19. 作为将来接手的人，我想读到「中继/跨设备是**推迟**而不是拒绝」，并知道它的前置条件是什么，以便路线图不丢项。
20. 作为维护者，我想知道唯一还没被登记的多端风险是**信任模型**（桥零鉴权 + CORS 放行任何 origin），以便在有中继之前不会被误判为已解决。
21. 作为 agent，我想让 `architecture:check` 对新规则（`domain-deps`、`route-table`）**用负例证明会咬**，以便「检查通过」不等于「检查器没在工作」。
22. 作为 agent，我想让这次改动**不新增任何 `@type {any}`**（`node-typecheck` 没有基线就是 0 条），以便清理的成绩不被吃掉。
23. 作为使用者，我想这次改动**不改变任何我看到的界面与行为**，以便不用重新验收功能。
24. 作为发布者，我想这次改动的协议表面 diff **只含等价性变化**，以便不需要走一次真正的版本升级。

---

## Implementation Decisions

### 群 A：桥内部结构（与流式无关，可并行）

**A1 — 描述符式域依赖注入容器〔结构〕**
新增一个容器模块，作为唯一的域装配点。域声明 `id` / `provides` / `requires` / `create(ctx)`；容器做三件事，全部**在启动时**完成：

1. **拓扑排序**——创建顺序不再取决于组合区里的书写先后；
2. **完整性校验**——`requires` 里任一名字不被任何域 `provides` → 启动即抛；两个域 `provides` 同名 → 启动即抛；
3. **名字闸**——`create(ctx)` 只拿得到自己 `requires` 里的名字，取别的直接抛。

域本体不改逻辑，跨域引用一律走 `ctx.<name>`。**两侧共用同一种装配**：桥的域工厂与渲染进程的 app-model 段是**同一个浅缝**，容器「按声明解析、启动时校验」的性质对两者一样——这是本项的 leverage 来源（一次深化，两处收益）。
**定位 = 清债 + 可测试性 + 让请求内核可继续拆**；**不是 B1 的前置**（B1 的行数目标 1,200 已由 793 行满足，`exceptions` 里也早已没有该文件）。
迁移路径每步独立可绿，**第②步用 A1b（快照模块）当第一个真实案例**——它的规模已被完整数出来：①只加容器、输出与今天逐字节相同（由既有装配测试锁住）→ ②按 A1b 删掉那批同款转发闭包与袋子键 → ③按域逐个把剩余转发闭包换成 `requires` 声明（从转发最多的域开始、`routesApp` 收尾）→ ④收敛入口的 **34 键** `scope` 字面量：**注意它是「入口启动常量」通道，与域导出有意区分，本步是「明确区分并登记」，不是「合并」** → ⑤入口那行约 200 个名字的解构改为按 id 取 → ⑥渲染侧 app-model 段改成同一容器（7 段各自声明 `requires`）。

**A1b — 先用快照模块把容器证明一遍〔结构〕**
`buildSnapshot` 只在 `server/sessionSnapshots.mjs`（658 行）定义一次（`:247`），却被 **8 处** `deps` 注入，并在 **9 个模块**里各自复制了**同一行**：
`const buildSnapshot = /** @type {any} */ ((...args) => deps.buildSnapshot(...args));`
（`bridgeUtils` / `mcpServers` / `modelLeaves` / `modelProviders` / `projectSessions` / `promptStream` / `routesApp` / `skillLeaves` / `skillPackages`）
这是浅模块的教科书样例：**接口与实现同宽**，`any` 让契约消失，9 份拷贝之间没有任何差别。而它本来就不必如此——`buildSnapshot(targetRuntime, options)` 的第一个参数**已经是 runtime**，只是默认值取自袋子；它真正从袋子里读的只有 `state.apiBase`（3 处）、`state.personalization`、以及 `findProject`（本文件 `:33` 自己也是个转发闭包）。
所以这一步是**把接口显式化**（「接受依赖，不要创建依赖」）：收到 `{ runtime, apiBase, personalization, findProject }` 或声明这几个 `requires`，调用方不必再从袋子里取。它同时也是容器 `requires` 声明的第一个真实样板。

**A2 — 路由成为数据〔结构〕**
路由变成表项（method + 匹配种类 + handler + transport），匹配种类至少含 `exact` / `suffix` / `prefix` / `param`（新增的订阅入口带参数，正好用上 `param`）。**今天靠书写顺序实现的「固定路由优先于后缀匹配」必须变成显式优先级字段**。冻结表面改由表生成，落地后跑一次 `architecture:write`，diff 必须只含等价性变化（路由集合逐条相同）。

**已落地（2026-10-26）**：`server/routeTable.mjs` 是唯一真源（103 行，语义注释随行搬过来），匹配按显式 `priority`（`exact` 0 / 参数化 10，与书写顺序无关），`server/index.mjs` 的 269 行 `if` 链换成 3 行查表（792 → 545 行），处理器按名字从组合区取并在启动时核对「名字存在」。检查器不再正则扒源码文本，改读表（`routesFromTable`）；测试里 20 多处「在源码里找 `url.pathname === "…"`」改成问表（`hasRoute` / `handlerFor` / `routeBody` 由标记反查处理器）。

两处与原文的有意偏差：

- **不实现 `param`**：B2 的订阅入口最后是 `POST /api/runs/stream`（请求体寻址，见 B2 落地说明），今天没有任何带路径参数的路由；没有消费者的匹配种类就是死代码，等真有 `:id` 路由再加（匹配器加一种形态是几行的事）。
- **表里不放 `transport`**：那是 `src/shared/protocol/bridgeEndpoints.ts` 对客户端的声明，搬进表等于同一件事的第二个副本、而且没有检查点；「声明的端点桥都答得出来」已由 `protocol-core` 规则咬着。

另外这次 `architecture:write` 的 diff 里有 12 处**方法被移除**（如 `/api/capabilities` 少了无故的 `POST`）：旧的文本提取器拿 160 字符窗口去正则，会把相邻分支的 `req.method` 算到上一条路径头上。路由集合逐条相同，少掉的都是提取器的假阳性 —— 表面因此更准。

**A3 — `storage` 边界从「未证明」变「已证明」〔结构〕**
`storage` 的 `seamGap` 自己写着缺一个 `setSqliteFactory()`。补上注入点 + 一条真的 swap 测试（用假驱动跑通会话索引的读写与事务语义），然后清空 `seamGap`、按其它协议的样子登记 `seam` 与 `swapTest`。
**已落地**（提交 `0a8b2b0`）：`setSqliteFactory()` + `seams.ts` 的 `storage` 登记 + 假驱动跑真调用点（`tests/bridgeSqlite.test.ts`）；`protocols` 里最后一行「未证明」消失。

**A4 — 治理钩子〔结构〕**
`policy.json` 新增两条规则：`domain-deps`（每个域必须声明 `provides` / `requires`；`requires ⊆ ⋃provides`；`provides` 无重复）、`route-table`（路由表是唯一真源、匹配语义与显式优先级）。**两条都必须带负例证明会咬**（沿用 `protocol-seam` / `no-bypass` 的既有做法）。注意：这是 **bridge 内部**约束，**不**登记进 `src/shared/protocol/seams.ts`。
**`route-table` 已落地**（提交 `4a531fa`）：`policy.routeTable` + `scripts/architecture/lib/routeRules.mjs`，咬三件事：①别的文件再长出「方法 + 路径字面量」分流；②入口不查表；③优先级不是 policy 声明的值 / 行形状不全 / 重复行。三条都有负例，另有一条**反负例**（处理器按路径取参数、注释提到老分支 → 不报）——狼来了的规则等于没有规则。
**`domain-deps` 依赖 A1**（要先有容器里的 `provides` / `requires` 声明才有东西可查），随 A1 一起落。

### 群 B：流式层的可扩展性（只留 affordance，不实现重连）（**B1–B7 全部已落地，2026-10-26**）

落地清单（按提交）：B3 帧信封与错误分类 `b00470d`（新 `src/shared/protocol/bridgeStreamFrames.ts`，两条传输共用构造器）；B1+B4 序号与背压 `af2954f`（新 `server/frameWriter.mjs`）；B2 前半 `df4601e`（`runId` 落帧）；B2 后半 `947b913`（新 `server/runStreams.mjs` + `POST /api/runs/stream`）；B6+B5 `7d549bf`（`deliveryProfile` + `DELIVERY_POLICY` 驱动断开分支）。B7 是硬约束，由既有寻址测试（`chatBubbleId` / `mergeChatBubbles` / 丢弃计数）继续咬着，本轮没有新增代码。

**B1 — 帧序号〔结构〕**
同一 run 内每一帧带单调递增、**不跳号**的序号。命名用 **`streamSeq`**：客户端已有 `queueSeq`（pi 的队列序号），叫 `seq` 会撞车。这是**唯一不能后加**的一项——没有它，已经发生过的帧永久不可寻址，将来只能全量重发或丢段。

**B2 — 提交与订阅分开（只加不改）〔affordance〕**
新增一条**只订阅**的入口，寻址 `(sessionPath, runId, fromSeq?)`。`/api/prompt` 的请求体与响应语义**一个字节不改**，只在响应里**增加** `runId` 字段（加字段，按 ADR-002 **不 bump** `PROTOCOL_VERSION`）。
**硬约束**：订阅必须留在同一套 HTTP + NDJSON 表面内，**不许顺手新开第二条通道**。今天客户端提交后立刻订阅同一个 `runId`，行为与现在等价——变的是**形状**已经允许「提交与订阅分离」这件事存在。

**B3 — 帧信封与错误分类〔结构〕**
今天的现状比「分类不清」更基础：**流帧根本没有共享契约**。`PromptStreamEvent` / `StreamProcessBlock` 只声明在**适配层**且**只有客户端一侧**（`src/lib/api.ts`），桥侧写的是无类型对象字面量；bootstrap 报文有 `assertBridgePayload` 守着，而流帧一个都没有。所以这个模块是桥边界上**第一个由两侧共同跨过的帧缝**（适配器角色：HTTP 与 loopback 两个实现都以它为准）。
保持现有**扁平** `type`，只**增加** `streamSeq` 与 `code`：

- 传输 / 分帧 / 上限类问题 → `type: "transport_error"` + `code: "malformed_line" | "truncated" | "overflow"`；
- 业务失败 → 现有 `type: "error"` + `code: "domain"`。

不引入一个名为 `frame` 的事件类型（frame 是传输单位，用它命名「坏行」会让每个正常事件也都是 frame）。客户端按 `type` 分派的既有逻辑因此不用动。落点：`src/shared/protocol/` 下新增一个 `bridge-safe` 的流式帧模块，与既有 `assertBridgePayload`（目前只用在 bootstrap）同一思路，顺势把自检扩到流式帧。**不新增 `protocols` 登记行**——帧形状是 bridge 内部线格式，不是跨边界可替换缝，登记进去会稀释那张表。

**B4 — 背压与待发上限〔结构〕**
`writeEvent` 检查 `res.write()` 的返回值，`false` 时等 `"drain"`；单流**待发字节上限**存在，且上限是**协议里声明的值**（不是散落的常量）；超限以 `transport_error` + `code:"overflow"` 结束该流，而不是让缓冲继续长。**保留上限不在本次**——今天没有保留，「保留上限」等到引入保留时同批交付。

**B5 — 断开策略成为档位查表值〔affordance〕**
把 `onClientClose` 里「客户端断开即中止该轮」从处理器里的条件分支变成**投递档位上的声明值**：`local-live`（今天）= 断开即中止；将来 `replayable` = 保持运行、为后来的订阅者保留事件。**默认值即今天的行为。**
注意条件里现存的 `!wasStreaming` 门是**有意的**：语义是「只有*启动*这轮的那个请求的断开才中止这轮，后到的请求断开不动别人的 run」。所以这一步是**把已有策略显式化**，不是引入新策略。

**B6 — 握手声明档位〔affordance〕**
`BridgeHandshake`（今天只有 `protocolVersion` / `pid`，入口是 `GET /api/protocol`）增加一个**声明的档位/能力字段**。今天只实现 `local-live` 一个值；**未实现的档位必须显式回「不支持」，不得静默降级**——与 `checkProtocolCompatibility` 把 `newer` 也算不兼容同一原则。取的是 Ada 的 `deliveryProfile` **这个轴**，不是它的两套实现。

**B7 — 既有资产不许漂移〔硬约束〕**
流帧与快照的寻址**继续共享**（`chatBubbleId(turn, role)` 仍是唯一来源）；无法寻址的事件仍是「丢弃并计数、绝不错位」，仍能由 `mergeChatBubbles` 在下一次快照补回。序号的加入**不改变**已有寻址语义。

### 群 C：登记与词汇（**已落地，2026-10-26**）

**C1 — 新增 ADR（桥的传输不换、也不引入第二套 RPC）〔文档〕**
**已落地**：`docs/adr/ADR-004-bridge-transport-surface.md`（含 C2 的 Consequences、C3 的措辞、C5 的拒绝清单）。
内容：桥保持 HTTP + NDJSON；**换实现始终允许**（`setBridgeTransport()` 就是那扇门，`loopback` + `bridgeLoopback.test.ts` 已是第二实现），**换表面不允许**；为将来的重连只保留 affordance（序号 / 订阅形状 / 档位声明），本次不实现重连、中继与鉴权。满足 ADR 三条件：难逆转、无上下文会困惑、真取舍。
**必须记录的理由**：①桥边界**已经是「通道形状」**——`BridgeDispatch` 收的是可序列化消息、注释里就写着 MessagePort host 的用法，所以「不取 RPC」不挡 WS 中继；②Ada 的 rpc 六层栈是在这条边界之上再叠一层，属重复建设；③ack 只在**有损传输**上有价值，loopback 的失败形态是「连接断开」而非「帧丢失」，此时 ack 是每帧白送一个 RTT；④**拒绝的替代项要写下来**（Ada 六层栈 / `VSBuffer` 二进制 / `ProxyChannel` / owner-lease），否则半年后会被重新提一遍。

**C2 — 信任模型缺口登记（只登记，不实现）〔文档〕**（**已落地**：ADR-004 的 Consequences；未新增 policy 机制）
桥今天**零鉴权**且 CORS 放行任何 origin（`Access-Control-Allow-Origin: *`，连响应都可读），只有「绑 127.0.0.1」这一层。这在单机单用户下是可接受的权衡，但中继/多端一旦落地，暴露面从「本机网页」变成「凡能连到中继者」，且还需要**每客户端身份**。写进 ADR 的 Consequences + 本 spec；**不新增 policy 机制**（不为一条未实现的功能加治理字段）。后加成本可控：`http-fetch` 守卫只放行 transport 一处，加 token 只动 transport + 桥的 accept 层。

**C3 — 措辞：中继 / 跨设备是「推迟 + 前置条件」，不是「不取」〔文档〕**（**已落地**：ADR-004 的 Consequences 与本文件的 Out of Scope）
跨设备恢复没有中继不可实现，所以不能一边说「需要跨设备恢复」一边把中继列为「不取」。正确写法是推迟，并写明前置条件 = B1+B2+B4+B5+（C2）。

**C4 — `CONTEXT.md` 新增词条〔文档〕**（**已落地**：`CONTEXT.md` 新增「流式与运行身份」一节，六个词条 + run owner/stream holder 的区分；顺手纠正「冻结表面 96 条」这个陈旧数字）
按词表规则「引入新词或改变既有词的含义时，先改这里再改代码」：

| 词 | 定义 | _避免_ |
| --- | --- | --- |
| **重连（reconnect）** | 同一客户端重新接到**同一个 run** 的流（靠「我收到 N 了」续订） | 与「恢复」混用 |
| **恢复（recovery）** | 新客户端或重启后拿到完整会话状态（靠快照与历史），与同一条流的续订无关 | 说成「重连」 |
| **中继（relay）** | 跨机器的传输路径；它引入**有损传输**，因此是 ack 的唯一适用场景 | 说成「远程功能」 |
| **run owner** | 有权中止该轮的身份；今天隐含为「启动这轮的请求」 | 与「stream holder」混用 |
| **stream holder** | 当前持有 SSE 流的渲染窗口（`pollMode.ts` 的 `ownsStream` 就是它） | 说成「owner」 |
| **streamSeq** | run 内单调递增的流帧序号（新增），与寻址用的 `bubbleId` 正交 | 与已有的 `queueSeq` 混用 |

**C5 — 明确不取（写进 ADR，不在本次实现）**（**已落地**：ADR-004 的「明确不取」表）
`packages/rpc` 式六层栈、`VSBuffer` 二进制序列化（ETag 建立在 JSON 字符串的 md5 上，304 语义会一起被换掉）、持久化协议的 ack 重传、`ProxyChannel` 跨进程代理、`IServiceAccessor`、以及 **owner/lease 的实现**（它是 B2 的后续项，不是无关概念）。也不**替换**传输表面（100 条冻结路由 / ETag 语义 / NDJSON 分帧 / 三条 bypass 守卫）。

**D— 实施顺序**（每步独立可绿；刻意把「越晚越贵」的排前面）

| # | 项 | 为什么在这个位置 |
| --- | --- | --- |
| 1 | A3 `setSqliteFactory()` | 极低风险，立刻消掉一处「未证明」 |
| 2 | B1 帧序号 + B4 背压 | 序号不能后加；背压是唯一可能线上炸的 |
| 3 | B2 提交/订阅只加不改（与 B3 同批） | 唯一越晚越贵，且靠「只加不改」把破坏面压住 |
| 4 | B6 握手档位 → B5 断开策略显式化 | 5 依赖 6 才有地方放 |
| 5 | A2 路由表 + 冻结表面由表生成 | 顺带让 surface 不再依赖源码文本 |
| 6 | A1 DI 容器（先做 A1b 快照案例；与 1–5 全无耦合，可并行） | 清债；B1 的行数目标已达成，不再有前置关系 |
| 7 | A4 规则 + C1–C4 落文档 | 治理与登记收尾 |

---

## Testing Decisions

**什么算好测试**：只断言**外部行为**与**已登记的契约**，不断言实现形态。两条本仓库踩过的教训要遵守：

- **结构性字符串断言**（`expect(source).toContain(<具体实现语句>)`）把实现细节当契约，很容易锁住 bug；改动行为要配行为级测试兜底，而不是改断言。
- **检查器本身要有自检**（正例 + 反例）：新规则 `domain-deps` / `route-table` 必须各有一个负例证明会变红，否则「检查通过」可能只是「检查器没在工作」。

**Seams（要测的东西挂在哪；理想是一条，这里 S1 承担全部行为断言）**

| Seam | 类型 | 承担什么 |
| --- | --- | --- |
| **S1 — 桥边界**：`setBridgeTransport()` + `createLoopbackBridgeTransport` | 既有，**最高** | 所有**客户端可观察行为**：`streamSeq` 单调不跳号、`transport_error` 与业务 error 可区分、超限以 overflow 结束、只订阅路径可指定起点、握手对未实现档位回「不支持」。上层用真 `src/lib/api.ts`，`globalThis.fetch` 换成地雷 |
| **S2 — 组合缝**：`createBridgeDomains(state, deps, scope)` + 路由表数据 | 既有 | 域装配的结构不变式：依赖解析顺序与书写顺序无关、缺依赖启动即抛、同名 `provides` 启动即抛、名字闸生效；路由匹配语义与**显式优先级**（固定路由不被后缀匹配吞掉） |
| **S3 — 策略缝**：`architecture/policy.json` + `runCheck` | 既有 | 规则 `domain-deps` / `route-table` 的正例与**负例**；冻结表面的双向一致与等价性 diff |
| **S4 — `setSqliteFactory()`** | **新增（已定）** | 换驱动后会话索引的读写/事务语义不变（用假驱动） |
| **S5 — 容器本身** | 新增（内部缝：给容器自己的测试） | 拓扑排序与书写顺序无关、缺 `requires` 启动即抛、同名 `provides` 启动即抛、名字闸生效；渲染侧 app-model 段同样可单独构造 |

**接缝纪律**：理想是一条。这里 S1 承担**全部行为断言**，S2/S3 只承担**结构不变式**（它们本来就存在，不改代码就跨不过去），S4/S5 是「已批准的既有边界补口」与「给容器自己的测试用的内部缝」——不是新增的外部缝。**本 spec 不新增任何外部缝。**

**要测的模块与 prior art**

| 模块 | 测什么 | prior art |
| --- | --- | --- |
| `src/lib/bridge/transport.ts` / `loopback.ts`（S1） | 换实现后上层行为不变；NDJSON 分帧语义（含坏行与上限） | `tests/bridgeTransport.test.ts`、`tests/bridgeLoopback.test.ts` |
| `server/promptStream.mjs`（S1） | 帧序号、错误分类、背压收尾、断开策略查表 | `tests/chatStreamProjection.test.ts`、`tests/messageActionsStreaming.test.ts` |
| `server/domains.mjs` + 容器 + 路由表（S2） | 装配与匹配的结构不变式 | `tests/domainAssembly.test.ts`（它已经把「立即解构取到 undefined」「转发体被当对象用」「同一工厂建两次」钉成断言——容器要把这三类变成启动即抛） |
| `architecture/policy.json` + `scripts/architecture/check.mjs`（S3） | 新规则会咬 + 表面等价 | `tests/architecture.test.ts` |
| `server/sqlite.mjs`（S4） | swap 后语义不变 | `tests/bridgeSqlite.test.ts` |
| `src/shared/protocol/` 流式帧模块 | 字段集共享真源 + 运行时自检 | `tests/bridgeMessages.test.ts` |
| 双向消除 | 客户端 `type` 分派在只加 `streamSeq`/`code` 后不用改 | `tests/bridgeProtocol.test.ts` |

**门禁**：`npm run architecture:check` 干净、`npm test` 全绿、`npm run typecheck:node` 退出 0 且 **0 条诊断**（没有基线 = 必须保持 0 条，**不得新增 `any`**）。清理度量（不是 KPI，只做方向验证）：`=> deps.` 从 248 下降、`@type {any}` 从 250 下降。

---

## Out of Scope

- **实现** `replayable` 档位、重连、跨设备恢复、设备配对、QR 握手——本次只声明轴与留结构。
- **中继服务是「推迟 + 前置条件」，不是「不取」**：跨设备恢复没有中继不可实现。前置条件 = B1 序号 + B2 订阅入口 + B4 上限 + B5 断开策略 + C2 的信任模型（见 ADR-004）。
- **鉴权 / origin 检查**（C2 只登记缺口，不实现）。
- **owner/lease 的实现**（登记为 B2 的后续项）。
- Ada 侧被拒的各项：六层 rpc 栈、`VSBuffer`、ack 重传、`ProxyChannel`、`IServiceAccessor`。
- **替换传输表面**：冻结路由集合、ETag/304 语义、NDJSON 分帧、三条 bypass 守卫都不动。
- 保留（retention）与其上限。
- 任何用户可见的功能或界面变化。
- B1 的「行数继续下降到某个数字」——数字目标已达成，继续下降只是收益。

---

## Further Notes

1. **一处事实更正（影响排期判断）**：被评审的计划文档称 `server/index.mjs` 当前 7,929 行、B1 未达 1,200。**实测 793 行**（`3c39c37`；2026-10-24 起就是 780），`policy.json` 的 `exceptions` 里早已没有该文件。7,929 抄自 `.wiki/log.md` 的 2026-10-23 条目。所以「DI 是 B1 的前置」这个因果关系不成立，DI 的理由要改写成清债 + 可测试性。
2. **一处内部矛盾**：被评审文档在「DI 容器不该登记进 `seams.ts`（那是换实现的门）」与「帧信封要登记进 `protocols`」之间自相矛盾。本文按前者的一致性处理：帧信封放 protocol 层模块 + 一致性测试，**不新增 protocol 行**。
3. **`land-docs.mjs` 与 `tests/architecture.test.ts` 里关于 `docs/` 写保护与 `/pw` 的陈旧说明已在本轮改掉**（pi-project-wiki 已关闭）。
4. **未决项按推荐定案**（本 spec 已按这些写）：只加不改地拆提交/订阅；帧序号命名 `streamSeq`、扁平信封 + `transport_error`；DI 定位为清债而非 B1 前置；背压与序号同批；信任模型只登记不实现；ADR + 词表 + 顺序表如上。
5. **未被本 spec 覆盖的三处同类陈旧引用**（`docs/adr/ADR-001` 与其草稿、`docs/reference/design-meta.md`）仍在说 `docs/` 有写保护，建议顺手清掉（ADR-001 需草稿与落盘两份同步改）。
6. **发布状态**：本文件是 spec 的落地形态，**尚未发布到 issue tracker**——`/setup-matt-pocock-skills` 未运行；按建议配置（GitHub tracker + 默认五件套标签，`ready-for-agent`）后即可发布。
7. **2026-10-26 架构审查**（报告：`<tmpdir>/architecture-review-1792993499.html`，跑完即弃）新增/确认的候选，已并入本 spec 的部分：①`deps` 袋**两侧孪生**（A1，渲染侧是新证据）；②`buildSnapshot` 的 9 处同款转发闭包（A1b）；③流帧**没有共享契约**（B3 加强）。
8. **审查中提出但本次不做**（已用删除检验筛过，写在这里以免下次重新提）：
   - `src/shared/chatBubbles.ts` 的接口**与实现同宽**（1162 行 / 46 个导出，投影那边 import 了 15 个）。它通过删除检验（删掉会把复杂度摊回投影与 hooks），所以不是要删，而是要**缩接口**：`build` / `upsert` / `claim` / `merge` / `id` 五个操作，其余内部化。**暂不入本次范围**（纯重构、收益高但风险面在聊天主路径上）。
   - **run 生命周期没有模块**：`ownsStream` / `choosePollMode` / `lifecycleGeneration` / `droppedEvents` / `queueSeq` / `streamCommitBuffer` 分散在 4 个模块，其中 `usePiDesktopApp.ts` 2962 行。B1/B2/B5 落地后它自然会浮出来，**建议作为 B2 的后续项**，本次先不做。
   - **一个协议要从四处学**（`seams.ts` + `policy.json` + 契约文件 + 生成文档）：删除检验不通过（是登记而不是重复实现），但它与 ADR-001 决策 3 同向，属**独立决策**，需自己走一遍 ADR。
9. **删除检验不通过的四处**（不属于候选，别再提）：`src/shared/gitStatusBadge.ts` + `GitStatusBadge.tsx` 是「纯视图模型 + 视图」的深拆分（37 个导出由 `node --test` 直接覆盖）；`chatStreamProjection.ts` 10 个导出、一件事，已经够深；`src/lib/api.ts` 是 ADR-001 决策 2 点名要的客户端契约镜像（它的摩擦是帧的**位置**，即 B3）；`src/i18n/{zh,en}.ts` 是数据不是模块。