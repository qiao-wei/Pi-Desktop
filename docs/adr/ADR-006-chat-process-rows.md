---
id: ADR-006
title: "聊天过程区按 ZCode 的行语法渲染，工具展示模型在投影边界派生一次"
type: adr
status: approved
owner: "@qiaowei"
created: 2026-10-27
updated: 2026-10-27
related: [ADR-001, ADR-003]
code_refs:
  - src/shared/toolDisplay.ts
  - src/shared/chatToolBlocks.ts
  - src/shared/chatProcessBlocks.ts
  - src/shared/chatStreamProjection.ts
  - src/shared/reasoningText.ts
  - src/components/assistant-ui/elements/tool-row.tsx
  - src/components/assistant-ui/elements/tool-bodies.tsx
  - src/components/assistant-ui/elements/thinking-row.tsx
  - src/features/chat/assistantUiParts.ts
  - src/shared/collapseGate.ts
  - src/shared/chatTurnTiming.ts
  - src/shared/scrollMask.ts
  - src/components/assistant-ui/elements/deferredCollapse.ts
  - src/app/tailwind.css
tags: [ui, chat, rendering, tool-calls, tokens]
summary: "助手气泡的过程区（思考行 + 工具行）改成 ZCode 生产环境的行语法：图标在首、chevron 在尾且 hover 才显形、状态词只在有信息时出现、diff 用底色+状态条+行号（不放 +/- 字符）。一起定的还有：结构化展示模型 ToolDisplay 只在投影边界派生一次（渲染层不许再解析文本），以及一套 ZCode 兼容的 token（--text-ui-* / --foreground-subtle* / --color-diff-*）。"
reviewers: ["@qiaowei"]
---

# ADR-006：过程区按 ZCode 的行语法渲染，展示模型在投影边界派生一次

## 背景

助手气泡里的「过程」（思考 + 工具调用）原来复用 Vercel `ai-elements` 那套卡片：
`AssistantToolGroup` / `AssistantToolCall` / `AssistantReasoningGroup` / `PiDesktopProcessGroup`
四个组件把它们包成「分组 + 可折叠卡片」。它和参考实现（ZCode 生产环境的聊天行）差在三处：

1. **几何不同**：卡片是前置 chevron + 边框容器；ZCode 是**图标在首、chevron 在尾**、无容器的行。
   视觉后果是过程区比答案正文重，层级反过来（工具标签比正文还显眼）。
2. **信息来源不同**：卡片只能看 `result` 文本 —— 于是错误靠前缀 `Error: ` 表达、diff 靠正则从
   结果文本里抠、`exit code` 靠字符串匹配。而 **pi 早就算好了结构化结果**：`edit` 的结果信封带
   `details.patch`（真实的 unified diff），`bash` 带 `structuredContent.exit_code / truncated /
   full_output_path`。桥把整个信封原样转发（`result: any`），渲染层把它们扔掉了。
3. **状态靠猜**：`streaming` 取自「整条消息在跑」，reasoning 的「还在想」取自「这块是不是最后一块」
   —— 位置猜是双向的错（工具块追到 thinking 后面 → 文本没写完的面板被判完成；对账重建的无标记块
   恰好排在最后 → 已完成的面板一直闪）。

所以先问一个事实问题：**这条边界是什么形状？**

- 数据侧：过程块已经是**结构化**的（`{kind, toolCallId, toolName, callText, resultText, isError, status}`），
  结果信封里还有更细的结构；
- 渲染侧：一行要回答的问题只有四个 —— **动作是什么 / 对象是谁 / 现在什么状态 / 正文长什么样**，
  这四个问题对同一份输入有唯一答案，却被分散在四个组件里各算一遍；
- 参考侧：ZCode 把「行语法」（`ToolSummaryRow` / `ToolLayout`）与「正文」（8 个 renderer）分开，
  行只消费已经分好类的展示模型。

## 决策

1. **展示模型在投影边界派生一次**。`src/shared/toolDisplay.ts` 导出 `deriveToolDisplay`（从工具名 +
   参数 + 结果信封算出 `ToolFileDiff` / `bash` 的退出码与截断 / MCP 的 server+工具名 / 兜底），
   投影层（`chatStreamProjection.ts` / `chatBubbles.ts`）把它挂到过程块的**可选**字段 `display` 上，
   渲染层只读模型。**渲染层不得再解析结果文本**（不是「尽量不」，是没有入口：`tool-bodies.tsx` 里
   没有 `JSON.parse`，也没有对 `resultText` 的正则）。
2. **行语法照抄 ZCode**：图标在首（最淡一档）、chevron 在尾且**只在 hover 或展开时**显形、
   动作词按工具族取 i18n 词（运行中扫光）、目标文本可截断、**状态词只在有信息时出现**（成功行不写
   「已完成」；失败行的状态词带虚线下划线 + 可复制 tooltip）。**错误不再用 `Error: ` 前缀污染正文**。
