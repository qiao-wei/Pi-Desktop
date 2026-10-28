import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_SCROLL_MASK_STATE,
  SCROLL_BOTTOM_LOCK_PX,
  isScrolledToBottom,
  scrollBottomDistance,
  scrollMaskState,
  scrollMaskStyle,
} from "../src/shared/scrollMask.ts";

/* -------------------------------------------------------------------------- */
/* 跟随 / 不跟随的判据                                                        */
/* -------------------------------------------------------------------------- */

test("贴底判定留一点容差：4px 以内仍算「在看最新」", () => {
  const metrics = { clientHeight: 240, scrollHeight: 1_000, scrollTop: 760 };
  assert.equal(scrollBottomDistance(metrics), 0);
  assert.equal(isScrolledToBottom(metrics), true);

  assert.equal(isScrolledToBottom({ ...metrics, scrollTop: 760 - SCROLL_BOTTOM_LOCK_PX }), true);
  assert.equal(
    isScrolledToBottom({ ...metrics, scrollTop: 760 - SCROLL_BOTTOM_LOCK_PX - 1 }),
    false,
    "超过容差就是读者自己往上滚了 —— 这时必须停止跟随",
  );
});

test("内容还没撑满容器时永远算贴底，距离不会是负数", () => {
  assert.equal(scrollBottomDistance({ clientHeight: 240, scrollHeight: 100, scrollTop: 0 }), 0);
  assert.equal(isScrolledToBottom({ clientHeight: 240, scrollHeight: 100, scrollTop: 0 }), true);
});

/* -------------------------------------------------------------------------- */
/* 上下渐隐                                                                    */
/* -------------------------------------------------------------------------- */

test("没有裁切就不要蒙版（内容全部可见时不该出现渐隐）", () => {
  assert.deepEqual(scrollMaskState({ clientHeight: 240, scrollHeight: 200, scrollTop: 0 }), EMPTY_SCROLL_MASK_STATE);
  assert.equal(scrollMaskStyle(EMPTY_SCROLL_MASK_STATE), undefined);
});

test("蒙版跟着滚动位置走：中间两端都淡，贴底只淡上面，贴顶只淡下面", () => {
  const base = { clientHeight: 240, scrollHeight: 1_000 };
  assert.deepEqual(scrollMaskState({ ...base, scrollTop: 400 }), { showTop: true, showBottom: true });
  assert.deepEqual(scrollMaskState({ ...base, scrollTop: 760 }), { showTop: true, showBottom: false });
  assert.deepEqual(scrollMaskState({ ...base, scrollTop: 0 }), { showTop: false, showBottom: true });

  const both = scrollMaskStyle({ showTop: true, showBottom: true });
  assert.ok(both && String(both.maskImage).includes("transparent 0px"));
  assert.ok(both && String(both.maskImage).includes("transparent 100%"));

  const bottomOnly = scrollMaskStyle({ showTop: false, showBottom: true });
  assert.ok(bottomOnly && String(bottomOnly.maskImage).startsWith("linear-gradient(to bottom, black 0px"));

  // 具体像素不是契约，但两端的方向是（贴底时上缘才该淡）。
  assert.notEqual(scrollMaskStyle({ showTop: true, showBottom: false })?.maskImage, bottomOnly?.maskImage);
});