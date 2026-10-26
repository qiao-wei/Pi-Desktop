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
- 代码：`server/index.mjs`（路由与运行时）、`server/` 其余模块、边界契约 `src/shared/protocol/bridgeEndpoints.ts`、渲染侧 `src/lib/bridge/transport.ts`。
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
- 是什么：`architecture/generated/bridge-surface.json` 里 96 条路由；桥实际应答的路由与渲染进程命名的路径必须与它**双向**一致。
- 代码：规则 `protocol-surface`。

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