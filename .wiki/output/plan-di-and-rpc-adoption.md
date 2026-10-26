---
title: "从 Ada 借鉴两样：域依赖注入 与 流式层的结构性补课"
type: doc
status: draft
owner: "@qiaowei"
created: 2026-10-26
updated: 2026-10-26
code_refs:
  - server/domains.mjs
  - server/index.mjs
  - server/promptStream.mjs
  - server/httpHelpers.mjs
  - server/sqlite.mjs
  - src/lib/bridge/transport.ts
  - src/features/chat/pollMode.ts
  - src/features/chat/usePiDesktopApp.ts
  - src/shared/chatStreamProjection.ts
  - src/shared/protocol/seams.ts
  - architecture/policy.json
tags: [architecture, proposal, bridge, di, streaming, replay]
summary: "Pi Desktop 从 Ada（≈110 万行、多端）只该取两样：描述符式域依赖注入（解 B1 的阻塞项）与流式层的结构性补课。第二样以「保留将来实现重连与跨设备恢复的能力」为硬约束——因为 Pi 已经在为缺失它付出可测量的代价。"
reviewers: ["@qiaowei"]
---

# 从 Ada 借鉴两样，其余不取

## 0. 这份文档的性质与一条重要修正

这不是「Ada 更好，所以照搬」。Ada 是约 **110 万行生产代码**（实测含测试 1,407,605 行，其中测试 309,041）、多窗口、多端、多部署形态的系统；Pi Desktop 是约 **8 万行生产代码**（实测含测试 126,152 行）、单 app、单壳、单用户。规模差约 11 倍，成本结构不同。

所以只取两样，且都做了尺寸裁剪。**判别标准**：只取能解决 Pi 已记录在案的痛点、或为已确认的路线图留出结构的东西；纯属「Ada 有而我们没有」的一概不取（第 4 节逐条拒绝）。

> **修正记录**：本文档第一版把「Pi 没有重连与跨设备恢复的需求」当作前提，据此把 ack 可靠传输、投递档位等整块排除。**该前提是错的**：Pi 需要重连与跨设备恢复，只是尚未实现。因此第 2 节已重写——它不再论证「不取」，而是论证「**取哪些能让将来实现得了的affordance，推迟哪些只在有损传输上才需要的机制**」。相应地，第 4 节的排除清单与第 5 节的验收条件都已变更。

---

## 1. 第一样：描述符式域依赖注入

### 1.1 它解的是已经写在案上的问题

`.wiki/log.md` 记着 B1 停下来的原因，原文：

> `server/index.mjs` 按路由域拆…最大可搬簇一度只剩 29 行 → 剩下的核心是互相咬合的请求内核，**继续拆需要注入化改造，不是机械搬运**。**未到 1,200，记为未完成。**

**这一节就是那个「注入化改造」。** 不是为了让代码更漂亮，是为了让 B1 从「搬不动」变成「搬得动」。

### 1.2 现状实测（`server/domains.mjs` 全文读过，`server/index.mjs` 读过路由与启动段）

| 指标 | 实测值 |
| --- | --- |
| 域工厂数 | 15 |
| `Object.assign(deps, {...})` 字面量块 | 15 |
| 注入的不同键 | 137 |
| 注入总次数（含重复） | 195 |
| **被重复注入 >1 次的键** | **26** |
| 重复最多次的键 | `openRuntimes`×7、`modelRuntime`×7、`buildSnapshot`×7、`refreshSnapshot`×7、`getRuntimeForRequest`×7 |
| `Object.assign(deps, <域返回值>)` 块 | 15 |
| 跨域转发闭包 `=> deps.x(...)` | **248 处** |
| `server/*.mjs` 里 `@type {any}` 标注 | **250 处** |
| 转发闭包最多的文件 | `routesApp.mjs` 53、`skillPackages.mjs` 29、`capabilitySnapshot.mjs` 27、`routesProjects.mjs` 23、`runtimeDomain.mjs` 22 |

具体形态（`server/promptStream.mjs:25-40`，17 处同款）：

```js
const findProject = /** @type {any} */ ((...args) => deps.findProject(...args));
const sanitizePathPart = /** @type {any} */ ((...args) => deps.sanitizePathPart(...args));
const abortSession = /** @type {any} */ ((...args) => deps.abortSession(...args));
// …共 17 处
```

