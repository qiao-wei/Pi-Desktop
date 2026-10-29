# CONTEXT — Pi Desktop 的领域词表

这份文件回答「这个词在本项目里到底指什么」。术语靠口语约定时，新人和 agent 都会用错，而用错的
代价是**改错文件**（例如把 pi 的「会话」当成 UI 的「会话」去处理）。每条给出：是什么 / 不是什么
（`_避免_`）/ 代码落点。

规则：**引入新词或改变既有词的含义时，先改这里再改代码**。词表只收「有歧义风险」的词，不收
React、npm 这类通用词。

---

## 运行拓扑

**bridge（桥）**
- 是什么：渲染进程之外的 Node 侧进程，持有 pi 内核、会话文件、项目登记与工具开关。渲染进程只通过 HTTP + NDJSON 与它说话。
- _避免_：说成「后端」「server」。它没有多租户、没有数据库（除 SQLite 存会话索引），生命周期跟着一个本地 app 走。
- 代码：`server/index.mjs`（入口与运行时）、**路由表 `server/routeTable.mjs`**（有哪些路由、哪条先匹配、谁处理）、`server/` 其余模块、边界契约 `src/shared/protocol/bridgeEndpoints.ts`、渲染侧 `src/lib/bridge/transport.ts`。
- 相关：`npm run bridge:sync` 把 `server/` + `src/shared/` 拷进 sidecar。

**sidecar（旁车 / 打包内的运行时）**
- 是什么：打包产物里那份 Node 运行时（含 pi 内核与桥代码），由壳在启动时拉起。
- _避免_：与 bridge 混用。bridge 是**逻辑角色**，sidecar 是**产物形态**——同一份代码，dev 下由 `npm run dev` 直接跑，打包后由壳从 `runtime/` 拉起。
- 代码：`scripts/build-bridge-runtime.mjs`、`scripts/lib/bridgeRuntime.mjs`、`src-electron/sidecar.js`。

**宿主 / 壳（host / shell）**
- 是什么：包住渲染进程的原生窗口：Tauri（Rust）或 Electron。渲染进程在两者上跑同一份 `dist/`。
- _避免_：说成「客户端」。宿主只做窗口级能力（文件夹选择、窗口外观、系统通知、打开外链）。
- 代码：契约 `src/shared/protocol/hostCommands.ts`（`HOST_COMMANDS` 是命令白名单）、渲染侧入口 `src/lib/shell/host.ts`、实现 `src-electron/preload.js` / `src-electron/host-commands.js` / `src-tauri/src/lib.rs`。
- 注意：**「宿主在不在场」只能问 `hasHostShell()`**，不要自己嗅 `__TAURI__` / `__TAURI_INTERNALS__`（曾经有三份实现，装了假宿主时会互相矛盾）。

---

## 领域对象

**project（项目）**
- 是什么：一个被登记的本地目录（含它的 pi 配置与信任状态）。侧栏的项目列表就是它。
- _避免_：说成「工作区」（workspace）。`workspace` 在本项目里指引用的第三方包/扩展工作区概念。
- 代码：`server/projectFolders.mjs`、`src/features/workspace/`。

**session（会话）**
- 是什么：pi 的一次对话记录，落在一个 session 文件里；桥可以同时打开多个（每个项目一个 runtime）。
- _避免_：说成「聊天」「conversation」。`ChatThread` 是渲染组件名，不是领域对象。
- 代码：`server/index.mjs` 的 runtime 管理、`src/features/chat/`。

**turn（一轮）**
- 是什么：用户一次提交 → 模型跑完（含工具调用）为止，这一整段。`turn_end` 埋点、通知（「一轮跑完了」）、错误上报都以它为单位。
- _避免_：说成「消息」。一轮里可以有几十条消息与多个工具调用。
- 代码：`src/features/chat/`（流式提交与结束）、`tests/` 里大量 `turn` 命名的用例。

**capability package（能力包 / 扩展包）**
- 是什么：以包形式装到项目里的扩展（skill / extension / MCP 配置）。设置页的「全局技能与扩展」管的就是它。
- _避免_：说成「插件」（plugin）——那是宿主层的词，指原生扩展。
- 代码：`src/features/capabilities/`、`server/capabilitySkillSelection.mjs`、`server/mcpImport.mjs`。

