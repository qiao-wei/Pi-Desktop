/**
 * 内置浏览器的**功能面**：一张命令表，和 `HOST_COMMANDS` 同一个写法。
 *
 * 为什么是表而不是一组函数：同一条"点这个按钮"要同时被两个消费者使用 —— 面板里的按钮
 * （人在点）和之后的 agent 工具（模型在点）。两边若各写一份，就会出现"界面能点、工具点不了"
 * 或者"工具绕过了界面的限制"。表是唯一真源：名字、参数、返回、用途都写在这里，执行器只有一份。
 *
 * 参数校验故意写在这里而不是靠 TypeScript：`run()` 的调用方可能是从线上来的 JSON
 * （agent 工具、之后的远端端），类型在运行时不存在。校验失败返回**具名错误码**，不抛。
 */

export interface BrowserCommandSpec {
  /** 参数形状的一句话说明；真正的校验在 `normalizeBrowserCommand`。 */
  readonly args: string;
  /** 返回形状的一句话说明。 */
  readonly returns: string;
  readonly summary: string;
  /** 脚本类命令要求页面已经 attach；导航类只要求 guest 存在。 */
  readonly needsPage?: boolean;
}

export const BROWSER_COMMANDS = {
  navigate: {
    args: "{ url: string }",
    returns: "void",
    summary: "Load a URL in the active tab (http/https/about:blank only).",
  },
  back: { args: "{}", returns: "void", summary: "Go back in the active tab's history." },
  forward: { args: "{}", returns: "void", summary: "Go forward in the active tab's history." },
  reload: { args: "{}", returns: "void", summary: "Reload the active tab." },
  stop: { args: "{}", returns: "void", summary: "Stop loading the active tab." },
  click: {
    args: "{ selector: string }",
    returns: "boolean",
    summary: "Click the first element matching the CSS selector.",
    needsPage: true,
  },
  type: {
    args: "{ selector: string; text: string; submit?: boolean }",
    returns: "boolean",
    summary:
      "Focus an input, set its value through the native setter, fire input/change, optionally press Enter.",
    needsPage: true,
  },
  press: {
    args: "{ key: string }",
    returns: "void",
    summary: "Dispatch a keydown/keyup pair on the focused element.",
    needsPage: true,
  },
  scroll: {
    args: "{ dx?: number; dy?: number }",
    returns: "void",
    summary: "Scroll the page by a delta (default: one viewport down).",
    needsPage: true,
  },
  extractText: {
    args: "{ selector?: string }",
    returns: "string",
    summary: "Text content of the first match, or of document.body when no selector is given.",
    needsPage: true,
  },
  extractHtml: {
    args: "{ selector?: string }",
    returns: "string",
    summary: "innerHTML of the first match, or of document.body when no selector is given.",
    needsPage: true,
  },
  waitFor: {
    args: "{ selector: string; timeoutMs?: number }",
    returns: "boolean",
    summary: "Resolve true when the selector appears; false on timeout (absence is not an error).",
    needsPage: true,
  },
  screenshot: {
    args: "{}",
    returns: "string (data:image/png;base64,…)",
    summary: "Capture the visible guest surface as a PNG data URL.",
  },
  pickElement: {
    args: "{ timeoutMs?: number }",
    returns: "{ selector: string; text: string } | null",
    summary: "Let the user click a page element; resolve with a usable selector and its text.",
    needsPage: true,
  },
} as const satisfies Record<string, BrowserCommandSpec>;

export type BrowserCommandId = keyof typeof BROWSER_COMMANDS;

export const BROWSER_COMMAND_IDS = Object.keys(BROWSER_COMMANDS) as readonly BrowserCommandId[];

export function isBrowserCommandId(value: unknown): value is BrowserCommandId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BROWSER_COMMANDS, value);
}

export type BrowserErrorCode =
  | "unsupported_command"
  | "invalid_args"
  | "page_not_ready"
  | "script_failed";

export type BrowserCommandResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: BrowserErrorCode; readonly message: string };

/** 等待类命令的缺省上限：一个挂死的页面不能拖住调用方。 */
export const DEFAULT_BROWSER_TIMEOUT_MS = 5_000;

type Checked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: BrowserErrorCode; readonly message: string };

/** 失败形状单独一类：`Checked<never>` 的成功分支（`{ ok: true, value: never }`）不是失败， */
/** 混进返回类型会让每个 `return invalid(...)` 都在类型上"成功"，于是被要求带 `command`。 */
type Invalid = { readonly ok: false; readonly code: BrowserErrorCode; readonly message: string };

