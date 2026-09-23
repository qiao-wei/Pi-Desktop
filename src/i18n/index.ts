import { loadUiPreferences, saveUiPreferences } from "../lib/ui-preferences.ts";
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
export type LocalePreference = Locale | "auto";

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
  const stored = loadUiPreferences().locale;
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

let currentLocale: Locale = resolveInitialLocale();

const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return currentLocale;
}

/** UI-preferences-stored value: "zh" | "en", or undefined (follow the OS). */
export function getLocalePreference(): LocalePreference {
  return loadUiPreferences().locale ?? "auto";
}

export function setLocale(locale: Locale): void {
  if (locale === currentLocale) {
    return;
  }
  currentLocale = locale;
  saveUiPreferences({ locale });
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
  const dictionary = dictionaries[currentLocale];
  const template = dictionary[key] ?? dictionaries.zh[key];
  if (template === undefined) {
    return key;
  }
  return interpolate(template, params);
}
