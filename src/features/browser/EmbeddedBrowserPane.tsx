import {
  ArrowLeft,
  ArrowRight,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  MousePointerSquareDashed,
  Plus,
  RotateCw,
  Camera,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useT } from "@/i18n/react";
import { supportsHostCapability } from "@/lib/shell/host.ts";
import { openTarget } from "@/lib/open-target.ts";
import { BLANK_BROWSER_URL, browserAddressLabel } from "@/shared/browserUrl";
import { createBrowserController } from "./browserController";
import {
  activateBrowserTab,
  browserTabLabel,
  closeBrowserTab,
  createBrowserTabs,
  openBrowserTab,
  updateBrowserTab,
  type BrowserTabState,
  type BrowserTabsState,
} from "./browserSession";
import { asWebviewElement, type WebviewElement } from "./webviewElement";
import { isRecoverableGuestExitReason, safeWebviewCall } from "./webviewLifecycle";

/**
 * 内置浏览器面板。
 *
 * 功能面（和 ZCode 的内置浏览器对齐的部分）：多标签、地址栏与历史、加载态、停止、页面内动作
 * （点击 / 输入 / 按键 / 滚动 / 取文本 / 取 HTML / 等待元素 / 截图 / 选元素）。
 *
 * 架构上它只是**宿主能力的消费者**：
 * - 能不能画 → `supportsHostCapability("embedded_browser")`（Electron 声明，Tauri / Web 没有）；
 * - 能打开什么 → `src/shared/browserUrl.ts`（与之后的 agent 导航工具共用一份判据）；
 * - 能做什么 → `BROWSER_COMMANDS` + `createBrowserController`（面板与 agent 工具共用一份执行器）；
 * - 真正的安全边界 → `src-electron/main.js` 的 `will-attach-webview` + 权限默认拒绝。
 *
 * 面板自己不持有跨会话状态：关掉 tab 就没了，重新打开回到空白页。
 */

interface GuestEvent {
  readonly tabId: string;
  readonly kind: "navigate" | "title" | "loading" | "stopped" | "failed" | "gone";
  readonly url?: string;
  readonly title?: string;
  readonly reason?: string;
  readonly errorCode?: number;
}

/**
 * 一张标签页的 guest。事件全部经一个回调上报，父组件的监听器不会随 tab 数量变化。
 *
 * `src` 只在挂载时读一次 `initialUrl`：把它绑到会随导航变化的 `url` 上，每一次地址更新都会
 * 触发一次重载（`did-navigate` → state → 重设 src → 再导航），页面会自己刷新自己。
 */
function BrowserGuest({
  tab,
  active,
  register,
  onEvent,
}: {
  tab: BrowserTabState;
  active: boolean;
  register: (id: string, view: WebviewElement | null) => void;
  onEvent: (event: GuestEvent) => void;
}) {
  useEffect(() => {
    const view = asWebviewElement(document.querySelector(`[data-browser-tab="${tab.id}"]`));
    register(tab.id, view);
    return () => register(tab.id, null);
  }, [tab.id, register]);

  return (
    <webview
      data-browser-tab={tab.id}
      src={tab.initialUrl}
      partition="persist:pi-embedded-browser"
      className={active ? "size-full" : "hidden"}
      ref={(node) => {
        const view = asWebviewElement(node);
        register(tab.id, view);
        if (!view) {
          return;
        }
        const emit = (kind: GuestEvent["kind"], extra: Omit<GuestEvent, "tabId" | "kind"> = {}) =>
          onEvent({ tabId: tab.id, kind, ...extra });
        const onNavigate = () => {
          const url = safeWebviewCall(
            () => view.getURL(),
            "",
            () => undefined,
          );
          const title = safeWebviewCall(
            () => view.getTitle(),
            "",
            () => undefined,
          );
          emit("navigate", { url, title });
        };
        view.addEventListener("dom-ready", onNavigate);
        view.addEventListener("did-navigate", onNavigate);
        view.addEventListener("did-navigate-in-page", onNavigate);
        view.addEventListener("page-title-updated", (event) => {
          const title = (event as Event & { title?: string }).title;
          if (typeof title === "string") {
            emit("title", { title });
          }
        });
        view.addEventListener("did-start-loading", () => emit("loading"));
        view.addEventListener("did-stop-loading", () => emit("stopped"));
        view.addEventListener("did-fail-load", (event) => {
          const detail = event as Event & { errorCode?: number; errorDescription?: string };
          if (detail.errorCode === -3) {
            return;
          }
          emit("failed", { errorCode: detail.errorCode, reason: detail.errorDescription });
        });
        view.addEventListener("render-process-gone", (event) => {
          emit("gone", { reason: String((event as Event & { reason?: string }).reason ?? "") });
        });
      }}
    />
  );
}

