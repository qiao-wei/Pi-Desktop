/**
 * 「流式中不跟随，视口里的工具/思考卡完成时自动折叠 → 画面跳一下」的回归测试。
 *
 * 为什么浏览器自己不会修好这件事：`.aui-thread-viewport` 在 `ChatThread` 接管位置期间
 * 被钉成 `overflow-anchor: none`（见 styles.css 与 threadMessageGeometry.test.ts），原生
 * 滚动锚定整段会话都是关着的；而 `useScrollPositionLock` 只在**手动**点 chevron 时被调用，
 * 状态机自动 `setOpen(false)` 走的是另一条路，谁都没管过它。
 *
 * 这里的规则是「只在没人看得见的地方释放高度」：折叠要么在视口下方、要么在贴底时被
 * `scrollTop` clamp 掉，否则就推迟到读者把这块滚出视野。所以本文件测两件事：
 *   1. 纯几何判定（`src/shared/collapseGate.ts`）—— 真契约，逐条数值边界；
 *   2. 接线（`thread.aui.tsx` 等）—— 每个自动折叠点必须经过闸门，且闸门只读不写滚动位置。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  COLLAPSE_GATE_TOLERANCE_PX,
  canCommitCollapse,
  distanceToBottom,
  shouldHoldCollapsed,
  shouldHoldDisclosure,
  type CollapseGateGeometry,
} from "../src/shared/collapseGate.ts";

// --- 场景几何 -----------------------------------------------------------------
// 一个 800px 高的会话视口（顶边在 40px 自绘标题栏下面），线程总高 5000px。
const VIEWPORT = {
  containerTop: 40,
  containerBottom: 840,
  clientHeight: 800,
  scrollHeight: 5000,
};

/** 贴底（跟随态）的 scrollTop。 */
const AT_BOTTOM = VIEWPORT.scrollHeight - VIEWPORT.clientHeight; // 4200

function geometry(
  over: Partial<CollapseGateGeometry> & Pick<CollapseGateGeometry, "blockTop" | "blockBottom">,
): CollapseGateGeometry {
  return { scrollTop: 1500, ...VIEWPORT, ...over };
}

test("a block that overlaps the viewport never releases its height mid-thread", () => {
  // 读者停在半路，刚结束的工具卡正好压在他视线里：折叠会把下面的文字整段往上抽。
  const inView = geometry({ blockTop: 300, blockBottom: 620 });
  assert.equal(canCommitCollapse(inView), false);
  assert.equal(shouldHoldCollapsed(inView), true);
  // 只露出触发行（面板主体在视口外）同样算重叠：闸门按整块判断，宁保守。
  assert.equal(canCommitCollapse(geometry({ blockTop: 800, blockBottom: 1400 })), false);
});

test("a block fully below the fold collapses right away", () => {
  // 折叠发生在视口下方，可见带一点都不会动 —— 跟是否贴底无关。
  assert.equal(canCommitCollapse(geometry({ blockTop: 840, blockBottom: 1200 })), true);
  // 容差边界：还差 5px 才到折线以下 → 仍然算看得见。
  assert.equal(
    canCommitCollapse(geometry({ blockTop: VIEWPORT.containerBottom - COLLAPSE_GATE_TOLERANCE_PX - 1, blockBottom: 1200 })),
    false,
  );
});

test("a block above the fold is only safe for a reader pinned at the bottom", () => {
  // 视口的可见带是 [40, 840]，所以“完全在上方”意味着 blockBottom 不超过 40+容差。
  const aboveFold = geometry({ blockTop: -160, blockBottom: 30 });
  // 非跟随（停在半路）：抽掉上方的内容不会 clamp scrollTop，等价于把读者的文字往上拽。
  assert.equal(
    distanceToBottom({ ...aboveFold }),
    VIEWPORT.scrollHeight - 1500 - VIEWPORT.clientHeight,
  );
  assert.equal(canCommitCollapse(aboveFold), false);
  // 跟随态：贴底时高度被抽掉，浏览器把 scrollTop clamp 到新范围，屏幕上还是同一段。
  assert.equal(canCommitCollapse(geometry({ ...aboveFold, scrollTop: AT_BOTTOM })), true);
  // 差 5px 就不算贴底（离底部还有 5px 时，抽高度会真的挪动画面）。
  assert.equal(
    canCommitCollapse(
      geometry({ ...aboveFold, scrollTop: AT_BOTTOM - COLLAPSE_GATE_TOLERANCE_PX - 1 }),
    ),
    false,
  );
});

