# Pi Desktop 方案

## 目标

做一个更像真人陪练的英语学习助手，核心不是“刷题”，而是：

- 主动开启轻松对话
- 根据用户表现动态调整难度
- 只做少量、温柔、有效的纠错
- 后期平滑加入语音

## 设计原则

1. 先体验，后复杂度。
2. 教学逻辑和 UI 解耦。
3. skills 可插拔、可扩展、可调试。
4. 所有状态变更都走明确的数据流。
5. 语音能力从一开始就预留接口，但第一期不做音频交互。
6. UI 要像朋友，不像考试系统。

## 技术栈

### 前端

- Tauri
- React
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui
- lucide-react

### 状态与数据

- TanStack Query: 服务端状态
- Zustand: 本地交互状态
- SQLite: 本地持久化

### AI 层

- pi-agent-core: agent 运行时
- skills: 教学能力模块
- policy skill: 生成本轮教学策略

## 核心分层

```text
UI Layer
  -> Tauri App Shell
  -> React Screens / Components

Agent Layer
  -> pi-agent-core
  -> skill selection
  -> streaming
  -> tool execution

Tutor Layer
  -> policy skill
  -> small-talk
  -> gentle-correction
  -> level-assessment
  -> rephrase-naturally
  -> roleplay

Persistence Layer
  -> SQLite
  -> session logs
  -> settings
```

## 关键概念

### 1. Skill

技能是可复用的教学动作，不直接负责全局调度。

例子：

- small-talk
- gentle-correction
- level-assessment
- rephrase-naturally
- roleplay

### 2. Policy Skill

policy skill 负责把“这一轮怎么教”写详细，输出一份结构化教学指令。

它会决定：

- 用哪个主 skill
- 是否纠错
- 纠错几个点
- 语气多温柔
- 难度升还是降
- 下一轮要不要复用某个话题

### 3. Policy Output

```ts
type TurnPolicy = {
  activeSkill: string
  tone: "gentle" | "warm" | "encouraging"
  shouldCorrect: boolean
  correctionBudget: 0 | 1 | 2
  difficultyDelta: -1 | 0 | 1
  questionStyle: "simple" | "guided" | "open"
  avoid: string[]
  nextMove: string
}
```

## 一轮对话流程

```text
1. 用户输入（客户端先放 provisional 气泡，服务端确认后原位认领）
2. server/index.mjs 订阅 pi 会话事件，翻成自己的出站事件（NDJSON 逐行）
3. src/shared/chatStreamProjection.ts 按事件里的 bubbleId 寻址，投影成气泡
4. ChatThread 把气泡喂给 assistant-ui 渲染
```

### thinking（推理面板）的事件契约

pi 会把推理进度说两遍：逐 token 的 `thinking_delta`，以及 `thinking_start` /
`thinking_end` 上的 `partial` 累计快照。出站事件只保留一条主线：

| pi 事件 | 出站事件 | 作用 |
| --- | --- | --- |
| `thinking_delta` | `thinking_delta`（带 `thinkingStreamKey` + `delta`） | live 推理块正文的**唯一来源**；同时把该 key 记为“未闭合” |
| `text_delta` | 先补一条**空正文**的 `assistant_partial`（`closeThinking: true`），再发 `delta` | 即时落定面板 |
| `toolcall_start` | 先补一条空正文 `assistant_partial`，再发 `tool_call_stream_start` | 即时落定面板 |
| 换 `contentIndex` 的 `thinking_delta` | 先补空正文 `assistant_partial`，再发 `thinking_delta` | 上一轮结束、新一轮另起一块 |
| `thinking_start` | （不发） | —— |
| `thinking_end` | `assistant_partial`（`closeThinking: true` + 全量正文） | 权威正文覆盖 + 兜底落定 |

三条硬规则：

1. **累计正文只在“块结束”这个边缘取。** `partial` 是和 provider 共享、就地改写的
   活对象（agent-loop 只做 `{...partialMessage}` 浅拷贝），开场时序列化它，读到的
   其实是“还没发出去的那几个 delta”的结果。客户端先按快照播种、再让同一批 delta
   追加，就是推理面板“首块重复”的成因（真机日志：快照 `chars=3 "Let"` + delta `"Let"`
   → `"LetLet me first look..."`）。
2. **块的身份只认 `streamKey`（`assistant-{msgIdx}-thinking-{contentIndex}`），不认位置、
   不认文本相等。** 一个 turn 只有一个气泡，多轮思考全写回同一个 `liveBlocks`；靠“从
   后往前找同类块”会在 thinking / tool 交替时把新一轮并进上一轮那块。
3. **不要用 provider 的 `thinking_end` 当“关圈”的唯一信号。** `openai-completions` 一类
   把**所有**块结束事件压在整条 message 的 SSE 循环之后统一补发
   （`pi-ai/dist/api/openai-completions.js` 里 `for (const block of blocks) finishBlock(block)`
   在循环外，真机实测最后一个 delta 之后 0.4~4.1s；abort 时甚至整个跳过），
   表现就是“工具卡都出来了，上面的推理还在转圈”。pi 的内容块是顺序流的，**下一个块
   一开始就证明上一块结束了**，所以适配器在那个边缘合成一条只带 `streamKey`、正文为空
   的关圈事件；客户端对空正文块只清 `open`、不碰逐 token 流出来的正文（见规则 1）。
   anthropic 在 `content_block_stop` 逐块发、google 在块类型切换时发，本来及时，走不到
   这条合成路径。

