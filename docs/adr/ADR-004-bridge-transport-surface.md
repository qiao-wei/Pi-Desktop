---
id: ADR-004
title: "桥的传输表面不换、也不在它上面再叠一套 RPC"
type: adr
status: approved
owner: "@qiaowei"
created: 2026-10-26
updated: 2026-10-26
related: [ADR-001, ADR-002]
code_refs:
  - src/shared/protocol/bridgeEndpoints.ts
  - src/lib/bridge/transport.ts
  - src/lib/bridge/loopback.ts
  - server/routeTable.mjs
  - architecture/generated/bridge-surface.json
  - docs/specs/architecture-extensibility.md
tags: [architecture, protocol, streaming, rpc]
summary: "HTTP + NDJSON 表面冻结；实现可换（setBridgeTransport）。重连只留 affordance（streamSeq / 订阅入口 / 档位声明），本次不实现重连、中继与鉴权；Ada 的六层 rpc 栈等被拒。"
reviewers: ["@qiaowei"]
---

# ADR-004：传输表面不换，也不叠第二套 RPC

## 背景

「将来要支持断线重连 / 多端 / 跨设备」这条需求，最容易推出的结论是「现在的桥协议不够用，先换一层」。
评审 Ada 侧的方案时出现过两个候选：

1. **换成 RPC 框架**（Ada 的 `packages/rpc`：六层栈，含编码层、通道层、服务代理、ack 重传）；
2. **在现有 HTTP + NDJSON 之上再叠一层带 ack 的 RPC**，理由是「流帧可能丢」。

两条都值得先问一个事实问题：**这条边界今天是什么形状？**

- `BridgeDispatch`（`src/lib/bridge/loopback.ts`）收的是**可序列化消息**（`BridgeRequestMessage`），
  注释里本来就写着「故意不收路径字符串，因为换成别的通道时它还得成立」（MessagePort host 的用法）
  —— 它**已经是「通道形状」**，不是「一组 HTTP 动作」；
- 传输实现已经有两份：`transport.ts`（HTTP）与 `loopback.ts`（同进程直连），后者被
  `tests/bridgeLoopback.test.ts` 逐条跑同一套行为。换实现这扇门是真的（`setBridgeTransport()`）；
- 帧的失败形态：HTTP 与 loopback 的失败都是**连接断开**（写失败 / 进程消失），不是「帧乱序丢失后仍然继续」。
  ack 与重传只在**有损传输**上换来东西；在本地连接上它每帧白送一个 RTT。

也就是说：**「要重连」需要的是帧可寻址（序号 / 订阅），不是换传输。**

## 决策

1. **传输表面冻结，实现可换**。保持 HTTP + NDJSON；冻结的 101 条路由、ETag/304 语义、NDJSON 分帧、
   三条 bypass 守卫都不动。换实现（HTTP → MessagePort / 中继 socket）**始终允许**，因为门在
   `setBridgeTransport()`；**换表面不允许**（那会让冻结表面、ETag 语义与客户端分帧同时失效）。
2. **不引入第二套 RPC**，也不在现有表面之上叠带 ack 的代理层。
3. **为将来的重连只留 affordance**（本次已落地）：帧序号 `streamSeq`、只订阅的入口
   `POST /api/runs/stream`（寻址 `(sessionPath, runId, fromSeq?)`）、握手声明投递档位
   （`deliveryProfile`）与断开策略（`DELIVERY_POLICY`）。**本次不实现重连、不实现 `replayable` 档位、
   不实现中继与鉴权。**
4. **信任模型的缺口登记在案**（本 ADR 的「后果」）：桥今天**零鉴权**，且 CORS 放行任何 origin
   （`Access-Control-Allow-Origin: *`，响应可读），只有「绑 127.0.0.1」这一层。单机单用户下这是
   可接受的权衡；**中继一旦落地，暴露面从「本机网页」变成「凡能连到中继者」，并且还需要每客户端身份**。

## 理由

1. **重连要的是寻址，不是新协议**。有了 `(runId, streamSeq)`，「我收到第 N 帧了，接着发」是一个
   普通请求；没有它，任何协议都得全量重发或允许丢段。所以先把序号与订阅入口做出来，
   传输与鉴权可以以后换 —— 顺序错了，代价是白换一层协议。
2. **六层栈是在这条边界之上再叠一层**，本边界已经提供它要提供的东西（可序列化消息 + 可替换实现），
   叠上去只增加「两端都要跟着动的层」，换不来能力。
3. **ack 的适用场景是丢帧，不是断连**。断连时唯一正确的动作是重连 + 从某个序号续订，而不是重传
   已发出的帧；在有损传输出现之前，ack 是纯开销。
4. **拒绝的替代项要写下来**，否则半年后会被重新提一遍（见下）。

## 后果

- **重连 / 跨设备 / 中继是「推迟 + 前置条件」，不是「不取」**：跨设备恢复没有中继确实不可实现，
  但写「不取」会与「将来要支持跨设备」自相矛盾。前置条件写清：B1 序号 + B2 订阅 + B4 背压上限 +
  B5 断开策略 + **C2 的信任模型**（身份与鉴权）。见 `docs/specs/architecture-extensibility.md`。