**trust gate（信任闸）**
- 是什么：项目未被信任时，pi 不读它的 `.pi` 配置、不执行它的命令；桥与渲染进程都要按这个状态拒绝请求。
- _避免_：说成「权限」「授权」——它不是用户级权限系统，是**项目级**的读取与执行闸。
- 代码：`server/piKernel.mjs`（`resolveProjectTrusted` / `hasTrustRequiringProjectResources`，两个非公共深引）、`server/index.mjs` 的 `hasTrustRequiringProjectResources` 调用点、渲染侧 `projectTrusted` 字段。

---

## 边界与不变量

**协议（protocol）**
- 本项目里的定义（比「接口」严格）：一处边界只有满足 **假实现 + 一个装配点 + 调用点零改动 + 一条绿测试** 才算有协议。只声明一个 `interface` 不算。
- 代码：登记表 `src/shared/protocol/seams.ts`，规则 `protocol-seam` 强制；文档渲染进 `docs/architecture/protocols.md`。

**seam（接缝）**
- 是什么：一条边界上「换实现的那扇门」——`setBridgeTransport()` / `setHostShell()` / `setStoragePort()` / `setPerfPort()` / `installLocalePreferencePort()` / `setKernelAdapter()`。
- _避免_：说成「抽象层」。接缝有唯一装配点，而且有测试真的调用它。

**bridge-safe（可进 sidecar）**
- 是什么：`src/shared` 下的模块必须同时能进渲染进程与桥（sidecar）——不许依赖 DOM、不许依赖 Node 专有 API。
- 代码：规则 `bridge-closure`；越界就在 `npm run architecture:check` 红。

**棘轮（ratchet）/ 债务例外**
- 是什么：`architecture/policy.json` 里的 `exceptions`：每条带 `ceiling`（只降不升）、`deadline`、`owner`、`reason`。超上限必须**拆**，不允许抬 ceiling；到期未处理即违规。
- _避免_：说成「白名单」。白名单是永久的，这里会过期并失败。

**冻结表面（frozen surface）**
- 是什么：`architecture/generated/bridge-surface.json` 里 101 条路由；桥实际应答的路由与渲染进程命名的路径必须与它**双向**一致。它**由路由表生成**（不是手抄的），所以差异只有两种：有人改了表没跑 `architecture:write`，或有人绕过了表。
- 代码：生成器 `scripts/architecture/lib/surface.mjs`；规则 `protocol-surface`。

---

## 域与依赖（桥侧装配）

**域（domain）**
- 是什么：一块桥内部职责及其工厂 —— 每个 `server/<id>.mjs` 导出一个 `create<Id>(state, deps)`，返回一组函数/对象。今天 15 个（`routesApp`、`promptStream`、`sessionSnapshots`…）。
- _避免_：说成「模块」。模块是文件，域是**装配单位**：它有 id、有声明、在域表里占一行。

**域表（domain table）**
- 是什么：`server/domainTable.mjs`，每域一行 `{ id, create, eager, lazy }`。它是**生成物**（`npm run architecture:write`），内容是各域模块真实读到的名字。手改会被 `domain-deps` 规则打回。
- _避免_：说成「清单/白名单」。它同时是容器的输入（顺序、名字闸、完整性校验），而且是**从代码推导**的，不是另一份要人手维护的真相。

**建厂期读取 vs 闭包读取（eager / lazy）**
- 是什么：同一个域从共享袋里读名字，分两类 —— **建厂期读取**发生在工厂函数体里（建域时真的执行到），是**排序约束**（读到还没发布的名字，容器**当场抛**，并说清是常量传了 `undefined` / 提供者返回了 `undefined` / 还没有人提供）；**闭包读取**发生在请求处理器/回调里，袋子是共享可变的，读到的时候早就填好了，**不参与排序**。
- _避免_：把「模块文本里出现了哪些名字」当排序依据。那会把闭包读取也算成约束，实测凭空造出 130+ 条反向边和一个真环（`promptStream` ⇄ `sessionSnapshots`），而闭包读取对建厂顺序没有任何要求。

