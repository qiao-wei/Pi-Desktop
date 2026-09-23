/**
 * 真 pi 对象上的落盘验证（不联网、不起浏览器）。
 *
 * 覆盖「每条会话用自己的模型；只有新建任务继承最后一次选择」这条语义里，只有真实现才能证明
 * 的三件事：
 *   1. pi 打开会话时会自己按会话文件里的 `model_change` 恢复模型，且不改全局 settings；
 *   2. 桥的兜底修复（session-open）只写会话文件，settings.json 一个字都不动 —— 连「记住的默认
 *      模型临时用不了、退到列表第一项」这种最容易吃人的场景也不动；
 *   3. 用户主动切换（user-switch）才真的把默认值落进 settings.json。
 *
 * 假端点指向 127.0.0.1:9（discard 端口，没人监听）：全程只创建会话/换模型，不发请求。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { applyModelToSession, MODEL_APPLY_REASONS, silenceGlobalModelWrites } from "../server/sessionModelPolicy.mjs";

/** 每家供应商一个模型、id 各不相同：断言才分得清「到底把哪家哪个写进了文件」。 */
const PROVIDERS = ["pa", "pb", "pc"] as const;
const modelOf = (provider: string) => `model-${provider.slice(-1)}`;

const providerConfig = (provider: string) => ({
  name: provider.toUpperCase(),
  baseUrl: "http://127.0.0.1:9/v1",
  api: "openai-completions",
  models: [
    {
      id: modelOf(provider),
      name: `${provider} model`,
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8000,
      maxTokens: 1000,
    },
  ],
});

interface Sandbox {
  cwd: string;
  agentDir: string;
  sessionDir: string;
  settingsFile: string;
  authFile: string;
  modelRuntime: any;
  readSettings: () => Record<string, unknown>;
  readDefaults: () => { provider?: string; model?: string };
}

async function createSandbox(
  defaults: { provider: string; model: string } | null,
  options: { withoutKey?: string[] } = {},
): Promise<Sandbox> {
  const root = mkdtempSync(join(tmpdir(), "pi-desktop-model-per-session-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionDir = join(agentDir, "sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  const models: Record<string, unknown> = {};
  const credentials: Record<string, unknown> = {};
  for (const provider of PROVIDERS) {
    models[provider] = providerConfig(provider);
    if (!options.withoutKey?.includes(provider)) {
      credentials[provider] = { type: "api_key", key: `sk-${provider}` };
    }
  }
  const authFile = join(agentDir, "auth.json");
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: models }, null, 2));
  writeFileSync(authFile, JSON.stringify(credentials, null, 2));

  const settingsFile = join(agentDir, "settings.json");
  writeFileSync(
    settingsFile,
    JSON.stringify(defaults ? { defaultProvider: defaults.provider, defaultModel: defaults.model } : {}, null, 2),
  );

  const modelRuntime = await ModelRuntime.create({
    authPath: authFile,
    modelsPath: join(agentDir, "models.json"),
  });
  await modelRuntime.refresh({ allowNetwork: false });

  const readSettings = () => JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;

  return {
    cwd,
    agentDir,
    sessionDir,
    settingsFile,
    authFile,
    modelRuntime,
    readSettings,
    readDefaults: () => {
      const raw = readSettings();
      return { provider: raw.defaultProvider as string | undefined, model: raw.defaultModel as string | undefined };
    },
  };
}

/** 造一条「用过了」的会话：有消息（pi 认这个才肯恢复），并且带着自己的 model_change。 */
function usedSession(box: Sandbox, provider: string) {
  const manager = SessionManager.create(box.cwd, box.sessionDir);
  manager.appendModelChange(provider, modelOf(provider));
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "第一条" }],
    timestamp: Date.now(),
  } as never);
  manager.appendMessage({
    role: "assistant",
    model: modelOf(provider),
    provider,
    content: [{ type: "text", text: "收到" }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "stop",
    timestamp: Date.now(),
  } as never);
  return manager.getSessionFile() as string;
}