3. **正文按族选择**，一族一个 body：`edit`/`write` → 内联 diff；`bash`/`powershell` → 终端正文；
   `mcp__*` → 结果优先面板；其余 → 参数+结果。**协议行永远不进正文**：`---`/`+++`、git 自己的
   `diff --git`/`index` 前置行、`@@` hunk 头都不显示（行已经说了文件名；hunk 窗口是格式的产物，
   不是读者要看的东西）。diff 用**底色 + inset 状态条 + 行号**表达增删，**不用 `+`/`-` 字符**。
4. **`read` / `grep` / `ls` / `find` 只有摘要行**（ZCode 的 `canToggle: false`）：文件内容本来就已经
   在会话里（工具结果正文），展开一遍是重复；搜索行的答案就是命中，摘要里说清楚就够。
5. **间距只有一个来源**。过程行与助手正文是**同一个列里的兄弟**，列间距 = ZCode 的
   `--conversation-block-gap`（默认 16px；它的三档会话密度分别是 0.625 / 1 / 1.5rem）。行组包裹层
   （`group-chainOfThought`）用 `contents` 而不是自带 `gap-1.5`；正文段落靠 `first:mt-0 last:mb-0`
   把首尾外边距清掉；同一条时间线上的 file / image / error 也不带自己的垂直 padding。**理由是观感
   而不是洁癖**：三套各自合理的间距（段落外边距、组内 6px、组外 0）叠起来，行会挤在一起、而正文与行
   之间是另一个值 —— 用户给的参考截图里整条时间线是**一个**节奏。
6. **两个层级，两种开合规则 —— 别把它们混成一件事**：
   - **行级（思考行 / 工具行）没有自动开合**：行的 `open` 只由读者驱动，开始跑不自动展开、跑完也
     不自动收起（ZCode 的 `ToolLayout` `autoOpen` 默认 false）。运行中的部分输出仍然显示（模型里有
     `partialResult` 兜底），但显示不等于自动展开。
   - **过程区级有自动折叠，且必须恢复**：一轮里的全部思考/工具行折在**一个** disclosure 里
     （`PiDesktopProcessGroup`），运行中展开、整轮结束折成一行表头。这正是 ZCode 的 turn history：
     `conversationTurnRenderUnits.ts` 的 `assistantHistoryDefaultOpen` 在「最后一轮还在跑 / 还没有
     末条正文」时为真，落定即收；表头文案就是 ZCode 的 `chat.history.workingFor` / `workedFor`
     （用户参考截图里的「已工作 58 秒」）。行换成 ZCode 语法时把这一层一起丢掉了 —— 那是丢错了，
     见下面的「修订记录」。
   自动折叠**必须过闸门**（`src/shared/collapseGate.ts`）：它只在没人看得见的地方释放高度
   （视口下方，或贴底时靠 `scrollTop` clamp），否则推迟到读者把该块滚出视野。闸门只读几何、
   从不写滚动位置 —— 折叠不该和会话切换的恢复窗口、贴底 pump 抢方向盘。
7. **思考行 = ZCode 的思考行**：`BrainIcon` + 扫光标签（`Thinking` → `Thought · N 秒`）+ 收起态的
   单行尾巴（**最后一行**非空文本，蒙版淡化而不是截断加省略号），正文是左导轨上的纯文本
   （`whitespace-pre-wrap` + 限高），**不是 markdown**（逐 chunk 重跑 markdown 解析既有卡顿风险，
   也让思考具备正文的视觉重量）。时长客户端算：首个 delta → 落定，向上取整且下限 1 秒；重放出来的
   历史块没有起点，**不编时长**。
8. **动词来自工具身份，不来自 diff 形状**。`edit` 只插入几行时补丁里没有 `-` 行，而「`write`
   覆盖成一个超集」的补丁形状与它**完全一样** —— 从形状反推动词，给已有文件追加几行就会显示成
   「Write」（用户 2026-10-27 实测到）。所以 `editOperationOfTool(toolName)` 只认工具名；`Delete`
   这个动词一并删掉（pi 没有删除工具，只删行也是 edit）。ZCode 同样从工具身份读
   （`fileSummaryHeuristics.ts` 的 `readEditOperationCandidates`）。
9. **文件名与路径是两个点击目标**（ZCode 的 `renderFileChip` / `renderFilePath`）：
   点**文件名** → 右面板打开这个文件（只读预览，`onOpenFile` 由宿主注入）；点**路径**（以及行的
   其余部分/chevron）→ 展开内联正文。名字是 `<button>`，`mousedown` 与 `click` 都要
   `stopPropagation`，否则会顺手展开正文；**项目外路径、多文件行不给链接**（右面板只读项目内文件，
   点了没反应比没有链接更糟）。
