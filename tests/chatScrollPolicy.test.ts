import test from "node:test";
import assert from "node:assert/strict";

import {
  BOTTOM_TOLERANCE_PX,
  anchorScrollCorrection,
  followingFromGeometry,
  resolveFollowing,
  SCROLL_DEADBAND_PX,
  SETTLED_FRAMES,
  isLayoutSettled,
  nextScrollTarget,
  nextStableFrames,
  pickAnchorBlock,
  shouldCloseEntryWindow,
} from "../src/shared/chatScrollPolicy.ts";

/**
 * 切换会话时那一下"轻微上下抖 + 像在读东西"的回归测试。
 *
 * 抖动的来源是恢复窗口每帧重锚：`content-visibility:auto` 让列表高度逐帧变化 1~2px，
 * 于是每帧都写一次 scrollTop。规则是：小于死区的漂移当作排版噪声，布局连续稳定就收窗。
 */

test("nextScrollTarget：死区内的漂移不写视口", () => {
  assert.equal(nextScrollTarget(165, 167, 325), null);
  assert.equal(nextScrollTarget(165, 165 + SCROLL_DEADBAND_PX, 325), null);
  assert.equal(nextScrollTarget(165, 165 + SCROLL_DEADBAND_PX + 1, 325), 166 + SCROLL_DEADBAND_PX);
});

test("nextScrollTarget：目标先被夹进可滚动范围，边界不外溢", () => {
  assert.equal(nextScrollTarget(0, 9999, 325), 325);
  assert.equal(nextScrollTarget(300, -50, 325), 0);
  // 内容为空（max=0）时不写，也不会算出负数
  assert.equal(nextScrollTarget(0, 10, 0), null);
  assert.equal(nextScrollTarget(0, 10, -40), null);
});

test("nextStableFrames：真实增长会重新计时，噪声以内算稳定", () => {
  assert.equal(nextStableFrames(null, 1000, 0), 1, "第一帧没有基准，算不稳定");
  assert.equal(nextStableFrames(1000, 1001, 3), 4, "1px 属于估计值抖动");
  assert.equal(nextStableFrames(1000, 1200, 4), 1, "长高了就要继续守着位置");
  assert.equal(nextStableFrames(1000, 900, 4), 1, "缩掉同样要重看");
});

test("isLayoutSettled：连续稳定满 SETTLED_FRAMES 帧才算布局稳定", () => {
  assert.equal(isLayoutSettled(SETTLED_FRAMES - 1), false);
  assert.equal(isLayoutSettled(SETTLED_FRAMES), true);
});

// ---------------------------------------------------------------- 是否还在跟读

test.describe("followingFromGeometry", () => {
  test("at the end of the thread means still following", () => {
    assert.equal(followingFromGeometry({ scrollTop: 2859, maxScrollTop: 2859, hasContent: true }), true);
  });

  test("a few pixels of rounding do not count as leaving", () => {
    assert.equal(
      followingFromGeometry({ scrollTop: 2859 - BOTTOM_TOLERANCE_PX, maxScrollTop: 2859, hasContent: true }),
      true,
    );
  });

  test("scrolled up means the reader stopped following", () => {
    assert.equal(followingFromGeometry({ scrollTop: 1287, maxScrollTop: 2859, hasContent: true }), false);
  });

  test("an un-laid-out thread cannot answer, so it must not overwrite the flag", () => {
    // The failure this guards: the scroller is empty for the first frames after a
    // switch, and reading "not at the end" from that dropped every session's
    // follow and left the next visit scrolled to a stale offset.
    assert.equal(followingFromGeometry({ scrollTop: 0, maxScrollTop: 0, hasContent: true }), null);
    assert.equal(followingFromGeometry({ scrollTop: 4, maxScrollTop: 4, hasContent: false }), null);
  });
});

// ---------------------------------------------------------------- 入场窗口收尾

const WINDOW = {
  openedAt: 1000,
  minOpenMs: 150,
  windowMs: 750,
  rowsGraceMs: 400,
  stableFrames: SETTLED_FRAMES,
};

test("气泡还没挂载时，布局稳定也不能收尾（那正是画出一帧空线程的时候）", () => {
  assert.equal(
    shouldCloseEntryWindow({ ...WINDOW, now: 1600, rowsMountedAt: null, stableFrames: SETTLED_FRAMES }),
    false,
  );
});

test("气泡一直没来也要有上限", () => {
  assert.equal(shouldCloseEntryWindow({ ...WINDOW, now: 1000 + 750 + 400, rowsMountedAt: null }), true);
});

test("挂载后布局稳定且过了最短时长才收尾", () => {
  const mounted = 1400;
  assert.equal(
    shouldCloseEntryWindow({ ...WINDOW, now: 1450, rowsMountedAt: mounted, stableFrames: SETTLED_FRAMES }),
    false,
    "挂载后不足最短时长，继续锁住",
  );
  assert.equal(
    shouldCloseEntryWindow({ ...WINDOW, now: 1600, rowsMountedAt: mounted, stableFrames: SETTLED_FRAMES }),
    true,
  );
});