跨域依赖因此是：**签名里看不见、类型是 `any`、调用时才从可变袋子里取、失败形态是运行期 `deps.x is not a function`。**

入口侧（`server/index.mjs`）还有两条并存通道：

- `const deps = {}` —— 模块级**可变单例**
- 一行从 `createBridgeDomains` 解构约 **200 个** `handle_*` 名字
- 同时再传一个 **39 键** 的 `scope` 对象字面量，键与 `deps` 里的名字**重复**（`agentSkillsDir`、`appSkillsDir`、`openRuntimes`、`modelRuntime`…）
- 15 个域对象最后靠 `return { ...a, ...b, … }` **扁平合并**：同名导出由展开顺序静默决定胜负

### 1.3 由此产生的三个真实危险（不是审美问题）

1. **创建顺序即依赖图，且无任何东西校验它。** 顺序错了不报错，只在某条调用路径上炸。
2. **转发闭包把「取不到」推迟到调用时。** 域在构造时不会因为缺依赖而失败，所以一个域缺了 `deps.x` 可以一直活到线上某次请求。
3. **扁平合并让同名冲突静默化。** 两个域导出同名函数时，谁赢由 `return` 里 `...` 的先后决定，无人发现。

### 1.4 Ada 的对应做法（`packages/services`）

Ada 用**描述符 + 集合**，核心是「服务身份是一个显式键，不是变量名或展开顺序」：

```ts
// packages/services/src/descriptors.ts
interface ServiceDescriptor<T> { readonly channelName: string; readonly _brand?: T }
function createServiceDescriptor<T>(channelName: string): ServiceDescriptor<T>;
```

一个名字同时是 interface（类型）和 descriptor（值），phantom `_brand` 让两者共享一个标识符。`ServiceCollection.register(descriptor, instance)` / `get` / `getOptional`，唯一组合根是 `packages/services/src/node.ts` 的 `createLocalServices()`。

### 1.5 取什么、不取什么

- **取**：描述符 / 集合 / 显式声明 `provides`+`requires` / **由容器解析顺序**
- **不取**：`ProxyChannel` 跨进程代理（Pi 的域在**进程内**，没有跨边界问题）、`IServiceAccessor`（那是给 RPC 客户端用的）

> Ada 靠 TypeScript 拿到编译期检查。Pi 的 `server/` 是 `.mjs` + checkJs，**拿不到**。所以 Pi 版必须把校验做成**运行期启动即失败**，这是相对 Ada 的增量，不是照抄。

### 1.6 目标形状

新增 `server/domainContainer.mjs`（一处边界，一个文件）：

```js
// 域声明：不是注释，是被容器读的数据
export const capabilitySnapshotDomain = {
  id: "capabilitySnapshot",
  provides: ["buildCapabilitiesSnapshot", "readCapabilitiesConfig", /* … */],
  requires: ["refreshSnapshot", "openRuntimes", "getRuntimeForRequest", /* … */],
  create: (ctx) => ({ /* 域本体；跨域一律走 ctx.<name> */ }),
};
```

容器做三件事，全部**在启动时**完成：

1. **拓扑排序** —— 创建顺序不再取决于 `domains.mjs` 里的书写先后
2. **完整性校验** —— 任一 `requires` 名字不被任何域 `provides` → 启动即抛；两个域 `provides` 同名 → 启动即抛（取代今天靠展开顺序静默决定胜负）
3. **名字闸** —— 域的 `create(ctx)` 只拿得到自己 `requires` 里的名字，取别的直接抛（取代 248 处「调用时才炸」的转发闭包）

### 1.7 顺带拿到的、可度量的收益

| 收益 | 度量方式 |
| --- | --- |
| 248 处无类型转发闭包可删 | `grep -c "=> deps\." server/*.mjs` |
| 250 处 `@type {any}` 可降 | `grep -rc "@type {any}" server/*.mjs` |
| 域可**独立构造**测试 | 现在测一个域必须复现 15 个工厂的创建顺序 |
| `scope` 第二通道可收敛 | 39 键字面量并入同一份声明 |
| 200 名字的解构可收敛 | 入口改为按 id 查注册表 |
| **B1 的阻塞项消失** | `server/index.mjs` 行数继续下降 |

