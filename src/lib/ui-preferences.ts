const UI_PREFS_KEY = "pi-desktop.ui.v1";

export interface UiPreferences {
  theme: "light" | "dark";
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
    return {
      ...defaultUiPreferences,
      ...(JSON.parse(raw) as Partial<UiPreferences>),
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