- **中继落地时必须一起做的两件事**（后加成本可控，但不做就是漏洞）：① 每客户端身份（token/配对），
  `http-fetch` 守卫只放行 transport 一处，所以加 token 只动 transport + 桥的 accept 层；
  ② origin 检查（今天 `*` 放行、连响应都可读）。`http-fetch` 守卫放行的只有两处
  （`transport.ts` 本体 + 取图片二进制自己造 blob URL 的 `image.tsx`），加 token 不用碰任何调用点。
- **`replayable` 档位现在是「未实现」而不是「不存在」**：握手声明了 `deliveryProfile` 这个轴，
  客户端对不认识的档位**显式判为不兼容**（与 ADR-002 把 `newer` 算不兼容同一原则），所以将来加档位
  不会被旧客户端静默按旧假设对待。
- 桥内部的结构（路由表、帧写入器、run 订阅）按「本机单用户」优化过：待发上限、断开即中止、
  日志有界。中继落地时这些值都要重新定，但**位置**已经在那里了。

## 明确不取（本次也不实现）

| 被拒项 | 理由 |
| --- | --- |
| Ada `packages/rpc` 式六层栈 | 在本边界上重复建设；本边界已是通道形状 |
| `VSBuffer` 二进制序列化 | ETag/304 建立在 JSON 正文的 md5 上（`server/httpHelpers.mjs`），换编码会把 304 语义一起换掉 |
| 持久化协议之上的 ack / 重传 | 只对有损传输有价值；本地传输的失败形态是断连 |
| `ProxyChannel` 跨进程代理 / `IServiceAccessor` | 桌面端没有多进程服务拓扑要表达 |
| **owner/lease 的实现** | 它是 B2 的后续项（「run 生命周期没有模块」），不是无关概念；今天 owner 隐含为「启动这轮的请求」 |
| 替换传输表面 | 冻结路由、ETag、NDJSON 分帧、bypass 守卫都保留 |

## 何时重新考虑

- 出现**真正的有损传输**（中继、广域网、移动网络）→ ack / 重传与保留上限同批设计；
- 需要**多客户端同时看同一轮**（多端）→ 先补 run 生命周期模块与 owner/lease，再谈传输；
- 传输实现真的要换成非 HTTP（MessagePort / 中继 socket）→ 这是 ADR-001 决策 2 已允许的
  「换实现」，走 `setBridgeTransport()` + 一条新的 loopback 式等价测试，**不需要改本 ADR**。
## 修订记录

- **2026-10-28：决策 3 的状态从「只留 affordance」变成「affordance + 渲染侧已用上」。**
  触发是一次止损：4 MiB 待发上限把积压清掉后发了一帧 `transport_error`，而客户端把它当业务失败
  收尾——气泡提前 done、发一条假的「本轮完成」通知、停止按钮消失，可桥上的 run 还在跑（只有
  owner 请求 close 才中止）。那句 `resync through bootstrap` 当时在客户端**没有任何调用点**。
  现在：`src/features/chat/promptFeed.ts` 在 `transport_error` 或 `streamSeq` 跳号时，从
  `(runId, 最后一条带序号的帧 + 1)` 续订 `POST /api/runs/stream`；404/409/400/403（run 已结束 /
  日志已滚出窗口）或重试用完，才退回一次强制 bootstrap。两条配套契约：
  ① **传输错误帧不带 `streamSeq`、也不占号**（`server/frameWriter.mjs`）——它不属于这条 run，
  带上序号会把续订地址推过一条从未送达的帧；
  ② **订阅者的重放帧不受待发上限约束**（`frameWriter.replay`）——否则「补上被丢掉的那一段」
  会当场再次越限，续订永远不可能成功。
  档位仍是 `local-live`（断开即中止 owner 那轮）；`replayable` 档位、中继、鉴权仍未实现。

- **2026-10-28（同日第二条）：帧**内容**也有预算了，不再只靠待发上限兜底。** 上一个修订把"断流"接上了
  自愈，但没解决它为什么会断：`write` 的参数就是整份文件正文，一帧几 MB，第一帧入队就把 4 MiB 待发预算
  吃满，下一帧必然越限（`droppedFrames: 0` 的那种）。现在的三层预算（见 `CONTEXT.md` 的"载荷预算"）：
  ① 参数字符串 32 KiB（head + tail，`__omitted` 记原文行数/字节）；② 参数流 delta 累计 64 KiB 后停发
  （打字机不再替客户端攒 4 MB 状态）；③ 整帧 1 MiB，在 `runStreams.publish` **落日志之前**裁。
  最后这条是协议性的：日志里存的必须是订阅者会收到的那一份，否则重放会给出 4 MB 的原帧，
  "越限 → 续订 → 越限"成为死循环。裁掉一律带标记（`__omitted` / `__cuts` / `__dropped`），
  界面据此显示"未随流传输"或"只显示了首尾"——空 diff 不许冒充"没有改动"。
  全文不随流传输：`write` 的目标文件、bash 的 `fullOutputPath` 才是原文。