`node-typecheck` 现在是「**没有基线 → 必须保持 0 条**」（见 `.wiki/log.md` 2026-10-23 条），所以新代码必须带类型。**这条规则本身就在替这次清理站台**——每把转发闭包换成具名注入，`any` 就少一处，而类型闸会阻止它涨回去。

### 1.8 迁移路径（每步独立可绿，一次一个域）

1. **只加容器，不改任何域。** 让 `createBridgeDomains` 用描述符建同一批工厂，输出与今天逐字节相同（用现有测试锁住）。
2. **按域逐个把 `=> deps.x(...)` 换成 `requires` 声明注入。** 一次一个域，每域一个小改动；建议从 `runtimeDomain.mjs`(22) 起手，留 `routesApp.mjs`(53) 收尾。
3. **收敛 `scope` 与 `deps` 两条通道**为一份声明。
4. **入口解构改为按 id 取**，200 名字的一行随之消失。
5. **回到 B1** —— 此时继续拆 `index.mjs` 才成立。

### 1.9 治理钩子（Pi 的必备动作，否则不算完成）

- `architecture/policy.json` 新增规则 **`domain-deps`**：每个域必须声明 `provides`/`requires`；`requires ⊆ ⋃provides`；`provides` 无重复。
- **必须带负例**：故意写一个未声明的 `requires` / 故意让两个域 `provides` 同名 → 必须变红。这是 `protocol-seam` 与 `no-bypass` 的既有做法（`.wiki/log.md` 记着「两条都用负例证明会咬」），新规则不照做就不该合入。
- 注意：这是 **bridge 内部**的约束，**不应**登记进 `src/shared/protocol/seams.ts`。`seams.ts` 的语义是「换实现的那扇门」（跨边界），DI 容器不是。放错地方会稀释那份登记表的含义。

---

## 2. 第二样：流式层的结构性补课

### 2.1 Pi 已经在为「不能重连」付代价（这不是将来问题）

`src/features/chat/pollMode.ts` 的文件头把现状写得很清楚：

> - We own the run and our stream is delivering → `ambient`. …
> - **We are not the one streaming, or a stop is landing → `full`. Another window's tokens never reach us, so the transcript itself is the only signal here.**
>
> …the whole point of the change is a *decision* that must not regress: **it decides whether a tick costs ~1 KB or 0.3-0.9 MB times whatever the conversation has grown to.**

配套的常量：`fullPollMs: 1000`、`stallReconcileMs: 15000`、`idleStreamMs: 3000`；输入字段叫 **`ownsStream`**。

也就是说，**多客户端场景今天已经存在**（多窗口），而当前的设计答案是：只有拥有流的那个窗口拿得到 token，其它窗口退化成**每秒一次的全量快照**，成本随会话增长线性上升（0.3–0.9 MB/tick），并且要靠 `idleStreamMs`/`stallReconcileMs` 这类启发式来掩盖「流不可恢复」这件事。

**结论：重连能力不是未来投资，它是把今天这套轮询启发式换掉的路径。** 所以第二样的目标不只是「补缺失的层」，而是**留下让重连与跨设备恢复将来能实现的结构**。

### 2.2 Pi 已经有的、必须保住的东西（比预想的多）

- `usePiDesktopApp.ts` 的 `SessionStreamState` 已经带 `lifecycleGeneration`（每次提交 +1，用作 **stale-run 防护**：`expectedGeneration !== streamState.lifecycleGeneration` 即丢弃）、`droppedEvents`、`queueSeq`、`controller`。
- `src/shared/chatStreamProjection.ts` 的文件头写明：服务端用**与快照构造器同一个** `chatBubbleId(turn, role)` 计算 `bubbleId`，所以**流帧与快照共享寻址**；无法寻址的事件「dropped and counted, never [silently lost]」，并由 `mergeChatBubbles` **在下一次快照时补回**。

**这已经是一套 replay-aware 的设计**：寻址在两条通道间一致、丢失可计数、可经快照收敛。**这一条是资产，改动中不要让它漂移。**