function invalid(message: string): Invalid {
  return { ok: false, code: "invalid_args", message };
}

function requireString(value: unknown, field: string): Checked<string> {
  return typeof value === "string" && value.trim() !== ""
    ? { ok: true, value }
    : invalid(`${field} must be a non-empty string`);
}

function optionalString(value: unknown, field: string): Checked<string | undefined> {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  return typeof value === "string" && value.trim() !== ""
    ? { ok: true, value }
    : invalid(`${field} must be a non-empty string`);
}

function optionalNumber(value: unknown, field: string): Checked<number | undefined> {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  return typeof value === "number" && Number.isFinite(value)
    ? { ok: true, value }
    : invalid(`${field} must be a finite number`);
}

/**
 * 参数归一化：把线上来的 `unknown` 变成执行器可以信任的形状，否则给 `invalid_args`。
 *
 * 返回的字段是**执行器唯一可用的字段名** —— 执行器不再对输入做 `as` 断言；多出来的键被丢掉，
 * 这样上游加字段不会意外改行为，也不会被静默透传进页面脚本。
 */
export type NormalizedBrowserCommand =
  | { readonly id: "navigate"; readonly url: string }
  | { readonly id: "back" | "forward" | "reload" | "stop" | "screenshot" }
  | { readonly id: "click"; readonly selector: string }
  | {
      readonly id: "type";
      readonly selector: string;
      readonly text: string;
      readonly submit: boolean;
    }
  | { readonly id: "press"; readonly key: string }
  | { readonly id: "scroll"; readonly dx: number; readonly dy: number | undefined }
  | { readonly id: "extractText" | "extractHtml"; readonly selector: string | undefined }
  | { readonly id: "waitFor"; readonly selector: string; readonly timeoutMs: number }
  | { readonly id: "pickElement"; readonly timeoutMs: number };

export function normalizeBrowserCommand(
  id: unknown,
  args: unknown,
):
  | { readonly ok: true; readonly command: NormalizedBrowserCommand }
  | { readonly ok: false; readonly code: BrowserErrorCode; readonly message: string } {
  if (!isBrowserCommandId(id)) {
    return {
      ok: false,
      code: "unsupported_command",
      message: `unknown browser command: ${String(id)}`,
    };
  }

  const input: Record<string, unknown> =
    args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};

  switch (id) {
    case "navigate": {
      const url = requireString(input.url, "url");
      return url.ok ? { ok: true, command: { id, url: url.value } } : url;
    }
    case "back":
    case "forward":
    case "reload":
    case "stop":
    case "screenshot":
      return { ok: true, command: { id } };
    case "click": {
      const selector = requireString(input.selector, "selector");
      return selector.ok ? { ok: true, command: { id, selector: selector.value } } : selector;
    }
    case "type": {
      const selector = requireString(input.selector, "selector");
      if (!selector.ok) {
        return selector;
      }
      if (typeof input.text !== "string") {
        return invalid("text must be a string");
      }
      return {
        ok: true,
        command: { id, selector: selector.value, text: input.text, submit: input.submit === true },
      };
    }
    case "press": {
      const key = requireString(input.key, "key");
      return key.ok ? { ok: true, command: { id, key: key.value } } : key;
    }
    case "scroll": {
      const dx = optionalNumber(input.dx, "dx");
      if (!dx.ok) {
        return dx;
      }
      const dy = optionalNumber(input.dy, "dy");
      if (!dy.ok) {
        return dy;
      }
      return { ok: true, command: { id, dx: dx.value ?? 0, dy: dy.value } };
    }
    case "extractText":
    case "extractHtml": {
      const selector = optionalString(input.selector, "selector");
      return selector.ok ? { ok: true, command: { id, selector: selector.value } } : selector;
    }
    case "waitFor": {
      const selector = requireString(input.selector, "selector");
      if (!selector.ok) {
        return selector;
      }
      const timeoutMs = optionalNumber(input.timeoutMs, "timeoutMs");
      return timeoutMs.ok
        ? {
            ok: true,
            command: {
              id,
              selector: selector.value,
              timeoutMs: timeoutMs.value ?? DEFAULT_BROWSER_TIMEOUT_MS,
            },
          }
        : timeoutMs;
    }
    case "pickElement": {
      const timeoutMs = optionalNumber(input.timeoutMs, "timeoutMs");
      return timeoutMs.ok
        ? { ok: true, command: { id, timeoutMs: timeoutMs.value ?? DEFAULT_BROWSER_TIMEOUT_MS } }
        : timeoutMs;
    }
  }
}
