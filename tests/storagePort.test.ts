/**
 * Boundary `storage`: the port is a port, and the real call sites go through it.
 *
 * The point of these cases is not that a Map works. It is:
 *
 * 1. `loadUiPreferences` / `saveUiPreferences` / `localPersistence` - the real, shipped call sites -
 *    read and write whatever store is installed, so a second host store (or a test) needs no change
 *    in those modules. Until this test existed they touched `window.localStorage` directly and could
 *    not run under `node --test` at all.
 * 2. The schema version is enforced: a store written by a newer build is refused instead of half-read,
 *    and a breaking change is a new `STORAGE_MIGRATIONS` entry rather than a silent field drop.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  STORAGE_MIGRATIONS,
  STORAGE_SCHEMA_VERSION,
  STORAGE_VERSION_KEY,
  checkStorageVersion,
  migrateStorage,
  storageMismatchMessage,
  type KeyValueStorePort,
} from "../src/shared/protocol/storage.ts";
import {
  getStoragePort,
  getStorageVersionStatus,
  installStoragePort,
  isStoreFromNewerBuild,
  setStoragePort,
  storageVersionWarning,
} from "../src/lib/storage.ts";
import { loadUiPreferences, saveUiPreferences } from "../src/lib/ui-preferences.ts";
import { localPersistence } from "../src/lib/persistence.ts";

/** A store that records every call, so "did the caller really use the port?" is observable. */
function recordingStore(): KeyValueStorePort & { calls: string[]; values: Map<string, string> } {
  const values = new Map<string, string>();
  const calls: string[] = [];
  return {
    values,
    calls,
    read(key) {
      calls.push(`read:${key}`);
      return values.get(key) ?? null;
    },
    write(key, value) {
      calls.push(`write:${key}`);
      values.set(key, value);
    },
    remove(key) {
      calls.push(`remove:${key}`);
      values.delete(key);
    },
  };
}

/** Run `fn` with `store` installed, then always put the default back. */
function withStore<T>(store: KeyValueStorePort, fn: () => T): T {
  setStoragePort(store);
  try {
    return fn();
  } finally {
    setStoragePort(null);
  }
}

test("UI 偏好读写走装上的端口（换实现不需要改 ui-preferences）", () => {
  const store = recordingStore();
  const saved = withStore(store, () => {
    saveUiPreferences({ theme: "dark", rightPanelWidth: 512 });
    return loadUiPreferences();
  });

  assert.equal(saved.theme, "dark");
  assert.equal(saved.rightPanelWidth, 512);
  assert.deepEqual(
    store.calls.filter((call) => call.startsWith("write:")),
    ["write:pi-desktop.ui.v1"],
    "写必须打在端口上",
  );
  assert.ok(store.calls.includes("read:pi-desktop.ui.v1"), "读也必须打在端口上");
  assert.equal(saved.appearance, "default", "缺省外观由默认值兜底");
});

test("上次保存的偏好与新偏好合并（不是整包覆盖）", () => {
  const store = recordingStore();
  const merged = withStore(store, () => {
    saveUiPreferences({ theme: "dark" });
    saveUiPreferences({ leftSidebarWidth: 333 });
    return loadUiPreferences();
  });
  assert.equal(merged.theme, "dark", "第二次保存不该把主题清掉");
  assert.equal(merged.leftSidebarWidth, 333);
});

test("UI 偏好里的脏数据回落到默认值（JSON 坏、外观 id 非法）", () => {
  const store = recordingStore();
  store.values.set("pi-desktop.ui.v1", "{{{ not json");
  assert.equal(withStore(store, () => loadUiPreferences()).theme, "light", "坏 JSON 不该抛，回落默认");

  store.values.set("pi-desktop.ui.v1", JSON.stringify({ theme: "dark", appearance: "../../etc/passwd" }));
  const sanitized = withStore(store, () => loadUiPreferences());
  assert.equal(sanitized.appearance, "default", "非法外观 id 被规范化");
  assert.equal(sanitized.theme, "dark", "同一份数据里的合法字段要保住");
});

test("会话快照（persistence）也走端口，读/写/清三件事都能被观察", () => {
  const store = recordingStore();
  const snapshot = { sessionId: "s1", messages: [] } as never;

  withStore(store, () => {
    assert.equal(localPersistence.load(), null, "空存储返回 null");
    localPersistence.save(snapshot);
    assert.deepEqual(localPersistence.load(), snapshot);
    localPersistence.clear();
    assert.equal(localPersistence.load(), null, "clear 之后读不到");
  });

  assert.deepEqual(store.calls, [
    "read:pi-desktop.snapshot.v1",
    "write:pi-desktop.snapshot.v1",
    "read:pi-desktop.snapshot.v1",
    "remove:pi-desktop.snapshot.v1",
    "read:pi-desktop.snapshot.v1",
  ]);
});

