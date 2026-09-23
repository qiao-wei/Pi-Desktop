import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertTriangle, Check, ChevronDown, Loader2, Pencil, Plus, RefreshCw, Search, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useT } from "../../i18n/react";

import { formatTokenCount, summaryLabel } from "./customModelForm";
import {
  addCustomModels,
  catalogModelPayload,
  discoverProviderModels,
  fetchModelProviders,
  fetchProviderModels,
  removeCustomModel,
  verifyProviderKey,
} from "./customModelsApi";
import type { CustomModelEntry, CustomModelsResponse, ModelProviderRow, ProviderModelOption } from "./customModelsApi";
import { ApiKeyField } from "./ApiKeyField";

/**
 * 「添加模型」弹窗：往一家已有的供应商里挑模型。
 *
 * 选完 provider 只显示 `models.json` / pi 目录里已经存在的行（不联网、不猜）；
 * 想看端点现在到底有哪些模型，要按列表上方的 Refresh 去拉一次。
 * 建新供应商 / 改供应商本身是另一个弹窗（ProviderDialog），这里只放入口。
 *
 * 已经在 models.json 里的模型默认勾上；取消勾选 = 提交时把那行从文件里删掉。
 * 所以这个弹窗既是「批量添加」也是「这一家的模型选择器」。
 */