async function openSession(box: Sandbox, sessionPath: string) {
  const settingsManager = SettingsManager.create(box.cwd, box.agentDir, { projectTrusted: false });
  const sessionManager = SessionManager.open(sessionPath, box.sessionDir, box.cwd);
  const created = await createAgentSession({
    cwd: box.cwd,
    agentDir: box.agentDir,
    modelRuntime: box.modelRuntime,
    settingsManager,
    sessionManager,
  });
  return { session: created.session, settingsManager };
}

test("沙盒自检：模型与鉴权是真的（否则下面几条都在假绿）", async () => {
  const box = await createSandbox({ provider: "pa", model: modelOf("pa") });
  for (const provider of PROVIDERS) {
    assert.ok(box.modelRuntime.getModel(provider, modelOf(provider)), `${provider} 的模型没注册上`);
    assert.equal(box.modelRuntime.hasConfiguredAuth(provider), true, `${provider} 该有 key`);
  }
  const { session } = await openSession(box, usedSession(box, "pa"));
  assert.ok(session.model, "createAgentSession 没给模型：这条链路整个失效");
});

test("pi 重开一条会话时自己恢复它原来的模型，且不动全局默认", async () => {
  const box = await createSandbox({ provider: "pa", model: modelOf("pa") });
  const sessionPath = usedSession(box, "pb");

  const { session } = await openSession(box, sessionPath);

  assert.equal(session.model?.provider, "pb", "重开必须回到这条会话自己的模型");
  assert.deepEqual(box.readDefaults(), { provider: "pa", model: modelOf("pa") }, "打开会话不该改写新任务的起点");
});

