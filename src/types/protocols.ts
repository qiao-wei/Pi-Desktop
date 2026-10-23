/**
 * Contracts layer: the shapes a **lower** layer must be able to depend on.
 *
 * Why this file exists separately from `domain.ts` and from `src/shared/protocol/`: layer order is
 * `contracts → foundation → protocol → ...`, so `protocol` (and everything above it) may import
 * `foundation`, but not the other way round. A port whose *implementation* lives in the adapters and
 * whose *consumer* is the foundation layer therefore cannot have its interface in `protocol` - that
 * would be an upward import the `layer-direction` rule rejects.
 *
 * `LocalePreferencePort` is exactly that case: `src/i18n` (foundation) resolves the language and must
 * not read storage, so the socket it reads through has to be declared below it. It used to live inside
 * `src/i18n/index.ts`; the shape is the same, the address is now one where any layer may name it.
 */

/**
 * How the i18n layer reads and writes the user's language preference.
 * Implemented in `src/lib/localePreferences.ts`, installed from `src/main.tsx`.
 */
export interface LocalePreferencePort {
  read(): "zh" | "en" | undefined;
  write(locale: "zh" | "en"): void;
}