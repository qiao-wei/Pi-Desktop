/**
 * 模型选择的记账规则：谁能改写「新任务从哪个模型开始」。
 *
 * 语义（用户定的）：已有会话各自独立、重开各回各的模型；只有新建任务继承「最后一次选择」。
 * 所以「打开会话时的兜底修复」不许顺手把全局默认模型盖掉 —— pi 的 `session.setModel()`
 * 不管来路，一律写全局，这一层就是拿来挡它的。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyModelToSession,
  composerDefaultModelReference,
  isFreshSession,
  MODEL_APPLY_REASONS,
  normalizeComposerDefaults,
  shouldRememberModelChoice,
  silenceGlobalModelWrites,
} from "../server/sessionModelPolicy.mjs";

/** 仿 pi 的 SettingsManager：四个全局写入口 + 一堆读口，写入口记在 state 上方便断言。 */
function createFakeSettings() {
  const state = { provider: "anthropic", model: "claude-a", thinking: "medium" };
  class FakeSettingsManager {
    getDefaultProvider() {
      return state.provider;
    }
    getDefaultModel() {
      return state.model;
    }
    getDefaultThinkingLevel() {
      return state.thinking;
    }
    setDefaultProvider(provider: string) {
      state.provider = provider;
    }
    setDefaultModel(model: string) {
      state.model = model;
    }
    setDefaultModelAndProvider(provider: string, model: string) {
      state.provider = provider;
      state.model = model;
    }
    setDefaultThinkingLevel(level: string) {
      state.thinking = level;
    }
  }
  return { manager: new FakeSettingsManager(), state };
}

/**
 * 仿 pi 的 AgentSession.setModel()：真实实现就是这三步 —— 改这条会话、往会话文件追加
 * `model_change`、再写全局 settings。全局那一步由调用方传进来的 manager 负责，正好被挡。
 */
function createFakeSession(settingsManager: ReturnType<typeof createFakeSettings>["manager"], options: { throws?: Error } = {}) {
  const applied: unknown[] = [];
  const session = {
    model: undefined as unknown,
    async setModel(model: unknown) {
      if (options.throws) {
        throw options.throws;
      }
      applied.push(model);
      session.model = model;
      settingsManager.setDefaultModelAndProvider((model as { provider: string }).provider, (model as { id: string }).id);
      // 思考等级按新模型能力重 clamp，也是全局写。
      settingsManager.setDefaultThinkingLevel("low");
    },
  };
  return { session, applied };
}

const model = { provider: "bailian", id: "qwen3.8-flash" };

test("只有「用户在输入框里切换」算一次选择，别的都不算", () => {
  assert.equal(shouldRememberModelChoice(MODEL_APPLY_REASONS.userSwitch), true);
  assert.equal(shouldRememberModelChoice(MODEL_APPLY_REASONS.sessionOpen), false);
  // 理由缺失/拼错一律算「不记」：宁可少记，不能吃用户记住的默认值。
  assert.equal(shouldRememberModelChoice(undefined), false);
  assert.equal(shouldRememberModelChoice(""), false);
  assert.equal(shouldRememberModelChoice("user_swich"), false);
});

test("打开会话时应用模型：这条会话用了，全局默认一个字都不动", async () => {
  const { manager, state } = createFakeSettings();
  const { session, applied } = createFakeSession(manager);

  await applyModelToSession({ session, settingsManager: manager, model, reason: MODEL_APPLY_REASONS.sessionOpen });

  assert.deepEqual(applied, [model]);
  assert.equal(session.model, model, "会话自己的模型必须生效");
  assert.deepEqual(state, { provider: "anthropic", model: "claude-a", thinking: "medium" }, "记住的默认值不能被打扰");
});

test("用户切换：会话与全局默认一起更新（新任务就从它开始）", async () => {
  const { manager, state } = createFakeSettings();
  const { session } = createFakeSession(manager);

  await applyModelToSession({ session, settingsManager: manager, model, reason: MODEL_APPLY_REASONS.userSwitch });

  assert.deepEqual(
    { provider: state.provider, model: state.model },
    { provider: "bailian", model: "qwen3.8-flash" },
  );
  assert.equal(state.thinking, "low", "思考等级的 clamp 跟着 pi 的原语义走");
});

test("挡完必须还原：下一次用户切换还得真能记住", async () => {
  const { manager, state } = createFakeSettings();
  const { session } = createFakeSession(manager);

  await applyModelToSession({ session, settingsManager: manager, model, reason: MODEL_APPLY_REASONS.sessionOpen });
  await applyModelToSession({ session, settingsManager: manager, model, reason: MODEL_APPLY_REASONS.userSwitch });

  assert.equal(state.model, "qwen3.8-flash");
  assert.equal(state.provider, "bailian");
});

test("setModel 抛错也要还原（没 key / 模型被删时不能把写入口永久堵住）", async () => {
  const { manager } = createFakeSettings();
  const { session } = createFakeSession(manager, { throws: new Error("No API key for bailian/qwen3.8-flash") });

  await assert.rejects(
    () => applyModelToSession({ session, settingsManager: manager, model, reason: MODEL_APPLY_REASONS.sessionOpen }),
    /No API key/,
  );

  const restore = silenceGlobalModelWrites(manager);
  restore();
  manager.setDefaultModelAndProvider("x", "y");
  assert.equal(manager.getDefaultModel(), "y", "还原后写入口是活的");
});