export function EmbeddedBrowserPane({ initialUrl }: { initialUrl?: string } = {}) {
  const t = useT();
  const supported = supportsHostCapability("embedded_browser");

  const [tabs, setTabs] = useState<BrowserTabsState>(() =>
    createBrowserTabs(initialUrl ?? BLANK_BROWSER_URL),
  );
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState(false);
  const [notice, setNotice] = useState<{
    kind: "picked" | "error" | "copied";
    text: string;
  } | null>(null);
  const [picking, setPicking] = useState(false);

  const views = useRef(new Map<string, WebviewElement>());
  const activeIdRef = useRef(tabs.activeId);
  activeIdRef.current = tabs.activeId;

  const controller = useMemo(
    () => createBrowserController(() => views.current.get(activeIdRef.current) ?? null),
    [],
  );

  const activeTab = tabs.tabs.find((tab) => tab.id === tabs.activeId) ?? tabs.tabs[0];

  useEffect(() => {
    setAddress(browserAddressLabel(activeTab.url));
  }, [activeTab.id, activeTab.url]);

  const register = useCallback((id: string, view: WebviewElement | null) => {
    if (view) {
      views.current.set(id, view);
    } else {
      views.current.delete(id);
    }
  }, []);

  const onEvent = useCallback(
    (event: GuestEvent) => {
      if (event.kind === "navigate") {
        setTabs((current) =>
          updateBrowserTab(current, event.tabId, {
            url: event.url ?? "",
            title: event.title ?? "",
          }),
        );
        return;
      }
      if (event.kind === "title") {
        setTabs((current) => updateBrowserTab(current, event.tabId, { title: event.title ?? "" }));
        return;
      }
      if (event.kind === "loading") {
        setTabs((current) => updateBrowserTab(current, event.tabId, { loading: true }));
        return;
      }
      if (event.kind === "stopped") {
        setTabs((current) => updateBrowserTab(current, event.tabId, { loading: false }));
        return;
      }
      if (event.kind === "failed") {
        setTabs((current) => updateBrowserTab(current, event.tabId, { loading: false }));
        setNotice({ kind: "error", text: event.reason ?? String(event.errorCode ?? "") });
        return;
      }
      if (event.kind === "gone" && event.reason && !isRecoverableGuestExitReason(event.reason)) {
        setNotice({ kind: "error", text: t("browser.crashed") });
      }
    },
    [t],
  );

  const run = useCallback(
    async (id: string, args?: Record<string, unknown>) => {
      const result = await controller.run(id, args);
      if (!result.ok) {
        setNotice({ kind: "error", text: result.message });
      }
      return result;
    },
    [controller],
  );

  if (!supported) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
        role="status"
      >
        <Globe aria-hidden className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium">{t("browser.unsupportedTitle")}</p>
        <p className="max-w-[28ch] text-xs text-muted-foreground">{t("browser.unsupportedBody")}</p>
      </div>
    );
  }

  const submitAddress = async () => {
    setAddressError(false);
    const result = await run("navigate", { url: address });
    if (!result.ok) {
      setAddressError(true);
    }
  };

  const takeScreenshot = async () => {
    const result = await run("screenshot");
    if (!result.ok || typeof result.value !== "string") {
      return;
    }
    const link = document.createElement("a");
    link.href = result.value;
    link.download = `pi-browser-${activeTab.id}.png`;
    link.click();
  };

  const pickElement = async () => {
    setPicking(true);
    setNotice(null);
    const result = await run("pickElement");
    setPicking(false);
    if (!result.ok) {
      return;
    }
    const picked = result.value as { selector: string; text: string } | null;
    setNotice(picked ? { kind: "picked", text: `${picked.selector}\n${picked.text}` } : null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label={t("browser.tabsAria")}
        className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/60 px-1"
      >
        {tabs.tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === tabs.activeId}
            className={`group flex min-w-0 max-w-[160px] items-center gap-1 rounded-t px-2 py-1 text-[11px] ${
              tab.id === tabs.activeId ? "bg-muted" : "hover:bg-muted/60 text-muted-foreground"
            }`}
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left"
              title={tab.url}
              onClick={() => setTabs((current) => activateBrowserTab(current, tab.id))}
            >
              {tab.loading ? (
                <Loader2 aria-hidden className="mr-1 inline size-3 animate-spin" />
              ) : null}
              {browserTabLabel(tab, t("browser.newTab"))}
            </button>
            <button
              type="button"
              aria-label={t("browser.closeTab")}
              className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-background/60"
              onClick={() => setTabs((current) => closeBrowserTab(current, tab.id))}
            >
              <X aria-hidden className="size-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          aria-label={t("browser.newTab")}
          className="ml-0.5 rounded p-1 hover:bg-muted"
          onClick={() => setTabs((current) => openBrowserTab(current))}
        >
          <Plus aria-hidden className="size-3.5" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <button
          type="button"
          aria-label={t("browser.back")}
          disabled={
            !safeWebviewCall(() => views.current.get(activeTab.id)?.canGoBack() ?? false, false)
          }
          className="rounded p-1 hover:bg-muted disabled:opacity-40"
          onClick={() => void run("back")}
        >
          <ArrowLeft aria-hidden className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={t("browser.forward")}
          disabled={
            !safeWebviewCall(() => views.current.get(activeTab.id)?.canGoForward() ?? false, false)
          }
          className="rounded p-1 hover:bg-muted disabled:opacity-40"
          onClick={() => void run("forward")}
        >
          <ArrowRight aria-hidden className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={activeTab.loading ? t("browser.stop") : t("browser.reload")}
          className="rounded p-1 hover:bg-muted"
          onClick={() => void run(activeTab.loading ? "stop" : "reload")}
        >
          {activeTab.loading ? (
            <X aria-hidden className="size-3.5" />
          ) : (
            <RotateCw aria-hidden className="size-3.5" />
          )}
        </button>

        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAddress();
          }}
        >
          <input
            value={address}
            placeholder={t("browser.addressPlaceholder")}
            aria-label={t("browser.addressPlaceholder")}
            aria-invalid={addressError}
            spellCheck={false}
            className="w-full rounded border border-border/60 bg-background/60 px-2 py-1 text-xs outline-none focus:border-border"
            onChange={(event) => {
              setAddress(event.target.value);
              setAddressError(false);
            }}
          />
        </form>

        <button
          type="button"
          aria-label={t("browser.pickElement")}
          aria-pressed={picking}
          disabled={picking}
          className="rounded p-1 hover:bg-muted disabled:opacity-40"
          onClick={() => void pickElement()}
        >
          <MousePointerSquareDashed aria-hidden className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={t("browser.screenshot")}
          className="rounded p-1 hover:bg-muted"
          onClick={() => void takeScreenshot()}
        >
          <Camera aria-hidden className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={t("browser.openExternal")}
          className="rounded p-1 hover:bg-muted"
          onClick={() => {
            if (activeTab.url) {
              void openTarget(activeTab.url);
            }
          }}
        >
          <ExternalLink aria-hidden className="size-3.5" />
        </button>
      </div>

      {addressError ? (
        <p className="shrink-0 px-2 py-1 text-[11px] text-destructive">
          {t("browser.invalidAddress")}
        </p>
      ) : null}
      {notice ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-border/60 bg-muted/40 px-2 py-1 text-[11px]">
          <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono">
            {notice.text}
          </pre>
          {notice.kind === "picked" ? (
            <button
              type="button"
              aria-label={t("browser.copy")}
              className="rounded p-1 hover:bg-background/60"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(notice.text)
                  .then(() => setNotice({ kind: "copied", text: t("browser.copied") }));
              }}
            >
              <Copy aria-hidden className="size-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={t("browser.dismiss")}
            className="rounded p-1 hover:bg-background/60"
            onClick={() => setNotice(null)}
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {/* 每张 tab 一个 guest：切走只是隐藏，不销毁 —— 否则切回来页面状态全丢。
            上限见 browserSession.MAX_BROWSER_TABS。 */}
        {tabs.tabs.map((tab) => (
          <BrowserGuest
            key={tab.id}
            tab={tab}
            active={tab.id === tabs.activeId}
            register={register}
            onEvent={onEvent}
          />
        ))}
      </div>
    </div>
  );
}