**名字闸（name gate）**
- 是什么：容器交给每个域的 `ctx` 只认它声明过的名字，读别的立刻抛（带域 id 与名字）。所以「某个域悄悄多读一个名字」在**启动时**就现形，而不是某条请求路径上拿到 `undefined`。
- _避免_：说成「类型检查」。`deps` 是无类型的（`any`），名字闸是**运行时的**；两者互补，不是一回事。

**纯转发（pass-through）**
- 是什么：`const x = (...args) => deps.x(...args)` 这种手写的转发闭包。A1 之前全仓有 **248 份**（`@type {any}` 主要来源）—— 它们看起来像本地函数，实际只是「调用时再去袋里取一次」。现在调用点直接写 `deps.x(...)`，再手写一份会被规则拦下。
- _避免_：说成「包装函数」。包装会改参数/改语义，纯转发只改名字。

**域容器（domain container）/ 唯一装配点**
- 是什么：`server/domainContainer.mjs`。启动时按域表建域，做四件事：名字闸、建厂期就绪校验（读到空值**当场抛** —— 汇总到末尾就太晚了：拿到 `undefined` 的那一行已经炸在调用点上）、发布（重名即抛）、合并导出。`server/domains.mjs` 因此只剩 23 行（原本 450 行手写顺序 + `Object.assign` 夹块）。
- _避免_：说成「依赖注入框架」。它没有生命周期、没有作用域层级、没有装饰器；就四件启动时检查。

**一条待做**：渲染侧 app-model 段的同类装配还没收敛到这个容器（spec 群 A 第 ⑥ 步，见 ADR-005 的「后果」）。

---

## 流式与运行身份

**run（一次运行）**
- 是什么：一次流式回答在桥侧的完整过程，从 `POST /api/prompt` 被接受到最后一帧写完。它有**自己的** `runId`（随机、不可猜），与「哪个请求发起的」不是一回事 —— 同一个 run 可以被后来的请求**订阅**（`POST /api/runs/stream`）。
- _避免_：说成「请求」。请求是入口，run 是被观察的对象；多端时一个 run 会有多个订阅者。
- 代码：`server/promptStream.mjs`（run 的生命周期）、`server/runStreams.mjs`（帧日志与多订阅者扇出）。

**run owner（run 的持有者）**
- 是什么：**有权中止这轮**的身份。今天隐含为「启动这轮的那个请求」（它断开即中止，见 `DELIVERY_POLICY.onOwnerDisconnect`）；订阅者断开只摘掉自己那条 sink，不动别人的 run。
- _避免_：与下面的 stream holder 混用。owner 是权限，holder 是当下谁在看。
- 代码：`server/promptStream.mjs` 的 `onClientClose`（`!wasStreaming` 那道门就是「谁有权中止」的边界）、`src/shared/protocol/version.ts` 的 `DELIVERY_POLICY`。

**stream holder（当前持有流的窗口）**
- 是什么：当下真正接着 SSE/NDJSON 那条流的渲染窗口（`pollMode.ts` 的 `ownsStream` 就是它）。
- _避免_：说成「owner」。切换窗口不改 owner，只换 holder。
- 代码：`src/features/chat/pollMode.ts`。

**streamSeq（流帧序号）**
- 是什么：**一条 run 内**单调递增、不跳号的帧序号（从 1 开始），由桥的帧写入器盖上去（载荷覆盖不了）。`(runId, streamSeq)` 就是「接着发」的地址。
- _避免_：把 `transport_error` 帧也算进序号。它是**关于这条流**的一句话，不是 run 的一帧；带上序号会把续订地址推过一条从未送达的帧（`overflow` 帧故意不带 `streamSeq`）。
- _避免_：与 `queueSeq` 混用 —— 后者是 pi 队列里那一轮的位置，跟流帧无关。
- 代码：`server/frameWriter.mjs`、`server/runStreams.mjs`；契约字段在 `src/lib/api.ts` 的 `PromptStreamEvent`。

