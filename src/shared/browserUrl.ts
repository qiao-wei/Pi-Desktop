/**
 * 内置浏览器能打开什么 —— 一份**纯策略**，放在内核层而不是组件里。
 *
 * 为什么单独成模块：这条策略有两个未来的消费者 —— 右面板里的地址栏（人在输入），以及之后的
 * agent 工具（模型在导航）。两边必须给同一个答案，否则「界面挡住了 file://，但工具没挡」就是
 * 一条只差一次工具调用就能穿过去的口子。
 *
 * 规则只有三条，都来自一个事实：guest 拿到的是**真实网页权限**。
 *
 * - 只允许 `http:` / `https:` —— `file:` 读本机文件、`javascript:` / `data:` 在页面上下文执行
 *   任意脚本，它们会把「浏览」变成「在本机执行」。
 * - `about:blank` 放行（空面板的初始态）。
 * - 省略 scheme 的输入按 `https://` 补全 —— 用户在地址栏敲 `example.com` 是常态，但**只有**
 *   看起来像域名时才补，避免把随手一行字变成一个奇怪的请求。
 */

/** 空面板的初始地址。 */
export const BLANK_BROWSER_URL = "about:blank";

/** 地址栏里补全 scheme 的判据：`example.com`、`localhost:3000`、`192.168.1.2:8080/path`。 */
const SCHEME_LESS_HOST =
  /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)|^localhost(?::\d+)?(?:[/?#]|$)|^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#]|$)/i;

/**
 * 「用户已经写了 scheme」的判据：**必须带 `//`**。
 *
 * 不能只写 `^[a-z]+:` —— `localhost:5173` 会匹配上，被当成一个叫 `localhost` 的协议，
 * 于是一个本地开发地址会被判成 `unsupported_scheme`。`scheme://` 才是一个确定的信号。
 * `javascript:` / `data:` / `mailto:` 这类没有 `//` 的写法落到下面按「非主机」处理，
 * 最终同样被 `isAllowedBrowserUrl` 拦下，只是给出的是 `unsupported_scheme` 而不是 `not_a_url`。
 */
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 这个地址能不能交给 guest。纯函数，两边共用。 */
export function isAllowedBrowserUrl(url: string): boolean {
  const value = url.trim();
  if (!value) {
    return false;
  }
  if (value === BLANK_BROWSER_URL) {
    return true;
  }
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export type BrowserAddressResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: "empty" | "unsupported_scheme" | "not_a_url" };

/**
 * 地址栏输入 → 可导航的 URL。
 *
 * 补全只发生一次，且发生在**校验之前**：先决定用户想打开什么，再用同一套策略判断能不能打开。
 * 顺序反过来会让 `example.com` 被判成 `not_a_url`。
 */
export function normalizeBrowserAddress(input: string): BrowserAddressResult {
  const value = input.trim();
  if (!value) {
    return { ok: false, reason: "empty" };
  }

  const candidate =
    value === BLANK_BROWSER_URL || EXPLICIT_SCHEME.test(value)
      ? value
      : SCHEME_LESS_HOST.test(value)
        ? `https://${value}`
        : value;

  if (!isAllowedBrowserUrl(candidate)) {
    return {
      ok: false,
      reason: /^[a-z][a-z0-9+.-]*:/i.test(candidate) ? "unsupported_scheme" : "not_a_url",
    };
  }

  return { ok: true, url: candidate };
}

/** 地址栏显示用的短形式：`https://example.com/` → `example.com`。只影响显示，不参与校验。 */
export function browserAddressLabel(url: string): string {
  if (!url || url === BLANK_BROWSER_URL) {
    return "";
  }
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}