test("还原是按原样还：原型方法不被留成实例上的僵尸属性", async () => {
  const { manager } = createFakeSettings();
  const proto = Object.getPrototypeOf(manager);
  const before = proto.setDefaultModelAndProvider;

  await applyModelToSession({
    session: createFakeSession(manager).session,
    settingsManager: manager,
    model,
    reason: MODEL_APPLY_REASONS.sessionOpen,
  });

  assert.equal(Object.prototype.hasOwnProperty.call(manager, "setDefaultModelAndProvider"), false, "不该留 own 属性");
  assert.equal(manager.setDefaultModelAndProvider, before);
});

test("实例上本来就有同名属性时，还原要把那个函数原样放回去", () => {
  const calls: string[] = [];
  const manager = { setDefaultModel: () => calls.push("own") } as Record<string, unknown>;
  const own = manager.setDefaultModel;

  const restore = silenceGlobalModelWrites(manager);
  (manager.setDefaultModel as () => void)();
  restore();

  assert.deepEqual(calls, [], "遮蔽期间的调用不该落到原函数上");
  assert.equal(manager.setDefaultModel, own);
  (manager.setDefaultModel as () => void)();
  assert.deepEqual(calls, ["own"]);
});

test("没有 settingsManager 时不炸，照常把模型应用到会话上", async () => {
  const applied: unknown[] = [];
  const session = { model: undefined as unknown, async setModel(m: unknown) { applied.push(m); } };

  await applyModelToSession({ session, settingsManager: undefined, model, reason: MODEL_APPLY_REASONS.sessionOpen });
  assert.deepEqual(applied, [model]);
});

test("只挡写入，不挡读取：同一次打开里仍能读到记住的默认值", () => {
  const { manager, state } = createFakeSettings();
  const restore = silenceGlobalModelWrites(manager);

  assert.equal(manager.getDefaultProvider(), "anthropic");
  assert.equal(manager.getDefaultModel(), "claude-a");
  assert.equal(manager.getDefaultThinkingLevel(), "medium");
  manager.setDefaultProvider("nope");
  manager.setDefaultThinkingLevel("max");
  assert.equal(state.provider, "anthropic");
  assert.equal(state.thinking, "medium");

  restore();
  manager.setDefaultProvider("now");
  assert.equal(state.provider, "now");
});

/* ------------------------------------------------------------------ 项目记录 */

test("normalizeComposerDefaults：只认认识的等级，provider/model 必须成对", () => {
  assert.equal(normalizeComposerDefaults(undefined), undefined);
  assert.equal(normalizeComposerDefaults(null), undefined);
  assert.equal(normalizeComposerDefaults("bailian/deepseek"), undefined);
  assert.deepEqual(
    normalizeComposerDefaults({ provider: "bailian", model: "deepseek-v4.1-flash", thinkingLevel: "high" }),
    { provider: "bailian", model: "deepseek-v4.1-flash", thinkingLevel: "high" },
  );
  // 空白要去掉，否则对不上 runtime 里的 provider/model。
  assert.deepEqual(
    normalizeComposerDefaults({ provider: " bailian ", model: " deepseek ", thinkingLevel: " low " }),
    { provider: "bailian", model: "deepseek", thinkingLevel: "low" },
  );
  // 半条记录：只有 provider 没有 model → 整对丢掉；只记等级时其余字段不该被杜撰。
  assert.equal(normalizeComposerDefaults({ provider: "bailian" }), undefined);
  assert.equal(normalizeComposerDefaults({ model: "deepseek" }), undefined);
  assert.deepEqual(normalizeComposerDefaults({ thinkingLevel: "max" }), { thinkingLevel: "max" });
  // 不认识的等级（或不再是字符串）丢掉，其余字段照常留下。
  assert.deepEqual(
    normalizeComposerDefaults({ provider: "bailian", model: "deepseek", thinkingLevel: "bogus" }),
    { provider: "bailian", model: "deepseek" },
  );
  assert.deepEqual(normalizeComposerDefaults({ provider: "p", model: "m", thinkingLevel: 3 }), { provider: "p", model: "m" });
  // 一个字段都不剩时返回 undefined，调用方才知道该回退。
  assert.equal(normalizeComposerDefaults({ thinkingLevel: "bogus" }), undefined);
});

test("composerDefaultModelReference：只有等级的半条记录不算模型（拿它查会捞错整家）", () => {
  assert.equal(composerDefaultModelReference(undefined), undefined);
  assert.equal(composerDefaultModelReference({ thinkingLevel: "low" }), undefined, "只记了等级 → 继续用全局默认模型");
  assert.equal(composerDefaultModelReference({ provider: "pa" }), undefined, "半条记录不能拼");
  assert.equal(composerDefaultModelReference({ model: "model-a" }), undefined);
  assert.deepEqual(
    composerDefaultModelReference({ provider: "pa", model: "model-a", thinkingLevel: "high" }),
    { provider: "pa", model: "model-a" },
  );
});

test("isFreshSession：只有「还没提交过消息」才算新会话", () => {
  const withMessages = (count: number) => ({ buildSessionContext: () => ({ messages: Array.from({ length: count }) }) });
  assert.equal(isFreshSession({ sessionManager: withMessages(0) }), true, "空会话 = 新任务");
  assert.equal(isFreshSession({ sessionManager: withMessages(1) }), false, "提交过就是历史会话");
  // 也可以直接传 SessionManager。
  assert.equal(isFreshSession(withMessages(0)), true);
  assert.equal(isFreshSession(withMessages(2)), false);
  // 没有 buildSessionContext 时退回看 entries。
  assert.equal(isFreshSession({ getEntries: () => [{ type: "model_change" }] }), true);
  assert.equal(isFreshSession({ getEntries: () => [{ type: "message" }] }), false);
  // 什么方法都没有时不炸：当成新会话（保守地让这次选择生效）。
  assert.equal(isFreshSession({}), true);
  assert.equal(isFreshSession(undefined), true);
});
