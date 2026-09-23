import { useSyncExternalStore } from "react";
import { getLocale, subscribeLocale, t, type Locale, type TranslationParams } from "./index.ts";

/**
 * React binding for the i18n runtime.
 *
 * `useT()` subscribes the component to locale changes and returns the same
 * module-level `t` - so a language switch re-renders every translated
 * component, including through pure helpers (compactionNotice etc.) that are
 * re-evaluated during that render.
 */
export function useLocale(): Locale {
  useSyncExternalStore(subscribeLocale, getLocale);
  return getLocale();
}

export function useT(): (key: string, params?: TranslationParams) => string {
  useSyncExternalStore(subscribeLocale, getLocale);
  return t;
}
