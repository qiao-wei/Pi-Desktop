import { expect, test, waitForFirstPaint, sendMessage } from "../lib/fixtures";
import { E2E_MODEL_ID } from "../lib/fakeModel.mjs";

/**
 * 冷启动 + 一轮流式对话。
 *
 * 这是 e2e 存在的**第一天就抓到真 bug 的那条用例**：B1 拆分（`server/index.mjs` → 18 个域）
 * 里有两处把 `Map` / 对象当成函数转发（`deps.X(...args)`），`POST /api/projects` 与
 * `POST /api/projects/command/run` 一进来就 500。node 级测试看不见 —— 它们没有真正起过桥。
 */
test("冷启动能画出界面，并且一轮对话能流式跑完", async ({ page, harness }) => {
  await page.goto(harness.rendererUrl, { waitUntil: "domcontentloaded" });
  await waitForFirstPaint(page);

  // 先建项目并把模型固定到假模型上（用户视角这相当于"打开一个目录、选一个模型"）。
  const projectId = await harness.api.openProject(harness.workspaceDir);
  await harness.api.selectE2EModel({ projectId });
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForFirstPaint(page);

  await sendMessage(page, "请复述这段测试文本");

  // 用户那条消息真的进了会话。
  await expect(page.locator("[data-message-id$='#user']")).toContainText("请复述这段测试文本");

  // 助手那条：分块到达 —— 先看到前一段，最后补齐整句。
  const assistant = page.locator("[data-message-id$='#assistant']").last();
  await expect(assistant).toContainText("E2E-1", { timeout: 30_000 });
  await expect(assistant).toContainText("E2E-3 done");

  // 假模型收到的请求：确实是这个 provider/model，且真的带上了这条用户消息。
  const turn = harness.requests.filter((request) => request.path.endsWith("/chat/completions"));
  expect(turn.length).toBeGreaterThan(0);
  const streamed = turn.find((request) => request.body.stream === true) ?? turn[0];
  expect(streamed.body.model).toBe(E2E_MODEL_ID);
  const serialized = JSON.stringify(streamed.body);
  expect(serialized).toContain("请复述这段测试文本");

  // 这一轮真的结束了：发送键从"排队后续消息"回到"发送"（流式中它是 Queue follow-up，且旁边有 Stop）。
  // 不去断言 send-button `enabled`：输入框是空的，按设计它本来就该是禁用的。
  await expect(page.locator(".composer .send-button")).toHaveAttribute("aria-label", "Send", { timeout: 30_000 });});