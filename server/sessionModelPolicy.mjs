/**
 * 「每条会话用自己那条模型」的规则里，谁有资格改写「新任务从哪个模型开始」。
 *
 * pi 的 `session.setModel()` 不区分来路：它既把模型应用到这条会话上（写进会话文件的
 * `model_change`，重开时 pi 自己会按这条记录恢复），也会顺手把 provider/model 写进全局 settings。
 * （pi-coding-agent **0.87 起**这件事改成显式 `{ persist: true }` 才做，0.84 是无条件写 ——
 * 见下面 `applyModelToSession` 注释。）Pi Desktop 要的语义是：
 *
 *   - `"user-switch"`：用户在输入框里主动切的 → 记进全局，之后新建的任务从它开始；
 *   - `"session-open"`：打开会话时挑一个能用的 → 只算这一条会话的，不许动全局。
 *
 * 第二条不挡会吃人：记住的默认模型临时用不了（key 被删、供应商被改）时，兜底会去挑下拉列表
 * 第一项，并把用户真正记住的那份默认值永久盖掉。
 *
 * 2026-09-20 起 Pi Desktop 把「新任务从哪个模型/思考等级开始」按项目记在 projects.json 里
 * （见下面的 `normalizeComposerDefaults` / `isFreshSession`），pi 的全局 settings 只当没记过
 * 时的兜底。所以桥现在**只**用 session-open（一律挡全局写入），`user-switch` 这条语义仍
 * 保留在本模块给别处用，但桥里不再有「记全局」的入口。
 */

/** pi 的思考档位顺序（与 pi-ai 的 EXTENDED_THINKING_LEVELS 同序）。 */
export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * 归一化 projects.json 里的 `composerDefaults`。
 *
 * 只认认识的思考档位；provider/model 必须成对出现，否则整对丢掉（宁可回退到全局默认，也
 * 不能拿半条记录去开新会话）。全部不认识时返回 `undefined`，让调用方走兜底。
 */
export function normalizeComposerDefaults(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  const thinkingLevel = typeof value.thinkingLevel === "string" ? value.thinkingLevel.trim() : "";
  const normalized = {};
  if (provider && model) {
    normalized.provider = provider;
    normalized.model = model;
  }
  if (THINKING_LEVELS.includes(thinkingLevel)) {
    normalized.thinkingLevel = thinkingLevel;
  }

  return Object.keys(normalized).length ? normalized : undefined;
}

/**
 * 项目记录里可用的模型引用：`{ provider, model }`，没记过 / 只记了等级时返回 `undefined`。
 *
 * 新会话靠这个值决定要不要显式指定模型；`undefined` 时让上层继续用 pi 的全局默认模型。
 * 必须成对返回 —— 拿 `undefined` 当 provider 去查模型会把整家供应商的模型都捞出来（踩过）。
 */
export function composerDefaultModelReference(value) {
  const defaults = normalizeComposerDefaults(value);
  return defaults?.provider && defaults?.model
    ? { provider: defaults.provider, model: defaults.model }
    : undefined;
}

/**
 * 这条会话还算不算「新任务」：会话文件里没有消息才算。
 *
 * 提交第一条消息之后它就变成了历史会话 —— 之后在里面改模型/思考等级只作用于这条会话，
 * 不再改写「新任务从哪开始」。`session` 传 AgentSession 或 SessionManager 都行。
 */
export function isFreshSession(session) {
  const manager = session?.sessionManager ?? session;
  const context = manager?.buildSessionContext?.();
  if (context) {
    return (context.messages?.length ?? 0) === 0;
  }
  return !(manager?.getEntries?.() ?? []).some((entry) => entry.type === "message");
}

/** 全局 settings 里会被 `setModel()` / `setThinkingLevel()` 顺带写掉的字段，就这四个写入口。 */
const GLOBAL_MODEL_WRITERS = Object.freeze([
  "setDefaultModelAndProvider",
  "setDefaultProvider",
  "setDefaultModel",
  "setDefaultThinkingLevel",
]);

export const MODEL_APPLY_REASONS = Object.freeze({
  userSwitch: "user-switch",
  sessionOpen: "session-open",
});

/**
 * 这次应用模型算不算「用户的选择」，要不要记成新任务的起点。
 *
 * 理由缺失或不认识时一律算否 —— 宁可少记一次，也不能把用户记住的默认值吃掉。
 */
export function shouldRememberModelChoice(reason) {
  return reason === MODEL_APPLY_REASONS.userSwitch;
}

/**
 * 在 `run()` 期间挡掉全局模型/思考等级写入，结束时（含抛错）原样还回去。
 *
 * 只挡写入口，不碰 `getDefaultProvider()` 之类的读取，所以同一次打开里仍能读到用户原本记住
 * 的默认值。返回还原函数，方便调用方自己决定还原时机。
 */
export function silenceGlobalModelWrites(settingsManager) {
  if (!settingsManager) {
    return () => {};
  }

  const captured = GLOBAL_MODEL_WRITERS.map((name) => ({
    name,
    // 这些方法定义在类的原型上：遮蔽过之后要按原样还原（没有 own 属性就删掉 own 属性），
    // 否则「本条会话不记全局」会漏成「这个 runtime 以后永远不记全局」。
    hadOwn: Object.prototype.hasOwnProperty.call(settingsManager, name),
    own: settingsManager[name],
  }));

  for (const entry of captured) {
    settingsManager[entry.name] = () => {};
  }

  return () => {
    for (const entry of captured) {
      if (entry.hadOwn) {
        settingsManager[entry.name] = entry.own;
      } else {
        delete settingsManager[entry.name];
      }
    }
  };
}

/**
 * 把 `model` 应用到一条会话上，`reason` 决定这次要不要顺手记成全局默认。
 *
 * 会话文件里的那条 `model_change` 两种理由都照写：那是这条会话自己的记录，正是「重开各回各的
 * 模型」的依据。`setModel()` 的报错（没有 key、模型已不存在）原样抛给调用方处理。
 *
 * 「记成全局默认」在 pi-coding-agent 0.87 起必须显式 `{ persist: true }` 才会发生（0.84 是无条件
 * 写，靠 `silenceGlobalModelWrites` 挡）。所以 user-switch 分支要显式传 —— 否则这条语义会**静默**
 * 失效：会话自己换了模型，但「新任务从哪开始」还停在旧值上。
 */
export async function applyModelToSession({ session, settingsManager, model, reason }) {
  if (!shouldRememberModelChoice(reason)) {
    const restore = silenceGlobalModelWrites(settingsManager);
    try {
      await session.setModel(model);
    } finally {
      restore();
    }
    return;
  }

  await session.setModel(model, { persist: true });
}
