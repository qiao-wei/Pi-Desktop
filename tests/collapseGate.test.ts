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
    canCommitCollapse(
      geometry({
        blockTop: VIEWPORT.containerBottom - COLLAPSE_GATE_TOLERANCE_PX - 1,
        blockBottom: 1200,
      }),
    ),
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
 * 现在唯一的自动折叠点是**过程概览**（整轮结束把它收起）。行级（思考行 / 工具行）按 ZCode 保持
 * 「默认收起、只有读者点击才开」，所以它们不该出现闸门调用 —— 反过来也要钉住：闸门不能被悄悄
 * 引到行上（那会让每一行都在流式里自己开合，正是用户 2026-10-27 不要的那种）。
 */
test("自动折叠只能发生在过程概览上，行级没有这套逻辑", () => {
  const group = declaration("PiDesktopProcessGroup");
  assert.ok(
    group.includes("useDeferredCollapse("),
    "过程概览的自动折叠必须过闸门",
  );
  assert.ok(
    /\bopen=\{open\}/.test(group),
    "过程概览渲染的是闸门后的 open，而不是原始意图",
  );
  assert.ok(
    group.includes("releaseCollapseGate()"),
    "手动点击必须能取消一次被推迟的自动折叠",
  );
  assert.ok(
    !/setOpen\(/.test(group),
    "过程概览还在直接写 open（自动折叠绕过了闸门）",
  );

  for (const file of ["tool-row.tsx", "thinking-row.tsx"] as const) {
    const row = readFileSync(
      new URL(`../src/components/assistant-ui/elements/${file}`, import.meta.url),
      "utf8",
    );
    assert.ok(
      !row.includes("useDeferredCollapse("),
      `${file} 不该自己自动开合（自动折叠只有过程概览一处）`,
    );
    assert.ok(
      !/setIntentOpen\(/.test(row),
      `${file} 不该有「意图态」这层`,
    );
  }
});

test("a disclosure that merely mounts closed is never held open", () => {
  // hold 只对「已经展开、现在想收起」的块成立。挂载就 hold 会本末倒置：
  // 新面板从 h-0 动画长开，是在读者眼前把布局撑大（上一轮试过，更糟）。
  assert.match(
    deferredCollapse,
    /const \[held, setHeld\] = useState\(false\)/,
    "the gate must start disarmed, so a mounting disclosure renders as the state machine wants",
  );
  assert.ok(
    !/SettleCollapseHold|useState\(mountHold|options\.holdOnMount/.test(
      deferredCollapse + threadAui,
    ),
    "mount-hold cannot preserve height (the panel has no previous layout); remove it again",
  );
});

test("过程概览全程挂载，整轮结束只是意图翻转而不是重建子树", () => {
  const summary = declaration("PiDesktopProcessGroup");
  // 运行中就展开：收起才是一个能被闸门推后的变化，而不是一次 DOM 替换。
  assert.match(summary, /useDeferredCollapse\(\s*processRef,\s*messageRunning \|\| userOpen,\s*\)/);
  assert.doesNotMatch(summary, /open=\{userOpen\}/);
  // 表头从一开始就在流里（ZCode 的 turn header 也常驻，底下一道分隔线）：没有“到点才出现”
  // 的元素，也就没有“出现”这一下位移。旧版靠 `showSummaryHeader` 隐藏它，是为了让包组前的
  // 几何逐像素一致 —— 常驻表头把那个理由去掉了。
  assert.match(summary, /data-slot="aui_process-group"/);
  assert.match(summary, /border-border\/50 border-b pb-2/);
  assert.match(
    summary,
    /t\(messageRunning \? "process\.workingFor" : "process\.workedFor", \{ seconds \}\)/,
    "表头文案要走 i18n（ZCode 的 chat.history.workingFor / workedFor）",
  );
  // 拿不到时长就说不出「已工作 0 秒」——ZCode 在同样的情况下退回不带时长的标签。
  assert.match(summary, /t\(messageRunning \? "process\.working" : "process\.history"\)/);
  // 区域内部的间距与消息列同一个来源，行不会在概览里换一套节奏。
  assert.match(summary, /flex flex-col gap-\[var\(--conversation-block-gap\)\]/);
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

test("过程概览把自己的根节点交给闸门", () => {
  // 闸门要量的是「这块现在占多高」，所以根 ref 必须真的挂在这个 disclosure 上
  //（旧版这层挂在 tool-call.tsx / tool-group.aui.tsx 上，行级不再自动折叠后只剩过程概览）。
  const summary = declaration("PiDesktopProcessGroup");
  assert.match(summary, /ref=\{processRef\}/, "过程概览必须把根节点交给闸门");
  assert.match(summary, /const processRef = useRef<HTMLDivElement>\(null\)/);
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
    deferredCollapse.includes('container.addEventListener("scroll", schedule'),
    "the gate re-judges on scroll, which is how a held collapse eventually lands",
  );
});
