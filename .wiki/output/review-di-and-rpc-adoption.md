---
title: "评审与决策记录：DI / 流式层提案的两处修正、RPC 取舍、可扩展性不变式"
type: doc
status: draft
owner: "@qiaowei"
created: 2026-10-26
updated: 2026-10-26
code_refs:
  - .wiki/output/plan-di-and-rpc-adoption.md
  - server/index.mjs
  - server/domains.mjs
  - server/promptStream.mjs
  - server/httpHelpers.mjs
  - server/sqlite.mjs
  - server/cors.mjs
  - server/sessionStoreFactory.mjs
  - server/localMedia.mjs
  - src/lib/bridge/transport.ts
  - src/lib/bridge/loopback.ts
  - src/features/chat/pollMode.ts
  - src/features/chat/streamCommitBuffer.ts
  - src/shared/chatStreamProjection.ts
  - src/shared/protocol/bridgeEndpoints.ts
  - architecture/policy.json
  - architecture/generated/bridge-surface.json
tags: [architecture, review, bridge, streaming, di, rpc, extensibility]
summary: "对 plan-di-and-rpc-adoption.md 的逐条核验：一条 10 倍事实误差（index.mjs 7,929 → 793，B1 数字目标已达成）、三处内部矛盾，以及「不取 RPC」不挡 WS 中继的证据。范围约束：本次只做架构层面，不加功能，但结构必须留出可扩展性。"
reviewers: ["@qiaowei"]
---

# 评审与决策记录

## 0. 范围与判据

评的是 `.wiki/output/plan-di-and-rpc-adoption.md`（下称**提案**）。

**范围约束（给定）：本次只做架构层面的优化，不加功能，但要保证架构是可扩展的。**

这条约束把提案里的条目切成三类，后文按这三类标注：

| 类 | 含义 | 提案中的例子 |
| --- | --- | --- |
| **结构** | 改形状 / 改内部组织，行为不变，本次可做 | DI 容器、路由表、`setSqliteFactory()`、帧序号、待发上限 |
| **affordance** | 只声明轴与位置，不实现第二档；为将来留位 | 提交/订阅拆开、握手声明档位、断开策略变成配置值 |
| **功能** | 需要新实现才能观察到行为差异 | 实现 `replayable` 档位、中继、跨设备恢复、鉴权 |

**判据**：只采信实测事实；决策分「已定 / 建议 / 未决」三种状态写明，不把建议伪装成结论。提案第 7 节自称出自外部静态阅读、未跑测试，因此本文对它引用的数字全部重新测量。

---

## 1. 已核实事实（本机实测，HEAD = `3c39c37`）

| 提案里的数 / 断言 | 实测 | 判定 |
| --- | --- | --- |
| `server/index.mjs` 当前 **7,929** 行（§5） | **793** 行 | ✗ **10 倍误差** |
| B1 未达 1,200，是 DI 的前置 | 793 < 1,200；`policy.json` 的 `exceptions` 里已无该文件（`.wiki/log.md`「B3 收口」已记） | ✗ **前提过期** |
| 跨域转发闭包 `=> deps.` 248 处 | 248 | ✓ 精确 |
| `@type {any}` 250 处 | 250 | ✓ 精确 |
| 域工厂 15 个 | 15 | ✓ |
| `Object.assign(deps, …)` 15 字面量块 + 15 域返回块 | 30（`grep -c` 计数一致） | ✓ |
| 注入键 137 / 注入 195 次 / 重复 26 键 | 136 / 198 / 32（统计口径差，量级一致） | ~ |
| `protocol-surface` 靠解析源码字面量发现路由 | `scripts/architecture/check.mjs:508` `extractBridgeRoutes(bridgeSource)` | ✓ |
| 冻结表面 100 条路由 | `bridge-surface.json` `routes` = 100；`architecture:check` 输出同为 100 | ✓ |
| 坏行降级成领域错误（传输错与业务错不可区分） | `src/lib/bridge/transport.ts:182` `onEvent({type:"error", message: line})` | ✓ 真缺陷 |
| `writeEvent` / `sendNdjson` 丢弃 `res.write()` 返回值 | `server/promptStream.mjs:130`、`server/httpHelpers.mjs:50` | ✓ 真缺陷 |
| 客户端断开即中止该轮 | `server/promptStream.mjs:446` `!wasStreaming && !closed && isStreaming → abortSession` | ✓ |
| `pollMode` 的 `ownsStream` / 1000 / 15000 / 3000 | `src/features/chat/pollMode.ts` 全对，注释确为「已调优、不许回退」 | ✓ |
| 流帧与快照共享寻址、丢失可计数可补回 | `src/shared/chatStreamProjection.ts` 头部；`droppedEvents` 见 `usePiDesktopApp.ts:110` | ✓ 资产判断正确 |
| `storage` 边界缺注入点 | `policy.json` `protocols[storage].seamGap` 原文一致；`sqlite.mjs` 65 行，唯一调用方 `server/sessionStoreFactory.mjs:29` | ✓ |
| 桥的域在进程内（`ProxyChannel` 无用） | `server/domains.mjs` 15 个工厂 + 248 转发闭包同在一个 Node 进程 | ✓ |
| `BridgeHandshake` 只有 `protocolVersion` / `pid` | `src/shared/protocol/bridgeEndpoints.ts:24-29` | ✓（§2.9 的落点存在） |
| Ada 的 `packages/**` 各项 | 不在本仓库，无法核验 | — 外源，未复核 |