缺的是另外三样：**流的序号**、**可寻址的订阅**、**保留**。

### 2.3 第一层（最高杠杆）：把「提交」与「订阅」拆开

**现状**：二者融合在一条 `POST /api/prompt` 里（`server/index.mjs:422`）。流的生命周期 == 这个 HTTP 请求的生命周期。重连无从下手，因为**没有一个可以重新订阅的对象**。

同理 `POST /api/stop`（`index.mjs:420`）与 `GET /api/bootstrap`（`index.mjs:160`）是仅有的两个收尾/补齐入口，而 `bootstrap?view=ambient` 是**轮询**，不是订阅。

**Ada 的对应做法**：三个独立的协议动词。

```
session/send      // 提交，不返回流
session/subscribe // 订阅事件流
session/resume    // 从某个位置续订
session/messages  // 读历史
session/events    // 读事件
```

（`packages/shared/src/ada-protocol/index.ts:4066-4077`）

**目标**：
- **提交**返回一个运行身份（`runId`），不带流
- **订阅**是独立入口，寻址 `(sessionPath, runId, fromSeq?)`，返回事件流
- 今天可以让客户端提交后**立刻**订阅同一个 `runId`，行为与现在等价——但**形状**已经允许「提交与订阅分离」这件事存在

**为什么这是最高杠杆**：只要这两件事还焊在一起，将来实现重连就必须重写提交路径。拆开是**唯一一个越晚做越贵的决定**；其余各层都可以后补。

### 2.4 第二层：帧上要有单调序号

**现状**：`queueSeq` 存在，但它跟的是 **pi 的队列**序号，不是**流帧**序号（`chatStreamProjection.ts`：「Last pi-queue sequence this view has applied」）。`promptStream.mjs` 里没有任何帧级计数器。

**目标**：同一 `runId` 内每一帧带单调递增的 `seq`，不跳号。

**为什么必须现在加**：重连的客户端唯一能说的就是「我收到 N 了，给我 N+1」。**序号不能回溯补加**——没有它，历史的每一帧都不可寻址，将来只能选择「全量重发」或「丢一段」。而加一个计数器，成本是几行。

### 2.5 第三层：断开 ≠ 中止（把今天的策略变成显式可配置项）

**现状**（`server/promptStream.mjs` 的 `onClientClose`）：

```js
res.on("close", onClientClose);
// …
if (!wasStreaming && !closed && activeSession.isStreaming) {
  void abortSession(activeSession, { requestId, reason: "prompt_client_close" }).catch(() => undefined);
}
```

**本地单客户端视角下这个选择是合理的**：唯一要这轮的人走了，没有理由继续烧 token。**但它与重连直接冲突**——重连恰恰要求「人走了这轮继续」。

**目标**：把它变成**投递档位上的一个声明值**，而不是处理器里的一个条件分支：

| 档位 | 客户端断开时 |
| --- | --- |
| `local-live`（今天） | 中止该轮（保留现有行为） |
| `replayable`（将来） | 保持运行，为后来的订阅者保留事件 |

注意条件里已有 `!wasStreaming` 的门（排队中的轮次不受影响）。**这个门是不是有意的，请复核**——如果是有意的，它说明「哪些轮次可以放手」这件事已经有隐含策略了，正应该显式化。

### 2.6 第四层：有界保留 + 背压

**现状（唯一有真实崩溃风险的一条）**：`promptStream.mjs` 的 `writeEvent` **忽略 `res.write()` 的返回值**，不处理 `drain`；`httpHelpers.mjs` 的 `sendNdjson` 同样。

```js
const writeEvent = (payload) => {
  if (closed || res.destroyed) return;
  res.write(`${JSON.stringify(payload)}\n`);   // ← 返回值被丢弃
};
```

长回合（几十次工具调用、逐 token 的 `delta`）遇上慢的渲染进程 → **Node 侧无界缓冲**。

**一旦引入保留（为将来重连所需），这条从「最好修」变成「必须先修」**：保留缓冲按定义就需要一个上限，否则就是把无界内存换了个地方。