气泡上有两份块列表：渲染优先 `liveBlocks`（流式现场，delta 驱动），`liveBlocks` 为空时
（历史转录、刷新后的会话）才回到 `processBlocks`。面板的“还在想”是显式数据 `open`，
由上面那三个结构边缘（正文 delta / 工具调用开始 / 换 key 的 delta）即时清，provider 的
`thinking_end` 只做兜底。`liveBlocks` 不会在收尾时清空，所以修复前“跑完又正常了”并不是
`processBlocks` 接管，而是收尾快照把 live 块里的文本**覆盖**了一遍——那是当时的唯一兜底。

#### 渲染层同样不得反推状态

`AssistantReasoningGroup`（`thread.aui.tsx`）曾经写 `streaming = messageRunning || ownStreaming`。
`streaming` 不只是标题的 shimmer，它还打开 `reasoning.tsx` 里那个**底部跟随的实时预览**
（`isPreview = streaming && open`）。于是只要整条消息在跑，**每一个**推理面板都显示成
“还在输出”：真机一个 7 轮工具调用、跑 2m14s 的 run，第一个面板正文 1 秒就写完，
却 shimmer + 跟随滚动了 2 分多钟，位置就在正在干活的工具卡上面 —— 这就是“工具都出来了、
上面的 thinking 还在输出”，**必现，跟服务端无关**（同期录到的 1437 条出站事件重放证明：
每轮思考都是独立块、都追在工具卡之后、都在下一个内容块开始的瞬间落定，正文没落错块）。
现在两个问题分开：`streaming` 只看本组自己的 part，`holdOpen` 才看整条消息（整轮结束前
不折叠，折叠会把下方内容抬起来）。合并回一个值就是回归，由
`tests/reasoningGroupStreaming.test.ts` 钉住。

> 历史锅：这个 `messageRunning` 是为了避免“思考一写完就折叠、在跑的过程中抽风”而加的，
> 但展开与“在思考”是两件事，不能绑在一起。

> 附带影响：`thinking_start` 不再发快照，所以推理面板从“开场”改成“第一个 delta 到达”
> 时出现（两者实测在几十毫秒内）。abort / error 时可能收不到 `thinking_end`：不靠它也不
> 会卡住——气泡 `status` 转为 done 后，`toAssistantUiParts` 里的 `isStreaming && …` 就
> 会把面板判为 complete。

## UI 形态

### 主界面

- 左侧：会话列表
- 中间：主聊天窗口
- 右侧：上下文状态、已加载技能

### 交互要求

- 输入框始终可见
- 支持连续追问
- 支持一键改写
- 支持“太难了 / 再简单点 / 继续”这类快速控制
- 回答流式展示，避免等待感

## 语音预留

第一期不做语音交互，但必须预留：

- 音频输入出口
- 音频输出出口
- turn-level event stream
- text/audio 双模消息结构
- 麦克风权限与设备管理入口

未来加入语音时，尽量只替换输入输出层，不动 Agent Layer。

## 性能要求

- 聊天流式输出
- 组件拆分，避免整页重渲染
- 对话状态和 UI 状态分离
- skills 独立文件，便于按需加载
- 低频数据持久化，避免每个 token 都写库

### 流式期间的两条硬规则（2026-09-09）

参照 pi TUI 的做法：它对渲染做帧预算（脏标志 + `MIN_RENDER_INTERVAL_MS=16`，输入类事件走
`requestImmediateRender()` 抢占），并且**整个 dist 里没有任何周期性状态对账**。我们抄了这两条：

1. **一条 token 不得换一次提交。** `src/features/chat/streamCommitBuffer.ts` 把
   `delta` / `thinking_delta` / `tool_call_stream_delta` / `tool_execution_update` 攒到下一帧提交一次；
   其余（工具卡起止、`assistant_partial`、`queued`、`done`/`error`、用量）先冲队列再立即提交。
   排队期间后续事件必须基于 **pending 视图**继续投影，且任何读转录的地方（`currentBubbles`）
   **先冲账再读** —— 否则攒着的 delta 会被覆盖掉。
2. **运行中的对账只问环境态，不搬转录。** `GET /api/bootstrap?view=ambient`
   （`buildAmbientSnapshot`）返回队列/审批/忙碌旗标，**不含会话内容**，代价与会话体积无关。
   取哪种模式由 `src/features/chat/pollMode.ts` 的纯函数决定：本窗口 own 这条流时只拿 ambient；
   不是我们起的运行、正在等停止落地、或自己的流静默超过 `stallReconcileMs`（兜“连接活着但
   服务端不再写字节”）时才回到全量。发送那一刻的 `canPrompt` 确认同样走 ambient——那里以前是
   用户等首字时最不该付的 MB 级同步 parse + merge。

推论：**任何“随会话体积线性增长、而且周期触发”的主线程工作都是卡源**。全量对账只允许出现在
`done`/`error`、重连、切会话、后台恢复这几个点（`mergeStreamingBootstrap` 仍是回收被服务端
清掉的插话的唯一入口，所以这些点不能省）。

## 代码组织建议

```text
src/
  app/
  components/
  features/
    chat/
    tutor/
    settings/
  skills/
    policy/
    small-talk/
    gentle-correction/
    level-assessment/
    rephrase-naturally/
    roleplay/
  agent/
  lib/
  store/
  types/
  tauri/
```

## 第一阶段交付

1. Tauri + React + TypeScript 基础工程
2. 聊天 UI
3. policy skill
4. 至少 2 个教学 skill
5. 流式回复
6. 本地持久化

## 第二阶段交付

1. 主动会话
2. 更丰富的纠错策略
3. 语音能力预留接入

## 风险控制

- 不要把 skill 写成大而全的怪物
- 不要让 UI 直接承担教学逻辑
- 不要一开始就引入过重的框架抽象
- 不要让纠错打断自然对话节奏