test("following the run still tidies itself up the moment it settles", () => {
  // 贴底的读者看的是最后一行，clamp 把它钉在视口底边，所以“结束就收起”不该被推迟：
  // 闸门只服务向上滚去看别处的读者（他们才把这次折叠当成位移）。
  const inView = geometry({ blockTop: 300, blockBottom: 620, scrollTop: AT_BOTTOM });
  assert.equal(canCommitCollapse(inView), true);
  // 同一个块，停在半路就得等。
  assert.equal(canCommitCollapse(geometry({ blockTop: 300, blockBottom: 620 })), false);
});

test("shouldHoldCollapsed is the exact inverse of canCommitCollapse", () => {
  for (const candidate of [
    geometry({ blockTop: 300, blockBottom: 620 }),
    geometry({ blockTop: 840, blockBottom: 1200 }),
    geometry({ blockTop: -300, blockBottom: -40 }),
    geometry({ blockTop: -300, blockBottom: -40, scrollTop: AT_BOTTOM }),
    geometry({ blockTop: 300, blockBottom: 620 }),
    geometry({ blockTop: 300, blockBottom: 620, scrollTop: AT_BOTTOM }),
  ]) {
    assert.equal(shouldHoldCollapsed(candidate), !canCommitCollapse(candidate));
  }
});

// --- 闸门状态机的决策（React 之外的那一半） -------------------------------------

test("the gate only ever defers a collapse it wants to commit", () => {
  const visible = geometry({ blockTop: 300, blockBottom: 620 });
  // 想开着的块永远不需要 hold。
  assert.equal(shouldHoldDisclosure({ desiredOpen: true, geometry: visible }), false);
  // 读者手动动过这块：他的选择最大，自动折叠不得再插手。
  assert.equal(
    shouldHoldDisclosure({ desiredOpen: false, manual: true, geometry: visible }),
    false,
  );
  // 看得见 → hold；看不见 → 放行。
  assert.equal(shouldHoldDisclosure({ desiredOpen: false, geometry: visible }), true);
  assert.equal(
    shouldHoldDisclosure({
      desiredOpen: false,
      geometry: geometry({ blockTop: 900, blockBottom: 1200 }),
    }),
    false,
  );
  // 量不到几何（refs 还没挂上/已脱离文档/不在任何滚动容器里）→ 保守地 hold，下一帧再判。
  assert.equal(shouldHoldDisclosure({ desiredOpen: false, geometry: null }), true);
});

// --- 接线：每个自动折叠点都得过闸门 --------------------------------------------

const threadAui = readFileSync(
  new URL("../src/components/assistant-ui/elements/thread.aui.tsx", import.meta.url),
  "utf8",
);
const deferredCollapse = readFileSync(
  new URL("../src/components/assistant-ui/elements/deferredCollapse.ts", import.meta.url),
  "utf8",
);

/** 顶层 `const NAME` 到下一个顶层 `const` 之间的声明体。 */
function declaration(name: string): string {
  const start = threadAui.indexOf(`const ${name}`);
  assert.ok(start >= 0, `${name} is gone from thread.aui.tsx`);
  const next = threadAui.indexOf("\nconst ", start + 1);
  return threadAui.slice(start, next === -1 ? threadAui.length : next);
}

/**
 * 运行中会自己从开变关的三个点：工具卡、思考面板、工具组。
 * 只要有一处把状态机的 false 直接写进 DOM，视口内就会出现位移。
 *
 * `PiDesktopProcessGroup` 不在列表里：它的“自动”不是运行中的状态翻转，而是整轮结束时
 * 本来要把全部过程块重包进一个以折叠态挂载的组（新面板没有旧高度可保持，CSS 还带
 * `data-[starting-style]:h-0`，hold 它等于在读者眼前把页面撑开），所以单独有用例。
 */
