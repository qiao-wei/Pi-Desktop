import { extensionWidgetRequest } from "./extensionUiRequests.mjs";
import { matchesKey } from "./piKernel.mjs";
import { readKeyResponse } from "./smallHelpers.mjs";
import { randomUUID } from "node:crypto";

/**
 * 扩展 UI 桥（headless 主题、面板请求/应答）
 *
 * 从 `server/index.mjs` 抽出的域：这些定义原来住在请求内核里，靠共享的可变状态与互相调用咬在一起。
 * 现在改成**注入**——共享状态走 `state`，外部函数/常量走 `deps`（按名字解构，函数体不改），
 * 由 index.mjs 在末尾组合区调用本工厂并解构成同名局部变量，所以调用点零改动。
 */
export function createExtensionUiDomain(state, deps) {
  const { activePackageCommands, appCwd, extensionUiAnsiAccent, normalizeExtensionUiMode, openRuntimes } = deps;
  const abortSession = /** @type {any} */ ((...args) => deps.abortSession(...args));
  const refreshSnapshot = /** @type {any} */ ((...args) => deps.refreshSnapshot(...args));

const headlessUiTheme = {
  fg: (_name, text) => text,
  bg: (_name, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  underline: (text) => text,
  inverse: (text) => text,
  strikethrough: (text) => text,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor",
  getThinkingBorderColor: () => (str) => str,
  getBashModeBorderColor: () => (str) => str,
};

/** ANSI codes for the colour roles extensions ask for. Unknown roles fall back to the default colour. */
const extensionUiAnsiFgCodes = {
  accent: extensionUiAnsiAccent,
  success: "92",
  error: "91",
  warning: "93",
  border: "90",
  borderAccent: extensionUiAnsiAccent,
  borderMuted: "90",
  muted: "90",
  dim: "90",
  text: "39",
  toolOutput: "37",
  toolDiffAdded: "92",
  toolDiffRemoved: "91",
  toolDiffContext: "90",
};

const extensionUiAnsiBgCodes = {
  selectedBg: "106",
  searchMatchBg: "103",
  userMessageBg: "100",
  customMessageBg: "100",
  toolPendingBg: "100",
  toolSuccessBg: "102",
  toolErrorBg: "101",
};

/**
 * The colour-preserving sibling of `headlessUiTheme`.
 *
 * `tui` presentation wants plain text (the host strips escapes anyway), but `webui`
 * presentation renders the panel in the window, where colour is what turns a wall of
 * monospace into a readable list. This theme emits real SGR sequences instead of inventing a
 * bespoke marker format: the renderer parses them with the same rules a terminal would
 * (`parseTerminalLines`), and any extension that draws with a real theme keeps working.
 */
const ansiUiTheme = {
  fg: (name, text) => `\u001b[${extensionUiAnsiFgCodes[name] ?? "39"}m${text}\u001b[39m`,
  bg: (name, text) => `\u001b[${extensionUiAnsiBgCodes[name] ?? "49"}m${text}\u001b[49m`,
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
  italic: (text) => `\u001b[3m${text}\u001b[23m`,
  underline: (text) => `\u001b[4m${text}\u001b[24m`,
  inverse: (text) => `\u001b[7m${text}\u001b[27m`,
  strikethrough: (text) => `\u001b[9m${text}\u001b[29m`,
  getFgAnsi: (name) => `\u001b[${extensionUiAnsiFgCodes[name] ?? "39"}m`,
  getBgAnsi: (name) => `\u001b[${extensionUiAnsiBgCodes[name] ?? "49"}m`,
  getColorMode: () => "ansi16",
  getThinkingBorderColor: () => (str) => ansiUiTheme.fg("muted", str),
  getBashModeBorderColor: () => (str) => ansiUiTheme.fg("accent", str),
};

/** The personalization choice, resolved per call so switching it applies to the next panel. */
function extensionUiRenderMode() {
  return normalizeExtensionUiMode(state.personalization?.extensionUi);
}

/** `webui` needs colours; `tui` keeps the historical plain-text output. */
function activeUiTheme() {
  return extensionUiRenderMode() === "webui" ? ansiUiTheme : headlessUiTheme;
}

function createExtensionUiBridge() {
  const listeners = new Set();
  const pendingRequests = new Map();
  const queuedEvents = [];
  const customViewportWidth = 88;

  function renderCustomRequest(request, component) {
    request.lines = component?.render?.(customViewportWidth)?.map((line) => String(line)) ?? [];
    emit(request);
  }

  function emit(event) {
    if (listeners.size === 0) {
      queuedEvents.push(event);
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    if (queuedEvents.length > 0) {
      for (const event of queuedEvents.splice(0, queuedEvents.length)) {
        listener(event);
      }
    }

    return () => {
      listeners.delete(listener);
    };
  }

  function request(method, payload, options = {}) {
    const id = randomUUID();
    const requestPayload = {
      type: "extension_ui_request",
      id,
      method,
      ...payload,
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    };

    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { request: requestPayload, resolve, reject });
      emit(requestPayload);
    });
  }

  async function respond(response) {
    const pending = pendingRequests.get(String(response?.id ?? ""));
    if (!pending) {
      return false;
    }

    if (pending.custom) {
      if (response?.cancelled) {
        pending.custom.finish({ cancelled: true });
        return true;
      }
      const keys = readKeyResponse(response);
      if (!keys) {
        return false;
      }
      try {
        // Replayed in order because a click is a synthetic "move the cursor there, then activate"
        // - a component may also close itself mid-sequence (enter on a terminal action), so stop
        // writing to it the moment it finishes.
        for (const data of keys) {
          pending.custom.component?.handleInput?.(data);
          if (pendingRequests.get(String(response.id)) !== pending) break;
        }
        if (pendingRequests.get(String(response.id)) === pending) {
          renderCustomRequest(pending.request, pending.custom.component);
        }
      } catch (error) {
        pending.custom.finish(undefined, error);
      }
      return true;
    }

    if (pending.web) {
      if (response?.cancelled) {
        pending.web.finish({ cancelled: true });
        return true;
      }
      if (typeof response?.action !== "string") {
        return false;
      }
      try {
        await pending.web.onAction?.({
          action: response.action,
          values: response.values && typeof response.values === "object" && !Array.isArray(response.values)
            ? response.values
            : {},
          data: response.data,
        }, pending.web.controller);
        if (pendingRequests.get(String(response.id)) === pending && !pending.web.onAction) {
          pending.web.finish({ action: response.action, values: response.values ?? {}, data: response.data });
        }
      } catch (error) {
        pending.web.controller.update({
          notice: {
            tone: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return true;
    }

    pendingRequests.delete(String(response.id));
    pending.resolve(response);
    return true;
  }

  function pendingRequestSnapshot() {
    return [...pendingRequests.values()].map((entry) => entry.request);
  }

  function clearPendingRequests() {
    for (const pending of pendingRequests.values()) {
      if (pending.custom) {
        pending.custom.finish({ cancelled: true });
      } else if (pending.web) {
        pending.web.finish({ cancelled: true });
      } else {
        pending.resolve({ cancelled: true });
      }
    }
    pendingRequests.clear();
    queuedEvents.length = 0;
  }

  function createUiContext() {
    return {
      select: async (title, options, opts) => {
        const response = await request("select", { title, options }, opts);
        if (response?.cancelled) {
          return undefined;
        }
        return typeof response?.value === "string" ? response.value : undefined;
      },
      confirm: async (title, message, opts) => {
        const response = await request("confirm", { title, message }, opts);
        if (response?.cancelled) {
          return false;
        }
        return Boolean(response?.confirmed);
      },
      input: async (title, placeholder, opts) => {
        const response = await request("input", { title, placeholder }, opts);
        if (response?.cancelled) {
          return undefined;
        }
        return typeof response?.value === "string" ? response.value : undefined;
      },
      notify: (message, type = "info") => {
        emit({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType: type });
      },
      onTerminalInput: () => () => {},
      setStatus: (statusKey, statusText) => {
        emit({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey, statusText });
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (widgetKey, content, options) => {
        // `undefined` 是「清除」；漏掉它会让扩展在 session_shutdown 里清掉的 widget 留在编辑器上方。
        const request = extensionWidgetRequest(widgetKey, content, options);
        if (!request) {
          return;
        }
        emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          ...request,
        });
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        emit({ type: "extension_ui_request", id: randomUUID(), method: "setTitle", title });
      },
      pasteToEditor: () => {},
      setEditorText: (text) => {
        emit({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text });
      },
      getEditorText: () => "",
      editor: async (title, prefill) => {
        const response = await request("editor", { title, prefill });
        if (response?.cancelled) {
          return undefined;
        }
        return typeof response?.value === "string" ? response.value : undefined;
      },
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() {
        return activeUiTheme();
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "UI not available" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
      web: async (definition, onAction) => {
        const id = randomUUID();
        const requestPayload = {
          type: "extension_ui_request",
          id,
          method: "web",
          title: String(definition?.title ?? "Package interface"),
          definition: definition && typeof definition === "object" ? definition : {},
          overlay: definition?.overlay !== false,
        };

        return new Promise((resolve, reject) => {
          let finished = false;
          const finish = (value, error) => {
            if (finished) return;
            finished = true;
            pendingRequests.delete(id);
            emit({ ...pending.request, closed: true });
            if (error) reject(error);
            else resolve(value);
          };
          const controller = {
            update: (patch) => {
              if (finished || pendingRequests.get(id) !== pending) return;
              const currentDefinition = pending.request.definition ?? {};
              pending.request = {
                ...pending.request,
                definition: {
                  ...currentDefinition,
                  ...(patch && typeof patch === "object" ? patch : {}),
                },
              };
              emit(pending.request);
            },
            close: (value) => finish(value),
          };
          const pending = {
            request: requestPayload,
            resolve,
            reject,
            web: {
              onAction: typeof onAction === "function" ? onAction : undefined,
              controller,
              finish,
            },
          };
          pendingRequests.set(id, pending);
          emit(requestPayload);
        });
      },
      custom: async (factory, options) => {
        const id = randomUUID();
        // The mode is read here, not at bind time, so toggling it in 设置 → 个性化 applies to the
        // next panel without reloading the session.
        const renderMode = extensionUiRenderMode();
        const requestPayload = {
          type: "extension_ui_request",
          id,
          method: "custom",
          title: options?.title ?? "Pi extension",
          lines: [],
          renderMode,
          overlay: options?.overlay !== false,
        };

        return new Promise((resolve, reject) => {
          let finished = false;
          /** @type {{ request: unknown, resolve: (value: any) => void, reject: (error: any) => void, custom: { component: { dispose?: () => void } | null, finish: (value?: any, error?: any) => void } }} */
          const pending = {
            request: requestPayload,
            resolve,
            reject,
            custom: {
              component: null,
              finish: (value, error) => {
                if (finished) return;
                finished = true;
                pendingRequests.delete(id);
                pending.custom.component?.dispose?.();
                emit({ ...requestPayload, closed: true, lines: [] });
                if (error) reject(error);
                else resolve(value);
              },
            },
          };
          pendingRequests.set(id, pending);

          const fakeTui = {
            requestRender: () => {
              if (!finished && pending.custom.component) {
                renderCustomRequest(requestPayload, pending.custom.component);
              }
            },
          };
          const fakeKeybindings = {
            matches: (data, key) => {
              if (key === "tui.select.up") return matchesKey(data, "up");
              if (key === "tui.select.down") return matchesKey(data, "down");
              if (key === "tui.select.confirm") return matchesKey(data, "enter");
              return false;
            },
            getUserBindings: () => ({}),
          };

          Promise.resolve()
            .then(() => factory(fakeTui, activeUiTheme(), fakeKeybindings, (value) => pending.custom.finish(value)))
            .then((component) => {
              if (finished) {
                component?.dispose?.();
                return;
              }
              pending.custom.component = component;
              renderCustomRequest(requestPayload, component);
            })
            .catch((error) => pending.custom.finish(undefined, error));
        });
      },
    };
  }

  function createProjectTrustContext(cwd, { hasUI = true } = {}) {
    return {
      cwd,
      mode: "rpc",
      hasUI,
      ui: {
        select: createUiContext().select,
        confirm: createUiContext().confirm,
        input: createUiContext().input,
        notify: createUiContext().notify,
      },
    };
  }

  return {
    emit,
    subscribe,
    respond,
    clearPendingRequests,
    getPendingRequests: pendingRequestSnapshot,
    createUiContext,
    createProjectTrustContext,
  };
}

function createPiDesktopCommandContextActions(runtimeRef) {
  return {
    getSystemPromptOptions: () => {
      const runtime = runtimeRef.current;
      if (!runtime) {
        return { cwd: appCwd };
      }

      return {
        cwd: runtime.cwd,
        contextFiles: runtime.session.resourceLoader.getAgentsFiles().agentsFiles,
        skills: runtime.session.resourceLoader.getSkills().skills,
      };
    },
    waitForIdle: async () => {
      const runtime = runtimeRef.current;
      if (!runtime) {
        return;
      }
      await runtime.session.waitForIdle();
    },
    newSession: async (options) => {
      const runtime = runtimeRef.current;
      if (!runtime) {
        throw new Error("Runtime is not ready.");
      }
      return runtime.newSession(options);
    },
    fork: async (entryId, options) => {
      const runtime = runtimeRef.current;
      if (!runtime) {
        throw new Error("Runtime is not ready.");
      }
      return runtime.fork(entryId, options);
    },
    navigateTree: async (targetId, options) => {
      const runtime = runtimeRef.current;
      if (!runtime) {
        throw new Error("Runtime is not ready.");
      }
      return runtime.session.navigateTree(targetId, options);
    },
    switchSession: async (sessionPath, options) => {
      const runtime = runtimeRef.current;
      if (!runtime) {
        throw new Error("Runtime is not ready.");
      }
      return runtime.switchSession(sessionPath, options);
    },
    reload: async () => {
      const runtime = runtimeRef.current;
      if (!runtime) {
        throw new Error("Runtime is not ready.");
      }
      await runtime.session.reload();
    },
  };
}

async function bindPiDesktopSessionExtensions(session, runtimeRef, uiBridge) {
  await session.bindExtensions({
    uiContext: uiBridge.createUiContext(),
    // "tui" on purpose, not "rpc". pi-core's contract is that `ctx.ui.custom()` only
    // behaves in "tui" mode; in plain "rpc" it is a headless stub. This host is not
    // headless - createExtensionUiBridge implements custom() for real (it renders the
    // TUI component to lines and forwards keystrokes), so extensions that guard
    // terminal-only overlays with `ctx.mode === "tui"` (e.g. a registered MCP
    // server's panel) would otherwise silently fall back to a text notification.
    mode: "tui",
    commandContextActions: createPiDesktopCommandContextActions(runtimeRef),
    abortHandler: () => {
      void abortSession(session, { reason: "extension_abort_handler" }).catch(() => undefined);
    },
    shutdownHandler: () => {
      session.dispose();
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Extension error: ${message}`);
    },
  });
}

async function respondToExtensionUiRequest(body) {
  const requestId = String(body?.id ?? body?.requestId ?? "").trim();
  if (!requestId) {
    throw new Error("Request id is required.");
  }

  for (const candidate of openRuntimes.values()) {
    if (await candidate.uiBridge?.respond(body)) {
      if (body?.cancelled && activePackageCommands.get(candidate.session.sessionFile) === candidate) {
        await abortSession(candidate.session, { reason: "extension_ui_cancel" }).catch(() => undefined);
      }
      return {
        ok: true,
        snapshot: await refreshSnapshot(),
      };
    }
  }

  throw new Error("Extension UI request not found.");
}

  return { activeUiTheme, ansiUiTheme, bindPiDesktopSessionExtensions, createExtensionUiBridge, createPiDesktopCommandContextActions, extensionUiAnsiBgCodes, extensionUiAnsiFgCodes, extensionUiRenderMode, headlessUiTheme, respondToExtensionUiRequest };
}
