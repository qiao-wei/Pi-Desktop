/**
 * 浏览器命令的**唯一执行器**：把 `BROWSER_COMMANDS` 里的名字变成对 guest 的实际动作。
 *
 * 它只认识一个很窄的端口（`BrowserViewPort`），所以：
 * - 面板可以用它（人是调用方）；
 * - 之后的 agent 工具可以用它（模型是调用方）；
 * - 单测可以用一个假端口跑遍全部命令，不需要 Electron。
 *
 * 注入页面的脚本全部由这里生成，**参数一律走 `JSON.stringify`**：选择器和输入文本可能来自
 * 模型或远端，字符串拼接等于把执行权交出去。生成脚本的步骤单独导出，就是为了能直接断言
 * 「带引号的 selector 没有逃出字符串字面量」。
 */

import { normalizeBrowserAddress } from "../../shared/browserUrl.ts";
import {
  BROWSER_COMMANDS,
  BROWSER_COMMAND_IDS,
  DEFAULT_BROWSER_TIMEOUT_MS,
  type BrowserCommandResult,
  type BrowserCommandSpec,
  type BrowserErrorCode,
  type NormalizedBrowserCommand,
  normalizeBrowserCommand,
} from "../../shared/browserCommands.ts";

/** guest 上执行器真正需要的方法。 */
export interface BrowserViewPort {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  executeJavaScript(script: string): Promise<unknown>;
  capturePage(): Promise<{ toDataURL(): string }>;
}

/** 端口在页面 attach 之前是拿不到的，所以调用方传的是一个**取端口**的函数。 */
export type BrowserPortProvider = () => BrowserViewPort | null;

export type BrowserRunResult<T = unknown> = BrowserCommandResult<T>;

const timeoutOf = (command: { timeoutMs?: number }) =>
  command.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS;

/** 在页面里按 selector 找元素；找不到返回 false 而不是抛错（"没有"是正常结果）。 */
function clickScript(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    return true;
  })()`;
}

/**
 * 输入文本。
 *
 * 用**原生 setter** 而不是 `el.value = text`：React / Vue 的受控输入会覆写 value 属性，
 * 直接赋值不触发框架的 onChange，页面看起来没反应。这是所有浏览器自动化里最经典的一处坑。
 */
function typeScript(selector: string, text: string, submit: boolean): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, ${JSON.stringify(text)});
    else el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (${submit ? "true" : "false"}) {
      for (const type of ["keydown", "keypress", "keyup"]) {
        el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true }));
      }
      el.form?.requestSubmit?.();
    }
    return true;
  })()`;
}

function pressScript(key: string): string {
  return `(() => {
    const target = document.activeElement ?? document.body;
    for (const type of ["keydown", "keypress", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, { key: ${JSON.stringify(key)}, bubbles: true }));
    }
  })()`;
}

function scrollScript(dx: number, dy: number | undefined): string {
  const delta = dy === undefined ? "window.innerHeight" : JSON.stringify(dy);
  return `(() => { window.scrollBy({ left: ${JSON.stringify(dx)}, top: ${delta}, behavior: "instant" }); })()`;
}

function extractScript(selector: string | undefined, asHtml: boolean): string {
  const target =
    selector === undefined
      ? "document.body"
      : `document.querySelector(${JSON.stringify(selector)})`;
  const value = asHtml ? "innerHTML" : "innerText";
  return `(() => {
    const el = ${target};
    return el ? String(el.${value} ?? "") : "";
  })()`;
}

/** 轮询等待元素出现：在页面里自等，不把节奏交给外部循环（少一次跨进程往返）。 */
function waitForScript(selector: string, timeoutMs: number): string {
  return `new Promise((resolve) => {
    const selector = ${JSON.stringify(selector)};
    const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
    const tick = () => {
      if (document.querySelector(selector)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  })`;
}

/**
 * 选元素：给页面盖一层透明遮罩，用户点哪儿就返回哪儿的 selector + 文本。
 *
 * 返回的 selector 尽量短：有 id 用 id，否则用「最多 6 层的 tag:nth-of-type」路径。它只承诺
 * "现在能用"，不承诺跨版本稳定 —— 调用方（面板 / agent）应当把它当作一次性引用，而不是契约。
 */
