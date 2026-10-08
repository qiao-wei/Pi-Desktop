/**
 * 供应商登录（OAuth / 交互式 API key）的桥接。
 *
 * pi 把「登录一家供应商」做成了一次回调式交互：provider 自己决定要跳浏览器、
 * 要设备码，还是要用户粘一段回调 URL，宿主只需要实现两个回调 —— `notify(event)`
 * 报告进度/网址/设备码，`prompt(prompt)` 问用户要一段输入。TUI 的 `/login` 就是
 * 这套接口的终端前端（LoginDialogComponent），这里把它翻成「一条 NDJSON 流 +
 * 一个答复口」，让设置页能跑同一个流程。
 *
 * **刻意不写死任何供应商名单**：一家供应商有没有 OAuth、OAuth 叫什么，全读
 * `provider.auth`。pi 的内置目录里新增一家支持 OAuth 的供应商，只要 TUI 看得到，
 * 这里也自动看得到（前端读的是桥回传的 `authMethods` / `oauth` 元数据）。
 *
 * 这个模块不 import pi，也不碰 HTTP：`start()` 接收一个 `login(interaction)`
 * 函数，测试里直接给一个假的就能把整套「事件 / 提问 / 答复 / 取消」走完。
 */

const CANCELLED_MESSAGE = "Login cancelled";
const AUTH_TYPES = ["oauth", "api_key"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * pi 的 AuthEvent / AuthPrompt 都是纯数据，只有一个不可序列化的 `signal`
 * （整个登录的中断信号）需要留在桥这边，不能上线。
 */
export function serializableAuthEvent(event) {
  if (!isRecord(event) || typeof event.type !== "string" || !event.type) {
    return null;
  }
  const { signal: _signal, ...rest } = event;
  return rest;
}

export function serializableAuthPrompt(prompt) {
  if (!isRecord(prompt) || typeof prompt.type !== "string" || !prompt.type) {
    return null;
  }
  const { signal: _signal, ...rest } = prompt;
  if (Array.isArray(rest.options)) {
    rest.options = rest.options
      .filter((option) => isRecord(option) && typeof option.id === "string" && option.id)
      .map((option) => ({
        id: option.id,
        label: String(option.label ?? option.id),
        ...(option.description === undefined ? {} : { description: String(option.description) }),
      }));
  }
  return rest;
}

/** 登录方式名：pi 只给了 `apiKey` / `oauth` 两种。 */
export function normalizeLoginAuthType(value) {
  const authType = String(value ?? "").trim();
  return AUTH_TYPES.includes(authType) ? authType : "api_key";
}

/**
 * 一家供应商支持哪些登录方式，以及各自的显示名。
 *
 * 形状和 TUI 的登录选择器一致：`oauth` 有就用 `loginLabel`（没写就用 `name`，再没有
 * 就落到前端自己的「用账号登录」文案），`apiKey` 只有实现了 `login()` 才配出现在列表里
 * （缺 `login` 的 ambient-only 供应商，TUI 那边是弹「去别处配好再回来」）。
 */
export function providerLoginMethods(provider) {
  const oauth = isRecord(provider?.auth?.oauth) ? provider.auth.oauth : undefined;
  const apiKey = isRecord(provider?.auth?.apiKey) ? provider.auth.apiKey : undefined;
  return {
    apiKey: Boolean(apiKey),
    apiKeyLogin: typeof apiKey?.login === "function",
    oauth: Boolean(oauth),
    oauthName: typeof oauth?.name === "string" ? oauth.name.trim() : "",
    oauthLabel: typeof oauth?.loginLabel === "string" ? oauth.loginLabel.trim() : "",
    oauthSubscription: oauth?.isSubscription === true,
  };
}

/**
 * 登录会话的登记处：负责把 provider 的交互回调转成流事件，并把用户的答复送回
 * 那个正在 `await` 的 `prompt()`。
 *
 * 一个会话 = 一次 `login()` 调用 = 一条 HTTP 流。`prompt` 的 id 全局唯一，
 * 所以答复口只凭 id 就能找到在等的那一个，不必再带 sessionId。
 */
export function createModelLoginBroker() {
  let sessionSeq = 0;
  let promptSeq = 0;
  const sessions = new Map();
  const pendingPrompts = new Map();

  function emit(session, payload) {
    if (session.finished) {
      return;
    }
    session.onEvent(payload);
  }

  /** 会话说结束就结束，别把还在等的 prompt 留成悬着的 promise。 */
  function rejectPendingOf(sessionId, reason) {
    for (const [id, entry] of [...pendingPrompts]) {
      if (entry.sessionId !== sessionId) {
        continue;
      }
      pendingPrompts.delete(id);
      entry.cleanup();
      entry.reject(reason);
    }
  }

  function requestPrompt(session, prompt) {
    if (session.finished || session.controller.signal.aborted) {
      return Promise.reject(new Error(CANCELLED_MESSAGE));
    }
    const payload = serializableAuthPrompt(prompt);
    if (!payload) {
      return Promise.reject(new Error(CANCELLED_MESSAGE));
    }
    const id = `login-prompt-${++promptSeq}`;
    return new Promise((resolve, reject) => {
      const entry = { sessionId: session.id, resolve, reject, cleanup: () => {} };
      pendingPrompts.set(id, entry);
      // provider 可以给单个 prompt 带自己的中断信号（比如整段流程已被取消）。
      const promptSignal = prompt?.signal;
      if (promptSignal) {
        if (promptSignal.aborted) {
          pendingPrompts.delete(id);
          reject(new Error(CANCELLED_MESSAGE));
          return;
        }
        const onAbort = () => {
          pendingPrompts.delete(id);
          entry.cleanup();
          reject(new Error(CANCELLED_MESSAGE));
        };
        promptSignal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup = () => promptSignal.removeEventListener("abort", onAbort);
      }
      emit(session, { type: "prompt", id, prompt: payload });
    });
  }

  /**
   * 起一次登录。返回 `{ sessionId, done }`：`done` 在「done / error」事件写完之后
   * 才 resolve，调用方 `await done` 再关流。
   */
  function start({ providerId, authType, login, onEvent } = {}) {
    const session = {
      id: `login-${++sessionSeq}`,
      providerId: String(providerId ?? ""),
      authType: normalizeLoginAuthType(authType),
      controller: new AbortController(),
      onEvent: typeof onEvent === "function" ? onEvent : () => {},
      finished: false,
    };
    sessions.set(session.id, session);
    emit(session, { type: "session", sessionId: session.id });

    const interaction = {
      signal: session.controller.signal,
      notify: (event) => {
        const payload = serializableAuthEvent(event);
        if (payload) {
          emit(session, { type: "event", event: payload });
        }
      },
      prompt: (prompt) => requestPrompt(session, prompt),
    };

    const done = Promise.resolve()
      .then(() => login(interaction))
      .then(
        () => {
          emit(session, { type: "done" });
        },
        (error) => {
          emit(session, { type: "error", message: errorMessage(error) });
        },
      )
      .then(() => {
        session.finished = true;
        sessions.delete(session.id);
        rejectPendingOf(session.id, new Error(CANCELLED_MESSAGE));
      });

    return { sessionId: session.id, done };
  }

  /** 用户答复某个 prompt：`cancelled` 沿用 TUI 的语义 —— 取消整个登录，不只这一问。 */
  function respond(promptId, value, options = {}) {
    const id = String(promptId ?? "");
    const entry = pendingPrompts.get(id);
    if (!entry) {
      return false;
    }
    pendingPrompts.delete(id);
    entry.cleanup();
    if (options?.cancelled) {
      entry.reject(new Error(CANCELLED_MESSAGE));
      cancel(entry.sessionId);
      return true;
    }
    entry.resolve(String(value ?? ""));
    return true;
  }

  /** 取消整个登录（用户关弹窗 / 客户端断开）。 */
  function cancel(sessionId) {
    const session = sessions.get(String(sessionId ?? ""));
    if (!session) {
      return false;
    }
    session.controller.abort();
    rejectPendingOf(session.id, new Error(CANCELLED_MESSAGE));
    return true;
  }

  return {
    start,
    respond,
    cancel,
    /** 测试/诊断用：当前还开着的登录会话数。 */
    size: () => sessions.size,
    pendingCount: () => pendingPrompts.size,
    hasSession: (sessionId) => sessions.has(String(sessionId ?? "")),
  };
}