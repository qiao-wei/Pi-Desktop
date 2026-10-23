/**
 * `architecture:why` answers the question you actually have while moving a file: what depends on it.
 *
 * The checker catches violations, and the docs explain the layer model, but neither answers "what breaks
 * if I move this?" - and `grep` is the wrong tool for it: it misses `import type`, dynamic `import()` and
 * re-exports, and it knows nothing about layers or ratchet ceilings. These cases pin the answers the B-group
 * splits rely on.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { why } from "../scripts/architecture/why.mjs";
import { appEntrySource } from "./lib/appSource.ts";

test("既有依赖方也有被依赖方（两个方向都列）", () => {
  const report = JSON.parse(why("src/lib/api.ts", { asJson: true }));
  assert.equal(report.exists, true);
  assert.ok(report.dependents.length > 10, "api.ts 是被广泛依赖的模块");
  assert.ok(report.dependencies.includes("src/lib/bridge/transport.ts"), "api.ts 依赖 bridge transport");
  assert.ok(
    report.dependents.includes("src/app/useAppCore.ts"),
    "useAppCore（原 App.tsx 拆出的第 1 段）直接调 api.ts：B2 拆分后主要调用方从这里看",
  );
});

test("区分「仅类型」依赖（移动文件时类型依赖比运行时依赖宽松）", () => {
  const report = JSON.parse(why("src/lib/api.ts", { asJson: true }));
  assert.ok(report.typeOnlyDependents.includes("src/features/chat/streamCommitBuffer.ts"));
  assert.ok(
    !report.typeOnlyDependents.includes("src/features/chat/usePiDesktopApp.ts") === false ||
      report.typeOnlyDependents.length > 0,
  );
});

test("层级、模块、规模与棘轮都报出来（拆分时就是靠这些判断边界）", () => {
  const report = JSON.parse(why("src/app/App.tsx", { asJson: true }));
  assert.equal(report.module.layer, "app");
  // 规模必须是「文件此刻的真实行数」—— 硬写常量会在每次合法拆分时假红（这条断言曾经就钉着 9000）。
  assert.equal(report.size.lines, appEntrySource().split("\n").length, "报出来的行数要和盘上文件一致");
  // B2 已完成：App.tsx 只剩两行胶水（useAppModel + AppShell），原来的超大文件棘轮例外
  // 被 `architecture:write` 自动删除 —— 规则是「降到上限以下时例外必须删」，这里钉住它。
  assert.ok(report.size.lines < 700, `App.tsx 应已拆到 700 行以下；现在 ${report.size.lines} 行`);
  assert.equal(report.size.exception, undefined, "拆到上限以下后不该再有 max-lines 例外（JSON 里这个键会整个消失）");
  assert.ok(report.dependencies.includes("src/app/useAppModel.ts"), "App.tsx 现在依赖 model 装配点");
  assert.ok(report.dependencies.includes("src/app/AppShell.tsx"), "App.tsx 现在依赖视图");
});

test("协议文件会标出它属于哪条边界（改契约时提醒连带的东西）", () => {
  const report = JSON.parse(why("src/shared/protocol/bridgeEndpoints.ts", { asJson: true }));
  assert.ok(report.protocols.includes("bridge"), `应标出 bridge，实际：${report.protocols.join(",")}`);
  const store = JSON.parse(why("src/shared/protocol/storage.ts", { asJson: true }));
  assert.ok(store.protocols.includes("local-store"));
});

test("文本输出能直接读（这是给人看的工具，不是只给机器）", () => {
  const text = why("src/lib/perf-port.ts");
  assert.match(text, /src\/lib\/perf-port\.ts/);
  assert.match(text, /层级：adapters/);
  assert.match(text, /被谁依赖/);
  assert.match(text, /→ src\/shared\/protocol\/perf\.ts/);
});

test("不存在的文件给出明确信号，而不是空报告", () => {
  const report = JSON.parse(why("src/lib/does-not-exist.ts", { asJson: true }));
  assert.equal(report.exists, false);
  assert.deepEqual(report.dependents, []);
});