/**
 * 「任务完成后发系统提醒」的纯决策部分（不起副作用、不碰 DOM，方便单测）。
 *
 * 提醒的是「一轮 prompt 落定」这件事，而不是每个 token：客户端在提交那一轮时持有
 * 自己的事件流（`done` / `error`），只有它能准确知道这轮什么时候结束、失败还是成功。
 * 副作用（调宿主 / 浏览器 `Notification`）在 `src/lib/systemNotification.ts`。
 *
 * 两条与产品行为直接相关的约定：
 *   1. 只在窗口不在前台时提醒。用户正看着屏幕时弹系统横幅纯属噪音，而且 macOS 的
 *      横幅还会盖住窗口内容。
 *   2. 用户自己按停止不算「任务完成」。该分支在 `usePiDesktopApp` 里由
 *      `lifecycleGeneration` 拦掉（`stopTurn` 会先 +1，事件全部早退），这里不再重复判断。
 */
export interface TurnNotificationDecisionInput {
  /** 设置页里的开关（`ui-preferences` 的 `notifyOnTurnComplete`）。 */
  enabled: boolean;
  /** 窗口是否在前台且可见。 */
  windowFocused: boolean;
}

/** 这一轮落定时是否该发系统提醒。 */
export function shouldNotifyTurnSettled(input: TurnNotificationDecisionInput): boolean {
  return input.enabled && !input.windowFocused;
}

export interface TurnNotificationLabelInput {
  /** 刚落定那一轮的会话路径。 */
  sessionPath: string | undefined;
  /** 当前会话的标题与 sessionFile（通常是活动会话的快照）。 */
  conversation?: { title?: string; sessionFile?: string };
  /** 同项目下的会话摘要（`project.sessions`），用于给后台会话找到标题。 */
  sessions?: ReadonlyArray<{ path: string; title?: string; name?: string }>;
}

function cleanLabel(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/**
 * 提醒正文里的会话名：优先当前会话（`sessionFile` 相等时用它的 title），
 * 否则在项目会话摘要里按路径找。找不到就返回 undefined，由调用方退回落文案
 * —— 后台会话、刚建的项目、标题还没生成的第一轮都属于这种情况。
 */
export function resolveTurnNotificationLabel(input: TurnNotificationLabelInput): string | undefined {
  const { sessionPath } = input;
  if (!sessionPath) {
    return undefined;
  }

  if (input.conversation?.sessionFile === sessionPath) {
    const title = cleanLabel(input.conversation.title);
    if (title) {
      return title;
    }
  }

  const match = input.sessions?.find((session) => session.path === sessionPath);
  return cleanLabel(match?.title) ?? cleanLabel(match?.name);
}

/** 正文 = 「会话名 · 落文案」；没有会话名时只用落文案，不留下孤零零的分隔符。 */
export function composeTurnNotificationBody(label: string | undefined, fallback: string): string {
  const clean = cleanLabel(label);
  return clean ? `${clean} · ${fallback}` : fallback;
}