**Ada 的做法是把上限写进协议，而不是靠启发式**：V4 投递档位里 `flushWindowMs` 与 `streamOutputCapBytes: 262144` 都是**声明值**；两档的差异也是声明出来的——`continuous { desktopOnlyRows:true, flushWindowMs:30, streamOutputCapBytes:262144, toolProgress:false }` 对 `replayable { desktopOnlyRows:false, flushWindowMs:150, streamOutputCapBytes:0, toolProgress:true }`（`packages/shared/src/ada-protocol-v4/profiles.ts`）。

**目标**：
- `writeEvent` 检查返回值，`false` 时等 `"drain"`
- 单流**待发字节上限** + 单 run **保留上限**，两者都是协议里声明的值
- 超限发一个 `frame` 类事件并结束该流（见 2.7），而不是让缓冲继续长

### 2.7 第五层：流式帧信封 + 明确的错误分类

**现状（真实缺陷）**：客户端按 `\n` 切分并 `JSON.parse`，坏行**降级成一个和领域错误同形的事件**（`src/lib/bridge/transport.ts`）：`{ type: "error", message: <原始行> }`。服务端流式失败同样是最后一行 `{type:"error", message}`。于是**「传输坏了」与「业务失败」不可区分**。

**目标**：

```js
{ type: "frame",  seq, code: "malformed_line" | "truncated" | "overflow", raw?: string }  // 传输/分帧/上限
{ type: "error",  seq, code: "domain", message: string }                                  // 业务失败
```

**契约落点**：`src/shared/protocol/` 下新增 `bridgeStreamFrames.ts`（protocol 层，`bridgeSafe: true`，两个运行时共用），并登记进 `policy.json` 的 `protocols`。与已有的 `assertBridgePayload`（`src/shared/protocol/bridgeMessages.ts`，目前只用在 bootstrap）同一思路，可顺势把自检扩到流式帧。

### 2.8 第六层：路由表（替代 if-chain）

**现状**：`server/index.mjs` 的约 100 条路由是一条线性 `if` 链，**顺序敏感**，文件注释自己承认：

```js
// 形如 /api/model-providers/login/respond 的固定路由要排在前面，别被这里吞掉。
```

随后三个后缀匹配器会吞掉任何后写的固定路由：`endsWith("/verify-key")`、`endsWith("/logout")`、`endsWith("/login")`。

而且路由身份被**编码进函数名**（`handle_get_api_projects_git_diff`），匹配却靠字面量比较——**声明与匹配是两套东西**。

**目标**：路由变成数据。

```js
{ method: "GET", match: { kind: "exact", value: "/api/projects/git" }, handler, transport: "json" },
{ method: "POST", match: { kind: "suffix", value: "/login" }, handler, transport: "ndjson" },
```

**必须保留**：固定路由优先于 `suffix`/`prefix` 的**显式优先级字段**——今天靠书写顺序，改数据后必须变成显式值。新增的订阅入口（2.3）会带参数，正好用上 `kind: "param"`。

**额外收益**：`protocol-surface` 规则今天必须**解析 `url.pathname === "..."` 字符串字面量**才能发现路由。路由成为数据后，`bridge-surface.json` 可由表**直接生成**，双向校验不再依赖源码文本形态。落地后须跑 `npm run architecture:write`。

### 2.9 第七层：握手声明投递档位

**现状**：`src/shared/protocol/bridgeEndpoints.ts` 已有 `BridgeHandshake { protocolVersion, pid? }`，入口是 `GET /api/protocol`（最便宜、不构建快照）。

**目标**：握手里增加一个**声明的档位/能力字段**（如 `deliveryProfile` 或 `capabilities`）。今天只实现一个值（`local-live`）；**未实现的档位必须显式回「不支持」，不得静默降级**——这是 `checkProtocolCompatibility` 把 `newer` 也算不兼容的同一原则。

**为什么现在就要**：档位一旦在握手里声明，「同一个桥服务不同客户端」这件事就有了位置，将来加 `replayable` 是填一个值，而不是改一遍握手语义。**这里取的是 Ada 的 `deliveryProfile` 这个轴，不是它的两套实现。**

### 2.10 顺带一条（低成本高分）：把「未证明」变成「已证明」

`architecture/policy.json` 的 `storage` 协议条目自己登记了缺口：

