# e2e（端到端）

真起桥（`server/index.mjs`）、真起渲染进程（vite dev）、真开浏览器 —— 只把**模型端点**换成
脚本化的假服务。`npm test` 那 2,100+ 条跑的是纯逻辑与模块契约；这一层回答的是另一个问题：
**整条路真的能跑起来吗**。

## 用例

| 用例 | 断言的是 |
| --- | --- |
| `specs/streamTurn.spec.ts` | 冷启动画出界面；发一条消息，助手的分块文本真的流到 DOM 里；这一轮结束后回到可发送状态 |
| `specs/protocolMismatch.spec.ts` | 桥公告了对不上的协议版本时，界面**说出可操作的话**（含双方版本号），而不是白屏 |
| `specs/trustGate.spec.ts` | 未信任项目的项目级资源不加载（技能真的看不见）、提示可见、点"信任并加载"之后技能真的出现 |
| `specs/packagedShell.spec.ts` | Electron 外壳起窗、首屏画出来、并且真的从桥拿到了数据 |

## 为什么是"假模型端点"而不是"假内核"

假内核（在 `server/piKernel.mjs` 那一层塞一个假的 pi）听起来更彻底，但它会把**桥自己的
plumbing** 换掉：会话生命周期、事件映射、SSE 帧、渲染进程的 reducer。那些恰恰是最容易写错、
也最值得测的部分。

改成假模型端点之后：

- pi 内核、桥、渲染进程**全是真的**，只有"模型怎么回话"是脚本化的（`E2E-1 E2E-2 E2E-3 done`，分块间隔可控）；
- 生产代码里**不需要任何测试后门**（没有"测试模式"开关，也就没有"生产环境误开"的风险）；
- 一整轮对话是确定性的：分块顺序、每块的延迟都由我们决定，于是"首字先到、末尾补齐"这种时序也能断言。

隔离靠桥自己认的两个变量（见 `server/sessionStoreFactory.mjs`、`server/bridgeListen.mjs`）：

- `PI_CODING_AGENT_DIR=<临时目录>`：每个用例一套全新的 agent 目录（`models.json`、会话库），不动 `HOME`；
- `PI_DESKTOP_PORT=0`：桥自己挑空闲端口并从 stdout 公告（`PI_DESKTOP_BRIDGE_URL=`），并行跑不会抢端口。

`models.json` 里放一个自定义 provider（`baseUrl` 指向假端点、内联 `apiKey`），于是"已经配好 key"
这件事也是真的走桥自己的配置读取路径。

## 怎么跑

```bash
# 首次：装 Playwright 的 chromium（约 120MB）
npx playwright install chromium

npm run e2e                 # 4 条用例，约 1 分钟
npm run e2e:report          # 看上一次失败的 HTML 报告（e2e/.report）

# 本机已经装了 Chrome 时可以不下载浏览器：
PLAYWRIGHT_CHANNEL=chrome npm run e2e
# 跳过外壳冒烟（没有显示服务器时）：
PI_DESKTOP_E2E_SHELL=0 npm run e2e

# 不起浏览器，只验证"假模型 + 桥 + 一轮对话"这条路：
node e2e/lib/smoke.mjs
```

## CI

`.github/workflows/package-electron.yml` 里的 `e2e` 作业：ubuntu runner、官方 chromium
（`npx playwright install --with-deps chromium`）、跑浏览器那三条（`PI_DESKTOP_E2E_SHELL=0`），
失败即红，并且**是出包作业的硬门**（与 `verify` 一样没有开关可以跳过）。

外壳冒烟在 CI 里跳过：headless runner 上要 xvfb，Electron 还常常要 `--no-sandbox`。
它在本地（或任何有显示的环境）跑，是"壳起来了但渲染进程拿不到地址"这类白屏的唯一防线。

## 它上线第一天就抓到的真 bug

B1 拆分（`server/index.mjs` 7,839 → 876 行，18 个域）之后，2,100+ 条 node 级测试全绿，
但第一次真起桥就 500：

- `server/bridgeUtils.mjs` 把 `lastCapabilityLoadStatuses`（一个 `Map`）当函数转发
  （`(...args) => deps.X(...args)`），`.get/.set` 全没了；
- `server/routesProjects.mjs` 把 `projectCommandRuns`（一个带 `register/scanProcesses/list/stop` 的对象）同样转发。

同一个 500 还牵出第三处：`server/mcpInspector.mjs` 在**建厂时**就 `const { findProject } = deps`，
而那些名字要到后面几个域才填进 `deps`（`undefined` 被永久捕获）。

现在这三类都有测试按着：

- `tests/domainAssembly.test.ts`：装配顺序不变式（建厂时不许解构还没填的 `deps` 成员）、
  转发名不许被当成对象用（`.get` / `.register` 这种用法）。
- 本目录的 `streamTurn.spec.ts`：真起桥、真发一轮 —— 这类"只有真跑才炸"的 bug 的兜底。

## 加一条新用例

用 `e2e/lib/fixtures.ts` 提供的夹具：

```ts
import { expect, test, waitForFirstPaint, sendMessage } from "../lib/fixtures";

test("我的场景", async ({ page, harness }) => {
  await page.goto(harness.rendererUrl);
  await waitForFirstPaint(page);
  // harness.api.get/post：直接打桥的 HTTP 面（建项目、选模型、读快照……）
  // harness.requests：假端点收到的请求（断言桥到底把什么发给了模型）
});
```

夹具是 **worker 作用域**的：vite 与桥全程只起一次，用例之间共享桥的状态 —— 需要干净状态的地方
（比如"未信任项目"）自己造目录和项目，这也是真实用户的用法。`workers: 1`（见 `playwright.config.ts`）
是因为一套夹具就带两个进程。