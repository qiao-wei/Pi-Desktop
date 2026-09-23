import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { choosePollMode, pollDelayMs } from "../src/features/chat/pollMode.ts";
import { applyAmbientBootstrap, isBootstrapForSession } from "../src/features/chat/ambientState.ts";

/**
 * 流式进行中的对账轮询改造（pi：不轮询状态、只推）的回归用例。
 *
 * 真问题：`hasBusySessions` 时那个定时器在**流越安静时拉得越勤**（健康 5s、静默 1s），
 * 而每次都是全量 `/api/bootstrap`（实测 609KB，最大见过 1.8MB），服务端
 * `JSON.stringify`+md5、客户端 parse+normalise+merge 全在两个主线程上；
 * 一次实测的工具执行静默 11.9 秒 = 约 12 次全量拉取。上下文越大越卡，就是这个。
 */

const OWNER = { ownsStream: true, isStopping: false };

test("自己 own 这条运行且流在动：只要环境态，不搬转录", () => {
  assert.equal(
    choosePollMode({ ...OWNER, sinceLastStreamEventMs: 40, sinceFullReconcileMs: 60_000 }),
    "ambient",
  );
});

test("长工具执行（流静默 12 秒）不得退化成每秒全量", () => {
  // 改前的形状：静默超过 3 秒 => 1 秒一次全量。这条就是钉住它。
  assert.equal(
    choosePollMode({ ...OWNER, sinceLastStreamEventMs: 12_000, sinceFullReconcileMs: 5_000 }),
    "ambient",
    "流静默但连接在：转录由我们自己那条流供给，无需再搬",
  );
});

test("静默太久仍要补一次全量，兜住“连着但服务端不再写字节”的哑火", () => {
  assert.equal(
    choosePollMode({ ...OWNER, sinceLastStreamEventMs: 12_000, sinceFullReconcileMs: 15_000 }),
    "full",
  );
});

test("不是我们起的运行 / 正在等停止落下：保持全量", () => {
  assert.equal(
    choosePollMode({ ownsStream: false, isStopping: false, sinceLastStreamEventMs: 0, sinceFullReconcileMs: 0 }),
    "full",
    "别人的 token 根本不会到我们的流上",
  );
  assert.equal(
    choosePollMode({ ownsStream: true, isStopping: true, sinceLastStreamEventMs: 0, sinceFullReconcileMs: 0 }),
    "full",
  );
});

test("节奏：ambient 5 秒，full 保持原来的 1 秒", () => {
  assert.equal(pollDelayMs("ambient"), 5000);
  assert.equal(pollDelayMs("full"), 1000);
});

/* -------------------------------------------------------------------------- */
/* 环境态入档：绝不碰转录                                                       */
/* -------------------------------------------------------------------------- */

const PATH = "/tmp/proj/.pi/session.jsonl";

function bootstrapFixture(messages: unknown[]) {
  return {
    activeSessionPath: PATH,
    canPrompt: false,
    streamingSessionPaths: [PATH],
    compactingSessionPaths: [],
    pendingQueues: { steering: [], followUp: [], seq: 3 },
    snapshot: { conversation: { sessionFile: PATH, messages }, modelConfig: {} },
  } as never;
}

const AMBIENT = {
  ambient: true as const,
  activeSessionPath: PATH,
  canPrompt: true,
  projectTrusted: true,
  streamingSessionPaths: [] as string[],
  compactingSessionPaths: [] as string[],
  pendingExtensionUiRequests: [],
  pendingQueues: { steering: [], followUp: [], seq: 9 },
};

test("ambient 入档后转录仍是同一个引用（新引用 = 整棵 thread 白重渲染）", () => {
  const messages = [{ id: "t1#user", role: "user", content: "hi" }];
  const next = applyAmbientBootstrap(bootstrapFixture(messages), AMBIENT, PATH);

  assert.ok(next);
  assert.equal(
    next.snapshot.conversation.messages,
    messages,
    "必须还是同一个数组引用：每 tick 换引用就是一个周期性卡顿",
  );
});

test("ambient 只折它带的东西：忙碌旗标 / 可提示 / 队列序号地板", () => {
  const next = applyAmbientBootstrap(bootstrapFixture([]), AMBIENT, PATH);

  assert.equal(next.canPrompt, true);
  assert.equal(next.projectTrusted, true);
  assert.deepEqual(next.streamingSessionPaths, []);
  assert.equal(next.pendingQueues.seq, 9, "序号要跟上，否则迟到事件能把已消费的插话捞回来");
});

test("不匹配会话的回包整块丢弃（迟到的 in-flight 轮询不得污染当前会话）", () => {
  const before = bootstrapFixture([{ id: "t1#user", role: "user", content: "hi" }]);

  assert.equal(applyAmbientBootstrap(before, { ...AMBIENT, activeSessionPath: "/tmp/other" }, "/tmp/other/session.jsonl"), null);
  assert.equal(isBootstrapForSession(before, PATH), true);
  assert.equal(isBootstrapForSession({ ...before, activeSessionPath: undefined }, PATH), true, "没 activeSessionPath 时要退化到 sessionFile");
});

test("没带队列的 ambient 回包不得把已有队列抹空", () => {
  const next = applyAmbientBootstrap(bootstrapFixture([]), { ...AMBIENT, pendingQueues: undefined }, PATH);

  assert.equal(next.pendingQueues.seq, 3, "缺字段 = 保持原样，不是“服务端没队列”");
});

test("接线：ambient 分支不走向全量 merge", () => {
  const source = readFileSync("src/features/chat/usePiDesktopApp.ts", "utf8");
  const start = source.indexOf('case "apply-ambient":');
  const ambientCase = source.slice(start, source.indexOf("default:", start));

  assert.ok(start > 0 && ambientCase.length > 0);
  assert.equal(ambientCase.includes("mergeStreamingBootstrap("), false, "插话回收只许走全量那条路");
  assert.equal(ambientCase.includes("normalizeBootstrap("), false);
});

test("接线：轻量视图两端都在", () => {
  const server = readFileSync("server/index.mjs", "utf8");
  const api = readFileSync("src/lib/api.ts", "utf8");
  const hook = readFileSync("src/features/chat/usePiDesktopApp.ts", "utf8");

  assert.match(server, /url\.searchParams\.get\("view"\) === "ambient"/);
  assert.match(server, /function buildAmbientSnapshot/);
  assert.equal(
    server.slice(server.indexOf("function buildAmbientSnapshot"), server.indexOf("function buildAmbientSnapshot") + 1600)
      .includes("buildChatBubbles"),
    false,
    "轻量视图绝不许构建会话",
  );
  assert.match(api, /\/api\/bootstrap\?view=ambient/);
  assert.match(hook, /fetchAmbientBootstrap\(\)/);
  assert.match(hook, /choosePollMode\(/);
  assert.match(hook, /acceptAmbientBootstrap\(ambient, requestedSessionPath\)/);
  // 发送那一刻也不许再搬整份会话（实测 609KB，最大见过 1.8MB）。
  const submitStart = hook.indexOf("const submitTurn = useCallback(");
  const submitRegion = hook.slice(submitStart, hook.indexOf("\n  }", submitStart));
  assert.match(submitRegion, /const ambient = await fetchAmbientBootstrap\(\)/);
  assert.match(submitRegion, /if \(streamState\.controller\)/);
});