> `seamGap`: `openSqliteDatabase()` 是唯一命名 `node:sqlite` 的地方，但还没有注入点（缺一个 `setSqliteFactory()`）；调用方直接拿单例，所以换驱动只能改文件、不能换实现

`server/sqlite.mjs` 只有 65 行，`openSqliteDatabase` 是唯一出口。补 `setSqliteFactory()` + 一条 swap 测试，就能让 `protocols.md` 里那格从 **未证明** 变 **已证明**。**全篇投入产出比最高的一项。**

---

## 3. 建议实施顺序

每步独立可绿、可单独评审。**刻意把「越晚越贵」的排在前面**：

| # | 项 | 为何是这个位置 | 依赖 |
| --- | --- | --- | --- |
| 1 | `setSqliteFactory()`（2.10） | 极低风险，立刻消掉一处「未证明」 | 无 |
| 2 | **提交/订阅拆开（2.3）** | **唯一一处越晚越贵的结构性决定** | 无 |
| 3 | 帧加单调 `seq`（2.4） | 与 2 同批做；序号不能回溯补加 | 与 2 同批 |
| 4 | 帧信封 + 错误分类（2.7） | 只加类型，不改语义 | 无 |
| 5 | 断开策略显式化（2.5） | 依赖档位字段（2.9）才有地方放 | 2.9 |
| 6 | 握手声明档位（2.9） | 小改动，为 5 与将来铺位 | 无 |
| 7 | 有界保留 + 背压（2.6） | 一旦有保留就变成必须先修 | 2.4 |
| 8 | 路由表（2.8） | 顺带让 surface 可由表生成 | 无；建议在 2 之后 |
| 9 | DI 容器（第 1 节） | 与 1–8 全无耦合，可并行；**B1 的前置** | 无 |

第 1–8 项与第 9 项**互不依赖**，可并行推进。第 9 项做完，B1 才能继续。

---

## 4. 明确不取的清单

| 不取 | 理由 |
| --- | --- |
| `packages/rpc` 整体六层栈 | 为 MessagePort/WebSocket + 二进制设计，服务 Electron 多进程与远程工作区 |
| `VSBuffer` 二进制序列化 | Pi 的桥是 JSON；ETag/304 建立在 JSON 字符串的 md5 上（`httpHelpers.mjs:15-40`） |
| **`persistent-protocol` 的 ack 确认重传** | **现在不需要，但不能因此不做序号。** ack 只在有损传输上才有价值（中继/WebSocket 断线重传）；本地 HTTP 的失败形态是「连接断开」，不是「帧丢失」。**精确的界线是：序号现在加，ack 等到真有有损传输再加**——而序号正是让 ack 将来可能实现的前提 |
| `ProxyChannel` 跨进程代理 | Pi 的域在进程内 |
| 换掉 HTTP + NDJSON 传输本身 | 会推翻冻结表面（100 条）、ETag 语义、loopback 第二实现、三条 bypass 守卫 |
| 中继服务、设备配对、QR 握手 | Pi 目前没有 `web-remote-control.ts` 那样的中继面；将来若做，属于新增边界而非本次的结构补课 |
| owner/lease、跨窗口原子抢占 | Pi 用一个 window 级 `ownsStream` 已经覆盖**单机多窗口**；Ada 的 lease/broadcast-claim 是为**跨设备**所有权问题存在的，等真有跨设备再加入 |
| **实现 `replayable` 档位本身** | 本次只要求**声明这个轴并留出结构**，不要求实现第二档。这正是「可扩展性」与「提前实现」的分界 |
| `IServiceAccessor` | 那是 RPC 客户端面；Pi 的域是进程内函数 |

---

## 5. 验收（必须全部为真）

**基础门禁**

- `npm run architecture:check` 干净；`npm test` 全绿（当前 `architecture: clean (301 files, 757 imports, 10 modules, 100 protocol routes, boundary v1)`）
- `npm run typecheck:node` 退出码 0、0 条诊断（规则已改为「没有基线 → 必须保持 0 条」，**不得新增 `any`**）
- 新增规则 `domain-deps` 与 `route-table`，**各自带负例证明会咬**
- `@type {any}` 计数下降（起点 250）；`=> deps.` 计数下降（起点 248）
- `server/index.mjs` 行数下降（当前 7,929；B1 目标 1,200）——DI 完成前不要求达成，完成后应重新可推进