10. **「已工作 N 秒」的来源是转录时间戳，不是客户端秒表**。`chatTurnTiming.ts` 用「本轮首条条目
    → 末条条目」算真实时长，`chatBubbles` 把它挂到气泡的 `turnDurationMs` 上；拿不到时间戳时返回
   `undefined` 而不是 0（「不知道」和「瞬间」是两回事），表头退回无时长的「思考过程」。**这正是历史
   消息也显示时长的原因**：重放出来的一轮没有 delta，客户端秒表无从测起。
11. **展开的思考正文吸底跟随，读者上滚即暂停**（ZCode 的 `autoFollowBottomRef`）：正文是限高滚动
   区，新 token 必须把视野推到末尾；但读者自己往上滚之后继续拉回去等于抢滚动条，所以
   `isScrolledToBottom`（4px 容差）是唯一的开关，滚回底部恢复。上下边缘的渐隐（`scrollMask.ts`）
   与 ZCode 同一套几何：贴着底就不该淡下缘。
12. **思考行的时长只有客户端测得到，而且必须活过「快照重建」**。pi 的转录里**没有逐块时间戳**
   （一条消息只有一个 `timestamp`），所以「思考 · N 秒」只能来自看过这次流式的那一方：
   投影边界在**首个 delta** 上写 `startedAt`、在块关闭（`thinking_end` / 下一块开始 / 整轮收尾）时写
   `endedAt`。这两个数还必须跟过**落定后的快照重建** —— 整轮结束时快照会用转录把块重建一遍（不带
   时长），而那正是行开始显示数字的时刻。所以 `thinkingTiming.ts` 把观测搬过去（按 `streamKey` 认块，
   没有 key 的老转录按正文认），并且只在**两个端点都有**时才承认一次观测；重放出来的历史没有起点，
   照旧不编数字。
13. **路径永远是位置，不是空字符串**。行尾的路径段（`data-slot="tool-row-path"`）是「文件在哪」，
   所以它不许为空：文件就在工作区根时，答案是**工作区自己的文件夹名**（`iej/`、`.PiDesktop/`），
   而不是什么都没有 —— 用户 2026-10-27 实测到的 `编辑 hello.py` 后面空着，读起来像这个文件没有位置。
   规则只有一处（`toolRowFolder`）：有目录用目录，没有就用根目录名，且**带尾斜杠**（ZCode 的
   `packages/ui/src/settings/` 就是这个形态，尾斜杠让这段读作位置而不是文件名的一部分）；
   项目外的绝对路径保留它自己的目录，不假装相对化；连工作区都不知道时返回空（宁可少一段，不编）。
14. **整轮时长的两个坑都补上了**（`turnDurationMs`）：
   - **问题的时刻不在 `pendingTurn` 里**。`buildChatBubbles` 把用户消息直接变成气泡，`pendingTurn`
     从**它之后**才开始装条目 —— 于是一个「一问一答」的轮次里只有一个时间戳，`turnDurationOf`
     如实返回 `undefined`，表头写「思考过程」。修法是把问题的时刻 prepend 进去
     （`turnDurationOf([{timestamp: turnStartedAt}, ...pendingTurn])`）。**这是历史消息有时长、
     刚落定那一轮反而没有的原因**。
   - **落定瞬间快照可能还没描述这一轮**。此时能用的只有「这个客户端看了多久」
     （`observedTurnDuration`：气泡的 `createdAt` → 落定时刻），它是一次真实测量；
     一旦快照带上转录自己的时间戳，就换成快照的值（`carryObservedAnswerTiming` 只在快照没有值时
     才搬本地的）。
15. **`+/−` 跟着参数流式生长，而不是等工具跑完**。`edit`/`write` 的行尾读数是「改了
   多少行」，而这两样信息在**参数**里就有：`edit` 的 `edits[]` 是精确替换（`oldText` 的行数 =
   删除数、`newText` 的行数 = 新增数），`write` 的 `content` 行数就是新增数。pi 的
   `details.patch` 要等文件落盘之后才有 —— 也就是说旧实现里数字**只在工具跑完那一刻出现**
   （用户实测对比 ZCode：它写大文件时数字是一路涨的）。现在：
   - `toolArgsPreview.ts` 的 `readPartialFileToolArgs` 读**半截 JSON**：被截断的字符串返回已解码
     的前缀（那正是用户在看的增长），截断的对象/数组保留已解析的成员，悬空的 `"key":` 与尾逗号
     丢掉；**没开始到达的字段就是没有**，不当空串。
   - 为了让一个 `write` 不至于 O(n²) 地重算（10 万字符 ≈ 2.5 万 token），预览**按文本自我保护地
     节流**：每跨过 128 字符才重算一次（`PREVIEW_REFRESH_CHARS`）。用文本当计时器，不引时钟，
     所以单测确定可复现；`tool_call_stream_end` 与 `tool_execution_start` 会各补一次精确值。
   - **权威值永远赢**：结果里带 `details.patch` 时（含 `write` 未来可能带的），用 patch；预览只在
     没有 patch 时出现，且 `status === "done"` 的块不再被重算。
   - **失败的行不报数字**：预览描述的是「打算做什么」，失败的 edit/write 一个字节都没改，
     所以 `isError` 时返回 `none` —— 行尾的 `+3 −1` 配一个红色状态词是在说没发生的事。
   - **`write` 的 `−M` 需要写入前的文件**，而 `src/shared` 是 pure 层不能做 I/O。做法是**注入**：
     派生逻辑接受一个 `baseline?: string`，宿主把它做成一个**同步读 + 后台补**的读取器
     （`src/features/chat/fileBaseline.ts` + `useFileBaselineReader`）：第一次问就发起 `/api/projects/file`，
     本次返回「还不知道」，请求落地后（通常还在参数流的中段）后续每次预览就能拿到正文。
     于是纯层仍然是纯的，`+N −M` 在工具跑之前就齐了。读不到（新文件 / 项目外 / 二进制 / 超大）就
     只显示 `+N` —— **不编 `−0`**。换项目会清缓存（同一个相对路径是另一个文件）。
     两个 React 层的坑（都踩了，记在这里）：读取器必须**惰性解析 source**（构造时读 app state 会撞
     TDZ：`Cannot access 'bootstrap' before initialization`），而且 source 必须是**当前渲染**的那份
     （把第一次渲染的闭包冻在 `useRef` 里，请求会一直带开场时的 `local-project`）。