### 1.1 提案未提到、但已核实的三条事实

| 事实 | 证据 | 为什么重要 |
| --- | --- | --- |
| **桥零鉴权，且 CORS 放行任何 origin** | `server/cors.mjs:18` `"Access-Control-Allow-Origin": "*"`；`server/` 内无 `Authorization` / `authToken` / `bearer` 命中；`server/localMedia.mjs:11` 自述 *"the server binds 127.0.0.1 but has no origin check"* | 这是「中继 / 多端」的第一号风险，提案全文未提 |
| **桥边界已是「通道形状」** | `src/lib/bridge/loopback.ts`：`BridgeDispatch` 收**可序列化消息**（原文 *"deliberately takes a serializable message rather than a path string"*），注释给出 MessagePort host 的用法；`tests/bridgeLoopback.test.ts` 以 `globalThis.fetch` 为地雷跑通整层上层 | 「不取 RPC」不影响加 WS 传输，反而有现成证据 |
| **`POST /api/prompt` 没有幂等键** | `server/index.mjs:141` 的 `requestId` 是**服务端每请求生成**，不是客户端带来的去重 id | 「断线后重新 POST」不是降级，而是**重复起一轮、写坏对话** |

---

## 2. 必须修正的部分

### 2.1 「当前 7,929」→ 793，第 1 节的立论要重写〔结构〕

`7,929` 抄自 `.wiki/log.md` 2026-10-23 那条（`index.mjs 8,804→7,929`），而 `.wiki/output/plan-di-and-rpc-adoption.md` 同一段引用的行号（`/api/prompt` 422、`/api/stop` 420、`/api/bootstrap` 160）与**当前** 793 行文件逐一对上——说明读的是拆分后的代码，只是把尺寸数字留在了拆分前。

受影响的三处：

- §1.1「B1 停在这里因为搬不动」——B1 的**数字目标已达成**，功能性前提不成立；
- §1.7「B1 的阻塞项消失」——应改为「转发闭包与 `any` 债务减少」；
- §5「行数下降（当前 7,929；B1 目标 1,200）」——应改为「793，已达标；继续下降是收益而非目标」。

**DI 依然值得做**（248 处转发闭包、250 处 `any`、域无法独立构造，都是真的），但理由是**清债 + 可测试性 + 让请求内核可继续拆**，不是「解锁一个被卡住的 B1」。这个差别决定它排 P1 还是 P3。

### 2.2 §2.7 与 §1.9 自相矛盾〔结构〕

§1.9 说 DI 容器「**不应**登记进 `src/shared/protocol/seams.ts`，因为那是『换实现的那扇门』」。§2.7 却要求把 `bridgeStreamFrames.ts` **登记进 `policy.json` 的 `protocols`**。而 `protocols` 的 7 条全是跨边界可替换契约（bridge / shell / kernel-adapter / storage / perf / local-store / locale），每条都带 `swap` / `seam`。帧信封只是 bridge **内部**的线格式，插进去正是 §1.9 警告的稀释。