**delivery profile（投递档位）**
- 是什么：桥在握手（`GET /api/protocol`）里声明的「我怎么投递帧」：今天只有 `local-live`（帧只发给在线者，断开即中止那轮）。**认不出的档位 = 不兼容**，不许静默按旧假设继续。
- _避免_：说成「协议版本」。版本是「形状变没变」，档位是「投递语义是什么」。
- 代码：`src/shared/protocol/version.ts`（`DELIVERY_PROFILE` / `DELIVERY_POLICIES`）、镜像 `server/protocolVersion.mjs`。

**重连（reconnect）vs 恢复（recovery）**
- 重连：**同一个客户端重新接到同一条 run** 的流，靠「我收到第 N 帧了」续订（`fromSeq`）。渲染侧已经接上（`promptFeed`）：流坏了就自动续订，续不上才走恢复。
- 恢复：新客户端或重启后拿到**完整会话状态**（快照 + 历史）。与「续订同一条流」是两件事。
- _避免_：互相混用；也避免把「跨设备恢复」说成「重连」——前者没有**中继**不可实现。
- 代码：重连的落点是 `server/runStreams.mjs` 的 `plan(fromSeq)` 与 `POST /api/runs/stream`；客户端是 `src/features/chat/promptFeed.ts`。

**断流（feed damage）**
- 是什么：这条 prompt 流本身坏了——收到 `transport_error`，或 `streamSeq` 跳号。**桥上的 run 可能还活着**，这是它和「这一轮失败了」的关键区别。
- 处理：先续订（`(runId, 最后一条带序号的帧 + 1)`），续不上才强制拉一次快照追平。**不许**当场把这一轮当失败收尾：那会提前把气泡标 done、发一条假的「完成」通知、收掉停止按钮，而服务端还在写。
- 代码：`src/features/chat/promptFeed.ts`（游标 + 续订 + 重试）、`usePiDesktopApp.ts` 的 `reconcileLostFeed`（续不上时的兜底）。

**载荷预算（payload budget）**
- 是什么：**帧内容**的大小上限。和 `frameWriter` 的待发上限（4 MiB，管的是"积压了多少还没发出去"）不是一回事：那管的是积压，这管的是单条载荷本身。三层：
  ① 单个参数字符串 32 KiB（裁成 head + `…` + tail，`__omitted` 记下原文的字节数与行数）；
  ② 参数流 delta 累计 64 KiB（打字机停发，收尾由带裁剪后对象的 `tool_call_stream_end` 负责）；
  ③ 整帧 1 MiB（`runStreams.publish` 裁，两档字符串预算，最坏降级为"只留结构字段 + `__dropped`"）。
- 为什么裁在**落日志之前**：日志里存的就是订阅者会收到的那一份。存原文的话，重放会把刚排空的 socket 再打满一次，"越限 → 续订 → 越限"永远出不来。
- _避免_：把"裁"说成"截断"。正文是 **head + tail**（读日志、读编译错误时结尾才是重点），参数对象保持**合法 JSON**，`path` / `command` 这类短字段不受影响，而 `+N`、`行数` 一律来自**裁剪之前**的原文。
- _避免_：静默裁剪。裁掉就要带标记（参数里的 `__omitted`、块上的 `resultTruncated`、帧上的 `__cuts`，最坏是 `__dropped`），界面据此说"未随流传输"或"只显示了首尾"。空 diff 绝不能被当成"没有改动"。
- 前提：**全文不在线上**。`write` 写的那份文件、bash 的 `fullOutputPath` 才是原文；"展开全文"应该去读文件，而不是要求把 MB 级正文再发一遍。
- 代码：`src/shared/toolPayloadBudget.ts`、`server/runStreams.mjs` 的 `publish`、`server/promptStream.mjs` 的工具帧；诊断事件 `run.frame_budget`。

**中继（relay）**
- 是什么：跨机器的传输路径。它引入**有损传输**，因此是 ack / 重传唯一说得通的场景；也是**信任模型必须先补上**的地方（今天桥零鉴权 + CORS `*`，只绑 127.0.0.1）。
- _避免_：说成「远程功能」。中继是传输路径，不是一组功能。
- 状态：**推迟**（不是不做），前置条件见 ADR-004 与 `docs/specs/architecture-extensibility.md`。

---

## 会话过程区（聊天渲染）

