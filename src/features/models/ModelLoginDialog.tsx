import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { openTarget } from "../../lib/open-target";
import { useT } from "../../i18n/react";

import {
  cancelModelLogin,
  respondModelLogin,
  startModelLogin,
} from "./customModelsApi";
import type {
  ModelLoginAuthType,
  ModelLoginEvent,
  ModelLoginPrompt,
  ModelLoginStreamEvent,
} from "./customModelsApi";

/** 流里出现过的每一条进度/提示。`auth_url` / `device_code` 单独成行，其余按文本显示。 */
type LoginStep = { id: number; event: ModelLoginEvent };

/**
 * 供应商登录（OAuth / 交互式 API key）。
 *
 * 这是 TUI `/login` 的桌面版前端：pi 的登录交互只有「报告事件」和「问一句话」两种
 * 回调（见 server/modelLogin.mjs），这边就照它的 AuthEvent / AuthPrompt 词汇渲染 ——
 * `auth_url` 给链接、`device_code` 给设备码、`select` 给选项、`text`/`manual_code`
 * 给输入框。**不写死供应商**：按钮文案读 provider 的登录元数据，pi 目录新增一家
 * 支持 OAuth 的供应商，这里自动就有对应的流程。
 *
 * 流程在打开时自动开始（和 TUI 一样）；`open` 翻成 false 才取消，所以开发模式
 * StrictMode 的「挂载→卸载→再挂载」不会把一次登录掐成两次（key 用 ref 记住）。
 */
