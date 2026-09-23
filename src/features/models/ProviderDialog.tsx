import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Plus, RefreshCw, Search, ShieldCheck, X } from "lucide-react";

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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useT } from "../../i18n/react";

import {
  API_TYPES,
  MODEL_ID_PATTERN,
  formatTokenCount,
  isHttpUrl,
  mergeListingInto,
  planModelChanges,
  prettifyModelId,
  staleListMessage,
  summaryLabel,
} from "./customModelForm";
import {
  addCustomModels,
  fetchProviderModels,
  listingModelPayload,
  removeCustomModel,
  testCustomModelConnection,
  updateProvider,
  verifyProviderKey,
} from "./customModelsApi";
import type { CustomModelsResponse, ModelListingEntry, ProviderModelOption } from "./customModelsApi";
import { ApiKeyField } from "./ApiKeyField";

/** 空列表项：没有比这更接近「我什么都不知道」的了。 */
const UNKNOWN_MODEL: Omit<ProviderModelOption, "id" | "name" | "api" | "baseUrl"> = {
  contextWindow: 0,
  maxTokens: 0,
  reasoning: false,
  supportsImages: false,
};

/**
 * 列表里的一行 + 它是怎么来的。
 *
 * 光看字段猜不出「这行是文件里已有的还是刚手填的」，而这两件事在 edit 模式下决定了
 * 提交时是加还是删，所以直接标在行上：`saved` = models.json 里已经有，
 * `listed` = 刚从端点拉回来，`manual` = 用户按名字加的。
 */
type ListedModel = ProviderModelOption & { origin: "saved" | "listed" | "manual" };

/**
 * 「添加 / 编辑 provider」弹窗：一家 OpenAI 兼容端点的身份（名字、地址、api 类型、key）+ 它名下的模型。
 *
 * 它叠在「添加模型」弹窗之上（`overlayOpen`），保存或取消后**退回添加模型弹窗**，
 * 不是把两层一起关掉：用户从那儿来，填完这家还想接着挑模型。
 *
 * 模型区在两种模式下都在：Refresh 去端点要一次列表、手填一个模型名、勾选、撤掉一行 ——
 * 改地址时顺手重拉一次列表是同一个动作的两半，不该逼用户关掉弹窗去别的地方再做一遍。
 * 拉列表要 key（框里没填、这家又没存过 key 就直接说“先填 key”，不白跑一趟）；
 * 拿不到列表时手填模型名那条路永远开着。
 *
 * - `add`：建新供应商。端点列表里拉回来的默认全勾上（这一家还没有任何模型，拉到的就是想要的），
 *   手填的行加进来即勾上。建新供应商必须有 key、至少一个模型。
 * - `edit`：改已有自定义供应商的 provider 级字段（名字 / 端点 / api 类型 / key），**并且**管它名下的模型：
 *   文件里已有的行一进来就是勾着的，取消勾选 = 保存时把那行删掉；Fetch 回来的新行**默认不勾**
 *   （网关动辄报几百个模型，只想改个名字的人不该被顺手全加进 models.json）。
 *   内置供应商不在此列（pi 自己管，只能改 key）。
 */