test("没装端口时默认端口仍可用（无 DOM 环境回落内存实现）", () => {
  assert.notEqual(getStoragePort(), undefined);
  const store = getStoragePort();
  store.write("pi-desktop.test.probe", "1");
  assert.equal(store.read("pi-desktop.test.probe"), "1");
  store.remove("pi-desktop.test.probe");
  assert.equal(store.read("pi-desktop.test.probe"), null);
});

test("schema 版本：新目录标记为 fresh 并写下当前版本", () => {
  const store = recordingStore();
  const status = migrateStorage(store);
  assert.deepEqual(status, { kind: "fresh", version: STORAGE_SCHEMA_VERSION });
  assert.equal(store.values.get(STORAGE_VERSION_KEY), String(STORAGE_SCHEMA_VERSION));
});

test("schema 版本：比本版本新时拒绝读取（前向兼容闸）", () => {
  const store = recordingStore();
  store.values.set(STORAGE_VERSION_KEY, "99");
  const status = checkStorageVersion(store);
  assert.deepEqual(status, { kind: "ahead", stored: 99, supported: STORAGE_SCHEMA_VERSION });
  const message = storageMismatchMessage(status);
  assert.match(String(message), /newer version of Pi Desktop/);
  assert.equal(storageMismatchMessage({ kind: "ok", version: 1 }), null, "正常情况不该有提示");
});

test("schema 版本：落后时按迁移表逐级跑，跑完写下新版本", () => {
  const store = recordingStore();
  store.values.set(STORAGE_VERSION_KEY, "1");
  store.values.set("old.key", "v1-value");
  const ran: string[] = [];
  const status = migrateStorage(
    store,
    [
      {
        from: 1,
        to: 2,
        why: "rename old.key",
        run(port) {
          ran.push("1->2");
          port.write("new.key", String(port.read("old.key")));
          port.remove("old.key");
        },
      },
      {
        from: 2,
        to: 3,
        why: "second step",
        run() {
          ran.push("2->3");
        },
      },
    ],
    3,
  );

  assert.deepEqual(status, { kind: "behind", from: 1, to: 3 });
  assert.deepEqual(ran, ["1->2", "2->3"], "迁移必须按顺序逐级跑");
  assert.equal(store.values.get("new.key"), "v1-value", "迁移动作真的作用在端口上");
  assert.equal(store.values.get("old.key"), undefined);
  assert.equal(store.values.get(STORAGE_VERSION_KEY), "3");
});

test("schema 版本：缺一级迁移就抛，而不是静默停在旧版本", () => {
  const store = recordingStore();
  store.values.set(STORAGE_VERSION_KEY, "1");
  assert.throws(() => migrateStorage(store, [], 3), /no storage migration from v1 to v2/);
  assert.equal(store.values.get(STORAGE_VERSION_KEY), "1", "失败时版本号不动");
});

test("迁移表现在是空的（没有破坏性变更），一旦加条目这条会提醒", () => {
  // 有意为之的断言：空表是当前事实，不是遗漏。加迁移时必须同步加测试（见上一个用例的形状）。
  assert.equal(STORAGE_MIGRATIONS.length, 0, "加迁移表条目时请同时补一条按顺序执行的测试");
  assert.equal(STORAGE_SCHEMA_VERSION, 1);
});

test("installStoragePort 只跑一次并记住状态（启动路径幂等）", () => {
  const store = recordingStore();
  setStoragePort(store);
  try {
    const first = installStoragePort();
    assert.deepEqual(first, { kind: "fresh", version: STORAGE_SCHEMA_VERSION });
    const writesAfterFirst = store.calls.filter((call) => call.startsWith("write:")).length;
    installStoragePort();
    assert.equal(
      store.calls.filter((call) => call.startsWith("write:")).length,
      writesAfterFirst,
      "第二次调用不该再写版本号",
    );
    assert.deepEqual(getStorageVersionStatus(), first);
    assert.equal(isStoreFromNewerBuild(), false);
    assert.equal(storageVersionWarning(), null);
  } finally {
    setStoragePort(null);
  }
});

test("轮到更新版本的目录时，启动检查会明确说「别读」", () => {
  const store = recordingStore();
  store.values.set(STORAGE_VERSION_KEY, String(STORAGE_SCHEMA_VERSION + 1));
  setStoragePort(store);
  try {
    installStoragePort();
    assert.equal(isStoreFromNewerBuild(), true);
    assert.match(String(storageVersionWarning()), /newer version of Pi Desktop/);
  } finally {
    setStoragePort(null);
  }
});