助手气泡里**除正文之外**的那部分：一串过程块。它们按 ZCode 生产环境的行语法渲染（见 ADR-006）。

**process region（过程区）**
- 是什么：一轮里**全部**过程行（+ 夹在它们之间的叙述文本）折成的**一个** disclosure，表头是「工作中/已工作 N 秒」（ZCode 的 `chat.history.workingFor` / `workedFor`，即 turn history）。运行中它是展开的，**整轮结束自动折叠**（ZCode 的 `assistantHistoryDefaultOpen`）。
- 边界：区域一直盖到**最后一个**思考/工具块为止；那之后的正文（也就是答案）留在区域外 —— 折叠时读者丢掉的只有过程，答案原地不动。
- _避免_：说成「工具组」（那是已删的旧分组概念）；也别说「行会自己折叠」——**自动折叠只有区域这一处**，行级的开合只由读者点击驱动。
- 代码：`src/components/assistant-ui/elements/thread.aui.tsx` 的 `PiDesktopProcessGroup`；判定与推迟在 `src/shared/collapseGate.ts`、`src/components/assistant-ui/elements/deferredCollapse.ts`。

**process header label（过程区表头文案）**
- 是什么：区域表头那一句 —— 运行中是「工作中 N 秒」，落定是「已工作 N 秒」（ZCode 的 `workingFor` / `workedFor`）；拿不到时长时退回无时长的「工作中」/「思考过程」（ZCode 的 `labels.history`）。
- 时长有两个来源，且**只有这两个**：转录自己的条目时间戳（整轮的跨度，**从问题那一条算起** —— 问题的时刻不在 `pendingTurn` 里，不 prepend 就只剩一个点，会被算成「没有时长」），以及「这个客户端看了多久」（落定瞬间快照还没描述这一轮时的兜底，`observedTurnDuration`）。**没有客户端秒表**：重放出来的一轮没有 delta，秒表无从测起。
- 每块思考的时长（`Thought · N 秒`）同样只来自客户端观测（首个 delta → 块关闭），并必须活过快照重建（`thinkingTiming.ts`）；转录里没有逐块时间戳。
- _避免_：说成「计时器」。它是**读出来的**跨度，不是跑着的表；「不知道」和「瞬间」是两回事，前者退回无时长文案，后者才取 1 秒下限。
- 代码：`src/shared/chatTurnTiming.ts`（`turnDurationOf` / `observedTurnDuration` / `settleStreamingAnswer`）、`src/shared/thinkingTiming.ts`（逐块观测与搬运）、消费方 `thread.aui.tsx` 的 `PiDesktopProcessGroup`。

**change summary card（变更文件卡片）**
- 是什么：一轮结束后、答案下面那张「N 个文件已更改」卡片，逐字照 ZCode 的 `ConversationFileSummaryPanel`。表头是 chevron + 标题 + 聚合 `+X -Y`；展开后每行「图标 + 文件名 + 目录 + 自己的 `+N -M`（只画非零那侧）+ `审查` / `打开 ⌄`（分段控件）」。
- 点击语义：「审查」渲染**这一轮的补丁**（`RightPanelFileTab.patch`，来源标签「本轮改动」），不是现读 git —— 新建文件在 git 里还是 untracked、改完就 commit 的文件在 unstaged 里也是空的。「打开」走正文。两者都先把路径折成**相对项目根**（右面板拒绝绝对路径）。
- 边界：**在消息正文列里、操作栏之前**（走消息内部的 `trailing` 槽位）；只在落定后出现（流式途中列表会一行行往外蹦）；默认收起（它是索引，不是正文）。数据只认 `write` / `edit` 两个工具 —— `bash` 改文件没有可信路径，宁可不列。
- _避免_：说成「git 改动」。它答的是「**这一轮**改了什么」，git 只知道「相对 HEAD 有什么改动」，两轮改同一个文件时会混在一起。
- 代码：`src/features/chat/TurnChangedFiles.tsx`、数据 `src/shared/turnChangedFiles.ts` 的 `collectTurnChangedFilesWithCounts`（行数只从 `display.files` 读；同一文件取最后一次调用；`counted: false` = 数不出来，不显示数字）；补丁 tab 在 `src/features/workspace/{rightPanelTabs,useWorkspacePanelTabs}.ts`。
- 样式：半径用**绝对**像素（卡片 `rounded-[12px]`、按钮 `rounded-[8px]`）—— `rounded-xl` 在本仓跟随主题 `--radius`（codex 16px → 20px），表头会变成胶囊。悬停用 `hover:bg-hover` / `hover:border-border-hover` —— 这两个 token 是后补的，缺了它们 Tailwind 会**静默丢弃**规则（类名对、界面没反馈）；按钮底色用 `bg-card` 而不是 `bg-input`（两仓同名不同义：那边的 input 是面、本仓是描边）。

