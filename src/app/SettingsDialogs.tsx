/**
 * 设置弹窗与会话能力设置.
 *
 * 设置面板（外观/模型/个性化/能力）与「本会话能力开关」区块。
 *
 * 从 `src/app/App.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */
import { CustomModelsSettings } from "../features/models/CustomModelsSettings";
import type { CustomModelsController } from "../features/models/useCustomModels";
import { ArchivedChatsSettings } from "../features/settings/ArchivedChatsSettings";
import { NotificationSettings } from "../features/settings/NotificationSettings";
import { t } from "../i18n/index.ts";
import { useLocale, useT } from "../i18n/react";
import type { ToolSettingsPayload } from "../lib/api";
import { themes } from "../themes/index.ts";
import type { ThemeId } from "../themes/index.ts";
import type { ArchivedSessionSummary, CapabilitiesState, PersonalizationSettings, ToolToggleState } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Archive, Bell, Save, Settings, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";

function ConversationCapabilitiesSettings({
  capabilities,
  onSetSessionSkill,
  onSetSessionPackage,
  onSetSessionExtension,
}: {
  capabilities: CapabilitiesState;
  onSetSessionSkill: (id: string, enabled: boolean) => Promise<unknown>;
  onSetSessionPackage: (id: string, enabled: boolean) => Promise<unknown>;
  onSetSessionExtension: (id: string, enabled: boolean) => Promise<unknown>;
}) {
  const t = useT();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function toggle(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  function renderRow(
    id: string,
    name: string,
    description: string,
    active: boolean,
    action: () => Promise<unknown>,
  ) {
    return (
      <div
        key={id}
        className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5"
      >
        <div className="grid min-w-0 gap-0.5">
          <strong className="truncate text-sm font-medium">{name}</strong>
          <span className="truncate text-xs text-muted-foreground">{description}</span>
        </div>
        <Switch
          checked={active}
          disabled={Boolean(busy)}
          onCheckedChange={() => void toggle(id, action)}
          aria-label={active ? t("capability.toggleOff", { name }) : t("capability.toggleOn", { name })}
          title={active ? t("capability.toggleOffTitle") : t("capability.toggleOnTitle")}
        />
      </div>
    );
  }

  function renderSectionHeading(title: string, count: number) {
    return (
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground tabular-nums">
          {count}
        </span>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground">
        {t("capability.sessionOnlyNote")}
      </p>
      {error ? (
        <p className="text-sm text-destructive" role="status">
          {error}
        </p>
      ) : null}
      <section className="grid gap-2">
        {renderSectionHeading("Skills", capabilities.skills.length)}
        {capabilities.skills.length ? capabilities.skills.map((item) => renderRow(
          `skill:${item.id}`,
          item.name,
          item.description || item.path,
          item.active,
          () => onSetSessionSkill(item.id, !item.active),
        )) : <p className="text-sm text-muted-foreground">{t("capability.noSkills")}</p>}
      </section>
      <section className="grid gap-2">
        {renderSectionHeading("Packages", capabilities.packages.length)}
        {capabilities.packages.length ? capabilities.packages.map((item) => renderRow(
          `package:${item.id}`,
          item.name,
          item.source,
          item.active,
          () => onSetSessionPackage(item.id, !item.active),
        )) : <p className="text-sm text-muted-foreground">{t("capability.noPackages")}</p>}
      </section>
      <section className="grid gap-2">
        {renderSectionHeading("Extensions", capabilities.extensions.length)}
        {capabilities.extensions.length ? capabilities.extensions.map((item) => renderRow(
          `extension:${item.id}`,
          item.name,
          item.path,
          item.active,
          () => onSetSessionExtension(item.id, !item.active),
        )) : <p className="text-sm text-muted-foreground">{t("capability.noExtensions")}</p>}
      </section>
    </div>
  );
}

function SettingsModal({
  open,
  onOpenChange,
  models,
  onModelsChanged,
  personalization,
  onSavePersonalization,
  toolSettings,
  onSaveToolSettings,
  appearance,
  onAppearanceChange,
  archivedSessions,
  onUnarchiveSession,
  onDeleteArchivedSession,
  onDeleteAllArchivedSessions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 自定义模型清单：与输入框旁的切换器共用，设置页保存后这里同步。 */
  models: CustomModelsController;
  onModelsChanged: () => void;
  personalization: PersonalizationSettings;
  onSavePersonalization: (settings: PersonalizationSettings) => Promise<void>;
  /** 工具开关（codemode）现状；写在 pi 自己的 settings 里，所以主题区一样是立即生效、不走保存按钮。 */
  toolSettings?: ToolSettingsPayload;
  onSaveToolSettings: (input: { scope: "user" | "project"; state: ToolToggleState }) => Promise<unknown>;
  /** 配色主题 id（`src/themes/<id>/`）；和明暗一样属于 UI 偏好，改完立即生效，不走下面的保存按钮。 */
  appearance: ThemeId;
  onAppearanceChange: (appearance: ThemeId) => void;
  /** 归档会话（跨项目），归「归档聊天」页唯一使用。 */
  archivedSessions: ArchivedSessionSummary[];
  onUnarchiveSession: (projectId: string, sessionPath: string) => Promise<void>;
  onDeleteArchivedSession: (projectId: string, sessionPath: string) => Promise<void>;
  onDeleteAllArchivedSessions: (projectId?: string) => Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const [activeTab, setActiveTab] = useState<"models" | "personalization" | "archived" | "notifications">("models");
  const [personalizationDraft, setPersonalizationDraft] = useState(personalization);
  const [isSavingPersonalization, setIsSavingPersonalization] = useState(false);
  const [isSavingToolToggle, setIsSavingToolToggle] = useState(false);
  const [toolToggleError, setToolToggleError] = useState<string | null>(null);

  useEffect(() => {
    setPersonalizationDraft(personalization);
  }, [personalization]);

  async function savePersonalizationSettings() {
    setIsSavingPersonalization(true);
    try {
      await onSavePersonalization(personalizationDraft);
    } finally {
      setIsSavingPersonalization(false);
    }
  }

  /** 工具开关直接改 pi 的设置文件，所以是"拨了就跑"，不跟下面的保存按钮绑定。 */
  async function toggleCodemode(enabled: boolean) {
    setToolToggleError(null);
    setIsSavingToolToggle(true);
    try {
      await onSaveToolSettings({ scope: "user", state: enabled ? "on" : "off" });
    } catch (error) {
      setToolToggleError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingToolToggle(false);
    }
  }

  // 每个分区都有 `settings.heading.<tab>`：加分区时不需要再扩一条嵌套三元。
  const heading = t(`settings.heading.${activeTab}`);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* sm:max-w-none is not redundant: DialogContent's base classes end with
          sm:max-w-lg, and tailwind-merge keeps it alongside an unprefixed
          max-w-none, so the sm: variant would clamp the dialog to 512px. */}
      <DialogContent
        showCloseButton={false}
        className="settings-dialog grid h-[min(88svh,760px)] w-[min(92vw,1180px)] max-w-none gap-0 overflow-hidden border-border bg-[var(--app-content-surface)] p-0 sm:max-w-none"
      >
        <DialogDescription className="sr-only">
          Configure models, personalization, notifications, and archived chats.
        </DialogDescription>

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as typeof activeTab)}
          orientation="vertical"
          className="settings-modal grid min-h-0 grid-cols-[260px_minmax(0,1fr)] gap-0 overflow-hidden"
        >
          {/* The sidebar chrome lives on this wrapper, not on TabsList: the vertical
              tabs variant forces h-fit, so a border on the list itself would stop
              short of the dialog bottom. */}
          <div className="settings-sidebar flex h-full min-h-0 flex-col gap-1 border-r border-border bg-muted/30 p-3">
            <div className="flex items-center gap-2 px-2 pt-1 pb-3 text-sm font-semibold text-foreground">
              <Settings size={18} />
              <span>{t("settings.title")}</span>
            </div>
            <TabsList
              variant="line"
              aria-label={t("settings.sectionsAria")}
              className="w-full items-stretch justify-start gap-1 rounded-none bg-transparent p-0"
            >
              <TabsTrigger value="models" className="h-9 gap-2 px-2">
                <Settings size={18} />
                <span>{t("settings.tab.models")}</span>
              </TabsTrigger>
              <TabsTrigger value="personalization" className="h-9 gap-2 px-2">
                <Sparkles size={18} />
                <span>{t("settings.tab.personalization")}</span>
              </TabsTrigger>
              <TabsTrigger value="archived" className="h-9 gap-2 px-2">
                <Archive size={18} />
                <span>{t("settings.tab.archived")}</span>
                {archivedSessions.length ? (
                  <Badge variant="secondary" className="ml-auto tabular-nums">
                    {archivedSessions.length}
                  </Badge>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="notifications" className="h-9 gap-2 px-2">
                <Bell size={18} />
                <span>{t("settings.tab.notifications")}</span>
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="flex min-w-0 flex-col overflow-hidden">
            <div className="settings-header flex flex-none items-center justify-between gap-4 border-b border-border px-6 py-4">
              <DialogTitle className="truncate">{heading}</DialogTitle>
              <DialogClose asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="-mr-2 shrink-0"
                  aria-label={t("settings.close")}
                  title={t("settings.close")}
                >
                  <X />
                </Button>
              </DialogClose>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <TabsContent value="models">
                <CustomModelsSettings models={models} onModelsChanged={onModelsChanged} />
                <p className="mt-4 text-xs text-muted-foreground">
                  {t("models.settings.switchHint")}
                </p>
              </TabsContent>

              <TabsContent value="personalization" className="grid max-w-2xl gap-6">
                {/*
                  主题选择放在最前面，且**立即生效**（不走下面的保存按钮）：
                  主题是 UI 偏好（localStorage），不是 pi 的个性化设置（服务端），
                  而且切换必须能当场看到效果，否则「选一下再保存」体验很怪。
                */}
                <div className="grid gap-2">
                  <Label>{t("settings.appearance.label")}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t("settings.appearance.desc")}
                  </p>
                  <div
                    className="grid grid-cols-2 gap-2.5"
                    role="radiogroup"
                    aria-label={t("settings.appearance.label")}
                  >
                    {themes.map((theme) => (
                      <button
                        key={theme.id}
                        type="button"
                        role="radio"
                        aria-checked={appearance === theme.id}
                        data-appearance-option={theme.id}
                        className={cn(
                          "grid min-w-0 gap-1.5 rounded-md border p-3.5 text-left hover:bg-accent",
                          appearance === theme.id && "border-primary bg-accent",
                        )}
                        onClick={() => onAppearanceChange(theme.id)}
                      >
                        {/* 文案跟着主题目录走（`themes/<id>/meta.ts`），不进 i18n 词典：
                            否则每加一个主题都要在两个语言包里各补两条。 */}
                        <strong className="text-sm">{theme.label[locale]}</strong>
                        <span className="text-xs leading-relaxed text-muted-foreground">
                          {theme.desc[locale]}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="settings-style">{t("settings.style.label")}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t("settings.style.desc")}
                  </p>
                  <Select
                    value={personalizationDraft.style}
                    onValueChange={(value) =>
                      setPersonalizationDraft((current) => ({ ...current, style: value }))
                    }
                  >
                    <SelectTrigger id="settings-style" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {personalizationStyleOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {t(option.labelKey)} - {t(option.descKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="settings-persona">{t("settings.persona.label")}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t("settings.persona.desc")}
                  </p>
                  <Textarea
                    id="settings-persona"
                    className="min-h-28"
                    value={personalizationDraft.persona}
                    maxLength={1000}
                    onChange={(event) =>
                      setPersonalizationDraft((current) => ({ ...current, persona: event.target.value }))
                    }
                    placeholder={t("settings.persona.placeholder")}
                  />
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {personalizationDraft.persona.length} / 1000
                  </p>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="settings-instructions">{t("settings.instructions.label")}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t("settings.instructions.desc")}
                  </p>
                  <Textarea
                    id="settings-instructions"
                    className="min-h-28"
                    value={personalizationDraft.customInstructions}
                    maxLength={1500}
                    onChange={(event) =>
                      setPersonalizationDraft((current) => ({
                        ...current,
                        customInstructions: event.target.value,
                      }))
                    }
                    placeholder={t("settings.instructions.placeholder")}
                  />
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {personalizationDraft.customInstructions.length} / 1500
                  </p>
                </div>

                <div className="grid gap-2">
                  <Label>{t("settings.extensionUi.label")}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t("settings.extensionUi.desc")}
                  </p>
                  <div
                    className="grid grid-cols-2 gap-2.5"
                    role="radiogroup"
                    aria-label={t("settings.extensionUi.label")}
                  >
                    {personalizationExtensionUiOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={personalizationDraft.extensionUi === option.value}
                        className={cn(
                          "grid min-w-0 gap-1.5 rounded-md border p-3.5 text-left hover:bg-accent",
                          personalizationDraft.extensionUi === option.value && "border-primary bg-accent",
                        )}
                        onClick={() =>
                          setPersonalizationDraft((current) => ({ ...current, extensionUi: option.value }))
                        }
                      >
                        <strong className="text-sm">{t(option.labelKey)}</strong>
                        <span className="text-xs leading-relaxed text-muted-foreground">{t(option.descKey)}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <Button
                  type="button"
                  className="w-fit"
                  onClick={() => void savePersonalizationSettings()}
                  disabled={isSavingPersonalization}
                >
                  <Save size={16} />
                  {isSavingPersonalization ? t("common.saving") : t("settings.savePersonalization")}
                </Button>

                {/* 这一段存的是 pi 自己的 `defaultTools`（终端 TUI 读的就是它），
                    所以拨了立即生效，不跟上面那个保存按钮绑定。 */}
                <div className="grid gap-2 rounded-md border border-border p-3.5">
                  <strong className="text-sm">{t("settings.codemode.section")}</strong>
                  <div className="flex items-start justify-between gap-4">
                    <div className="grid min-w-0 gap-1">
                      <Label htmlFor="settings-codemode">{t("settings.codemode.label")}</Label>
                      <p className="text-sm text-muted-foreground">{t("settings.codemode.desc")}</p>
                    </div>
                    <Switch
                      id="settings-codemode"
                      checked={Boolean(toolSettings?.global)}
                      disabled={isSavingToolToggle || !toolSettings}
                      onCheckedChange={(checked) => void toggleCodemode(checked)}
                    />
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">{t("settings.codemode.hint")}</p>
                  {toolToggleError ? (
                    <p className="text-sm text-destructive" role="status">
                      {toolToggleError}
                    </p>
                  ) : null}
                  {toolSettings?.project === "off" && toolSettings.global ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t("settings.codemode.projectOverride")}
                    </p>
                  ) : null}
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {(toolSettings?.activeTools ?? []).includes("codemode")
                      ? t("settings.codemode.activeOn")
                      : t("settings.codemode.activeOff")}
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="archived">
                <ArchivedChatsSettings
                  sessions={archivedSessions}
                  onUnarchive={onUnarchiveSession}
                  onDelete={onDeleteArchivedSession}
                  onDeleteMany={onDeleteAllArchivedSessions}
                />
              </TabsContent>

              <TabsContent value="notifications">
                <NotificationSettings />
              </TabsContent>
            </div>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/** Extension-panel presentation; the values mirror `ExtensionUiMode` in `src/types` and the server list. */
const personalizationExtensionUiOptions = [
  { value: "tui", labelKey: "settings.extensionUi.tui.label", descKey: "settings.extensionUi.tui.desc" },
  { value: "webui", labelKey: "settings.extensionUi.webui.label", descKey: "settings.extensionUi.webui.desc" },
] as const;

const personalizationStyleOptions = [
  { value: "default", labelKey: "settings.style.default.label", descKey: "settings.style.default.desc" },
  { value: "professional", labelKey: "settings.style.professional.label", descKey: "settings.style.professional.desc" },
  { value: "friendly", labelKey: "settings.style.friendly.label", descKey: "settings.style.friendly.desc" },
  { value: "concise", labelKey: "settings.style.concise.label", descKey: "settings.style.concise.desc" },
  { value: "imaginative", labelKey: "settings.style.imaginative.label", descKey: "settings.style.imaginative.desc" },
  { value: "efficient", labelKey: "settings.style.efficient.label", descKey: "settings.style.efficient.desc" },
  { value: "sharp", labelKey: "settings.style.sharp.label", descKey: "settings.style.sharp.desc" },
  { value: "socratic", labelKey: "settings.style.socratic.label", descKey: "settings.style.socratic.desc" },
] as const;

export { ConversationCapabilitiesSettings, SettingsModal, personalizationExtensionUiOptions, personalizationStyleOptions };