16. **token 层按 ZCode 的名字与公式补**（`src/app/tailwind.css` 的 `@theme`）：`--text-ui-caption|base|sm|xs`、
   `--foreground-subtle` / `--foreground-subtlest`（由**本主题**的 `--foreground` 按 60%/40% 混出，深色只把 subtlest 调到 30%）、
   `--color-diff-added/removed`、`--animate-collapsible-down/up`。深浅两档的差异只写在
   `src/themes/{default,codex}/theme.css` 的 `.dark` 里（组件里没有写死的深浅色）。
17. **内联 diff 的语法高亮是第二遍，不是第一帧**（ZCode 同款）。第一帧永远是纯文本——高亮器要
   动态 import、要 wasm、要 tokenize，任何一样在展开那一帧同步做都会掉帧，而"点开就看见 diff"
   比"点开先看见彩色"重要。落法：
   - `src/shared/diffHighlight.ts`（纯）：`diffHighlightRuns` 把行**按同一种 kind 切段**（增/删/
     上下文各成一段，一段一次 tokenize —— 跨行语法才连得上；整篇一起喂会把新旧两版代码混成一份
     看不懂的文档，逐行喂又会打断多行字符串与注释）；`mapHighlightTokens` 把 token 贴回行号。
   - **贴不上就整段不画**：行数不一致、或某行 token 拼起来不等于那行正文，这一段的颜色一律丢弃。
     颜色错行比没有颜色糟得多，而且错得看不出来。
   - `src/features/chat/useDiffHighlight.ts`（渲染层）：复用 `@pierre/diffs` 的 **shared highlighter**
     （和右侧代码面板同一个 `shiki-wasm` 引擎、同一份语言表，不新开 shiki 实例），语言名来自
     `shared/codePreviewLanguage.ts` 的 `inferCodeLanguage`，主题跟着 `<html>.dark`（`useThemeMode`），
     所以没有两份真相。`log`（纯文本）直接不跑；`catch` 里什么都不做（高亮失败 = 保持纯文本）。
   - 折叠时不算：`DiffBody` 只在展开时挂载，未渲染的行不需要颜色。
   - 验收：`data-diff-highlight` 只会在 token 到达后出现（e2e 轮询断言它最终出现），
     `tests/diffHighlight.test.ts` 钉住切段与"贴不上就丢"的规则。

