import { t } from "../i18n/index.ts";

export function formatTokens(value: number | null | undefined) {
  if (value == null) {
    return "--";
  }

  if (value >= 1000) {
    return `${Math.round(value / 100) / 10}k`;
  }

  return String(value);
}

/**
 * 「累计缓存」行的明细文案：读写都有才展示「(输入 x，输出 y)」拆分；
 * 单边（如 cacheWrite=0）只展示数字本身，不带「输入/输出」字样。
 */
export function formatCacheDetail(cacheRead: number, cacheWrite: number) {
  const hasRead = cacheRead > 0;
  const hasWrite = cacheWrite > 0;

  if (hasRead && hasWrite) {
    return t("usage.cacheDetail", { read: formatTokens(cacheRead), write: formatTokens(cacheWrite) });
  }

  return formatTokens(hasRead ? cacheRead : cacheWrite);
}

export function percentOf(value: number, total: number | undefined) {
  if (!total || total <= 0) {
    return null;
  }
  return Math.min(100, (value / total) * 100);
}

/**
 * 「累计缓存」行占比：分母只用读侧（input + cacheRead），不带普通输出。
 */
export function cachePercent(cacheRead: number, cacheWrite: number, readSideTotal: number) {
  return percentOf(cacheRead + cacheWrite, readSideTotal);
}