for (const name of [
  "AssistantToolCall",
  "AssistantReasoningGroup",
  "AssistantToolGroup",
]) {
  test(`${name} defers its auto-collapse through the gate`, () => {
    const body = declaration(name);
    assert.ok(body.includes("useDeferredCollapse("), `${name} must route through useDeferredCollapse`);
    assert.ok(
      /\bopen=\{open\}/.test(body),
      `${name} must render the gated open state, not the raw intent`,
    );
    assert.ok(
      body.includes("releaseCollapseGate()"),
      `${name} must let a manual toggle overrule a deferred collapse`,
    );
    assert.ok(
      !/setOpen\(/.test(body),
      `${name} still writes the open state directly (auto-collapse bypasses the gate)`,
    );
  });
}

test("a disclosure that merely mounts closed is never held open", () => {
  // hold 只对「已经展开、现在想收起」的块成立。挂载就 hold 会本末倒置：
  // 新面板从 h-0 动画长开，是在读者眼前把布局撑大（上一轮试过，更糟）。
  assert.match(
    deferredCollapse,
    /const \[held, setHeld\] = useState\(false\)/,
    "the gate must start disarmed, so a mounting disclosure renders as the state machine wants",
  );
  assert.ok(
    !/SettleCollapseHold|useState\(mountHold|options\.holdOnMount/.test(deferredCollapse + threadAui),
    "mount-hold cannot preserve height (the panel has no previous layout); remove it again",
  );
});

test("过程概览全程挂载，整轮结束只是意图翻转而不是重建子树", () => {
  const summary = declaration("PiDesktopProcessGroup");
  // 运行中就展开：收起才是一个能被闸门推后的变化，而不是一次 DOM 替换。
  assert.match(
    summary,
    /useDeferredCollapse\(\s*processRef,\s*messageRunning \|\| userOpen,\s*\)/,
  );
  assert.doesNotMatch(summary, /open=\{userOpen\}/);
  // 表头本身是一个占位的行：没真折叠、又不是用户自己点开时它必须隐藏，
  // 否则“结束”这一帧光是露出表头就能把读者那一行顶走。
  assert.match(summary, /const showSummaryHeader = !open \|\| userTouched/);
  assert.match(summary, /hidden=\{!showSummaryHeader\}/);
  // 没切换成概览形态前，内容容器不参与布局，保证包组前后的几何一致。
  assert.match(summary, /"flex flex-col gap-2 ps-1 pt-2" : "contents"/);
  // 分组边界不再等运行结束才成立。
  assert.doesNotMatch(threadAui, /if \(messageRunning\) return -1/);
});

// --- 完成瞬间的锚点：整组收起时把答案按在原地 --------------------------------

test("the completion lock anchors on a surviving text block, not the message root", () => {
  const chatThread = readFileSync(
    new URL("../src/features/chat/ChatThread.tsx", import.meta.url),
    "utf8",
  );
  // 锚点先细化到块，再退回消息根。
  assert.match(
    chatThread,
    /anchor: block \?\? root,\n\s*anchorTop: \(block \?\? root\)/,
    "the snapshot must prefer the refined block",
  );
  assert.match(
    chatThread,
    /pickAnchorBlock\(candidates, \{ top: band\.top, bottom: band\.bottom \}\)/,
    "the block is chosen from the bubble's own top-level blocks",
  );
  // 块被重新包裹弄没了就先换回根，绝对偏移是最后手段。
  const hold = chatThread.slice(
    chatThread.indexOf("const holdPosition = ()"),
    chatThread.indexOf("let active = true"),
  );
  assert.ok(
    hold.indexOf("anchor?.isConnected") < hold.indexOf("anchorRoot?.isConnected"),
    "the block outranks the message root",
  );
  assert.ok(
    hold.indexOf("anchorRoot?.isConnected") < hold.indexOf("previousSnapshot.scrollTop"),
    "the absolute offset is the last resort, not the first guess",
  );
  // 根锁仍然只能给「不在底部」的读者用（贴底时靠 clamp，不需要补偿）。
  assert.match(
    chatThread,
    /if \(!wasStreamingRef\.current \|\| isStreaming \|\| !previousSnapshot \|\| previousSnapshot\.wasAtBottom\)/,
  );
});

test("gated disclosures can actually be measured", () => {
  for (const file of [
    "../src/components/assistant-ui/elements/tool-call.tsx",
    "../src/components/assistant-ui/elements/tool-group.aui.tsx",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /ref=\{composedRef\}/, `${file} must expose its root to the gate`);
    assert.match(source, /ref\?: Ref<HTMLDivElement>/, `${file} must accept the gate's ref`);
  }
});

test("the gate reads geometry and never writes the scroll position", () => {
  // 这是它跟 `useScrollPositionLock`（补偿式）的分工：延迟折叠是纯只读操作，
  // 所以它不会和会话切换的恢复窗口、贴底 pump、还在提交中的滚动甩动抢方向盘。
  assert.ok(
    !/\.scrollTop\s*=[^=]/.test(deferredCollapse),
    "deferredCollapse must not assign scrollTop - it schedules the shift away, it does not undo it",
  );
  assert.ok(!/\.scrollTo\(/.test(deferredCollapse), "deferredCollapse must not scroll");
  assert.ok(!/\.scrollBy\(/.test(deferredCollapse), "deferredCollapse must not scroll");
  assert.ok(
    deferredCollapse.includes("container.addEventListener(\"scroll\", schedule"),
    "the gate re-judges on scroll, which is how a held collapse eventually lands",
  );
});