**改法**：`src/shared/protocol/bridgeStreamFrames.ts` + 一致性测试（扩现成的 `assertBridgePayload`，目前只用在 bootstrap），**不**新增 `protocols` 行。

### 2.3 验收条件「保留上限」提前了〔结构〕

今天没有保留，所以「保留上限」无对象。§5 应拆成两条：**待发字节上限 = 现在就要**（真缺口）；**保留上限 = 引入保留时同批交付**。

### 2.4 RPC 表述：把「换实现」和「换表面」拆开〔结构〕

§4 把两件事写成一行「换掉 HTTP + NDJSON 传输本身」：

- **换实现**——**已经支持**，`setBridgeTransport()` 就是那扇门（`protocols.md` 的 `bridge` 行 swap 列原文如此），`loopback.ts` + `bridgeLoopback.test.ts` 是证明。写成「不取」，等于把预定方向说成禁区。
- **换表面**（100 条路由 / ETag / NDJSON 语义）——**这才是要拒绝的**。

附带一条硬约束应写进 §2.3 正文：**订阅入口必须留在同一套表面内，不许顺手新开第二条通道**。

### 2.5 `owner/lease` 从「不取」改成「§2.3 的已知后续项」〔affordance〕

理由：今天的服务端 owner 是**隐含**的——就是「启动这轮的那个 HTTP 请求」，`promptStream.mjs:446` 的 `!wasStreaming` 门正是这条策略的编码。§2.3 一旦拆开提交与订阅，「谁有权 stop」就不能再用「哪个请求还开着」表达，必须变成协议里的一个值。**它是 §2.3 的直接产物，不是无关的 Ada 概念。**

且不需要引入 Ada 的 lease/broadcast-claim：`lifecycleGeneration`（每次提交 +1，`usePiDesktopApp.ts:102/827` 已用作 stale-run 防护）就是天然的 owner 凭证候选。

### 2.6 新增一条：登记信任模型缺口〔功能（本次不实现，但要登记）〕

见 1.1。今天的模型是「绑 loopback + 无鉴权 + 放行任何 origin」= 本机上任何网页都能驱动桥（`*` 连响应都可读）。单机单用户下是可接受的权衡；中继/多端一旦进入路线图，暴露面从「本机网页」变成「凡能连到中继者」，且还需要**每客户端身份**。

好消息：后加成本可控（`bypassGuards` 的 `http-fetch` 只放行 `transport.ts`，加 token 只动 transport + 桥的 accept 层）。坏消息：它是唯一一条「不重新设计就上不了多端」的东西，现在完全没有登记。

### 2.7 跨设备 / 中继：措辞从「不取」改成「推迟 + 前置条件」〔功能〕

提案 §0 修正记录承认「Pi 需要重连与跨设备恢复」，§4 却排除中继服务与设备配对，并称之为「新增边界而非本次结构补课」——跨设备恢复没有中继不可实现，二者只能择一表述。按本次范围约束，正确写法是：**推迟，并写明前置条件（见第 4 节）**。

---

## 3. RPC 取舍复核：为什么「不取 RPC」不挡 WS 中继

提案对 RPC 的**方向全对**，但漏掉了自己手里最硬的证据，并且把两类东西记成了一类。

### 3.1 拒绝清单逐条核对