18. **运行态是「动作词 + 扫光」，且只能由 part 自己的 `status` 决定**。ZCode 的运行中行不说话、不转
   spinner（长流式里每行一个旋转图标会持续吃渲染资源），它只把动作词换成一个进行时的词并让文字扫光：
   `正在思考` / `正在写入` / `正在编辑` / `正在执行`，落定后换回名词（`思考 · N 秒` / `写入` / `终端`）。
   - **接线的坑（真 bug）**：插槽渲染是 `<ToolFallbackComponent {...part} />`，part 里带的是 assistant-ui
     的 `status: { type: "running" | "complete" | ... }`。`ToolRow` 当时只声明了一个可选的 `running`
     （默认 `false`），于是**永远**停在落定态 —— 三条运行态文案在词表里、在代码里，但一帧都没上屏。
     现在 `running ?? status?.type === "running"`：显式值优先（测试与直接调用方），否则读 part。
     教训：**「词表里有」不等于「用户看得见」**；接线要用 e2e 量计算样式，只断言类名会漏掉这种 bug。
   - **扫光必须看得见**：`tw-shimmer` 的扫光是拿 `currentColor` 派生的（亮档 = currentColor，暗档 = 20%）。
     所以运行态标签**不能再叠一层淡色**（曾经叠了 `text-foreground-subtlest` 40%，于是亮档 40%、暗档 8%，
     看起来就是一行不动的淡灰字）。落定态才用淡色，那是对的。
   - **短标签要收窄扫光带**：插件默认带宽是 `4ch + 80px`（再加 200px 轨道 × tan15°），比四个汉字还宽，
     一个 `正在写入` 会长期整行落在软色带里 → 又变成"淡灰字"。用 `shimmer-spread-30 shimmer-angle-0`
     把带子收到比一个词还窄：文字主体保持全强度，一条窄的淡带扫过去（两帧实测：帧 1 淡在「在」、帧 2
     移到「入」）。
   - **兜底行也必须本地化**：参数还在流、`display` 还没派生出来的那一小段时间，`write`/`edit` 会走
     `fallbackPresentation`。旧实现把工具标识符首字母大写当动作词 —— 中文界面里出现 `Write`、`Todo write`。
     现在兜底按 **family** 取同一组词表（read/write/edit/execute/search/mcp），只有**未知家族**才退回工具
     自己的名字（那是标识符，不是文案；翻不了，也不该被一个泛动词盖掉）。成功行不多话：旧的
     `执行中 / 已执行` 二级词删掉了，动作词本身已经表达了状态。
   - 终端退出码从硬编码的 `exit {code}` 改走 `process.tool.exitCode`（`退出码 {code}` / `exit {code}`）。

19. **「N 个文件已更改」逐字照 `ConversationFileSummaryPanel`，且「审查」渲染的是这一轮的补丁**
   （ZCode `packages/ui/src/v4/ConversationFileSummaryPanel.tsx` + `OpenSplitButton.tsx`）。
   - **形态**：外壳 `overflow-hidden rounded-xl border border-border bg-card shadow-none`；表头
     `h-10` + `hover:bg-hover`（chevron + 「N 个文件已更改」+ 聚合 `+X -Y`）；行是
     `div[role=button]`（整行 = 看改动）`px-2 py-2 hover:bg-hover/30`；名字 `text-ui-base
     font-medium`、目录 `text-ui-base text-foreground-subtlest`（`gap-1.5`），行内增删**只画非零**
     （新增文件是 `+20`，不是 `+20 -0`）；右侧 `审查` 与 `打开` 都是**同一底色 + 边框**的
     `h-7 rounded-lg`，`打开` 是分段控件（右边 20px 箭头下拉 = 用什么打开）。破折号用 ASCII `-`
     （参考实现如此），表头聚合**两个数字都画**。
   - **两处 token 坑**：`bg-hover` / `border-border-hover` 之前**根本没有定义** —— Tailwind 对未知
     类名是静默跳过的，于是"类名写对了、界面没有任何悬停反馈"。现在 `@theme` 里有
     `--color-hover: var(--color-neutral-200)`、`--color-border-hover: color-mix(... 20% ...)`，
     深色在主题的 `.dark` 里换成浅色叠加。
   - **半径写死绝对像素**（卡片 12px、按钮 8px），不用 `rounded-xl` / `rounded-lg`：那两个类在本仓
     是 `calc(var(--radius) ± n)`，`--radius` 是**主题级**的（默认 10px、codex 16px）—— 同一个
     `rounded-xl` 在 codex 主题下是 20px，40px 高的表头直接变成胶囊（用户原话「这个圆角太大了」）。
     参考实现的 `--radius-xl` 就是 12px（Tailwind 默认档），与主题无关。
   - **按钮底色不用 `bg-input`**：两仓同名不同义 —— ZCode 的 `--color-input` 是**面**色
     （白 / neutral-800），本仓的 `--input` 是**描边**色（0.87 灰）。照抄会让按钮变成一块中灰。
     用 `bg-card`：两套主题下都与参考实现的按钮底色等价。
   - **位置**：卡片在正文列里、消息操作栏**之前**（消息内部的 `trailing` 槽位
     `AssistantMessageTrailingContext`）。挂在 `<AssistantMessage />` 外面会落到操作栏下面，
     读起来像消息的装饰而不是这一轮回答的一部分。
   - **`审查` 不查 git，直接渲染这一轮的补丁**。ZCode 把 `formatPatch(...)` 交给 code viewer；
     本仓右面板原来只会按来源现读 git，而那个 diff 经常**根本不是这一轮**：agent 新建的文件在
     git 里还是 untracked（unstaged diff 为空）、改完就 commit 的文件也一样。于是「审查」打开的是
     一张空白页 —— 用户说的"点了也不是显示 diff"。现在 `RightPanelFileTab` 多一个 `patch` 字段，
     有它就不发请求，头部数字用 `diffStatsFromPatch` 从同一份文本数出来，来源标签写「本轮改动」
     （`git.source.turn`），而不是假装成 git 的未暂存改动。
   - **路径必须折成相对项目根**再交给右面板：`readWorkspaceFile` / `normalizeRelativeDir` 对绝对
     路径一律回 `Path is outside the project folder`，而工具参数里的路径经常是绝对的 —— 那正是
     "点「打开」没有任何反应"的真身。卡片自己 `toWorkspaceRelativePath` 一次（项目外保留原样）。
   - **行数口径**：只从投影层的 `display.files` 读，不从 patch 文本里数。同一个文件被改多次时
     **取最后一次**（`edit` 的 display 只描述那一次补丁，两次相加会把同一段代码算两遍）；
     `counted: false`（正文被预算裁掉）时不显示数字，也不在表头画 `+0 -0`。
   - **`撤销` 没做**：ZCode 表头右侧的 rewind 依赖"按轮回滚文件"的接口，本仓没有（`sessionBranch.ts`
     只回滚会话条目，不动工作区文件）。不画一个点了只会弹"暂不支持"的按钮；等接口有了再加。
   - 为腾出棘轮空间，`AssistantActionBar`（含 `useActionsDisabled`）从 `thread.aui.tsx` 拆到
     `elements/assistant-action-bar.tsx`：**拆而不是抬 ceiling**。

