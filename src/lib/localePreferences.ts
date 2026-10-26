/**
 * Locale preference persistence - the **adapter** that keeps `src/i18n` free of I/O.
 *
 * The i18n module is `foundation` layer: pure lookups that run in `node --test` with no
 * storage at all. Reading and writing the saved language is a side effect, so it belongs in
 * `lib/` (adapters) and is injected at startup from the composition root (`src/main.tsx`).
 *
 * Before this split, `src/i18n/index.ts` imported `lib/ui-preferences.ts`, which is an
 * upward import (foundation → adapters) and the only genuine layer inversion in the tree.
 * The dependency now points the right way, and the swap is explicit: a different host with a
 * different preferences store implements `LocalePreferencePort` and installs it here.
 */

import { configureLocalePreference } from "../i18n/index.ts";
import { loadUiPreferences, saveUiPreferences } from "./ui-preferences.ts";

/** Call once, before the first render, from the composition root. */
export function installLocalePreferencePort(): void {
  configureLocalePreference({
    read: () => loadUiPreferences().locale,
    write: (locale) => saveUiPreferences({ locale }),
  });
}

/** Detach - used by tests that want the OS/env fallback without touching storage. */
export function uninstallLocalePreferencePort(): void {
  configureLocalePreference(undefined);
}