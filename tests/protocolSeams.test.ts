/**
 * The seam registry is only worth having if it stays true. `scripts/architecture/check.mjs` has the
 * same checks as rule `protocol-seam`; this file keeps them inside `npm test` too, so a refactor that
 * quietly drops a swap door fails the test suite as well as the architecture gate.
 *
 * The interesting assertion is the last one: a boundary may be declared in the policy **without** being
 * proven swappable, but then it must say why (`seamGap`), and it shows up in the docs' debt column.
 * Silently claiming "we have a protocol" for something nobody can swap is what this is guarding against.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PROTOCOL_SEAMS, PROTOCOL_SEAM_IDS } from "../src/shared/protocol/seams.ts";
import { loadPolicy } from "../scripts/architecture/check.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const policy = loadPolicy(root);

test("每条接缝的文件都存在（契约 / 真实现 / 插槽 / 装配点 / 证据测试）", () => {
  for (const seam of PROTOCOL_SEAMS) {
    for (const [field, path] of [
      ["contract", seam.contract],
      ["production", seam.production],
      ["portModule", seam.portModule],
      ["assemblyPoint", seam.assemblyPoint],
      ["swapTest", seam.swapTest],
    ] as const) {
      assert.ok(existsSync(join(root, path)), `接缝 ${seam.id} 的 ${field} 不存在：${path}`);
    }
  }
});

test("插槽模块必须导出换实现函数（不然只是「有接口」）", () => {
  for (const seam of PROTOCOL_SEAMS) {
    const source = readFileSync(join(root, seam.portModule), "utf8");
    const defined =
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${seam.install}\\b`).test(source) ||
      new RegExp(`export\\s+const\\s+${seam.install}\\b`).test(source);
    assert.ok(defined, `${seam.portModule} 必须导出 ${seam.install}()`);
  }
});

test("每条接缝都有测试真的调用换实现函数（可替换性要有证据）", () => {
  for (const seam of PROTOCOL_SEAMS) {
    const source = readFileSync(join(root, seam.swapTest), "utf8");
    assert.match(
      source,
      new RegExp(`(?<![\\w$])${seam.install}\\s*\\(`),
      `${seam.swapTest} 必须真的调用 ${seam.install}() —— 只声明接口不算协议`,
    );
  }
});

test("生产装配点（与插槽不同文件时）必须真的装配", () => {
  for (const seam of PROTOCOL_SEAMS) {
    if (seam.assemblyPoint === seam.portModule) continue;
    const source = readFileSync(join(root, seam.assemblyPoint), "utf8");
    assert.match(
      source,
      new RegExp(`(?<![\\w$])${seam.install}\\s*\\(`),
      `${seam.assemblyPoint} 必须调用 ${seam.install}()`,
    );
  }
});

test("接缝登记表与 policy.protocols 一一对应（两处清单不许各自漂移）", () => {
  const declaredSeams = policy.protocols.filter((protocol) => protocol.seam).map((protocol) => protocol.id);
  assert.deepEqual(
    [...declaredSeams].sort(),
    [...PROTOCOL_SEAM_IDS].sort(),
    "policy 里声明了 seam 的协议与 seams.ts 的登记表必须一致",
  );
});

test("policy 里没有 seam 的协议必须写明缺口原因（不许含糊地宣称有协议）", () => {
  const unproven = policy.protocols.filter((protocol) => !protocol.seam);
  for (const protocol of unproven) {
    assert.ok(
      typeof protocol.seamGap === "string" && protocol.seamGap.length > 20,
      `${protocol.id} 没有 seam，就必须在 policy 里写清 seamGap（为什么还不可替换）`,
    );
  }
  // 当前只有一个：桥 ↔ SQLite。这条断言让「悄悄多一个未证明协议」变成可见变化。
  assert.deepEqual(
    unproven.map((protocol) => protocol.id),
    ["storage"],
    "未证明可替换的协议清单变了：要么补 seam，要么更新这条断言并说明",
  );
});