## 理由

1. **投影边界是唯一同时拿到「参数」和「结果信封」的地方**，也是**合并身份**（同一块要不要复用）
   的决策点。派生放在这里，才有 `sameToolDisplay` 可比较：流式里每个 token 都会重算一遍块，如果
   `display` 每次都是新对象，投影的「内容相同就保留原块」规则会失效，于是**每个 token 重渲一次整行**
   （旧实现的问题之一）。渲染层派生等于把这件事按帧数放大。
2. **结构化优先于文本解析**。`edit` 的 diff 来自 `details.patch`：正则做不到「这是 diff 还是
   一个内容里刚好含 diff 的文件」。同理 `bash` 的退出码只有 `structuredContent` 里有。
3. **`display` 必须是可选字段**。老会话的转录、以及今天还不产出结构化结果的工具，都只能走兜底行
   ——所以兜底不是异常路径，是常态之一，它也得是「参数 + 结果」而不是一坨 JSON。
4. **行不撒谎**。`read` 不展开是因为内容已在别处；状态词只在有信息时出现是因为「已完成」在成功行上
   不携带信息；`@` 与 `+/-` 字符是**协议**，不是内容。

## 被拒的方案

| 方案 | 为什么不 |
| --- | --- |
| 在渲染层用正则/文本解析兜底算 diff、退出码 | 同一事实的第二份实现，且无法区分「这是 diff」与「内容里含 diff」；结果文本还要按工具逐族适配 |
| 继续用 `ai-elements` 的卡片 + 换皮 | 几何本身就是差异（卡片容器 + 前置 chevron vs 行）；状态与「是否展开」的自动逻辑是旧 bug 的来源 |
| 行级自动展开/收起（跑完把一行自己折掉） | 读者没法把一行按自己的意愿留着，而且每一行都在流式里自己开合；ZCode 的行级 `autoOpen` 也是 false。**区域**级的自动折叠不在此列 —— 那是 ZCode 自己的行为（见 §6） |
| 过程区不折，行直接平铺进正文列 | 试过了（行换成 ZCode 语法时就是这么做的）：一轮的工具/思考会把答案推得很远，且和 ZCode 的生产形态不一致（它的 turn history 是可以折的）。行与正文仍是同一个列间距的兄弟，折的只是「这一轮的过程」这一层 |
| 把派生结果写进快照/持久化 | 派生量进快照 = 第二真源 + 快照变大（`bootstrapPatch` 会带上每行的完整 diff）；只在合并时用 `sameToolDisplay` 判等就够 |
| 像 ZCode 一样一个 renderer 一个文件（8 个） | 本仓的工具面窄（7 个内置 + MCP），一族一个 body 已经是一一对应；文件数上限也拦着 |
| 也做 `skill` 行 | pi **没有** skill 工具（skills 是提示资源，不是工具）；照着参考抄一个不存在的工具行才是失真 |
| 顺手把每行耗时也显示出来（ZCode 有 `durationMs`） | 桥今天不转发 `tool_execution_end.durationMs`；那是数据层改动，不是渲染层能补的 |

## 后果