| 拒绝项 | 核实 |
| --- | --- |
| `packages/rpc` 六层栈 | ✓ 它解的是跨进程/跨机器 RPC，且需要自己的序列化、通道、代理、错误信封。Pi 只有 1 条真边界，已有一层（`BridgeTransport`）+ 3 条 bypass 守卫（`local-storage` / `http-fetch` / `host-invoke`）。为替换 100 条已冻结路由引入六层栈 = 负收益 |
| `VSBuffer` 二进制 | ✓ 证据是硬的：`httpHelpers.mjs:16-19` `ETag = md5(JSON body)`，304 表面建立在 **JSON 字符串**上；二进制化会连「没变就别传」一起换掉 |
| `ProxyChannel` 跨进程代理 | ✓（但正确理由是**桥层**已通道就绪，不是「域在进程内」——后者只答了域） |
| `IServiceAccessor` | ✓ RPC 客户端面，与 Pi 无关 |
| ack 确认重传 | ✓ 且是全篇最锋利的一句：**序号不能回溯补加，ack 只在有损传输上有价值**。在 loopback 下 ack 不是「不需要」，是**有害**（每帧白送一个 RTT 换零收益） |
| 只声明 `replayable` 轴、不实现第二档 | ✓ 这条界线划得对 |
| owner/lease | ✗ 见 2.5 |
| 中继 / 配对 / QR | ~ 见 2.7 |

### 3.2 漏掉的证据：桥边界已经是 RPC 形状

`src/lib/bridge/loopback.ts` 把请求定义成**可序列化消息**（`BridgeRequestMessage`），并明写这是为了跨通道存活（structured cloning）；注释直接给出 `// a MessagePort host (nothing about HTTP remains in the picture)`；`tests/bridgeLoopback.test.ts` 用 `fetch` 地雷证明上层不依赖 HTTP。

所以准确表述不是「**RPC 不取**」，而是「**RPC 那个边界已经有了，且已由两个实现证明；不取的是 Ada 在通道之上再叠的六层栈**」。写进去之后，2.4 的拆分也就有了正确切法。

---

## 4. 挡住 WS 中继 / 多端的是哪些（不是 RPC）

| # | 缺口 | 在中继下的后果 | 提案处理 | 本次范围 |
| --- | --- | --- | --- | --- |
| 1 | 无帧序号（§2.4） | 断线后客户端唯一能说的是「我收到 N 了，给我 N+1」；没有序号只能全量重发或丢段，**且不能回溯补加** | 要加 ✓ | **结构**，做 |
| 2 | 提交与订阅焊死（§2.3） | 唯一的「重连」手段是重新 `POST /api/prompt`——而它**没有幂等键**（1.1），重连 = 重复起一轮、写坏对话 | 要拆 ✓ | **affordance**，只加不改 |
| 3 | 断开即 abort（§2.5） | 中继上客户端断开是常态（切后台、网络抖动）→ 今天会**杀掉正在跑的 run** | 要档位化 ✓ | **affordance** |
| 4 | 无界缓冲 / 无保留上限（§2.6） | 跨网络中继=慢客户端是常态 → Node 侧无界缓冲 | 要修 ✓ | **结构**，做 |
| 5 | 所有权（§4 拒绝的 lease） | 多端必须回答「谁能 stop」；§2.3 一落地今天的答案就不可表达 | 拒绝 ✗ | **affordance**，登记后续项 |
| 6 | **信任模型**（1.1） | 暴露面从「本机网页」变成「凡能连到中继者」+ 需要每客户端身份 | **未提** ✗ | **功能**，本次只登记 |

第 5 条要说明的是：`ownsStream` 是**渲染进程的本地状态**（`pollMode.ts`），跨设备根本不存在这个概念的载体——多窗口能用它兜住，多端不能。

**多窗口 vs 多端**要分开看：**多窗口（同机）今天其实还行**，`ownsStream` + `pollMode` 是有意调过的决定，1s 全量只发生在非 owner 窗口。**多端（换设备）不好**，破的是四个假设（owner 是请求、断开即中止、每个窗口自算 `ownsStream`、只服务一个受信本机渲染进程）加一条成本假设（`pollMode` 注释那句「1 KB vs 0.3–0.9 MB × 会话长度」，本地无所谓，跨网络 × 每秒一次不可能）。其中三条由 §2.3/2.4/2.5 解决，成本那条由 §2.3/2.4 从根上消掉，第 4、6 条是提案的政策空洞。

---

## 5. 可扩展性不变式〔本次「只做架构」的可验收定义〕

范围约束要求「不加功能，但保证可扩展」。把它写成**不需实现重连即可验证的结构断言**：