export function ProviderDialog({
  open,
  mode,
  providerId,
  overlayOpen = false,
  onBack,
  onClose,
  onSaved,
}: {
  open: boolean;
  mode: "add" | "edit";
  /** edit 模式要改的那家。 */
  providerId?: string;
  /** 底下还压着「添加模型」弹窗：保存/取消之后退回那里，而不是整个关掉。 */
  overlayOpen?: boolean;
  /** 退回上一层（添加模型弹窗）。没给就当直接关。 */
  onBack?: () => void;
  onClose: () => void;
  onSaved: (response: CustomModelsResponse) => void;
}) {
  const t = useT();
  const [providerName, setProviderName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiType, setApiType] = useState("openai-completions");
  const [apiKey, setApiKey] = useState("");
  const [savedKeyConfigured, setSavedKeyConfigured] = useState(false);
  const [models, setModels] = useState<ListedModel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  /** 打开时 models.json 里就有的那些模型：取消勾选/撤掉行 = 保存时删掉它们。 */
  const [savedModelIds, setSavedModelIds] = useState<string[]>([]);
  const [manualModel, setManualModel] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "discovering" | "saving" | "verifying">("idle");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [keyVerifyResult, setKeyVerifyResult] = useState<{ ok: boolean; message: string } | null>(null);
  /** 上一次拉列表失败的原因：成功后要把它从屏上撤掉，失败后要在提交时再顶出来一次。 */
  const fetchErrorRef = useRef("");
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const manualInputRef = useRef<HTMLInputElement | null>(null);

  const busy = status !== "idle";
  const base = baseUrl.trim();
  /** 地址填对了才谈得上拉列表；key 的门槛在 fetchModels 里（要说清原因，不能按着按钮不给反馈）。 */
  const canFetch = isHttpUrl(base);
  /** 框里没填、这家又没存过 key = 一个 key 都没有。 */
  const noKeyAtAll = !apiKey.trim() && !savedKeyConfigured;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return models;
    }
    return models.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(needle));
  }, [models, query]);
  const chosenModels = useMemo(() => models.filter((model) => selected.includes(model.id)), [models, selected]);
  /** 本次提交要写进文件的行 / 要从文件里删掉的行（口径见 planModelChanges）。 */
  const plan = useMemo(() => planModelChanges({
    savedIds: savedModelIds,
    listedIds: models.map((model) => model.id),
    selectedIds: selected,
  }), [savedModelIds, models, selected]);
  const toAdd = useMemo(() => models.filter((model) => plan.toAdd.includes(model.id)), [models, plan]);
  const toRemove = plan.toRemove;
  /** 把这家最后一条模型也删了 = 整个供应商会跟着消失，得先说清楚。 */
  const removesWholeProvider = mode === "edit" && plan.removesEverything;
  const manualTrimmed = manualModel.trim();
  const manualDuplicated = Boolean(manualTrimmed) && models.some((model) => model.id === manualTrimmed);
  const manualInvalid = Boolean(manualTrimmed) && !MODEL_ID_PATTERN.test(manualTrimmed);

  // 打开时：edit 模式先把这家的现值读进来（桥是唯一真相，不在前端缓存）；add 模式是干净一张表。
  useEffect(() => {
    if (!open) {
      setProviderName("");
      setBaseUrl("");
      setApiType("openai-completions");
      setApiKey("");
      setSavedKeyConfigured(false);
      setModels([]);
      setSelected([]);
      setSavedModelIds([]);
      setManualModel("");
      setQuery("");
      setNotice("");
      setError("");
      setKeyVerifyResult(null);
      setStatus("idle");
      fetchErrorRef.current = "";
      return;
    }
    if (mode !== "edit" || !providerId) {
      requestAnimationFrame(() => nameInputRef.current?.focus());
      return;
    }
    let cancelled = false;
    setStatus("loading");
    void fetchProviderModels(providerId)
      .then((row) => {
        if (cancelled) {
          return;
        }
        setProviderName(row.name ?? "");
        setBaseUrl(row.baseUrl ?? "");
        setApiType(row.api || row.models?.[0]?.api || "openai-completions");
        setSavedKeyConfigured(Boolean(row.authConfigured));
        // 已存的 key 回填进框里（默认密文，眼睛切明文）：用户要的是“看得见这里有没有 key、
        // 现在用的是哪个”，不是对着一个空框猜。原样发回去 = 写回同一个值，无副作用。
        setApiKey(row.apiKey ?? "");
        // 文件里已有的行列出来，默认全勾着（勾着 = 保留），取消勾选就是要把这行删掉。
        const list = (row.models ?? []).map((model) => ({ ...model, origin: "saved" as const }));
        setModels(list);
        setSavedModelIds(list.map((model) => model.id));
        setSelected(list.map((model) => model.id));
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(readableError(loadError));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setStatus("idle");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode, providerId]);

  /** 端点报回来的一行 → 列表项。缺的信息用当前表单的值兜底。 */
  function listingToOption(entry: ModelListingEntry): ListedModel {
    return {
      id: entry.id,
      name: entry.name || prettifyModelId(entry.id),
      api: entry.api || apiType,
      baseUrl: entry.baseUrl || base,
      contextWindow: entry.contextWindow ?? 0,
      maxTokens: entry.maxTokens ?? 0,
      reasoning: Boolean(entry.reasoning),
      supportsImages: Array.isArray(entry.input) ? entry.input.includes("image") : false,
      origin: "listed",
    };
  }

  /** 手填的那一行：端点只报 id 时也只有 id 可给，上下文/模态由桥按默认值补。 */
  function manualOption(id: string): ListedModel {
    return { id, name: prettifyModelId(id), ...UNKNOWN_MODEL, api: apiType, baseUrl: base, origin: "manual" };
  }

  /**
   * 把**这一轮新出现**的行补进勾选。
   *
   * 只补新的：已经在屏上的行留着用户刚才自己勾/取消的结果 —— 否则「取消勾选一条要删的」
   * 之后手一抖再 Fetch 一次，勾选就被悄悄恢复了。edit 模式下新行也不自动勾：
   * 网关一次报几百个模型，只想改个名字的人不该被顺手全加进文件。
   */
  function selectNewRows(list: ListedModel[], previousIds: Set<string>) {
    if (mode !== "add") {
      return;
    }
    setSelected((current) => Array.from(new Set([
      ...current,
      ...list.filter((model) => !previousIds.has(model.id)).map((model) => model.id),
    ])));
  }

  /** 打端点自己的列表接口：URL 与鉴权头按 api 类型分派。 */
  async function fetchModels() {
    const typedModel = manualTrimmed;
    fetchErrorRef.current = "";
    setError("");
    setNotice("");
    if (!canFetch) {
      setError(t("models.provider.badBaseUrl"));
      return;
    }
    if (noKeyAtAll) {
      setError(t("models.add.noKeyFetch") + t("models.provider.orAddByName"));
      return;
    }
    setStatus("discovering");
    try {
      const result = await testCustomModelConnection({
        baseUrl: base,
        // providerId 带上：没填 key 时桥会退到这家已存的那一份（编辑场景下 key 本来就在文件里）。
        providerId: mode === "edit" ? providerId : undefined,
        apiKey: apiKey.trim(),
        api: apiType,
        model: typedModel || undefined,
      });
      if (!result.ok) {
        const reason = result.error || t("models.provider.endpointRejected");
        fetchErrorRef.current = reason;
        setError(`${reason} ${t("models.provider.fixAndRetry")}`);
        setNotice(
          models.length
            ? t("models.provider.staleScreenList", { count: models.length })
            : t("models.provider.nothingToSave"),
        );
        return;
      }
      const incoming = (result.listing?.length
        ? result.listing.map((entry) => listingToOption(entry))
        : (result.models ?? []).map((id) => listingToOption({ id })));
      const previousIds = new Set(models.map((model) => model.id));
      const list = mergeListingInto(models, incoming);
      setModels(list);
      selectNewRows(list, previousIds);
      setManualModel("");
      const added = list.length - models.length;
      setNotice(
        !added
          ? t("models.provider.fetchedUnchanged", { count: list.length })
          : mode === "add"
            ? t("models.provider.fetchedAllSelected", { count: list.length, added })
            : t("models.provider.fetchedPick", { count: list.length, added }),
      );
    } catch (fetchError) {
      const reason = readableError(fetchError);
      fetchErrorRef.current = reason;
      setError(`${reason} ${t("models.provider.fixAndRetry")}`);
    } finally {
      setStatus("idle");
    }
  }

  /** 手填模型名 → 进列表并勾上。端点不实现 `/models` 时这是唯一入口，所以要有显式反馈。 */
  function addManualModel() {
    const id = manualTrimmed;
    if (!id) {
      setError(t("models.provider.typeModelName"));
      return;
    }
    if (!MODEL_ID_PATTERN.test(id)) {
      setError(t("models.provider.modelNamePattern"));
      return;
    }
    if (models.some((model) => model.id === id)) {
      setError(t("models.provider.alreadyInList", { id }));
      return;
    }
    setError("");
    setNotice(t("models.provider.addedManually", { id }));
    const next = [...models, manualOption(id)];
    setModels(next);
    setSelected((current) => [...current, id]);
    setManualModel("");
    requestAnimationFrame(() => manualInputRef.current?.focus());
  }

  /** 从列表里撤掉一行（手填点错了、拉回来一堆不想要的、或就是要删这家的一条模型）。 */
  function dropModel(id: string) {
    const rest = models.filter((model) => model.id !== id);
    setModels(rest);
    setSelected((current) => current.filter((modelId) => modelId !== id));
    // 上一轮拉取失败过：那句「哪些照常生效」还成立，优先留着它；否则说清这一行撤掉之后会发生什么。
    if (fetchErrorRef.current) {
      setNotice(staleListMessage({ error: fetchErrorRef.current, list: rest }) ?? "");
      return;
    }
    setNotice(savedModelIds.includes(id)
      ? t("models.provider.savedRowWarning", { id })
      : "");
  }

  /** 验 key：留空就验已存的那份。 */
  async function handleVerifyKey() {
    if (mode !== "edit" || !providerId) {
      return;
    }
    setStatus("verifying");
    setKeyVerifyResult(null);
    try {
      const result = await verifyProviderKey(providerId, apiKey.trim());
      setKeyVerifyResult(
        result.ok
          ? { ok: true, message: t("models.provider.keyValid", { count: result.models?.length ?? 0 }) }
          : { ok: false, message: result.error || t("models.provider.verifyFailed") },
      );
    } catch (verifyError) {
      setKeyVerifyResult({ ok: false, message: readableError(verifyError) });
    } finally {
      setStatus("idle");
    }
  }

  async function submit() {
    const name = providerName.trim();
    if (!name) {
      setError(t("models.add.nameRequired"));
      return;
    }
    if (!isHttpUrl(base)) {
      setError(t("models.provider.badBaseUrl"));
      return;
    }
    if (mode === "add") {
      // 建新供应商必须同时有 key 和至少一个模型：二者缺一，落盘后这家什么都干不了。
      if (!apiKey.trim()) {
        setError(t("models.provider.keyRequired"));
        return;
      }
      if (!chosenModels.length) {
        setError(fetchErrorRef.current
          ? t("models.provider.noListAddByName", { error: fetchErrorRef.current })
          : t("models.provider.selectOrType"));
        return;
      }
    }
    if (mode === "edit" && providerId) {
      // 桥对自定义端点从来不允许“没 key”：一家从未存过 key 的供应商，在这里加模型会被它拒掉。
      // 与其让用户对着一句“API key is required.”猜，不如在发请求前说清楚。
      if (toAdd.length && !apiKey.trim() && !savedKeyConfigured) {
        setError(t("models.provider.noKeyBeforeAdd"));
        return;
      }
    }
    setStatus("saving");
    setError("");
    try {
      if (mode === "edit" && providerId) {
        // 先改 provider（地址/名字/api），再按新地址加模型：桥认不认得到同一家，看的就是 baseUrl 对不对得上。
        let response = await updateProvider({
          providerId,
          name,
          baseUrl: base,
          api: apiType,
          apiKey: apiKey.trim() || undefined,
        });
        if (toAdd.length) {
          response = await addCustomModels({
            providerName: name,
            baseUrl: base,
            providerId,
            // 留空 = 沿用已存的那一份 key，加模型这步不该再逼用户输一遍。
            apiKey: apiKey.trim() || undefined,
            models: toAdd.map((model) => ({ model: listingModelPayload(model) })),
          });
        }
        for (const modelId of toRemove) {
          response = await removeCustomModel(providerId, modelId);
        }
        onSaved(response);
      } else {
        const response = await addCustomModels({
          providerName: name,
          baseUrl: base,
          apiKey: apiKey.trim(),
          models: chosenModels.map((model) => ({ model: listingModelPayload(model) })),
        });
        onSaved(response);
      }
      // 底下压着「添加模型」弹窗时退回那里；单独打开时才是真的关闭。
      if (onBack && overlayOpen) {
        onBack();
      } else {
        onClose();
      }
    } catch (saveError) {
      setError(readableError(saveError));
    } finally {
      setStatus("idle");
    }
  }

  /** 退回上一层。没压着别的东西时就是关闭。 */
  function back() {
    if (onBack && overlayOpen) {
      onBack();
    } else {
      onClose();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          back();
        }
      }}
    >
      <DialogContent
        className="grid gap-5 sm:max-w-[560px]"
        // 底下那层「添加模型」弹窗在 Escape 时也活着：这里放行，别一次关掉两层。
        onEscapeKeyDown={(event) => {
          if (overlayOpen) {
            event.preventDefault();
            back();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{mode === "edit" ? t("models.provider.editTitle") : t("models.provider.addTitle")}</DialogTitle>
          <DialogDescription>
            {mode === "edit"
              ? t("models.provider.editDesc")
              : t("models.provider.addDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[62vh] gap-4 overflow-y-auto pr-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="provider-name">{t("models.field.providerName")}</Label>
              <Input
                id="provider-name"
                ref={nameInputRef}
                value={providerName}
                placeholder={t("models.placeholder.providerName")}
                onChange={(event) => setProviderName(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="provider-base-url">{t("models.field.baseUrl")}</Label>
              <Input
                id="provider-base-url"
                value={baseUrl}
                placeholder="https://api.example.com/v1"
                autoComplete="off"
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="provider-api">{t("models.provider.apiType")}</Label>
              <Select value={apiType} onValueChange={setApiType}>
                <SelectTrigger id="provider-api" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {API_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {t(type.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="provider-key">{t("models.field.apiKey")}</Label>
            <div className="flex items-start gap-2">
              <ApiKeyField
                id="provider-key"
                value={apiKey}
                onChange={(next) => {
                  setApiKey(next);
                  setKeyVerifyResult(null);
                }}
                savedConfigured={savedKeyConfigured}
                placeholder={mode === "edit" ? t("models.placeholder.keyReplace") : t("models.provider.keyPlaceholder")}
              />
              {mode === "edit" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 flex-none"
                  disabled={busy}
                  onClick={() => void handleVerifyKey()}
                >
                  {status === "verifying" ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                  {t("models.add.verifyKey")}
                </Button>
              ) : null}
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

          {/* 模型区常驻：以前它只在拉到列表后才出现，于是「Fetch 失败」=「这一栏整个没了」，
              用户既看不到手填的入口，也看不到已经配好的行，就以为这个弹窗干不了这事。 */}
          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <Label className="min-w-0 flex-1" htmlFor="provider-model-search">
                {t("models.provider.modelsLabel")}
              </Label>
              {/* 就一颗 Refresh：它和刚才那颗「Fetch models」调的是同一个函数，留两个入口只会让人
                  纠结“这两颗有什么不一样”。disabled 只看 busy —— 地址没填对、key 没填，都要点了给话，
                  按成灰的等于把原因咽回去。 */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 flex-none"
                aria-label={t("models.add.fetchAria")}
                title={t("models.add.fetchTitle")}
                disabled={busy}
                onClick={() => void fetchModels()}
              >
                {status === "discovering"
                  ? <Loader2 size={13} className="animate-spin" />
                  : <RefreshCw size={13} />}
                {t("models.add.refresh")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {mode === "edit"
                ? t("models.provider.editSelectedCount", { selected: selected.length, total: models.length, saved: savedModelIds.length })
                : models.length
                  ? t("models.add.selectedCount", { selected: selected.length, total: models.length }) + "."
                  : t("models.provider.emptyListModel")}
              {mode === "add" && noKeyAtAll ? " " + t("models.provider.enterKeyToFetch") : ""}
            </p>

            {models.length || status === "discovering" ? (
              <>
                <div className="flex items-center gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="provider-model-search"
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
                    onClick={() => setSelected(selected.length === filtered.length ? [] : filtered.map((model) => model.id))}
                  >
                    {selected.length === filtered.length ? t("models.add.clear") : t("models.add.selectAll")}
                  </Button>
                </div>
                <ul className="add-model-options">
                  {filtered.map((model) => {
                    const checked = selected.includes(model.id);
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
                            </span>
                            <span className="settings-row-meta">
                              <span className="settings-row-chip">{t("models.row.context", { count: formatTokenCount(model.contextWindow) })}</span>
                              {model.reasoning ? <span className="settings-row-chip">{t("models.row.reasoning")}</span> : null}
                              {model.supportsImages ? <span className="settings-row-chip">{t("models.row.images")}</span> : null}
                              {model.origin === "saved" ? <span className="settings-row-chip">{t("models.add.inModelsJsonChip")}</span> : null}
                              {model.origin === "manual" ? <span className="settings-row-chip">{t("models.provider.addedByNameChip")}</span> : null}
                            </span>
                          </span>
                          {checked ? <Check size={14} className="flex-none text-emerald-600" /> : null}
                          <button
                            type="button"
                            aria-label={t("models.provider.removeRowAria", { id: model.id })}
                            title={model.origin === "saved" ? t("models.provider.removeSavedRow") : t("models.provider.removeRow")}
                            className="provider-model-remove"
                            onClick={(event) => {
                              // 它在 <label> 里：不拦住这一下会连带把勾选取消一遍。
                              event.preventDefault();
                              event.stopPropagation();
                              dropModel(model.id);
                            }}
                          >
                            <X size={13} />
                          </button>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
            {removesWholeProvider ? (
              <p className="settings-card-error" role="alert">
                <AlertTriangle size={14} className="flex-none" />
                <span className="min-w-0 break-words">
                  {t("models.provider.removesWholeProvider", { name: providerName.trim() || t("models.provider.thisProvider") })}
                </span>
              </p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="provider-manual">{t("models.provider.addByNameLabel")}</Label>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  id="provider-manual"
                  ref={manualInputRef}
                  value={manualModel}
                  placeholder="qwen3.7-plus"
                  autoComplete="off"
                  aria-invalid={manualInvalid || manualDuplicated}
                  onChange={(event) => setManualModel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      // 回车即加一条；表单的默认提交不该把弹窗整个交出去。
                      event.preventDefault();
                      addManualModel();
                    }
                  }}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 flex-none"
                disabled={busy || !manualTrimmed || manualInvalid || manualDuplicated}
                onClick={addManualModel}
              >
                <Plus size={14} />
                {t("models.provider.add")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {manualInvalid
                ? t("models.provider.modelNamePattern")
                : manualDuplicated
                  ? t("models.provider.duplicateHint")
                  : mode === "edit"
                    ? t("models.provider.manualEditHint")
                    : t("models.provider.manualAddHint")}
            </p>
          </div>
        </div>

        <DialogFooter>
          <span className="mr-auto self-center text-xs text-muted-foreground">
            {mode === "edit"
              ? toAdd.length || toRemove.length
                ? t("models.provider.footerWithChanges", { summary: summaryLabel(toAdd.length, toRemove.length) })
                : t("models.provider.footerSettingsOnly")
              : t("models.provider.footerWillSave", { count: selected.length })}
          </span>
          {/* 文案统一 Cancel：它本来就是“关掉这一层”，行为（退回 Add model 还是整个关闭）由 overlayOpen 决定，
              不需要在按钮上再讲一遍弹窗栈的故事。 */}
          <Button type="button" variant="outline" onClick={back} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={busy} onClick={() => void submit()}>
            {status === "saving" ? <Loader2 size={14} className="animate-spin" /> : null}
            {mode === "edit" ? (toAdd.length || toRemove.length ? t("models.add.applyChanges") : t("models.provider.saveChanges")) : t("models.provider.addTitle")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
