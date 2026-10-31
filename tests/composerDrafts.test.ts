/**
 * Composer 草稿的会话级仓储（纯数据层）。
 *
 * 背景：composer 正文活在 contentEditable 的 DOM 里，切会话不会卸载这块 DOM；不按会话
 * 停放草稿，A 里打了一半的字会原样出现在 B 的输入框里（用户反馈）。
 *
 * 这里只锁仓储语义：按会话隔离、空草稿不落库、take 只给一次、附件预览地址能枚举到
 * （切走后不能被回收）、会话不存在时能被裁剪掉。DOM 的存取在 `useAppWiring`，
 * 真行为由 e2e（`composerDrafts.spec.ts`）验证。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createComposerDraftStore, isComposerDraftEmpty } from "../src/app/composerDrafts.ts";
import type { ComposerPart } from "../src/app/AppComposerHelpers";

function text(value: string): ComposerPart {
  return { kind: "text", text: value };
}

function attachment(id: string, previewUrl = `blob:${id}`): ComposerPart {
  return {
    kind: "attachment",
    attachment: {
      id,
      name: `${id}.png`,
      mimeType: "image/png",
      size: 3,
      kind: "image",
      previewUrl,
    },
  };
}

function skill(id: string): ComposerPart {
  return {
    kind: "capability",
    capability: { id, kind: "skill", name: `${id} skill`, description: "", instanceId: `${id}-instance` },
  };
}

test("两个会话各存各的完整草稿：正文、附件、技能徽标都不串", () => {
  const store = createComposerDraftStore();
  store.save("/sessions/a.jsonl", [text("A 的草稿"), attachment("a-badge"), skill("a-skill")]);
  store.save("/sessions/b.jsonl", [text("B 的草稿")]);

  assert.deepEqual(store.take("/sessions/b.jsonl"), [text("B 的草稿")]);
  const a = store.take("/sessions/a.jsonl");
  assert.equal(a?.length, 3);
  assert.deepEqual(a?.[0], text("A 的草稿"));
  assert.equal(a?.[1].kind === "attachment" ? a[1].attachment.id : null, "a-badge");
  assert.equal(a?.[2].kind === "capability" ? a[2].capability.id : null, "a-skill");

  // 取走即删除：同一份草稿不会被两个画面同时持有。
  assert.equal(store.take("/sessions/a.jsonl"), undefined);
  assert.equal(store.size(), 0);
});

test("空 / 纯空白草稿不落库（切回空会话时输入框是干净的）", () => {
  const store = createComposerDraftStore();
  store.save("/sessions/a.jsonl", [text("先有内容")]);
  assert.equal(store.has("/sessions/a.jsonl"), true);

  store.save("/sessions/a.jsonl", []);
  assert.equal(store.has("/sessions/a.jsonl"), false);

  store.save("/sessions/a.jsonl", [text("   \n\t")]);
  assert.equal(store.has("/sessions/a.jsonl"), false);
  assert.equal(store.size(), 0);
});

test("只有空白文本但带徽标仍算草稿", () => {
  const store = createComposerDraftStore();
  store.save("/sessions/a.jsonl", [text("  "), attachment("only-badge")]);
  assert.equal(store.has("/sessions/a.jsonl"), true);
  assert.equal(isComposerDraftEmpty([text("  "), attachment("x")]), false);
});

test("停放草稿的附件预览地址可枚举（切走后 URL 不能被回收）", () => {
  const store = createComposerDraftStore();
  store.save("/sessions/a.jsonl", [text("x"), attachment("a1"), attachment("a2", "blob:a2")]);
  store.save("/sessions/b.jsonl", [attachment("b1")]);

  assert.deepEqual(store.previewUrls().sort(), ["blob:a1", "blob:a2", "blob:b1"]);
  // 没有附件 / 没有草稿时是空集合，调用方直接展开也安全。
  store.delete("/sessions/a.jsonl");
  store.delete("/sessions/b.jsonl");
  assert.deepEqual(store.previewUrls(), []);
});

test("会话被删除后 prune 丢掉它的草稿并交回 parts（用于回收 blob URL）", () => {
  const store = createComposerDraftStore();
  store.save("/sessions/alive.jsonl", [text("留着")]);
  store.save("/sessions/deleted.jsonl", [text("删掉"), attachment("gone", "blob:gone")]);

  const dropped = store.prune(["/sessions/alive.jsonl"]);
  assert.deepEqual(dropped.map((part) => part.kind), ["text", "attachment"]);
  assert.equal(store.has("/sessions/deleted.jsonl"), false);
  assert.deepEqual(store.take("/sessions/alive.jsonl"), [text("留着")]);
});

test("同一会话再次保存会整体覆盖（不叠加旧内容）", () => {
  const store = createComposerDraftStore();
  store.save("/sessions/a.jsonl", [text("旧")]);
  store.save("/sessions/a.jsonl", [text("新")]);
  assert.deepEqual(store.take("/sessions/a.jsonl"), [text("新")]);
});