- **新增**：`src/shared/toolDisplay.ts`（展示模型 + diff 渲染行）、`chatToolBlocks.ts`（转录侧工具结果读取）、
  `messageText.ts`（共享的 `messageToText`）、`reasoningText.ts`（思考行的两个纯函数）、
  `elements/tool-row.tsx`（行语法）、`elements/tool-bodies.tsx`（四种正文）、`elements/thinking-row.tsx`、
  `src/features/chat/assistantUiParts.ts`（块 → assistant-ui part 的映射，从 `ChatThread.tsx` 拆出）、
  `src/shared/diffHighlight.ts` + `src/features/chat/useDiffHighlight.ts` + `useThemeMode.ts`（内联 diff 的第二遍高亮，见决策 17）、
  `elements/tool-row-presentation.tsx`（每个 family 的图标 / 动作词 / 目标文本 / 正文选择，从 `tool-row.tsx` 拆出：
  行文件要留在 700 行棘轮内）、`elements/assistant-action-bar.tsx`（消息操作栏，从 `thread.aui.tsx` 拆出：
  给消息内的「变更文件」槽位腾出棘轮空间）。
- **删除**：`elements/reasoning.aui.tsx`、`elements/reasoning.tsx`、`elements/reasoningState.ts`、
  `elements/tool-call.tsx`、`elements/tool-group.aui.tsx`、`elements/tool-fallback.aui.tsx`（627 行的
  `ai-elements` 兜底组件，行换成 ZCode 语法后没有消费者了）、`tests/reasoningGroupStreaming.test.ts`
  （它钉的是「位置猜」：对账重建的无标记块恰好排在最后 → 已完成的面板一直闪；替代断言在
  `tests/toolStreamingStatus.test.ts`）。
- **保留**：`src/shared/collapseGate.ts` + `elements/deferredCollapse.ts` + `tests/collapseGate.test.ts`
  —— 它们钉的不是行，而是**过程区**的自动折叠（几何只读、视口外才释放高度）。行语法换了，
  这套语义一个字没变，所以闸门与它的用例都留着；用例里只把「三个自动折叠点」收敛成「唯一的
  过程区」，并加上 ZCode 的表头形态（常驻行 + 分隔线 + `workingFor`/`workedFor` 文案）。
- **有意未做**：
  1. **子代理 / agent 行**（ZCode 有独立 renderer）。子代理在本仓是「另一个会话」而不是一行，
     要做得先定「行里显示什么」；随之未做的还有 ZCode 的 `SourceLabel`（`bg-surface` /
     `bg-background-alt` 两个 token 因此有定义暂无消费者）。
  3. 每行耗时（见上表）。
  4. **每轮时长的「真实耗时」语义**。今天的数字是**墙钟跨度**（首条条目 → 末条条目），包含排队与
     工具执行；ZCode 记的是它自己 turn 的计时。两者对读者都是「这一轮花了多久」，但没有对齐到
     「模型思考了多久」这种更细的语义 —— 要那样得让桥把每段耗时写进转录。
  5. **会话密度的三档**（紧凑 / 舒适 / 宽松）。ZCode 用 `data-conversation-density` 整体切换七个间距
     变量；本仓还没有这项设置，所以只落默认档（`--conversation-block-gap: 1rem`）。名字先对齐，将来加
     档位时不必再到处找 `gap-*` 数字。
- **行为差异（有意的）**：行级无自动开合（区域级按 ZCode 自动折叠）；错误不再有 `Error: ` 前缀；
  `display` 是可选字段，兜底行是常态之一。
- **测试**：新增 `tests/fileBaseline.test.ts`（6 条：首次发起/在途去重/读不到不编/失败不抛/路径归一化/
  换项目清缓存），`tests/toolArgsPreview.test.ts`（7 条：半截 JSON 的字符串/对象/转义/`edits`、
  参数流到一半行数就在涨、节流分档、权威 patch 覆盖预览）、`tests/toolDisplay.test.ts`（25 条：信封读取、diff 派生、渲染行、截断、MCP 名解析、
  路径段非空）、`tests/thinkingTiming.test.ts`（8 条：观测判定、秒数下限、按 key/正文搬过重建）、
  `tests/chatTurnTiming.test.ts`（7 条：跨度、秒数、落定兜底）、
  `tests/toolRow.test.ts`（8 条：行语法与 token 契约）、`tests/thinkingRow.test.ts`
  （尾巴行/时长/不自动开合/不猜位置）；`tests/toolStreamingStatus.test.ts` 改成钉
  「部分输出走 `partialResult`」与「运行中不自动展开」；`tests/chatTypography.test.ts` 的前置
  chevron 用例改成「图标在首、chevron 在尾且 hover 才显形」。端到端在
  `e2e/specs/toolRows.spec.ts`：**假模型回一个真的 `edit`/`bash` 工具调用**（也能先发
  `reasoning_content`，于是事件序是「思考 → 工具 → 文本」），pi 真执行，断言摘要行、展开后的
  diff/终端正文、思考行的收起态与时长，**并在浏览器里量出相邻行的间距 = 16px**（间距这种事只有真实
  布局能验）；另有一条专门钉**过程区的自动折叠**：运行中区域带 `data-live` 且行在 DOM 里，整轮落定后
  折成表头（行退场、答案不动），点一下又能打开。截图落 `e2e/.screenshots/`（浅色 + 深色、
  折叠态与展开态）。另有 3 条钉用户实测反馈：**历史消息（reload 之后）表头仍有真实时长**、
  **点文件名开右面板 / 点路径展开内联**、**展开的思考正文在流式里吸底跟随、读者上滚后停止**。
