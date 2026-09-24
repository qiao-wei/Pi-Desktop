const UI_PREFS_KEY = "pi-desktop.ui.v1";

/**
 * 界面配色主题（与 `theme` 的浅色/深色正交）：`default`（缺省）、`codex` 等。
 *
 * 应用方式：`<html data-appearance="…">`，配合 `.dark` class 一起决定最终配色。
 *
 * 这里**刻意没有主题 id 的枚举**：主题清单来自目录（`src/themes/<id>/`），而本模块
 * 要能在 `node --test` 里加载。已知性判断在 `src/themes/index.ts` 的
 * `resolveAppearance()` 里做，见下面 `normalizeAppearance()` 的注释。
 */

/** 主题 id 的字面形态：小写字母/数字/连字符，≤32 字符。 */
const APPEARANCE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * 读持久化偏好时用它兜底：localStorage 里可能是旧版本、手改或非字符串的任意值。
 *
 * 只做**卫生检查**，不判断 id 是否真的有对应主题：
 * - 「未知但形态合法」的 id 会在 `src/themes/index.ts` 的 `resolveAppearance()` 里
 *   落回默认主题；
 * - 就算两边都漏掉，`data-appearance` 指不到任何主题块时界面也只会渲染成默认主题
 *   （默认主题是裸 `:root`，见 `src/themes/default/theme.css`）。
 */
export function normalizeAppearance(value: unknown): string {
  return typeof value === "string" && APPEARANCE_ID.test(value) ? value : "default";
}

export interface UiPreferences {
  theme: "light" | "dark";
  /** 配色主题 id（`src/themes/<id>/` 的目录名）；缺省 = `default`。见 `normalizeAppearance()`。 */
  appearance: string;
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
      // 只做形态卫生：未知但合法的 id 交给 `src/themes/index.ts` 的
      // `resolveAppearance()` 落回默认主题。
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
