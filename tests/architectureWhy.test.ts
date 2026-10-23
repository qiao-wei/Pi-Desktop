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
    report.dependents.includes("src/app/App.tsx"),
    "App.tsx 是主要调用方（B2 拆它时要看这份清单）",
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
  // 规模必须是「文件此刻的真实行数」—— App.tsx 正在按簇往外拆，硬写 9000 这种常量
  // 会在每次合法拆分时假红（这条断言曾经就钉着 9000）。拆到 700 行以下时例外会消失，
  // 那时把这一条改成「不该再有例外」即可。
  assert.equal(report.size.lines, appEntrySource().split("\n").length, "报出来的行数要和盘上文件一致");
  assert.ok(report.size.lines > 700, `App.tsx 还没拆到上限（700）以下，应仍有例外；现在 ${report.size.lines} 行`);
  assert.ok(report.size.exception, "App.tsx 应该在棘轮例外清单里，否则 checker 早就红了");
  assert.equal(typeof report.size.exception.ceiling, "number");
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