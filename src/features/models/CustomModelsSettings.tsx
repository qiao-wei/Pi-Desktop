import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Cloud,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { loadUiPreferences, saveUiPreferences } from "@/lib/ui-preferences";
import { useT } from "../../i18n/react";

import {
  costRateErrorKey,
  costThresholdErrorKey,
  draftFromEntry,
  emptyCostDraft,
  emptyThinkingLevels,
  formatTokenCount,
  groupCustomEntriesByProvider,
  MAX_PRICE_TIERS,
  newCostTier,
  PRICE_FIELDS,
  priceSummary,
  THINKING_LEVELS,
  validateDraft,
} from "./customModelForm";
import type { CustomEntryGroup, ThinkingLevel } from "./customModelForm";
import {
  fetchProviderModels,
  reloadCustomModels,
  removeCustomModel,
  saveCustomModel,
  saveProviderApiKey,
  testCustomModelConnection,
} from "./customModelsApi";
import type { CostDraft, CostTierDraft, CustomModelDraft, CustomModelEntry, CustomModelsResponse } from "./customModelsApi";
import type { CustomModelsController } from "./useCustomModels";
import { AddModelsDialog } from "./AddModelsDialog";
import { ProviderDialog } from "./ProviderDialog";
import { ApiKeyField } from "./ApiKeyField";

/**
 * 设置 → 模型：手动添加自定义模型（OpenAI 兼容端点）。
 *
 * 数据全部由桥读写 `~/.pi/agent/models.json`，这里只是一个编辑器：打开时拉一次，
 * 保存/删除后再拉一次，不在前端留副本。
 */