**process block（过程块）**
- 是什么：助手气泡里 `kind` 不是 `text` 的那些块 —— `thinking` / `tool` / `notice`。它们有顺序、可合并（流式里同一块会被反复重算），是过程区的**唯一数据形状**。
- _避免_：说成「工具组」「步骤」。分组是旧实现的渲染概念（已删），块本身是平铺的。
- 代码：`src/types/domain.ts` 的 `ProcessBlock`、`src/shared/chatProcessBlocks.ts`（合并与投影）、`src/shared/chatStreamProjection.ts`（线 → 块）。

**tool display（工具展示模型 `ToolDisplay`）**
- 是什么：一行的**已分类**内容：行族 + 动作词 + 目标 + 状态 + 正文模型（diff 文件 / 终端输出 / 参数 / 结果）。在**投影边界**从「工具名 + 参数 + 结果信封」派生一次，挂在过程块的可选字段 `display` 上。
- _避免_：说成「格式化」或「主题」。它不是渲染样式，是**从结构化结果里读出来的事实**（`edit` 的 `details.patch`、`bash` 的 `structuredContent.exit_code`）；渲染层不许再解析结果文本。
- 代码：`src/shared/toolDisplay.ts`（`deriveToolDisplay` / `toolDisplayForBlock` / `sameToolDisplay`）、消费方 `elements/tool-row.tsx` + `elements/tool-bodies.tsx`。
- 注意：**字段是可选的**。老会话的转录与不产出结构化结果的工具没有它，走兜底行（参数 + 结果），这是常态之一而不是异常。
**running label（运行态动作词）**：一行在进行中时，动作词是进行时（`正在思考` / `正在写入` / `正在编辑` /
`正在执行` / `正在读取` / `正在搜索`）并带一条扫光带；落定后换回名词（`写入` / `终端` / `思考 · N 秒`）。
运行与否**只来自该 part 自己的 `status`**（`running ?? status?.type === "running"`），不看整条消息是否在跑。
扫光基于 `currentColor`，所以运行态标签**不许再叠淡色**；短标签用 `shimmer-spread-30 shimmer-angle-0`
收窄扫光带，否则整行长期落在软色带里，看起来就是一行淡灰字。兜底行（`display` 还没派生）按 family 取同一组
词表，只有未知工具才显示它自己的名字。

**translator reference（翻译函数引用）**：`useT()` 返回的是**按语言分键的固定引用**，不是模块级 `t`
（`src/i18n/react.ts` 的 `translators`）。模块级 `t` 的引用永远不变，`useMemo(..., [t])` 在切语言时
不会重算 —— 过程行就会停在切换前那一门语言（用户 2026-10-29 的截图：思考行已经是「思考」，
bash 行还写着 `Terminal`）。让引用跟着语言换，所有已经依赖 `t` 的派生值自动失效。
_避免_：把 `useT` 改回 `return t`；或在每个 `useMemo` 里额外挂一个 `[locale]` 去绕（那是补丁，
不是契约）。回归用例：`e2e/specs/toolRows.spec.ts`「切语言时行上的文字当场跟着换」。

**diff second pass（diff 的第二遍高亮）**：内联 diff 的第一帧永远是**纯文本**；Shiki token 由
`useDiffHighlight` 异步补（复用右侧面板的 `shiki-wasm` shared highlighter，语言名来自
`inferCodeLanguage`，主题跟着 `<html>.dark`）。规则在 `src/shared/diffHighlight.ts`：按**同一种行**
切段（一段一次 tokenize，跨行语法才连得上），token 行数或正文对不上就**整段不画** —— 宁可不着色，
也不能让颜色落到别的行上。纯文本语言（`log`）不跑；高亮失败等于没发生。