- **行的类名是逐字抄的**（`max-w-full cursor-pointer … text-ui-base`）。参考实现升级时这层要对照
  ZCode 的 `ToolCallBlocks`（`ToolSummaryRow` / `ToolLayout` / `lightweight-diff-preview`）再看一遍，
  所以 `tests/toolRow.test.ts` 把关键类名与 token 一起钉住了。
- **思考行的正文是纯文本**：如果将来要给思考加 markdown 或代码高亮，注意它**只在展开且不流式**
  时才有意义 —— 旧版是流式里逐 chunk 重跑解析。

## 修订记录

- **2026-10-28（同日第二轮）用户实测：「样式要和 zcode 一致，现在是不一致」「点 review 也不是在右侧
  显示的 diff，点查看也不是直接在右侧打开」**。第一轮只把卡片做"像"，这一轮照源码逐条对齐：
  悬停 token（`bg-hover` 之前根本不存在）、行内只画非零、`打开` 改成分段控件、破折号用 ASCII、
  按钮底色换成 `bg-card`（`--input` 在两仓同名不同义）。两个点击各有一个独立 bug：绝对路径被右面板
  判成"不在项目里"，「审查」去问 git（新建文件 untracked → 空白页）。见 §19。
  **教训**：类名不是契约，**token 才是** —— 没有 token 的 `hover:bg-hover` 会被 Tailwind 静默丢掉，
  单测只断言 class 字符串会一路绿灯。

- **2026-10-28 用户实测：「变更文件的显示应该像截图那样，现在在正文后面，样式也不对」**。
  结论是**两件事都不对**，而且都不是样式微调：形态差一个层级（一行小字 vs 一张卡片）、位置差一个
  容器（消息脚注 vs 消息正文）。落地见 §19。**教训**：判断"参考实现长什么样"要看它所在的**容器**，
  而不是只看我们自己那个组件的 class —— 卡片挂在操作栏下面就永远长不出卡片的样子。

- **2026-10-27（同日，第二轮）用户实测两处「没改完」**。
  1. 「思考后面还是没有显示时间」——行自己的秒表在**行被卸载时就没了**（整轮结束过程区自动折叠，
     行退场），而数字恰恰是落定后才有意义；同时快照重建块会把观测冲掉。修法见 §12（投影边界打点 +
     `thinkingTiming.ts` 把观测搬过重建）。**教训**：一个值如果只在「组件活着的时候」存在，那它在
     这个 UI 里等于不存在 —— 先找出组件在哪些时刻会被卸载/重建，再决定值放在哪一层。
  2. 「编辑和写入文件后还是没有路径」——`edit hello.py` 这种**文件就在项目根**的行，目录部分为空，
     于是整段路径被省略。修法见 §13。**教训**：「没有值」和「值为空串」在渲染上长得一样，都会变成
     「这一段不渲染」；派生函数返回空串时，问一句「读者会不会以为这里本来就没有东西」。
  另：整轮表头的时长这次才真正落到**刚落定的那一轮**上（§14），此前只有更早的轮次和重载后的历史有。

- **2026-10-27（同日）修正一处丢错的行为**。第 3–8 条落地时，把过程区**整体**的自动折叠和「行级自动
  开合」当成一件事一起删了（§6、以及「被拒的方案」里的一行），理由是「ZCode 没有」——**这个前提是错的**：
  ZCode 的 turn history 就是这一层（`assistantHistoryDefaultOpen` 在整轮跑完时翻转、表头就是用户参考
  截图里的「已工作 58 秒」）。用户的反馈是「没有自动折叠思考和工具的区域了」。于是恢复
  `collapseGate` / `deferredCollapse` 与过程区的接线，并且把表头做成 ZCode 的形态（常驻行 + 分隔线 +
  `workingFor`/`workedFor`）。**教训**：参考实现的「没有」要搜到它的**渲染单元**层
  （`conversationTurnRenderUnits.ts`），不要停在组件层（`ToolLayout`）—— 一个行为往往属于外层容器，
  行组件里当然搜不到。

## 相关文档

- 词表：`CONTEXT.md`「会话过程区（聊天渲染）」——过程块 / 工具展示模型 / 行族 / ZCode 兼容 token 层 /
  过程区表头
- 参考实现：ZCode（Ada）`packages/ui/src/ToolCallBlocks/`（`ToolSummaryRow` / `ToolLayout` /
  `ToolCallBody` / renderers）与 `components/ui/lightweight-diff-preview.tsx`
- 邻近决策：ADR-001（分层：`src/shared` 必须 bridge-safe，所以展示模型放在 `src/shared` 而不是组件目录）
- ADR-003（棘轮：这次拆出来的文件都在 700 行以内，没有新增例外）