export function ModelLoginDialog({
  open,
  providerId,
  providerName,
  authType,
  onClose,
  onSuccess,
}: {
  open: boolean;
  providerId: string;
  providerName: string;
  authType: ModelLoginAuthType;
  onClose: () => void;
  /** 凭证已写入 auth.json：调用方负责刷新供应商/模型列表。 */
  onSuccess: () => void;
}) {
  const t = useT();
  const [steps, setSteps] = useState<LoginStep[]>([]);
  const [prompt, setPrompt] = useState<{ id: string; prompt: ModelLoginPrompt } | null>(null);
  const [answer, setAnswer] = useState("");
  const [phase, setPhase] = useState<"running" | "done" | "failed">("running");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const startedKeyRef = useRef("");
  const controllerRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef("");
  const stepSeqRef = useRef(0);
  const settledRef = useRef(false);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  // 关窗取消。和启动 effect 的先后顺序由声明顺序保证：先清 key，再 abort。
  useEffect(() => {
    if (open) {
      return;
    }
    startedKeyRef.current = "";
    const sessionId = sessionIdRef.current;
    sessionIdRef.current = "";
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (sessionId) {
      void cancelModelLogin(sessionId).catch(() => undefined);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const key = `${providerId}:${authType}`;
    // StrictMode 会「挂载→卸载→再挂载」：第二次进来 key 没变就不重开，
    // 否则回调端口会被两次登录抢（OpenAI 那条会直接报 port in use）。
    if (startedKeyRef.current === key) {
      return;
    }
    startedKeyRef.current = key;
    const controller = new AbortController();
    controllerRef.current = controller;
    sessionIdRef.current = "";
    settledRef.current = false;
    setSteps([]);
    setPrompt(null);
    setAnswer("");
    setPhase("running");
    setError("");
    setBusy(false);

    const pushStep = (event: ModelLoginEvent) => {
      setSteps((current) => [...current, { id: ++stepSeqRef.current, event }]);
    };
    const handle = (payload: ModelLoginStreamEvent) => {
      if (payload.type === "session") {
        sessionIdRef.current = payload.sessionId;
        return;
      }
      if (payload.type === "prompt") {
        setPrompt({ id: payload.id, prompt: payload.prompt });
        setAnswer("");
        return;
      }
      if (payload.type === "done") {
        settledRef.current = true;
        setPrompt(null);
        setPhase("done");
        onSuccessRef.current();
        return;
      }
      if (payload.type === "error") {
        settledRef.current = true;
        setPrompt(null);
        setPhase("failed");
        setError(payload.message);
        return;
      }
      // `event`：先摆上提示，再决定要不要弹浏览器。
      pushStep(payload.event);
      if (payload.event.type === "auth_url" && typeof payload.event.url === "string") {
        void openTarget(payload.event.url).catch(() => undefined);
      } else if (payload.event.type === "device_code" && typeof payload.event.verificationUri === "string") {
        void openTarget(payload.event.verificationUri).catch(() => undefined);
      }
    };

    void startModelLogin(providerId, authType, handle, { signal: controller.signal }).catch((streamError) => {
      if (controller.signal.aborted || settledRef.current) {
        return;
      }
      setPhase("failed");
      setError(streamError instanceof Error ? streamError.message : String(streamError));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, providerId, authType]);

  const hasAuthUrl = useMemo(
    () => steps.some((step) => step.event.type === "auth_url" || step.event.type === "device_code"),
    [steps],
  );

  async function submitAnswer() {
    if (!prompt || busy) {
      return;
    }
    setBusy(true);
    try {
      await respondModelLogin(prompt.id, answer);
      setPrompt(null);
      setAnswer("");
    } catch (respondError) {
      setPhase("failed");
      setError(respondError instanceof Error ? respondError.message : String(respondError));
    } finally {
      setBusy(false);
    }
  }

  function onAnswerKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitAnswer();
    }
  }

  function handleClose() {
    startedKeyRef.current = "";
    controllerRef.current?.abort();
    controllerRef.current = null;
    onClose();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          handleClose();
        }
      }}
    >
      <DialogContent className="grid gap-4 sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("models.login.title", { name: providerName })}</DialogTitle>
          <DialogDescription>
            {phase === "running" ? t("models.login.desc") : null}
            {phase === "done" ? t("models.login.done") : null}
            {phase === "failed" ? t("models.login.failed") : null}
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[52vh] gap-3 overflow-y-auto pr-1">
          {steps.map((step) => (
            <LoginStepRow key={step.id} event={step.event} />
          ))}

          {phase === "running" && hasAuthUrl && !prompt ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 size={13} className="animate-spin" />
              {t("models.login.waiting")}
            </p>
          ) : null}

          {phase === "running" && prompt ? (
            <div className="grid gap-2 rounded-md border p-3">
              <p className="text-sm">{prompt.prompt.message}</p>
              {prompt.prompt.type === "select" ? (
                <div className="grid gap-2">
                  {(prompt.prompt.options ?? []).map((option) => (
                    <Button
                      key={option.id}
                      type="button"
                      variant="outline"
                      className="h-auto justify-start py-2 text-left"
                      disabled={busy}
                      onClick={() => {
                                                void respondModelLogin(prompt.id, option.id).then(
                          () => {
                            setPrompt(null);
                            setAnswer("");
                          },
                          (respondError: unknown) => {
                            setPhase("failed");
                            setError(respondError instanceof Error ? respondError.message : String(respondError));
                          },
                        );
                      }}
                    >
                      <span className="grid gap-0.5">
                        <span>{option.label}</span>
                        {option.description ? (
                          <span className="text-xs text-muted-foreground">{option.description}</span>
                        ) : null}
                      </span>
                    </Button>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Input
                    autoFocus
                    type={prompt.prompt.type === "secret" ? "password" : "text"}
                    value={answer}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={prompt.prompt.placeholder ?? ""}
                    onChange={(event) => setAnswer(event.target.value)}
                    onKeyDown={onAnswerKeyDown}
                  />
                  <Button type="button" className="flex-none" disabled={busy || !answer.trim()} onClick={() => void submitAnswer()}>
                    {busy ? <Loader2 size={14} className="animate-spin" /> : null}
                    {t("models.login.submit")}
                  </Button>
                </div>
              )}
            </div>
          ) : null}

          {error ? (
            <p className="settings-card-error" role="alert">
              <AlertTriangle size={14} className="flex-none" />
              <span className="min-w-0 break-words">{error}</span>
            </p>
          ) : null}
        </div>

        <DialogFooter>
          {phase === "done" ? (
            <Button type="button" onClick={handleClose}>
              {t("models.login.close")}
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={handleClose}>
              {phase === "failed" ? t("models.login.close") : t("common.cancel")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 一条事件按 pi 给的词汇渲染；认不出来的类型就把 message（没有就整条 JSON）显示出来。 */
function LoginStepRow({ event }: { event: ModelLoginEvent }) {
  const t = useT();
  if (event.type === "auth_url" && typeof event.url === "string") {
    return (
      <div className="grid gap-1.5">
        {event.instructions ? <p className="text-sm">{event.instructions}</p> : null}
        <Button type="button" variant="outline" className="justify-start" onClick={() => void openTarget(event.url!).catch(() => undefined)}>
          <ExternalLink size={14} />
          <span className="truncate">{t("models.login.openAuthUrl")}</span>
        </Button>
        <p className="text-xs break-all text-muted-foreground">{event.url}</p>
      </div>
    );
  }
  if (event.type === "device_code" && typeof event.userCode === "string") {
    return (
      <div className="grid gap-1.5">
        <Button
          type="button"
          variant="outline"
          className="justify-start"
          onClick={() => typeof event.verificationUri === "string" && void openTarget(event.verificationUri).catch(() => undefined)}
        >
          <ExternalLink size={14} />
          <span className="truncate">{event.verificationUri}</span>
        </Button>
        <p className="text-sm">
          {t("models.login.deviceCodeLabel")}{" "}
          <span className="font-mono text-base font-semibold tracking-wider">{event.userCode}</span>
        </p>
      </div>
    );
  }
  if (event.type === "info") {
    return (
      <div className="grid gap-1">
        {event.message ? <p className="text-sm">{event.message}</p> : null}
        {(event.links ?? []).map((link) => (
          <button
            key={link.url}
            type="button"
            className="flex items-center gap-1.5 text-left text-xs text-primary hover:underline"
            onClick={() => void openTarget(link.url).catch(() => undefined)}
          >
            <ExternalLink size={12} />
            {link.label || link.url}
          </button>
        ))}
      </div>
    );
  }
  if (event.message) {
    return <p className="text-xs text-muted-foreground">{event.message}</p>;
  }
  return <p className="text-xs text-muted-foreground">{JSON.stringify(event)}</p>;
}