**streaming preview（流式读数）**
- 是什么：`edit`/`write` 行尾的 `+N −M` 在**工具还没跑**的时候就已经在涨 —— 值来自**已经到达的参数文本**（`edit` 的 `edits[].oldText/newText` 行数、`write` 的 `content` 行数），不是等结果里的 `details.patch`。
- 边界：结果是权威。`details.patch` 一到就用它（带上下文行、计数一致）；`status === "done"` 的块不再重算；**失败的行不显示预览**（参数描述的是「打算做什么」，失败的写没有发生）。
- `write` 的 `−M` 需要**写入前的文件**：宿主注入一个同步读 + 后台补的读取器（`fileBaseline.ts`），纯派生层只接一个 `baseline?: string`；读不到（新文件/项目外/二进制/超大）就只给 `+N`，绝不编 `−0`。
- _避免_：说成「估算」或「预测」。它是**已到达部分的精确读数**：参数是精确替换，`oldText`/`newText` 的行数就是删/增行数；唯一被省略的是「还没到的那部分」。
- 代码：`src/shared/toolArgsPreview.ts`（半截 JSON 解析 + 128 字符分档节流 `streamedArgsDisplay`）、`src/shared/toolDisplay.ts` 的 `previewEditDisplay` / `patchForWrittenFile`。

- 路径段（行尾的目录，`toolRowFolder`）**永远非空**：文件就在工作区根时显示工作区的文件夹名并带尾斜杠（`iej/`），项目外路径保留自己的目录 —— 空着读起来像这个文件没有位置。

**row family（行族）**
- 是什么：工具名 → 一族，决定动作词、图标与正文形态：`read` / `write` / `edit` / `execute`（bash、powershell）/ `search`（grep、ls、find）/ `mcp`（`mcp__<server>__<tool>`）/ `other`。
- _避免_：与「工具名」混用。族是**一的映射**（`mcp__*` 要先于内置名判定），名字到词表的对照只有一张表。
- 代码：`src/shared/toolDisplay.ts` 的 `toolRowFamily` / `parseMcpToolName`；词在 `src/i18n/{en,zh}.ts` 的 `process.tool.*`。

**ZCode 兼容 token 层**
- 是什么：`src/app/tailwind.css` 里那批按 ZCode 名字与公式定义的 token：`--text-ui-caption|base|sm|xs`、`--foreground-subtle` / `--foreground-subtlest`（由**本主题**的 `--foreground` 混出 60%/40%；深色只把 subtlest 提到 30%）、`--color-diff-added|removed`、`--animate-collapsible-down|up`、**`--conversation-block-gap`**（会话内「块与块」的间距，默认 1rem：过程行之间、行与正文之间都是它 —— 正文与行是同一个列里的兄弟，没有第二套间距）。
- _避免_：当成「主题变量」随意改值。它们的作用是让过程行的**层级**（最淡一档文字、diff 底色）与参考实现一致；深浅两档只写在 `src/themes/{default,codex}/theme.css` 的 `.dark` 里，组件里不写死颜色。
- 代码：`src/app/tailwind.css` 的 `@theme` 块；契约在 `tests/toolRow.test.ts`（类名与 token 值一起钉）。

---

## 开发开关（不要和用户偏好混为一谈）

这些是开发者用的，读到就在启动时生效；读法都走存储端口（`getStoragePort()`），但语义上是**开关**不是用户设置：

| 开关 | 作用 |
| --- | --- |
| `?perf=1` / `?perf=overlay` / `VITE_PI_DESKTOP_PERF=1` | 打开性能探针（`PerfPort`） |
| `pi-desktop.perf.console` = `1` | 探针结果打到 console |
| `pi-desktop.diag.console` = `1` | 诊断上报打到 console |
| `pi-desktop.strict` = `1` | 打开 React StrictMode（dev） |
| `VITE_PI_DESKTOP_DIAGNOSTICS_ENABLED=1` | 允许上报诊断事件（默认关） |