test("挂载后仍受自身窗口上限约束", () => {
  assert.equal(shouldCloseEntryWindow({ ...WINDOW, now: 1400 + 750, rowsMountedAt: 1400, stableFrames: 0 }), true);
});

/**
 * 一轮回答结束时那一下「答案往上跳」的锚点选择。
 *
 * 结束锁每帧把锚点推回原位，可它原来钉的是整条消息根节点：过程组是在根节点
 * *内部*收起来的，根的顶边一动不动，于是锁什么都没补。细化到「气泡里第一个还
 * 在视口内、且自身不会被折叠的顶层块」（也就是答案正文）才补得对。
 */
const BAND = { top: 40, bottom: 840 };

test("锚点跳过会被折叠的块，落在正文上", () => {
  const candidates = [
    // 过程组：整块都在视口里，但它一收就是几百像素，不能当锚。
    { top: 60, bottom: 520, hasDisclosure: true },
    // 答案第一段：跨过视口上沿 —— 正是读者在看的那一段。
    { top: 540, bottom: 900, hasDisclosure: false },
    { top: 900, bottom: 1200, hasDisclosure: false },
  ];
  assert.equal(pickAnchorBlock(candidates, BAND), 1);
});

test("包裹折叠块的 chain-of-thought 容器同样不能当锚", () => {
  // 折叠发生在*里面*，容器自己的顶边不动，锚在它上面等于没锚。
  const candidates = [
    { top: 60, bottom: 520, hasDisclosure: true },
    { top: 540, bottom: 700, hasDisclosure: false },
  ];
  assert.equal(pickAnchorBlock(candidates, BAND), 1);
});

test("视口里只剩折叠块时退回消息根（返回 null）", () => {
  const candidates = [
    { top: 60, bottom: 520, hasDisclosure: true },
    { top: 520, bottom: 800, hasDisclosure: true },
  ];
  assert.equal(pickAnchorBlock(candidates, BAND), null);
});

test("完全不在视口里的正文不能被当锚点", () => {
  const candidates = [
    { top: 60, bottom: 520, hasDisclosure: true },
    // 正文整段还在折线以下：钉它会为了一个看不见的块去挪视口。
    { top: 900, bottom: 1300, hasDisclosure: false },
  ];
  assert.equal(pickAnchorBlock(candidates, BAND), null);
});

test("贴住视口上沿的那几个像素不算还在读", () => {
  // bottom 只比 band.top 多 1px（默认边距 2px）→ 视为已经滚出视野。
  assert.equal(pickAnchorBlock([{ top: -400, bottom: 41, hasDisclosure: false }], BAND), null);
  assert.equal(pickAnchorBlock([{ top: -400, bottom: 43, hasDisclosure: false }], BAND), 0);
});

// ------------------------------------------------- 窗口缩放时的阅读位置

test.describe("anchorScrollCorrection", () => {
  test("锚点还在原处就不写视口", () => {
    assert.equal(anchorScrollCorrection(120, 120), null);
    assert.equal(anchorScrollCorrection(120, 120 + SCROLL_DEADBAND_PX), null);
    assert.equal(anchorScrollCorrection(120, 120 - SCROLL_DEADBAND_PX), null);
  });

  test("超出死区的漂移按差值补偿（正负都要）", () => {
    // 重排后锚点跑到了下面，说明内容整体上移，视口要跟着下移。
    assert.equal(anchorScrollCorrection(180, 120), 60);
    assert.equal(anchorScrollCorrection(60, 120), -60);
  });

  test("没有锚点（还没持久化过 / 已卸载）时不动", () => {
    assert.equal(anchorScrollCorrection(null, 120), null);
    assert.equal(anchorScrollCorrection(120, null), null);
    assert.equal(anchorScrollCorrection(null, null), null);
  });
});

test.describe("resolveFollowing", () => {
  const base = { derived: false as boolean | null, following: true, grew: true, userInputAgeMs: 1000, graceMs: 400 };

  test("几何算不出来（空线程 / 切换中）时保持未知", () => {
    assert.equal(resolveFollowing({ ...base, derived: null }), null);
  });

  test("几何说到头了就是跟随，跟原来的标志无关", () => {
    assert.equal(resolveFollowing({ ...base, derived: true, following: false }), true);
  });

  test("几何说离开了底部，且本来就没在跟随 → 不跟随", () => {
    assert.equal(resolveFollowing({ ...base, following: false }), false);
  });

  test("内容在长高时，跟随可以压过几何（运行中 token 一直把底部推远）", () => {
    assert.equal(resolveFollowing(base), true);
  });

  test("刚被用户滚过就先听用户，不做增长豁免", () => {
    assert.equal(resolveFollowing({ ...base, userInputAgeMs: 100 }), false);
  });

  test("内容没长高就不再粘住跟随——拖滚动条到中段后，窗口一缩放就会被拽回底部", () => {
    assert.equal(resolveFollowing({ ...base, grew: false }), false);
  });
});