**可扩展性不变式（不需实现重连即可验证）**

- 每一帧带 `seq`；同一 `runId` 内单调递增且**不跳号**
- 存在一条**只订阅、不提交**的路径，且订阅可指定 `fromSeq` 起点
- **断开连接的默认行为是一个配置值**（按档位查表），不是处理器里的条件表达式
- 单流的待发与保留都有上限，且**上限是协议里声明的值**，不是散落的常量
- 握手里声明投递档位；**未实现的档位显式报「不支持」**，不静默降级
- 流帧与快照的寻址**继续共享**（`chatBubbleId(turn, role)` 仍是唯一来源）；`droppedEvents` 仍可经快照合并补回——即 §2.2 的既有资产没有漂移

**其他**

- 背压生效：单流超限以 `frame` 类事件结束，不再无界缓冲
- `protocols.md` 的 `storage` 条目由「未证明」变「已证明」
- 若因路由表变更重新生成 `bridge-surface.json`，diff 必须**只含等价性变化**（路由集合逐条相同），并在改动说明里单独交代

---

## 6. 如果只做一件事

分两种意图，答案不同：

- **如果重连与跨设备恢复确实在路线上（按你的说明，是的）** → 做 **2.3（提交与订阅拆开）+ 2.4（帧序号）**。这是唯一两项**越晚做越贵**的：只要提交与流还焊在一条 `POST /api/prompt` 上，将来实现重连就必须重写提交路径；序号不回溯补加。
- **如果只求消除当下风险** → 做 **2.6（有界保留 + 背压）**。它是唯一一条「不修可能在生产上炸」的，改动只落在 `server/httpHelpers.mjs` + `server/promptStream.mjs`。

**如果目标是解锁后续所有拆分** → 做 **第 1 节（DI 容器）**，因为 B1 已被它卡住一次，且记录在案。

---

## 7. 我可能判断错的地方（请 Pi 自己复核后推翻）

这份提案来自**外部静态阅读**（读过 `server/domains.mjs` 全文、`server/index.mjs` 的路由与启动段、`server/promptStream.mjs`、`server/httpHelpers.mjs`、`server/sqlite.mjs`、`src/lib/bridge/transport.ts`、`src/features/chat/pollMode.ts`、`src/shared/chatStreamProjection.ts`、`architecture/policy.json`），**没有运行过 `npm test`**，也未读完全部 74 个 `server/*.mjs`。以下几条最可能被推翻：

1. **`@type {any}` 的 250 处里，有多少真是跨域转发造成的？** 我只按 `=> deps.` 数出 248 处转发闭包，但存在其他来源（如 pi 内核返回值）。**真实可清理量应以逐域核查为准，不要按我的数字立 KPI。**
2. **`scope` 那条 39 键通道是否真的冗余？** 它可能是「启动常量」与「域导出」的**有意区分**（启动常量不该被域覆盖）。若是，1.8 第 3 步应改为「明确区分两者」而不是「合并」。
3. **`onClientClose` 里的 `!wasStreaming` 门是不是有意的？** 它意味着「排队中的轮次不会因断开而被中止」。若这是有意策略，2.5 的目标就不是「引入策略」而是「把已有策略显式化」。
4. **多窗口今天是否已在用 `full` 轮询兜底，且被接受？** `pollMode.ts` 的注释语气像是在描述一个**已调优的**方案，而不是一个待替换的权宜。若团队认为 1s 全量轮询可接受，2.3 的紧迫性要下调——**但代价随会话增长线性上升这一点仍然成立**。
5. **背压是否已被渲染侧的 `streamCommitBuffer`（16ms 合帧）兜住？** 我没查到确定证据。**若没有，这条优先级要提到最高。**
6. **拆开提交与订阅会不会破坏 `bridge-surface.json` 的等价性？** 新增订阅入口属于**加路由**，不是改路由；但若同时调整 `/api/prompt` 的返回语义，则是一次协议变更，需要按 `ADR-002` 判断是否 bump `PROTOCOL_VERSION`。这一点我没有定论，留给实现时判断。