export function CustomModelsSettings({
  models,
  onModelsChanged,
}: {
  /** `useCustomModels()` 的返回值：设置页和输入框旁共用一份数据。 */
  models: CustomModelsController;
  /** 保存/删除成功后通知外面：可用模型列表（bootstrap）要刷新。 */
  onModelsChanged?: () => void;
}) {
  const t = useT();
  const { entries, modelsPath, loading, error: loadError, apply } = models;
  const [status, setStatus] = useState<"idle" | "saving" | "removing">("idle");
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<CustomModelDraft | null>(null);
  const [adding, setAdding] = useState(false);
  // 弹窗栈：`adding` 是底，`providerDialog` 是压在上面的那一层。两层都在时只渲染上面那层，
  // 关掉上面那层就退回「Add model」，而不是一口气把整个设置流程关掉。
  const [providerDialog, setProviderDialog] = useState<{ mode: "add" | "edit"; providerId?: string } | null>(null);
  const [providerHost, setProviderHost] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<CustomModelEntry | null>(null);
  /** 组头的 Add / Edit 要把 Add model 弹窗带到哪一家；null = 普通打开（自己挑供应商）。 */
  const [pickerProviderId, setPickerProviderId] = useState<string | null>(null);
  // 删整家（组头的 Delete）要二次确认：一按就抹掉这一家所有模型行。
  const [pendingGroupRemoval, setPendingGroupRemoval] = useState<CustomEntryGroup | null>(null);
  // 内置供应商的模型行不能改（改了就是把内置目录整条盖掉），只能换 key。
  const [keyTarget, setKeyTarget] = useState<CustomModelEntry | null>(null);
  const [keyValue, setKeyValue] = useState("");
  const [keyError, setKeyError] = useState("");
  /** 回填 key 是异步的：拿 ref 记住「这会儿开着的是哪家/哪条」，迟到的响应别塞错地方。 */
  const keyTargetRef = useRef<CustomModelEntry | null>(null);
  const draftRef = useRef<CustomModelDraft | null>(null);

  /**
   * 取这家已存的明文 key，用来回填输入框（桥只在「单家详情」口给，供应商列表口不带）。
   * 拿不到就返回空串 —— 宁可让框空着要人填，也不要在里面画一串假圆点糊弄眼睛图标。
   */
  async function loadStoredKey(providerId: string): Promise<string> {
    try {
      return (await fetchProviderModels(providerId)).apiKey ?? "";
    } catch {
      return "";
    }
  }

  /** 内置供应商：只能改 key。开窗时顺手把已存的那份填回框里（密文，眼睛切明文）。 */
  function openKeyDialog(entry: CustomModelEntry) {
    setKeyError("");
    setKeyValue("");
    setKeyTarget(entry);
    keyTargetRef.current = entry;
    void loadStoredKey(entry.providerId).then((key) => {
      if (!key || keyTargetRef.current?.providerId !== entry.providerId) {
        return;
      }
      setKeyValue((current) => (current.trim() ? current : key));
    });
  }

  /** 自定义模型行：整条可编辑，key 也填回来（「Test connection」不再需要先手打一遍 key）。 */
  function openModelDraft(entry: CustomModelEntry) {
    const base = draftFromEntry(entry);
    setDraft(base);
    draftRef.current = base;
    void loadStoredKey(entry.providerId).then((key) => {
      if (!key) {
        return;
      }
      setDraft((current) => (current
        && current.targetProviderId === base.targetProviderId
        && current.targetModel === base.targetModel
        && !current.apiKey.trim()
        ? { ...current, apiKey: key }
        : current));
    });
  }

  const managed = useMemo(() => entries.filter((entry) => entry.managed && entry.model), [entries]);
  const groups = useMemo(() => groupCustomEntriesByProvider(managed), [managed]);

  // 折叠状态跟着 UI 偏好走（localStorage），重开设置页/重启应用都保持；key = provider id。
  const [collapsedProviders, setCollapsedProviders] = useState<string[]>(() => loadUiPreferences().modelsCollapsedProviderIds ?? []);

  function toggleProviderCollapsed(providerId: string) {
    setCollapsedProviders((current) => {
      const next = current.includes(providerId)
        ? current.filter((id) => id !== providerId)
        : [...current, providerId];
      saveUiPreferences({ modelsCollapsedProviderIds: next });
      return next;
    });
  }

  /**
   * 开 provider 弹窗：先记下「谁压着谁」再决定关闭时退回哪儿。
   *
   * 底下有「Add model」弹窗时，provider 弹窗保存/取消后退回那里；从别的入口（没有底）打开时就是关闭。
   * `providerHost` 在开窗**当时**定下，不靠渲染时的 `adding`（开窗后底下那层渲染上会进短暂空档，
   * 拿它当依据会把「回到 Add model」误判成「整个关掉」）。
   */
  function openAddProvider(next: { mode: "add" | "edit"; providerId?: string } = { mode: "add" }) {
    setProviderHost(adding);
    setProviderDialog(next);
  }

  /**
   * 重读 models.json（含 pi 的 runtime），再刷一遍可用模型列表。
   * 手改过文件才需要 —— 应用自己的保存/删除已经把两边都同步好了。
   */
  async function handleReloadModels() {
    setReloading(true);
    setError("");
    try {
      apply(await reloadCustomModels());
      onModelsChanged?.();
    } catch (reloadError) {
      setError(readableError(reloadError));
    } finally {
      setReloading(false);
    }
  }

  async function handleSave(next: CustomModelDraft) {
    setStatus("saving");
    setError("");
    try {
      apply(await saveCustomModel(next));
      setDraft(null);
      draftRef.current = null;
      onModelsChanged?.();
    } catch (saveError) {
      setError(readableError(saveError));
    } finally {
      setStatus("idle");
    }
  }

  /** 开「Add model」弹窗，并选中这家供应商（组头的 Add / Edit 都走这里）。 */
  function openModelPicker(providerId: string) {
    setPickerProviderId(providerId);
    setAdding(true);
  }

  /** 删掉一家：逐条删它的模型行，最后一条删完时桥会把整个供应商一起收走。 */
  async function handleRemoveGroup(group: CustomEntryGroup) {
    setStatus("removing");
    setError("");
    setPendingGroupRemoval(null);
    try {
      let response: CustomModelsResponse | undefined;
      for (const entry of group.entries) {
        response = await removeCustomModel(entry.providerId, entry.model);
      }
      if (response) {
        apply(response);
      }
      onModelsChanged?.();
    } catch (removeError) {
      setError(readableError(removeError));
    } finally {
      setStatus("idle");
    }
  }

  async function handleRemove(entry: CustomModelEntry) {
    setStatus("removing");
    setError("");
    setPendingRemoval(null);
    try {
      apply(await removeCustomModel(entry.providerId, entry.model));
      onModelsChanged?.();
    } catch (removeError) {
      setError(readableError(removeError));
    } finally {
      setStatus("idle");
    }
  }

  async function handleSaveKey() {
    if (!keyTarget) {
      return;
    }
    const key = keyValue.trim();
    if (!key) {
      setKeyError("API key is required.");
      return;
    }
    setStatus("saving");
    setKeyError("");
    try {
      apply(await saveProviderApiKey(keyTarget.providerId, key));
      setKeyTarget(null);
      keyTargetRef.current = null;
      setKeyValue("");
      onModelsChanged?.();
    } catch (saveError) {
      setKeyError(readableError(saveError));
    } finally {
      setStatus("idle");
    }
  }

  const shownError = loadError || error;

  return (
    <div className="grid gap-4">
      <section className="settings-card">
        <header className="settings-card-header">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{t("models.settings.title")}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("models.settings.descriptionA")}{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[0.7rem]">{modelsPath}</code>{t("models.settings.descriptionB")}
            </p>
          </div>
          <div className="flex flex-none items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void handleReloadModels()}
              disabled={status !== "idle" || reloading}
              aria-label={t("models.reload")}
              title={t("models.reload")}
            >
              <RefreshCw className={cn((loading || reloading) && "animate-spin")} />
            </Button>
            {/* 「Add provider」不在这里：它只是加模型路上的一步，入口在 Add model 弹窗里。 */}
            <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus size={14} />
              Add model
            </Button>
          </div>
        </header>

        <div className="settings-card-body">
          {loading && !managed.length ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="animate-spin" size={14} />
              {t("models.loading")}
            </p>
          ) : groups.length ? (
            <div className="settings-groups">
              {groups.map((group) => (
                <section key={group.providerId} className="settings-group">
                  <header className="settings-group-header">
                    {/* 整条 provider 栏就是折叠开关：点名字/地址/模型数都能收起来，右侧动作按钮不受影响。 */}
                    <button
                      type="button"
                      className="settings-group-toggle"
                      aria-expanded={!collapsedProviders.includes(group.providerId)}
                      aria-label={collapsedProviders.includes(group.providerId)
                        ? t("models.row.expandGroupAria", { name: group.providerName })
                        : t("models.row.collapseGroupAria", { name: group.providerName })}
                      title={collapsedProviders.includes(group.providerId)
                        ? t("models.row.expandGroupTitle")
                        : t("models.row.collapseGroupTitle")}
                      onClick={() => toggleProviderCollapsed(group.providerId)}
                    >
                      {collapsedProviders.includes(group.providerId)
                        ? <span className="settings-group-chevron"><ChevronRight size={14} /></span>
                        : <span className="settings-group-chevron"><ChevronDown size={14} /></span>}
                      <span className="settings-group-name">{group.providerName}</span>
                      <span className="settings-group-meta">
                        <span className="settings-group-url">{group.baseUrl || t("models.builtInEndpoint")}</span>
                        <span className="settings-group-count">
                          · {t("models.modelCount", { count: group.entries.length })}
                        </span>
                      </span>
                    </button>
                    {/* 每一家两个动作：Edit 进「Add model」弹窗并选好这一家（加模型、改供应商都在那一屏，
                        所以这里不再单独放一颗 Add）；Delete 删这一家的全部模型行，确认走下面的应用内弹窗。 */}
                    <span className="settings-group-actions">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("models.row.editGroupAria", { name: group.providerName })}
                        title={t("models.row.editGroupTitle")}
                        disabled={status !== "idle"}
                        onClick={() => openModelPicker(group.providerId)}
                      >
                        <Pencil size={14} />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("models.row.deleteGroupAria", { name: group.providerName })}
                        title={t("models.row.deleteProviderTitle")}
                        disabled={status !== "idle"}
                        onClick={() => setPendingGroupRemoval(group)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </span>
                  </header>
                  {collapsedProviders.includes(group.providerId) ? null : (
                  <ul className="settings-list">
                    {group.entries.map((entry) => (
                <li
                  key={`${entry.providerId}/${entry.model}`}
                  className="settings-row"
                >
                  <Cloud size={16} className="flex-none text-sky-600" />
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-sm font-medium">{entry.modelLabel || entry.model}</span>
                      {entry.modelLabel && entry.modelLabel !== entry.model ? (
                        <span className="settings-row-id">{entry.model}</span>
                      ) : null}
                    </p>
                    <p className="settings-row-meta">
                      <span className="settings-row-chip">{t("models.row.context", { count: formatTokenCount(entry.contextWindow) })}</span>
                      {entry.reasoning ? <span className="settings-row-chip">{t("models.row.reasoning")}</span> : null}
                      {entry.supportsImages ? <span className="settings-row-chip">{t("models.row.images")}</span> : null}
                      {priceSummary(entry.cost) ? (
                        <span className="settings-row-chip">{priceSummary(entry.cost)}</span>
                      ) : null}
                    </p>
                  </div>
                  {!entry.apiKeyConfigured ? (
                    <span className="settings-row-flag">{t("models.row.noApiKey")}</span>
                  ) : entry.available ? null : (
                    <span className="settings-row-flag">{t("models.row.notLoaded")}</span>
                  )}
                  {/* 删除确认统一在应用内弹窗里，行内只留 Edit / Delete 两颗图标按钮。 */}
                  <span className="flex flex-none items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={entry.builtin
                          ? t("models.row.editKeyAria", { name: entry.providerName })
                          : t("models.row.editAria", { name: entry.providerName, model: entry.modelLabel })}
                        title={entry.builtin ? t("models.row.editKeyTitle") : t("models.row.editTitle")}
                        disabled={status !== "idle"}
                        onClick={() => {
                          if (entry.builtin) {
                            openKeyDialog(entry);
                          } else {
                            openModelDraft(entry);
                          }
                        }}
                      >
                        <Pencil size={14} />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("models.row.deleteAria", { name: entry.providerName, model: entry.modelLabel })}
                        title={t("models.row.deleteTitle")}
                        disabled={status !== "idle"}
                        onClick={() => setPendingRemoval(entry)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </span>
                </li>
                    ))}
                  </ul>
                  )}
                </section>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("models.noModels")}
            </p>
          )}

          {shownError ? (
            <p className="settings-card-error" role="alert">
              <AlertTriangle size={14} className="flex-none" />
              <span className="min-w-0 break-words">{shownError}</span>
            </p>
          ) : null}
        </div>
      </section>

      <AddModelsDialog
        initialProviderId={pickerProviderId ?? ""}
        open={adding && !providerDialog}
        overlayOpen={Boolean(adding && providerDialog)}
        onOverlayBack={() => setProviderDialog(null)}
        entries={managed}
        onClose={() => {
          setAdding(false);
          setPickerProviderId(null);
        }}
        onRequestAddProvider={openAddProvider}
        onRequestEditProvider={(providerId) => openAddProvider({ mode: "edit", providerId })}
        onAdded={(response) => {
          apply(response);
          onModelsChanged?.();
        }}
      />

      <ProviderDialog
        open={Boolean(adding && providerDialog)}
        mode={providerDialog?.mode ?? "add"}
        providerId={providerDialog?.providerId}
        overlayOpen={providerHost}
        onBack={() => {
          setProviderHost(false);
          setProviderDialog(null);
        }}
        onClose={() => {
          setProviderDialog(null);
          setProviderHost(false);
          setAdding(false);
        }}
        onSaved={(response) => {
          apply(response);
          onModelsChanged?.();
        }}
      />

      {/* 删除确认：以前是就地换成「Confirm delete / Cancel」两颗按钮，组头会跟着忽长忽短，
          也说不清要删几条、删哪个文件；改成弹窗，把后果写在里面。 */}
      <Dialog
        open={Boolean(pendingGroupRemoval || pendingRemoval)}
        onOpenChange={(next) => {
          if (!next) {
            setPendingGroupRemoval(null);
            setPendingRemoval(null);
          }
        }}
      >
        <DialogContent className="grid gap-4 sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>
              {pendingGroupRemoval
                ? t("models.delete.groupTitle", { name: pendingGroupRemoval.providerName, count: pendingGroupRemoval.entries.length })
                : t("models.delete.entryTitle", { name: pendingRemoval?.modelLabel || (pendingRemoval?.model ?? "") })}
            </DialogTitle>
            <DialogDescription>
              {pendingGroupRemoval
                ? t("models.delete.groupDesc", { name: pendingGroupRemoval.providerName, count: pendingGroupRemoval.entries.length, path: modelsPath })
                : t("models.delete.entryDesc", { name: pendingRemoval?.providerName ?? "", model: pendingRemoval?.model ?? "", path: modelsPath })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setPendingGroupRemoval(null);
                setPendingRemoval(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={status !== "idle"}
              onClick={() => {
                if (pendingGroupRemoval) {
                  void handleRemoveGroup(pendingGroupRemoval);
                } else if (pendingRemoval) {
                  void handleRemove(pendingRemoval);
                }
              }}
            >
              {status === "removing" ? t("models.delete.deleting") : t("models.delete.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(keyTarget)}
        onOpenChange={(next) => {
          if (!next) {
            setKeyTarget(null);
            keyTargetRef.current = null;
            setKeyValue("");
            setKeyError("");
          }
        }}
      >
        <DialogContent className="grid gap-4 sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>{t("models.apiKey.title", { name: keyTarget?.providerName ?? "" })}</DialogTitle>
            <DialogDescription>
              {t("models.apiKey.builtinDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="provider-key-input">{t("models.field.apiKey")}</Label>
            <ApiKeyField
              id="provider-key-input"
              value={keyValue}
              onChange={setKeyValue}
              savedConfigured={Boolean(keyTarget?.apiKeyConfigured)}
              placeholder={t("models.apiKey.placeholder")}
            />
            {keyTarget && !keyTarget.apiKeyConfigured ? (
              <p className="text-xs text-muted-foreground">{t("models.apiKey.noKeySaved")}</p>
            ) : null}
            {keyError ? (
              <p className="settings-card-error" role="alert">
                <AlertTriangle size={14} className="flex-none" />
                <span className="min-w-0 break-words">{keyError}</span>
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setKeyTarget(null)} disabled={status !== "idle"}>
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={() => void handleSaveKey()} disabled={status !== "idle"}>
              {status === "saving" ? <Loader2 size={14} className="animate-spin" /> : null}
              {t("models.apiKey.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CustomModelDialog
        draft={draft}
        busy={status === "saving"}
        isNew={!draft?.targetProviderId}
        onChange={setDraft}
        onClose={() => {
          setDraft(null);
          draftRef.current = null;
        }}
        onSubmit={(next) => void handleSave(next)}
      />
    </div>
  );
}

function CustomModelDialog({
  draft,
  isNew,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  draft: CustomModelDraft | null;
  isNew: boolean;
  busy: boolean;
  onChange: (draft: CustomModelDraft) => void;
  onClose: () => void;
  onSubmit: (draft: CustomModelDraft) => void;
}) {
  const t = useT();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [test, setTest] = useState<{ status: "idle" | "running" | "ok" | "failed"; message: string; models: string[] }>({
    status: "idle",
    message: "",
    models: [],
  });

  function patch(next: Partial<CustomModelDraft>) {
    if (!draft) {
      return;
    }
    onChange({ ...draft, ...next });
  }

  // 旧草稿（或别的入口造的草稿）可能没带 cost：当场补一份空的，不在类型上打洞。
  const cost = draft?.cost ?? emptyCostDraft();

  function patchCost(next: Partial<CostDraft>) {
    patch({ cost: { ...cost, ...next } });
  }

  function patchCostTier(index: number, next: Partial<CostTierDraft>) {
    patchCost({
      tiers: cost.tiers.map((tier, row) => (row === index ? { ...tier, ...next } : tier)),
    });
  }

  // 旧草稿也可能没带新的映射表形状：当场补一份（= pi 的默认档位），不在类型上打洞。
  const thinkingLevels = draft?.thinkingLevels ?? emptyThinkingLevels();

  function patchThinkingLevel(level: ThinkingLevel, value: string) {
    patch({ thinkingLevels: { ...thinkingLevels, [level]: value } });
  }

  function submit() {
    if (!draft) {
      return;
    }
    const nextErrors = validateDraft(draft, { requireApiKey: isNew });
    setErrors(nextErrors);
    if (!Object.keys(nextErrors).length) {
      onSubmit(draft);
    }
  }

  async function runConnectionTest() {
    if (!draft) {
      return;
    }
    const baseUrlErrors = validateDraft(draft, { requireApiKey: false });
    if (baseUrlErrors.baseUrl || baseUrlErrors.model) {
      setErrors(baseUrlErrors);
      return;
    }
    if (!draft.apiKey.trim()) {
      setErrors({ apiKey: t("models.test.noKey") });
      return;
    }
    setErrors({});
    setTest({ status: "running", message: t("models.test.connecting"), models: [] });
    try {
      const result = await testCustomModelConnection({
        providerId: draft.providerId || draft.targetProviderId || undefined,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey,
        model: draft.model.trim() || undefined,
      });
      if (result.ok) {
        setTest({
          status: "ok",
          message: t("models.test.connected", { count: (result.models ?? []).length }),
          models: result.models ?? [],
        });
      } else {
        setTest({ status: "failed", message: result.error || t("models.test.failed"), models: [] });
      }
    } catch (error) {
      setTest({ status: "failed", message: readableError(error), models: [] });
    }
  }

  const canSubmit = Boolean(draft) && !busy;

  return (
    <Dialog open={Boolean(draft)} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="grid gap-5 sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{isNew ? t("models.dialog.addTitle") : t("models.dialog.editTitle")}</DialogTitle>
          <DialogDescription>
            {t("models.dialog.desc")}
          </DialogDescription>
        </DialogHeader>

        {draft ? (
          <div className="grid max-h-[60vh] gap-4 overflow-y-auto pr-1">
            <div className="grid gap-2">
              <Label htmlFor="custom-model-provider">{t("models.field.providerName")}</Label>
              <Input
                id="custom-model-provider"
                value={draft.providerName}
                placeholder={t("models.placeholder.providerName")}
                onChange={(event) => patch({ providerName: event.target.value })}
              />
              <FieldError text={errors.providerName} />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="custom-model-base-url">{t("models.field.baseUrl")}</Label>
              <Input
                id="custom-model-base-url"
                value={draft.baseUrl}
                placeholder="https://api.example.com/v1"
                autoComplete="off"
                onChange={(event) => {
                  setTest({ status: "idle", message: "", models: [] });
                  patch({ baseUrl: event.target.value });
                }}
              />
              <FieldError text={errors.baseUrl} />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="custom-model-key">{t("models.field.apiKey")}</Label>
              <div className="flex items-start gap-2">
                <ApiKeyField
                  id="custom-model-key"
                  value={draft.apiKey}
                  onChange={(next) => {
                    setTest({ status: "idle", message: "", models: [] });
                    patch({ apiKey: next });
                  }}
                  savedConfigured={!isNew}
                  placeholder={isNew ? t("models.placeholder.keyNew") : t("models.placeholder.keyReplace")}
                />
                <Button type="button" variant="outline" size="sm" className="h-9 flex-none" onClick={() => void runConnectionTest()}>
                  {test.status === "running" ? <Loader2 size={14} className="animate-spin" /> : null}
                  {t("models.test.connection")}
                </Button>
              </div>
              <FieldError text={errors.apiKey} />
              {test.message ? (
                <p className={cn("text-xs", test.status === "ok" ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>
                  {test.message}
                </p>
              ) : null}
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="custom-model-id">{t("models.field.modelName")}</Label>
                <Input
                  id="custom-model-id"
                  value={draft.model}
                  list="custom-model-id-options"
                  placeholder="qwen3.7-plus"
                  autoComplete="off"
                  onChange={(event) => patch({ model: event.target.value })}
                />
                <datalist id="custom-model-id-options">
                  {test.models.map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
                <FieldError text={errors.model} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="custom-model-label">{t("models.field.displayName")}</Label>
                <Input
                  id="custom-model-label"
                  value={draft.modelLabel}
                  placeholder={t("models.placeholder.displayName")}
                  onChange={(event) => patch({ modelLabel: event.target.value })}
                />
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="custom-model-context">{t("models.field.contextWindow")}</Label>
                <Input
                  id="custom-model-context"
                  inputMode="numeric"
                  value={draft.contextWindow}
                  onChange={(event) => patch({ contextWindow: event.target.value })}
                />
                <FieldError text={errors.contextWindow} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="custom-model-max">{t("models.field.maxTokens")}</Label>
                <Input
                  id="custom-model-max"
                  inputMode="numeric"
                  value={draft.maxTokens}
                  onChange={(event) => patch({ maxTokens: event.target.value })}
                />
                <FieldError text={errors.maxTokens} />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-5">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.reasoning}
                  aria-label={t("models.field.reasoning")}
                  onCheckedChange={(checked) => patch({ reasoning: checked === true })}
                />
                {t("models.field.reasoning")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.supportsImages}
                  aria-label={t("models.field.imageInput")}
                  onCheckedChange={(checked) => patch({ supportsImages: checked === true })}
                />
                {t("models.field.imageInput")}
              </label>
            </div>

            {/* 思考档位映射：只有勾了 Reasoning 才出现（关掉推理就不谈档位）。
                每档一个框：填值 = 选中该档时发给端点的 effort（可改名，如 high → xhigh）；
                留空 = 该档不存在，composer 里不会出现它。composer 显示几档就由这张表推出来。 */}
            {draft.reasoning ? (
              <div className="grid gap-2">
                <Label>{t("models.field.thinkingMap")}</Label>
                <p className="text-xs text-muted-foreground">{t("models.field.thinkingMapHint")}</p>
                <div className="grid gap-1.5">
                  {THINKING_LEVELS.map((level) => (
                    <div key={level} className="flex items-center gap-2">
                      <span className="w-16 flex-none font-mono text-xs text-muted-foreground">{level}</span>
                      <Input
                        className="h-8 flex-1 font-mono text-xs"
                        value={thinkingLevels[level] ?? ""}
                        placeholder={t("models.field.thinkingMapPlaceholder")}
                        aria-label={t("models.field.thinkingMapValueAria", { level })}
                        onChange={(event) => patchThinkingLevel(level, event.target.value)}
                      />
                    </div>
                  ))}
                </div>
                {errors.thinkingLevels ? (
                  <p className="text-xs text-destructive" role="status">{errors.thinkingLevels}</p>
                ) : null}
              </div>
            ) : null}

            {/* 价格：四个顶层价 + 可选阶梯档。不换算币种，填什么就是什么数。 */}
            <div className="grid gap-2">
              <Label>{t("models.cost.title")}</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {PRICE_FIELDS.map(({ key, labelKey }) => (
                  <div key={key} className="grid min-w-0 gap-2">
                    <Label htmlFor={`custom-model-price-${key}`} className="text-muted-foreground">{t(labelKey)}</Label>
                    <Input
                      id={`custom-model-price-${key}`}
                      className="min-w-0"
                      inputMode="decimal"
                      placeholder="0"
                      value={cost[key]}
                      aria-invalid={Boolean(errors[costRateErrorKey(key)])}
                      onChange={(event) => patchCost({ [key]: event.target.value })}
                    />
                    <FieldError text={errors[costRateErrorKey(key)]} />
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("models.cost.hint")}
              </p>
            </div>

            <div className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>{t("models.cost.tiers")}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 flex-none"
                  disabled={cost.tiers.length >= MAX_PRICE_TIERS}
                  onClick={() => patchCost({ tiers: [...cost.tiers, newCostTier(cost.tiers)] })}
                >
                  <Plus size={14} className="mr-1" />
                  {t("models.cost.addTier")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                本单输入（含缓存读写）总量超过阈值时，整单改用这一档的四个价 —— 不是分段累进。
              </p>
              {cost.tiers.map((tier, index) => (
                <div key={index} className="cost-tier">
                  <div className="cost-tier-head">
                    <div className="grid min-w-0 flex-1 gap-2">
                      <Label htmlFor={`custom-model-tier-${index}-threshold`} className="text-muted-foreground">
                        {t("models.cost.thresholdLabel")}
                      </Label>
                      <Input
                        id={`custom-model-tier-${index}-threshold`}
                        className="min-w-0"
                        inputMode="numeric"
                        placeholder="e.g. 32000"
                        value={tier.inputTokensAbove}
                        aria-invalid={Boolean(errors[costThresholdErrorKey(index)])}
                        onChange={(event) => patchCostTier(index, { inputTokensAbove: event.target.value })}
                      />
                      <FieldError text={errors[costThresholdErrorKey(index)]} />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="cost-tier-remove h-8 flex-none"
                      aria-label={`Remove pricing tier ${index + 1}`}
                      onClick={() => patchCost({ tiers: cost.tiers.filter((_, row) => row !== index) })}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {PRICE_FIELDS.map(({ key, labelKey }) => (
                      <div key={key} className="grid min-w-0 gap-2">
                        <Label htmlFor={`custom-model-tier-${index}-${key}`} className="text-muted-foreground">
                          {t(labelKey)}
                        </Label>
                        <Input
                          id={`custom-model-tier-${index}-${key}`}
                          className="min-w-0"
                          inputMode="decimal"
                          placeholder="0"
                          value={tier[key]}
                          aria-invalid={Boolean(errors[costRateErrorKey(key, index)])}
                          onChange={(event) => patchCostTier(index, { [key]: event.target.value })}
                        />
                        <FieldError text={errors[costRateErrorKey(key, index)]} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {errors.costTiers ? (
                <p className="settings-card-error" role="alert">
                  {errors.costTiers}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={!canSubmit}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FieldError({ text }: { text?: string }) {
  if (!text) {
    return null;
  }
  return (
    <p className="text-xs text-destructive" role="alert">
      {text}
    </p>
  );
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
