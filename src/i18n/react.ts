import { useSyncExternalStore } from "react";
import { getLocale, subscribeLocale, t, type Locale, type TranslationParams } from "./index.ts";

export type Translator = (key: string, params?: TranslationParams) => string;

/**
 * React binding for the i18n runtime.
 *
 * Both hooks subscribe the component to locale changes, so a language switch
 * re-renders every translated component - including through pure helpers
 * (compactionNotice etc.) that are re-evaluated during that render.
 *
 * `useT()` deliberately hands back **one stable function per locale** instead of
 * the module-level `t`: `t`'s identity never changes, so a `useMemo(() => …,
 * [t])` would keep its previous result after a language switch even though the
 * component re-rendered. That is exactly how the chat's process rows went stale
 * (the thinking row switched to Chinese while the tool row still said
 * `Terminal`, 2026-10-29). A per-locale reference makes every memo that already
 * depends on `t` invalidate on switch, without asking each call site to add a
 * second `locale` dependency it does not otherwise need.
 *
 * The closures still call the module-level `t` rather than freezing a locale:
 * an async callback created under Chinese should render its error in whatever
 * language is current when it actually runs.
 */
export function useLocale(): Locale {
  useSyncExternalStore(subscribeLocale, getLocale);
  return getLocale();
}

const translators: Record<Locale, Translator> = {
  zh: (key, params) => t(key, params),
  en: (key, params) => t(key, params),
};

export function useT(): Translator {
  return translators[useLocale()];
}