function pickElementScript(timeoutMs: number): string {
  return `new Promise((resolve) => {
    const cssPath = (node) => {
      if (node.id) return "#" + CSS.escape(node.id);
      const parts = [];
      let el = node;
      while (el && el.nodeType === 1 && parts.length < 6) {
        let part = el.tagName.toLowerCase();
        const parent = el.parentElement;
        if (parent) {
          const same = [...parent.children].filter((child) => child.tagName === el.tagName);
          if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(el) + 1) + ")";
        }
        parts.unshift(part);
        if (el.id) { parts[0] = "#" + CSS.escape(el.id); break; }
        el = parent;
      }
      return parts.join(" > ");
    };

    const layer = document.createElement("div");
    layer.setAttribute("data-pi-element-picker", "");
    Object.assign(layer.style, {
      position: "fixed", inset: "0", zIndex: "2147483647", cursor: "crosshair", background: "rgba(0,0,0,0.02)",
    });

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      layer.removeEventListener("click", onClick, true);
      layer.remove();
      resolve(value);
    };
    const onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const el = event.target;
      if (!(el instanceof Element)) return finish(null);
      finish({ selector: cssPath(el), text: String(el.innerText ?? el.textContent ?? "").trim().slice(0, 500) });
    };
    const timer = setTimeout(() => finish(null), ${JSON.stringify(timeoutMs)});

    layer.addEventListener("click", onClick, true);
    document.documentElement.appendChild(layer);
  })`;
}

/** 命令 → 注入脚本。纯函数，可单测（参数转义就靠它）。 */
export function buildBrowserScript(command: NormalizedBrowserCommand): string | null {
  switch (command.id) {
    case "navigate":
    case "back":
    case "forward":
    case "reload":
    case "stop":
    case "screenshot":
      return null;
    case "click":
      return clickScript(command.selector);
    case "type":
      return typeScript(command.selector, command.text, command.submit);
    case "press":
      return pressScript(command.key);
    case "scroll":
      return scrollScript(command.dx, command.dy);
    case "extractText":
      return extractScript(command.selector, false);
    case "extractHtml":
      return extractScript(command.selector, true);
    case "waitFor":
      return waitForScript(command.selector, command.timeoutMs);
    case "pickElement":
      return pickElementScript(timeoutOf(command));
  }
}

function scriptFailure(error: unknown): BrowserRunResult<never> {
  return {
    ok: false,
    code: "script_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * 执行一条命令。
 *
 * 两个消费者（面板 / agent 工具）都走这里，所以**能力只在这里定义一次**：界面不会偷偷多出一种
 * 网页动作，工具也不会绕过界面上的 URL 策略（`navigate` 与地址栏共用同一份判据）。
 */
export function createBrowserController(getPort: BrowserPortProvider) {
  /** 取端口：没有 guest → `page_not_ready`；脚本类命令再探一次 attach。 */
  // 失败形状单独写：写成 `BrowserRunResult<never>` 会把它的**成功**分支
  // `{ ok: true, value: never }` 也带进联合，调用方 `if (!resolved.ok)` 之后就拿不到 `port`。
  function resolvePort(
    needsPage: boolean,
  ): { ok: true; port: BrowserViewPort } | { ok: false; code: BrowserErrorCode; message: string } {
    const port = getPort();
    if (!port) {
      return { ok: false, code: "page_not_ready", message: "no browser view is attached" };
    }
    if (needsPage) {
      try {
        // 同步方法在 guest 未 attach 时会抛；先探一下，好过让调用方拿到 Electron 内部错误。
        port.getURL();
      } catch (error) {
        return {
          ok: false,
          code: "page_not_ready",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { ok: true, port };
  }

  return {
    commandIds: BROWSER_COMMAND_IDS,

    async run(id: unknown, args?: unknown): Promise<BrowserRunResult> {
      const normalized = normalizeBrowserCommand(id, args);
      if (!normalized.ok) {
        return normalized;
      }
      const command = normalized.command;
      // `BROWSER_COMMANDS` 是 `as const`，只有部分命令写了 `needsPage`；先收宽到 spec 再读。
      const spec: BrowserCommandSpec = BROWSER_COMMANDS[command.id];
      const resolved = resolvePort(spec.needsPage === true);
      if (!resolved.ok) {
        return resolved;
      }
      const port = resolved.port;

      switch (command.id) {
        case "navigate": {
          const address = normalizeBrowserAddress(command.url);
          if (!address.ok) {
            return {
              ok: false,
              code: "invalid_args",
              message: `cannot open ${command.url}: ${address.reason}`,
            };
          }
          try {
            await port.loadURL(address.url);
          } catch (error) {
            return scriptFailure(error);
          }
          return { ok: true, value: address.url };
        }
        case "back":
          port.goBack();
          return { ok: true, value: undefined };
        case "forward":
          port.goForward();
          return { ok: true, value: undefined };
        case "reload":
          port.reload();
          return { ok: true, value: undefined };
        case "stop":
          port.stop();
          return { ok: true, value: undefined };
        case "screenshot": {
          try {
            const image = await port.capturePage();
            return { ok: true, value: image.toDataURL() };
          } catch (error) {
            return scriptFailure(error);
          }
        }
        default: {
          const script = buildBrowserScript(command);
          if (script === null) {
            return {
              ok: false,
              code: "unsupported_command",
              message: `no script for ${command.id}`,
            };
          }
          try {
            const value = await port.executeJavaScript(script);
            return { ok: true, value };
          } catch (error) {
            return scriptFailure(error);
          }
        }
      }
    },
  };
}

export type BrowserController = ReturnType<typeof createBrowserController>;
