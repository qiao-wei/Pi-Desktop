import { zh } from "./zh.ts";
import { en } from "./en.ts";

/**
 * Minimal i18n runtime for Pi Desktop.
 *
 * Design constraints that shaped this module:
 * - Pi Desktop renders strings from non-React modules too (compactionNotice,
 *   capabilityScope, customModelForm...), so `t` is a plain module function
 *   reading the locale at call time - not a context-bound hook. React callers
 *   use `useT()` to re-render on locale change; pure modules re-run during
 *   that same re-render because the component now subscribes.
 * - Dictionaries are flat `dot.key -> string` maps with `{param}` slots, so a
 *   key is trivially greppable in both source and language packs.
 * - The English pack is type-checked against the Chinese key set (`Record<
 *   keyof typeof zh, string>`), so a missing translation is a compile error,
 *   not a runtime surprise.
 * - Locale resolution: an explicit preference (persisted in ui-preferences)
 *   wins; otherwise follow the OS language once at startup; final fallback is
 *   Chinese (the language the app shipped in).
 */

export type Locale = "zh" | "en";
import type { LocalePreferencePort } from "../types/protocols.ts";
export type LocalePreference = Locale | "auto";

/**
 * 语言偏好的持久化是**适配层**的事，不是 i18n 的事：这一层（foundation）不许 import 任何
 * 会读磁盘/localStorage 的东西（架构规则 `layer-direction`）。谁在启动时把它接上？
 * `src/main.tsx` 调 `installLocalePreferencePort()`（见 `src/lib/localePreferences.ts`）。
 *
 * 不接也不影响：没接的时候 i18n 只看环境变量与系统语言 —— 纯模块单测正是这种情况。
 */
// 契约在 `src/types/protocols.ts`（contracts 层）：i18n 是 foundation，不能向上依赖 protocol 层，
// 而端口的契约要放在比它更低的层才合法。这里再导出一次，免得调用方多认一条路径。
export type { LocalePreferencePort };

let preferencePort: LocalePreferencePort | undefined;

/** 装配点：适配层在启动时注入读写实现。传 `undefined` 可以卸下来（测试用）。 */
export function configureLocalePreference(port: LocalePreferencePort | undefined): void {
  preferencePort = port;
  // 还没人问过当前语言时，按新读到的偏好重算；已经问过就不回滚用户当下的选择。
  if (currentLocale === undefined) {
    currentLocale = resolveInitialLocale();
  }
}

const dictionaries: Record<Locale, Readonly<Record<string, string>>> = {
  zh: zh as Readonly<Record<string, string>>,
  en: en as Readonly<Record<string, string>>,
};

function detectSystemLocale(): Locale {
  if (typeof navigator !== "undefined" && typeof navigator.language === "string") {
    return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  }
  return "zh";
}

function resolveInitialLocale(): Locale {
  const stored = preferencePort?.read();
  if (stored === "zh" || stored === "en") {
    return stored;
  }
  // Environment override (used by the test suite; also handy for debugging):
  // PI_DESKTOP_LOCALE=zh / PI_DESKTOP_LOCALE=en pins the locale before OS detection.
  if (typeof process !== "undefined" && process.env) {
    if (process.env.PI_DESKTOP_LOCALE === "zh" || process.env.PI_DESKTOP_LOCALE === "en") {
      return process.env.PI_DESKTOP_LOCALE;
    }
  }
  return detectSystemLocale();
}

// 懒解析：首次真正需要语言时才问（那时 main.tsx 的装配已完成）；在此之前 setLocale() 的
// 显式选择优先于任何读盘结果。
let currentLocale: Locale | undefined;

function locale(): Locale {
  return (currentLocale ??= resolveInitialLocale());
}

const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return locale();
}

/** UI-preferences-stored value: "zh" | "en", or undefined (follow the OS). */
export function getLocalePreference(): LocalePreference {
  return preferencePort?.read() ?? "auto";
}

export function setLocale(locale: Locale): void {
  if (locale === currentLocale) {
    return;
  }
  currentLocale = locale;
  preferencePort?.write(locale);
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type TranslationParams = Record<string, string | number>;

/** `{name}` slots are replaced left-to-right; an unknown slot is left as-is. */
function interpolate(template: string, params: TranslationParams | undefined): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function t(key: string, params?: TranslationParams): string {
  const dictionary = dictionaries[locale()];
  const template = dictionary[key] ?? dictionaries.zh[key];
  if (template === undefined) {
    return key;
  }
  return interpolate(template, params);
}

/**
 * `t` 的「有没有这条文案」版本，给需要「专用措辞优先、否则退到通用措辞」的场景用
 * （见 shared/builtinCommandNotice.ts）。查表顺序与 `t` 完全一致，避免两者判断不一致。
 */
export function hasTranslation(key: string): boolean {
  return dictionaries[locale()][key] !== undefined || dictionaries.zh[key] !== undefined;
}