1. 每一帧带**单调递增、不跳号**的序号；同一 run 内可寻址。
2. 存在一条**只订阅、不提交**的路径，且订阅可指定起点。
3. **断开连接的默认行为是一个配置值**（按档位查表），不是处理器里的条件表达式。
4. 单流**待发字节上限**存在，且上限是**协议里声明的值**，不是散落的常量。
5. 握手里声明投递档位；**未实现的档位显式报「不支持」，不静默降级**。
6. 流帧与快照的寻址**继续共享**（`chatBubbleId(turn, role)` 仍是唯一来源）；`droppedEvents` 仍可经快照合并补回——即 §2.2 认定的既有资产**没有漂移**。
7. 传输**实现**可换（`setBridgeTransport()` 唯一装配点 + 第二条实现绿）而**表面不变**（不新增通道、不改既有路由语义）。

**可后加性分级**（决定什么必须现在做）：

| 能后加，成本可控 | 理由 |
| --- | --- |
| WS / 中继传输实现 | 单文件口子，`loopback` 已证明 |
| 每设备投递档位 | 不变式 5 的握手字段就是为它留的位 |
| 保留上限 | 纯服务端 |
| 订阅路由 | 「只加不改」还能满足 surface 等价 |
| 鉴权 | transport + 桥 accept 层 |

**不能后加：帧序号（不变式 1）。** 没有它，已经发生过的帧永久不可寻址，将来只能全量重发或丢段。这是全篇唯一「位置不对就来不及」的一项。

---

## 6. 未决问题

见本文交付时的提问（下一轮 grilling）。未答之前，**DI 容器的定位、提交/订阅是否本次拆、ADP/CONTEXT 是否同步落盘**三项保持未决，不写入 `docs/`。

---

## 7. 建议同时落盘（待确认）

### 7.1 ADR-004 候选：桥的传输不换、也不引入第二套 RPC

三条件核对：

1. **难逆转**：动的是冻结表面与每一帧的形状，反悔要改两边运行时 + 100 条路由的等价性证据；
2. **无上下文会困惑**：将来的人会问「有 HTTPS 为什么不用 WebSocket」「既然没有重连，为什么每帧都带序号」；
3. **真取舍**：备选是 Ada 的 rpc 栈 / 现在就上 WS / 现在就做 ack，三个都被拒，理由具体。

**提议正文要点**：桥保持 HTTP + NDJSON；换**实现**始终允许（`setBridgeTransport()`），换**表面**不允许；为将来的重连只保留 affordance（序号 / 订阅形状 / 档位声明），本次不实现重连、中继与鉴权。

### 7.2 `CONTEXT.md` 词条候选（本项目词表在根 `CONTEXT.md`，不是 `GLOSSARY.md`）

| 词 | 提案定义 | _避免_ |
| --- | --- | --- |
| **重连（reconnect）** | 同一客户端重新接到同一个 run 的流；靠「我收到 N 了」续订 | 与「恢复」混用 |
| **恢复（recovery）** | 新客户端或重启后拿到完整会话状态；靠快照与历史，与同一条流的续订无关 | 说成「重连」 |
| **中继（relay）** | 跨机器的传输路径；它引入**有损传输**，因此是 ack 的唯一适用场景 | 说成「远程功能」 |
| **run owner** | 有权中止该轮的客户端身份；今天隐含为「启动这轮的请求」 | 与「stream holder」混用 |
| **stream holder** | 当前 SSE 流在自己手上的渲染窗口；`pollMode.ts` 的 `ownsStream` 就是它 | 说成「owner」 |
| **帧序号（`streamSeq`）** | run 内单调递增的流帧序号（新增），与寻址用的 `bubbleId` 正交 | 与已有的 **`queueSeq`（pi 队列序号）** 混用 |

### 7.3 落盘清单

若确认落 `docs/`：`.wiki/output/adr-004-*.md` 需**加入 `scripts/architecture/land-docs.mjs` 的 `PLAN` 清单**，否则 `land-docs` 会报 `draft missing` / 不落盘。

---

## 8. 与提案的关系

本文不取代 `plan-di-and-rpc-adoption.md`，而是它的**核验与修订记录**。待第 6 节的三项未决有答案后，提案按 2.1–2.7 修订一次，本文可作为修订依据留档。