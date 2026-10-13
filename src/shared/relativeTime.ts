/**
 * 「3 分钟前」这种相对时间，用在右面板「标签页总览」里（打开时间 / 关闭时间）。
 *
 * 返回的是 **i18n key + 参数**，不是拼好的句子：文案要跟着语言走（zh/en 两包都得有），
 * 而这里只该负责分档。放在 `shared/` 是为了能被 `node --test` 直接钉住每一档的边界。
 */
export interface RelativeTimeLabel {
  key: string;
  params: Record<string, number>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTimeLabel(timestamp: unknown, now: number): RelativeTimeLabel {
  const value = typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : Number.NaN;
  // 时间戳坏了、或者是未来的时间（时钟回拨）都按「刚刚」处理：总览里显示一个负数没意义。
  const elapsed = now - value;
  if (!Number.isFinite(elapsed) || elapsed < MINUTE) {
    return { key: "time.justNow", params: {} };
  }
  if (elapsed < HOUR) {
    return { key: "time.minutesAgo", params: { count: Math.floor(elapsed / MINUTE) } };
  }
  if (elapsed < DAY) {
    return { key: "time.hoursAgo", params: { count: Math.floor(elapsed / HOUR) } };
  }
  return { key: "time.daysAgo", params: { count: Math.floor(elapsed / DAY) } };
}