test("兜底修复（session-open）只写会话文件，settings.json 不动", async () => {
  // 最容易吃人的场景：记住的默认模型（pc）key 没了 → 桥会退到列表第一项（pa）。
  // 旧写法里这一步会把用户记住的默认值永久盖成 pa。
  const box = await createSandbox({ provider: "pc", model: modelOf("pc") }, { withoutKey: ["pc"] });
  assert.equal(box.modelRuntime.hasConfiguredAuth("pc"), false, "场景前提：记住的默认模型现在没 key");

  const sessionPath = usedSession(box, "pb");
  const { session, settingsManager } = await openSession(box, sessionPath);
  assert.equal(session.model?.provider, "pb", "场景前提：这条会话还带着自己的模型");
  const applied = box.modelRuntime.getModel("pa", modelOf("pa"));
  assert.ok(applied, "会话自己的模型没能恢复，场景不成立");

  await applyModelToSession({
    session,
    settingsManager,
    model: applied,
    reason: MODEL_APPLY_REASONS.sessionOpen,
  });
  await settingsManager.flush();

  assert.equal(session.model?.provider, "pa", "这条会话确实换过去了");
  assert.deepEqual(
    box.readDefaults(),
    { provider: "pc", model: modelOf("pc") },
    "记住的默认值不能被兜底改写（key 补回来还是它）",
  );
  assert.equal(box.readSettings().defaultThinkingLevel, undefined, "顺手 clamp 的思考等级也不能写全局");

  const entries = readFileSync(sessionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(
    entries.filter((entry) => entry.type === "model_change").map((entry) => entry.provider),
    ["pb", "pa"],
    "会话文件里要留下这条会话自己的新记录，下次重开才认得",
  );
});

test("用户主动切换（user-switch）才把默认值落进 settings.json", async () => {
  const box = await createSandbox({ provider: "pa", model: modelOf("pa") });
  const sessionPath = usedSession(box, "pa");
  const { session, settingsManager } = await openSession(box, sessionPath);

  await applyModelToSession({
    session,
    settingsManager,
    model: box.modelRuntime.getModel("pb", modelOf("pb")),
    reason: MODEL_APPLY_REASONS.userSwitch,
  });
  await settingsManager.flush();

  assert.equal(box.readDefaults().provider, "pb", "新任务要从这次的选择开始");
  assert.equal(box.readDefaults().model, modelOf("pb"));
  assert.equal(settingsManager.getDefaultProvider(), "pb");
  const entries = readFileSync(sessionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.filter((entry) => entry.type === "model_change").at(-1)?.provider, "pb");
});

test("默认值没记住过时，兜底不会偷偷替用户建一份 settings", async () => {
  const box = await createSandbox(null);
  const sessionPath = usedSession(box, "pb");
  const { session, settingsManager } = await openSession(box, sessionPath);
  assert.deepEqual(box.readDefaults(), { provider: undefined, model: undefined }, "前提：sandbox 里没记住任何默认模型");

  await applyModelToSession({
    session,
    settingsManager,
    model: box.modelRuntime.getModel("pa", modelOf("pa")),
    reason: MODEL_APPLY_REASONS.sessionOpen,
  });
  await settingsManager.flush();

  assert.equal(box.readSettings().defaultProvider, undefined, "没记住过 ≠ 可以由兜底代填");
  assert.equal(box.readSettings().defaultModel, undefined);
  assert.equal(session.model?.provider, "pa");
});

/**
 * 从 2026-09-20 起，「新任务从哪个模型/等级开始」按项目记在 projects.json（composerDefaults），
 * pi 的全局 settings 只当没记过时的兜底。桥的做法是把模型和等级一起静默应用（不写全局），
 * 下面两条用真 pi 对象验证这个机制真的成立。
 */
test("新任务按项目记录起步：显式传 model + thinkingLevel 就落在这条会话上，且不碰全局", async () => {
  const box = await createSandbox({ provider: "pa", model: modelOf("pa") });
  const settingsManager = SettingsManager.create(box.cwd, box.agentDir, { projectTrusted: false });
  const sessionManager = SessionManager.create(box.cwd, box.sessionDir);
  // 镜像桥的 persistSessionShell：新会话先把空壳写盘并标 flushed，之后 pi 才会追加条目。
  const sessionFile = sessionManager.getSessionFile() as string;
  const shell = [sessionManager.getHeader(), ...sessionManager.getEntries()].filter(Boolean);
  writeFileSync(sessionFile, `${shell.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  (sessionManager as unknown as { flushed: boolean }).flushed = true;
  const chosen = box.modelRuntime.getModel("pb", modelOf("pb"));
  assert.ok(chosen, "前提：项目记的模型真的存在");

  const created = await createAgentSession({
    cwd: box.cwd,
    agentDir: box.agentDir,
    modelRuntime: box.modelRuntime,
    settingsManager,
    sessionManager,
    model: chosen,
    thinkingLevel: "high",
  });
  await settingsManager.flush();

  assert.equal(created.session.model?.provider, "pb", "新会话要用项目记的模型");
  assert.equal(created.session.thinkingLevel, "high", "新会话要用项目记的等级");
  assert.deepEqual(
    box.readDefaults(),
    { provider: "pa", model: modelOf("pa") },
    "新会话起步不该改写 pi 的全局默认（那是没记过项目时的兜底）",
  );
  assert.equal(box.readSettings().defaultThinkingLevel, undefined, "全局等级也不该被顺手写入");

  const entries = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.find((entry) => entry.type === "model_change")?.provider, "pb");
  assert.equal(entries.find((entry) => entry.type === "thinking_level_change")?.thinkingLevel, "high");
});

test("改思考等级在静默窗口里只写会话文件，settings.json 一个字不动", async () => {
  const box = await createSandbox({ provider: "pa", model: modelOf("pa") });
  const sessionPath = usedSession(box, "pa");
  const { session, settingsManager } = await openSession(box, sessionPath);
  const before = box.readSettings();

  const restore = silenceGlobalModelWrites(settingsManager);
  try {
    session.setThinkingLevel("high");
  } finally {
    restore();
  }
  await settingsManager.flush();

  assert.equal(session.thinkingLevel, "high", "这条会话自己的等级要变");
  assert.deepEqual(box.readSettings(), before, "pi 原本会写全局 defaultThinkingLevel，静默窗口必须挡住");

  const entries = readFileSync(sessionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(
    entries.filter((entry) => entry.type === "thinking_level_change").at(-1)?.thinkingLevel,
    "high",
    "会话文件里要留下记录，重开才认得",
  );
});
