const UI_PREFS_KEY = "pi-desktop.ui.v1";

/**
 * 界面配色主题（与 `theme` 的浅色/深色正交）：
 * - `default`：Pi Desktop 原有配色（暖白底 + 绿色点缀），缺省值；
 * - `codex`：中性灰阶 + 深色侧栏，参考 PI-Desktop 的 Codex 风格视觉系统。
 *
 * 应用方式：`<html data-appearance="…">`，配合 `.dark` class 一起决定最终配色。
 */
export type UiAppearance = "default" | "codex";

/**
 * 读取持久化偏好时用它兜底：localStorage 里可能是旧版本或手改的任意字符串，
 * 未知值一律落回缺省主题，避免 `<html>` 上挂一个没有样式定义的值（界面全裸）。
 */
export function normalizeAppearance(value: unknown): UiAppearance {
  return value === "codex" ? "codex" : "default";
}

export interface UiPreferences {
  theme: "light" | "dark";
  /** 配色主题；缺省 = `default`（原有配色）。`loadUiPreferences()` 会把它归一到已知值。 */
  appearance: UiAppearance;
  /** UI language; absent = follow the OS (resolved once by src/i18n at startup). */
  locale?: "zh" | "en";
  leftSidebarWidth: number;
  rightPanelWidth: number;
  leftSidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  projectSidebarShowPinned: boolean;
  projectSidebarExpandedProjectIds?: string[];
  /** 设置页里被折叠起来的供应商（按 provider id）；缺省 = 全部展开。 */
  modelsCollapsedProviderIds?: string[];
  /** 右侧面板里被折叠起来的分区（`skills` / `packages`）；缺省 = 两个都展开。 */
  capabilityPanelCollapsedSections?: string[];
  /** 全局技能与扩展页上次停留的标签页；缺省 = 技能。 */
  capabilityScopeTab?: "skill" | "package";
  /**
   * 任务完成后发系统提醒。缺省（undefined）= 关闭：系统通知会惊动整个屏幕，
   * 而且 macOS 首次发送会弹权限询问，必须是用户自己去设置页打开的。
   */
  notifyOnTurnComplete?: boolean;
}

const defaultUiPreferences: UiPreferences = {
  theme: "light",
  appearance: "default",
  locale: undefined,
  leftSidebarWidth: 280,
  rightPanelWidth: 340,
  leftSidebarCollapsed: false,
  rightPanelCollapsed: false,
  projectSidebarShowPinned: true,
};

export function loadUiPreferences(): UiPreferences {
  if (typeof window === "undefined") {
    return defaultUiPreferences;
  }

  const raw = window.localStorage.getItem(UI_PREFS_KEY);
  if (!raw) {
    return defaultUiPreferences;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<UiPreferences>;
    return {
      ...defaultUiPreferences,
      ...parsed,
      // 只认已知主题：手改/旧版本里的未知字符串会让 `<html data-appearance>` 指向一个
      // 没有任何样式块命中的值，整个界面就只剩浏览器默认样式。
      appearance: normalizeAppearance(parsed.appearance),
    };
  } catch {
    return defaultUiPreferences;
  }
}

export function saveUiPreferences(prefs: Partial<UiPreferences>): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ ...loadUiPreferences(), ...prefs }));
}
