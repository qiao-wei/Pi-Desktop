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
- _避免_：与 `queueSeq` 混用 —— 后者是 pi 队列里那一轮的位置，跟流帧无关。
- 代码：`server/frameWriter.mjs`、`server/runStreams.mjs`；契约字段在 `src/lib/api.ts` 的 `PromptStreamEvent`。

**delivery profile（投递档位）**
- 是什么：桥在握手（`GET /api/protocol`）里声明的「我怎么投递帧」：今天只有 `local-live`（帧只发给在线者，断开即中止那轮）。**认不出的档位 = 不兼容**，不许静默按旧假设继续。
- _避免_：说成「协议版本」。版本是「形状变没变」，档位是「投递语义是什么」。
- 代码：`src/shared/protocol/version.ts`（`DELIVERY_PROFILE` / `DELIVERY_POLICIES`）、镜像 `server/protocolVersion.mjs`。

**重连（reconnect）vs 恢复（recovery）**
- 重连：**同一个客户端重新接到同一条 run** 的流，靠「我收到第 N 帧了」续订（`fromSeq`）。今天只是**留了形状**，没有实现。
- 恢复：新客户端或重启后拿到**完整会话状态**（快照 + 历史）。与「续订同一条流」是两件事。
- _避免_：互相混用；也避免把「跨设备恢复」说成「重连」——前者没有**中继**不可实现。
- 代码：重连的落点是 `server/runStreams.mjs` 的 `plan(fromSeq)` 与 `POST /api/runs/stream`。

**中继（relay）**
- 是什么：跨机器的传输路径。它引入**有损传输**，因此是 ack / 重传唯一说得通的场景；也是**信任模型必须先补上**的地方（今天桥零鉴权 + CORS `*`，只绑 127.0.0.1）。
- _避免_：说成「远程功能」。中继是传输路径，不是一组功能。
- 状态：**推迟**（不是不做），前置条件见 ADR-004 与 `docs/specs/architecture-extensibility.md`。

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