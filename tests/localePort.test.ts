/**
 * Boundary `locale`: the language preference is read through a port, and the i18n layer itself is
 * driven by it.
 *
 * Two things are checked here that the i18n unit tests could not check before:
 *
 * 1. the real adapter (`installLocalePreferencePort`) reads/writes through the UI preference store -
 *    i.e. the port is wired, not just declared;
 * 2. a *different* implementation can be installed and the i18n layer follows it (`configureLocalePreference`
 *    is the slot in `src/i18n/index.ts`; `LocalePreferencePort` itself is declared in the contracts
 *    layer, `src/types/protocols.ts`, because foundation may not import protocol).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { configureLocalePreference, getLocale, setLocale, t } from "../src/i18n/index.ts";
import {
  installLocalePreferencePort,
  uninstallLocalePreferencePort,
} from "../src/lib/localePreferences.ts";
import { setStoragePort } from "../src/lib/storage.ts";
import { loadUiPreferences } from "../src/lib/ui-preferences.ts";
import type { KeyValueStorePort } from "../src/shared/protocol/storage.ts";

/** A fake preference store: the "other implementation" a different host would provide. */
function fakePort(initial?: "zh" | "en") {
  let value = initial;
  const writes: ("zh" | "en")[] = [];
  return {
    writes,
    port: {
      read: () => value,
      write: (locale: "zh" | "en") => {
        writes.push(locale);
        value = locale;
      },
    },
    current: () => value,
  };
}

function memoryStore(): KeyValueStorePort {
  const values = new Map<string, string>();
  return {
    read: (key) => values.get(key) ?? null,
    write: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key),
  };
}

test("真实适配器接上以后，语言偏好落在（可替换的）存储端口里", () => {
  const store = memoryStore();
  setStoragePort(store);
  try {
    installLocalePreferencePort();
    // 起点由环境决定（PI_DESKTOP_LOCALE 可能已经设了），所以先切到「当前语言的另一侧」，
    // 否则 setLocale 会因为「没变化」提前返回，这条用例就成了假绿。
    const target = getLocale() === "en" ? "zh" : "en";
    setLocale(target);
    assert.equal(loadUiPreferences().locale, target, "写必须经 ui-preferences → storage 端口");
  } finally {
    setStoragePort(null);
    uninstallLocalePreferencePort();
  }
});

test("换一个实现：i18n 跟着装上的端口走（可替换性的兑现）", () => {
  const original = getLocale();
  const target = original === "en" ? "zh" : "en";
  const fake = fakePort(target === "en" ? "zh" : "en");
  try {
    configureLocalePreference(fake.port);
    setLocale(target);
    assert.deepEqual(fake.writes, [target], "写走的是装上的端口，不是真实适配器");
    assert.equal(fake.current(), target);
  } finally {
    configureLocalePreference(undefined);
    setLocale(original);
  }
});

test("卸掉端口之后 i18n 仍然可用（纯模块单测没有存储也能跑）", () => {
  const original = getLocale();
  try {
    configureLocalePreference(undefined);
    setLocale("en");
    assert.equal(getLocale(), "en");
    assert.equal(typeof t("settings.title"), "string", "语言切换后翻译仍能取到（缺失则回退 key）");
  } finally {
    setLocale(original);
  }
});

test("契约在 contracts 层声明（foundation 不许向上依赖 protocol）", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const contracts = readFileSync(join(root, "src/types/protocols.ts"), "utf8");
  assert.match(contracts, /export interface LocalePreferencePort/, "端口契约必须在 contracts 层");
  const i18n = readFileSync(join(root, "src/i18n/index.ts"), "utf8");
  assert.match(
    i18n,
    /from "\.\.\/types\/protocols\.ts"/,
    "i18n 必须向下（contracts）拿契约，不能自己再声明一份",
  );
  assert.ok(
    !/export interface LocalePreferencePort/.test(i18n),
    "i18n 里不该再有一份接口声明（会与 contracts 层漂移）",
  );
});