export function AddModelsDialog({
  open,
  entries,
  onClose,
  onAdded,
  onRequestAddProvider,
  onRequestEditProvider,
  overlayOpen = false,
  onOverlayBack,
  initialProviderId = "",
}: {
  open: boolean;
  /** 当前 models.json 里的条目：用来判断哪些模型已经加过。 */
  entries: CustomModelEntry[];
  onClose: () => void;
  onAdded: (response: CustomModelsResponse) => void;
  /** 打开「添加 / 编辑 provider」弹窗（叠在本弹窗之上）。 */
  onRequestAddProvider: () => void;
  /** 选中的是用户自己登记的供应商时，打开「编辑 provider」弹窗。 */
  onRequestEditProvider: (providerId: string) => void;
  /** provider 弹窗开着时本弹窗只是压在底下：不销毁状态，回来还是同一张列表。 */
  overlayOpen?: boolean;
  /** provider 弹窗退回去了：重新露出来。 */
  onOverlayBack?: () => void;
  /**
   * 打开时就选中这家供应商（设置页每一组的 Add / Edit 按钮带进来的）。
   *
   * 这个弹窗本来就是「这一家的模型选择器」：勾上=加进 models.json，取消勾选=删掉。
   * 从某一组点进来还让我重新挑一遍供应商，等于把用户已经站在的位置忘掉。
   */
  initialProviderId?: string;
}) {
  const t = useT();
  const [providers, setProviders] = useState<ModelProviderRow[]>([]);
  const [providerId, setProviderId] = useState("");
  const [providerQuery, setProviderQuery] = useState("");
  const [providerOpen, setProviderOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ProviderModelOption[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  /** 拉列表那一刻「文件里已经有」的模型：取消勾选就是要把它们删掉。 */
  const [addedEntries, setAddedEntries] = useState<CustomModelEntry[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"idle" | "loadingProviders" | "loadingModels" | "discovering" | "saving" | "verifying">("idle");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [keyVerifyResult, setKeyVerifyResult] = useState<{ ok: boolean; message: string } | null>(null);
  const providerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const providerSearchRef = useRef<HTMLInputElement | null>(null);
  const providerListRef = useRef<HTMLDivElement | null>(null);

  const provider = useMemo(() => providers.find((row) => row.id === providerId), [providers, providerId]);
  const providerMatches = useMemo(() => {
    const needle = providerQuery.trim().toLowerCase();
    const list = needle
      ? providers.filter((row) => `${row.name} ${row.id} ${row.baseUrl}`.toLowerCase().includes(needle))
      : providers;
    // 已经配好 key 的排前面：多数时候用户要的就是手上这家。
    return [...list].sort((left, right) => Number(right.authConfigured) - Number(left.authConfigured)
      || left.name.localeCompare(right.name));
  }, [providers, providerQuery]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return models;
    }
    return models.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(needle));
  }, [models, query]);

  /** 这个 provider 在 models.json 里已经有的模型行。 */
  const providerEntries = useMemo(
    () => (providerId ? entries.filter((entry) => entry.providerId === providerId) : []),
    [entries, providerId],
  );

  const chosenModels = useMemo(
    () => models.filter((model) => selected.includes(model.id)),
    [models, selected],
  );
  const addedIds = useMemo(() => new Set(addedEntries.map((entry) => entry.model)), [addedEntries]);
  const toAdd = useMemo(
    () => chosenModels.filter((model) => !addedIds.has(model.id)),
    [chosenModels, addedIds],
  );
  const toRemove = useMemo(
    () => addedEntries.filter((entry) => !selected.includes(entry.model)),
    [addedEntries, selected],
  );
  const busy = status !== "idle";
  const canRefresh = Boolean(providerId);
  /** 没填 key 也允许验：留空就是验已存的那一份。 */
  const canVerifyKey = Boolean(providerId);
  /** 只有用户自己登记在 models.json 里的供应商能改；内置的那是 pi 管的。 */
  const canEditProvider = Boolean(provider && !provider.builtin && provider.registered);

  // 底下压着 provider 弹窗（open=false）时**不重置**：那是去隔壁加了一家公司，回来不该把
  // 刚选好的供应商、勾好的模型全丢。重新露出来时只把 provider 目录刷一遍，新加的那家要在列表里。
  useEffect(() => {
    if (!open && !overlayOpen) {
      setProviderOpen(false);
      setProviderId("");
      setProviderQuery("");
      setBaseUrl("");
      setApiKey("");
      setModels([]);
      setSelected([]);
      setAddedEntries([]);
      setQuery("");
      setNotice("");
      setError("");
      setKeyVerifyResult(null);
      return;
    }
    let cancelled = false;
    if (open) {
      setStatus("loadingProviders");
    }
    void fetchModelProviders()
      .then((response) => {
        if (!cancelled) {
          setProviders(response.providers ?? []);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(readableError(loadError));
        }
      })
      .finally(() => {
        if (!cancelled && open) {
          setStatus("idle");
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, overlayOpen]);

  // 带着「就是这家」进来时先把它选中：providers 可能还没到，等到了再定。
  useEffect(() => {
    if (!open || !initialProviderId) {
      return;
    }
    if ((providers.some((row) => row.id === initialProviderId) || providers.length === 0) && providerId !== initialProviderId) {
      setProviderId(initialProviderId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialProviderId, providers.length]);

  // 展开就把光标送进搜索框（dropdown 第一排是搜索，展开即打字）。
  useEffect(() => {
    if (!providerOpen) {
      return;
    }
    const frame = requestAnimationFrame(() => providerSearchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [providerOpen]);

  // 这份列表滚不动：打开它的「添加模型」是 Radix modal 弹窗，弹窗用 react-remove-scroll
  // 在 document 上把所有 wheel preventDefault 掉（锁外面的滚动）；而本 dropdown 是 portal
  // 到 body 的，正好在锁外。锁只对「锁树里的 target」算可用滚动量，portal 进来的 target
  // 一律当作锁外直接拦，于是列表永远滚不动。
  // 解法：在列表元素自身的捕获阶段把 wheel/touchmove stopPropagation 掉 ——
  // react-remove-scroll 的 document 级监听收不到事件，就不会 preventDefault；
  // stopPropagation 不影响默认行为，浏览器照常按事件 target 滚这条列表。
  // 用 ref 回调而不是 effect：dropdown 是 portal + Presence 异步挂载的，
  // effect 在 providerOpen 翻转时跑一次，那会儿 ref 还是 null，监听就丢了。
  const swallowForScrollGuard = (event: Event) => {
    event.stopPropagation();
  };
  function attachProviderListRef(node: HTMLDivElement | null) {
    const previous = providerListRef.current;
    if (previous && previous !== node) {
      previous.removeEventListener("wheel", swallowForScrollGuard, { capture: true });
      previous.removeEventListener("touchmove", swallowForScrollGuard, { capture: true });
    }
    providerListRef.current = node;
    if (node) {
      node.addEventListener("wheel", swallowForScrollGuard, { capture: true, passive: true });
      node.addEventListener("touchmove", swallowForScrollGuard, { capture: true, passive: true });
    }
  }

  /** 换供应商：清掉上一家的列表与勾选，再从配置里读这一家的模型行。 */
  useEffect(() => {
    if (!open) {
      return;
    }
    setSelected([]);
    setModels([]);
    setAddedEntries([]);
    setKeyVerifyResult(null);
    setNotice("");
    setError("");
    if (providerId) {
      void loadConfiguredModels(providerId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, providerId]);

  /** 配置里已有的模型列表（桥只读 models.json / runtime 目录，不打网络）。 */
  async function loadConfiguredModels(id: string) {
    setStatus("loadingModels");
    try {
      const row = await fetchProviderModels(id);
      // 已存的 key 回填进框里（默认密文，眼睛切明文）。用户已经手打了一串就别覆盖。
      setApiKey((current) => (current.trim() ? current : row.apiKey ?? ""));
      const list = row.models ?? [];
      setModels(list);
      syncSelection(list);
      setNotice(list.length
        ? t("models.add.configuredNotice", { count: list.length })
        : t("models.add.configuredEmpty"));
    } catch (loadError) {
      // 拉不到配置也别把列表清空成“这家没有模型”：那是另一件事。
      setError(readableError(loadError));
    } finally {
      setStatus("idle");
    }
  }

  function closeProviderPicker(refocusTrigger = true) {
    setProviderOpen(false);
    if (refocusTrigger) {
      providerTriggerRef.current?.focus();
    }
  }

  function focusOption(current: HTMLButtonElement | null, direction: 1 | -1) {
    const options = Array.from(
      providerListRef.current?.querySelectorAll<HTMLButtonElement>("[data-provider-option]") ?? [],
    );
    if (!options.length) {
      return;
    }
    const index = current ? options.indexOf(current) : -1;
    const next = (index + direction + options.length) % options.length;
    options[next]?.focus();
  }

  /** 搜索框里回车 = 选第一个匹配项，省一次鼠标。 */
  function onProviderSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      // 只收 dropdown（弹窗那边已经用 onEscapeKeyDown 放行，不会连带关掉）。
      event.preventDefault();
      closeProviderPicker();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption(null, 1);
      return;
    }
    if (event.key === "Enter") {
      const first = providerMatches[0];
      if (first) {
        event.preventDefault();
        pickProvider(first);
      }
    }
  }

  function onProviderOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeProviderPicker();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
    }
  }

  function pickProvider(row: ModelProviderRow) {
    setProviderId(row.id);
    setBaseUrl(row.baseUrl ?? "");
    setApiKey("");
    setProviderOpen(false);
    providerTriggerRef.current?.focus();
  }

  /** 已经加过的模型默认勾上；取消勾选就是提交时要删掉的。 */
  function syncSelection(list: ProviderModelOption[]) {
    const existing = list
      .map((model) => providerEntries.find((entry) => entry.model === model.id))
      .filter((entry): entry is CustomModelEntry => Boolean(entry));
    setAddedEntries(existing);
    setSelected(existing.map((entry) => entry.model));
  }

  /** Refresh：去端点实时拉一次列表（内置走 runtime，自定义由桥打 `/models` 再并上文件里的行）。 */
  async function fetchList() {
    if (!providerId) {
      setError(t("models.add.pickFirst"));
      return;
    }
    // 没填 key、这家又没存过 key = 一个 key 都没有：先说清楚，别白跑一趟（和 provider 弹窗同一条规则）。
    if (!apiKey.trim() && !provider?.authConfigured) {
      setError(t("models.add.noKeyFetch"));
      return;
    }
    setError("");
    setNotice("");
    setStatus("discovering");
    try {
      const result = await discoverProviderModels({ providerId, apiKey: apiKey.trim() || undefined });
      const list = result.models ?? [];
      setModels(list);
      syncSelection(list);
      if (result.warning) {
        setError(`${result.warning} ${t("models.add.warningSuffix", { count: list.length })}`);
      } else {
        setNotice(t("models.add.fetchedNotice", { count: list.length }));
      }
    } catch (discoverError) {
      setError(readableError(discoverError));
    } finally {
      setStatus("idle");
    }
  }

  /** 验证 API key 是否有效（留空 = 验已存的那份）。 */
  async function handleVerifyKey() {
    if (!providerId) {
      return;
    }
    setStatus("verifying");
    setKeyVerifyResult(null);
    try {
      const result = await verifyProviderKey(providerId, apiKey.trim());
      setKeyVerifyResult(
        result.ok
          ? { ok: true, message: `API key is valid (${result.models?.length ?? 0} models reported).` }
          : { ok: false, message: result.error || "Verification failed." },
      );
    } catch (verifyError) {
      setKeyVerifyResult({ ok: false, message: readableError(verifyError) });
    } finally {
      setStatus("idle");
    }
  }

  async function submit() {
    if (!providerId) {
      setError("Pick a provider first.");
      return;
    }
    if (!toAdd.length && !toRemove.length) {
      setError(t("models.add.selectAtLeastOne"));
      return;
    }
    const name = (provider?.name ?? providerId).trim();
    if (!name) {
      setError(t("models.add.nameRequired"));
      return;
    }

    setStatus("saving");
    setError("");
    try {
      let response: CustomModelsResponse | undefined;
      if (toAdd.length) {
        response = await addCustomModels({
          providerName: name,
          baseUrl: baseUrl.trim(),
          providerId,
          apiKey: apiKey.trim() || undefined,
          models: toAdd.map((model) => ({ model: catalogModelPayload(model) })),
        });
      }
      for (const entry of toRemove) {
        response = await removeCustomModel(entry.providerId, entry.model);
      }
      if (response) {
        onAdded(response);
      }
      onClose();
    } catch (saveError) {
      setError(readableError(saveError));
    } finally {
      setStatus("idle");
    }
  }

  return (
    <Dialog
      open={open || overlayOpen}
      onOpenChange={(next) => {
        if (next) {
          return;
        }
        // provider 弹窗开着时关掉的是那一层，不是本弹窗。
        if (overlayOpen) {
          onOverlayBack?.();
        } else {
          onClose();
        }
      }}
    >
      <DialogContent
        className="grid gap-5 sm:max-w-[620px]"
        // Radix 的 Escape 监听挂在 document 的捕获阶段，React 里 stopPropagation 拦不住它：
        // dropdown 开着时先让弹窗别关，收起动作交给下面输入框自己的 keydown。
        onEscapeKeyDown={(event) => {
          if (providerOpen) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("models.add.title")}</DialogTitle>
          <DialogDescription>
            {t("models.add.desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[62vh] gap-4 overflow-y-auto pr-1">
          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="add-model-provider-trigger" className="min-w-0 flex-1">
                {t("models.add.providerLabel")}
              </Label>
              {provider && canEditProvider ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 flex-none"
                  onClick={() => onRequestEditProvider(provider.id)}
                >
                  <Pencil size={13} />
                  {t("models.provider.editTitle")}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 flex-none"
                onClick={onRequestAddProvider}
              >
                <Plus size={13} />
                {t("models.provider.addTitle")}
              </Button>
            </div>
            {/* 供应商有 40+ 家，摊开太长；收成一个 dropdown，展开后第一排就是搜索。
                面板走 portal 定位：弹窗里那层 overflow-y-auto 会把绝对定位的面板裁掉。 */}
            <Popover open={providerOpen} onOpenChange={setProviderOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  id="add-model-provider-trigger"
                  ref={providerTriggerRef}
                  className="provider-picker-trigger"
                  aria-haspopup="listbox"
                  aria-expanded={providerOpen}
                  disabled={status === "loadingProviders"}
                >
                  <span className="provider-picker-trigger-name">
                    {status === "loadingProviders" ? t("models.add.loadingProviders") : provider?.name ?? t("models.add.selectProvider")}
                  </span>
                  <span className="provider-picker-trigger-meta">
                    {provider
                      ? t("models.add.providerMeta", { count: provider.modelCount, auth: provider.authConfigured ? t("models.add.keySaved") : t("models.add.noKey") })
                      : t("models.add.availableCount", { count: providers.length })}
                  </span>
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={6}
                collisionPadding={8}
                className="provider-picker-content w-(--radix-popover-trigger-width) max-w-(--radix-popover-content-available-width) p-0"
                // Escape 由我们自己收（同时 DialogContent 放行），别让两层各关一次。
                onEscapeKeyDown={(event) => event.preventDefault()}
              >
                <div className="provider-picker-body">
                  <div className="provider-picker-search">
                    <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      ref={providerSearchRef}
                      id="add-model-provider-search"
                      className="pl-7"
                      value={providerQuery}
                      placeholder={t("models.add.searchProviders", { count: providers.length })}
                      aria-label={t("models.add.searchProvidersAria")}
                      onChange={(event) => setProviderQuery(event.target.value)}
                      onKeyDown={onProviderSearchKeyDown}
                    />
                  </div>
                  <div className="provider-picker-list" role="listbox" aria-label={t("models.add.providersListAria")} ref={attachProviderListRef}>
                    {providerMatches.length ? providerMatches.map((row) => (
                      <button
                        key={row.id}
                        type="button"
                        role="option"
                        aria-selected={row.id === providerId}
                        data-provider-option
                        data-state={row.id === providerId ? "checked" : undefined}
                        className="provider-picker-row"
                        onClick={() => pickProvider(row)}
                        onKeyDown={onProviderOptionKeyDown}
                      >
                        <span className="provider-picker-name">{row.name}</span>
                        <span className="provider-picker-meta">
                          {t("models.add.providerMeta", { count: row.modelCount, auth: row.authConfigured ? t("models.add.keySaved") : t("models.add.noKey") })}
                          {row.registered ? t("models.add.inModelsJsonSuffix") : ""}
                        </span>
                      </button>
                    )) : (
                      <p className="provider-picker-empty">{t("models.add.noProviderMatch")}</p>
                    )}
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            {provider ? (
              <p className="provider-picker-current">
                {t("models.add.selectedPrefix")} <strong>{provider.name}</strong>
                <span className="provider-picker-url">{provider.baseUrl || t("models.builtInEndpoint")}</span>
              </p>
            ) : null}
            {provider && !provider.authConfigured && !(provider.authMethods ?? []).includes("apiKey") ? (
              <p className="text-xs text-muted-foreground">
                {t("models.add.authSignInHint")}
              </p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="add-model-key">{t("models.field.apiKey")}</Label>
            <div className="flex items-start gap-2">
              <ApiKeyField
                id="add-model-key"
                value={apiKey}
                onChange={(next) => {
                  setApiKey(next);
                  setKeyVerifyResult(null);
                }}
                savedConfigured={Boolean(provider?.authConfigured)}
                placeholder={t("models.placeholder.keyReplace")}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 flex-none"
                disabled={busy || !canVerifyKey}
                onClick={() => void handleVerifyKey()}
              >
                {status === "verifying" ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                {t("models.add.verifyKey")}
              </Button>
            </div>
            {keyVerifyResult ? (
              <p className={cn("text-xs", keyVerifyResult.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>
                {keyVerifyResult.message}
              </p>
            ) : null}
            {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
            {error ? (
              <p className="settings-card-error" role="alert">
                <AlertTriangle size={14} className="flex-none" />
                <span className="min-w-0 break-words">{error}</span>
              </p>
            ) : null}
          </div>

          {models.length || status === "discovering" || status === "loadingModels" ? (
            <div className="grid gap-2">
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {t("models.add.selectedCount", { selected: selected.length, total: models.length })}
                  {addedEntries.length ? t("models.add.alreadyInJsonCount", { count: addedEntries.length }) : ""}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 flex-none"
                  aria-label={t("models.add.fetchAria")}
                  title={t("models.add.fetchTitle")}
                  disabled={busy || !canRefresh}
                  onClick={() => void fetchList()}
                >
                  <RefreshCw size={13} className={cn(status === "discovering" && "animate-spin")} />
                  {t("models.add.refresh")}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-7"
                    value={query}
                    placeholder={t("models.add.searchModels", { count: models.length })}
                    aria-label={t("models.add.searchModelsAria")}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 flex-none"
                  onClick={() =>
                    setSelected(selected.length === filtered.length ? [] : filtered.map((model) => model.id))
                  }
                >
                  {selected.length === filtered.length ? t("models.add.clear") : t("models.add.selectAll")}
                </Button>
              </div>
              <ul className="add-model-options">
                {filtered.map((model) => {
                  const checked = selected.includes(model.id);
                  const already = addedIds.has(model.id);
                  return (
                    <li key={model.id}>
                      <label className="add-model-option">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) =>
                            setSelected((current) =>
                              next === true ? [...current, model.id] : current.filter((id) => id !== model.id),
                            )
                          }
                        />
                        <span className="min-w-0 flex-1">
                          <span className="add-model-title">
                            <span className="truncate">{model.name}</span>
                            {model.name !== model.id ? <span className="add-model-id">{model.id}</span> : null}
                            {already ? <span className="settings-row-chip">{t("models.add.inModelsJsonChip")}</span> : null}
                          </span>
                          <span className="settings-row-meta">
                            <span className="settings-row-chip">{t("models.row.context", { count: formatTokenCount(model.contextWindow) })}</span>
                            {model.reasoning ? <span className="settings-row-chip">{t("models.row.reasoning")}</span> : null}
                            {model.supportsImages ? <span className="settings-row-chip">{t("models.row.images")}</span> : null}
                          </span>
                        </span>
                        {checked ? <Check size={14} className="flex-none text-emerald-600" /> : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <span className="mr-auto self-center text-xs text-muted-foreground">
            {summaryLabel(toAdd.length, toRemove.length)}
          </span>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={busy || (!toAdd.length && !toRemove.length)} onClick={() => void submit()}>
            {status === "saving" ? <Loader2 size={14} className="animate-spin" /> : null}
            {toRemove.length ? t("models.add.applyChanges") : t("models.add.addSelected")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
