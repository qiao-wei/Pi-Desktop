import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  reasoningGroupFlags,
} from "../src/components/assistant-ui/elements/reasoningState.ts";
import { cn } from "../src/lib/utils.ts";

/**
 * Regression test for "工具都出来了，上面的 thinking 还在输出"（必现）.
 *
 * The wire and the projection were innocent: a captured 7-round run
 * (2m14s, 1437 outbound events) shows each round's thinking as its own block,
 * appended after the tool card, settled the moment the next content block
 * started. The bug was in the renderer: the reasoning group computed
 * `streaming = messageRunning || ownStreaming`, and `streaming` is what turns on
 * the shimmering trigger *and* the bottom-pinned live preview in `reasoning.tsx`
 * (`isPreview = streaming && open`). So a panel whose text finished in the first
 * second kept shimmering and auto-scrolling for the rest of the turn, right above
 * tool cards that were visibly working - and because that flag dominated
 * everything, the server-side settle latency was invisible next to it.
 *
 * The two questions are now separate: what is this group doing (`streaming`), and
 * may the layout move (`holdOpen`).
 */

test("a settled reasoning group is not 'thinking' just because the turn still runs", () => {
  const settled = reasoningGroupFlags({ messageRunning: true, ownStreaming: false });
  assert.equal(settled.streaming, false, "整条消息在跑不代表这块还在输出");
  assert.equal(settled.holdOpen, true, "但面板仍保持展开，避免中途收起把下方内容抬起来");
});

test("the group's own stream still reads as thinking", () => {
  const live = reasoningGroupFlags({ messageRunning: true, ownStreaming: true });
  assert.deepEqual(live, { streaming: true, holdOpen: true });
});

test("after the turn ends nothing shimmers and the panel may collapse", () => {
  const done = reasoningGroupFlags({ messageRunning: false, ownStreaming: false });
  assert.deepEqual(done, { streaming: false, holdOpen: false });
});

test("shimmering implies held open", () => {
  // A panel that claims to be thinking while collapsed shows nothing, so the
  // visual flag must never outlive the hold.
  for (const messageRunning of [false, true]) {
    for (const ownStreaming of [false, true]) {
      const { streaming, holdOpen } = reasoningGroupFlags({ messageRunning, ownStreaming });
      if (streaming) assert.equal(holdOpen, true, `streaming without holdOpen: ${messageRunning}/${ownStreaming}`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Wiring guards                                                              */
/* -------------------------------------------------------------------------- */

test("the reasoning group feeds the visual flag from the helper, not from the message", () => {
  const source = readFileSync(
    new URL("../src/components/assistant-ui/elements/thread.aui.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /const \{ streaming, holdOpen \} = reasoningGroupFlags\(\{ messageRunning, ownStreaming \}\)/,
  );
  // The look must be driven by `streaming` alone.
  assert.match(source, /streaming=\{streaming\}/);
  assert.match(source, /<Reasoning\.Trigger active=\{streaming\}/);
  assert.match(source, /<Reasoning\.Content aria-busy=\{streaming\}>/);
  // ...and the disclosure is held by `holdOpen`.
  assert.match(source, /useState\(holdOpen\)/);
  assert.match(source, /setIntentOpen\(holdOpen\)/);

  // The old conflation - asserted negatively, because it is what made the bug
  // invisible from the server side.
  assert.equal(
    source.includes("messageRunning || ownStreaming"),
    false,
    "不得再把整条消息的运行状态并进入觉 flag",
  );
});

/* -------------------------------------------------------------------------- */
/* The typewriter reveal                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Same symptom, second cause. `MarkdownTextPrimitive` smooths text by default:
 * `useSmooth` drains whatever has already been received at ≥2.5ms per character.
 * Nothing else on screen is smoothed - the tool card renders the moment it
 * arrives - so a completed thinking block kept typing itself out *above* a tool
 * card that was already working. Captured (headless Chromium against a real
 * `deepseek-v4.1-flash` run, 25ms DOM sampling): the app parsed the authoritative
 * 172-character payload 31ms before the tool card was painted, and the panel above
 * it grew 69→172 characters over the following ~600ms, one short chunk per frame.
 * Turning the reveal off removes the whole class of "text still arriving after the
 * rest of the turn moved on" artifacts.
 */
test("markdown text lands when it arrives instead of typing itself out", () => {
  const source = readFileSync(
    new URL("../src/components/assistant-ui/elements/markdown-text.tsx", import.meta.url),
    "utf8",
  );

  // Default must be off: the reasoning renderer (`reasoning.aui.tsx`) and the
  // answer text both use this component without passing the prop.
  assert.match(
    source,
    /smooth = false/,
    "MarkdownText 必须默认关闭打字机（否则工具卡会先于它上面的文本画出来）",
  );
  // The prop has to reach the primitive; a local default without forwarding would
  // leave `MarkdownTextPrimitive`'s own `smooth = true` in charge.
  assert.match(source, /<MarkdownTextPrimitive[\s\S]{0,400}?smooth=\{smooth\}/, "必须把 smooth 传给 MarkdownTextPrimitive");

  const primitive = readFileSync(
    new URL("../node_modules/@assistant-ui/react-markdown/dist/primitives/MarkdownText.js", import.meta.url),
    "utf8",
  );
  // Guard the assumption the default is written against: the library really does
  // smooth unless told otherwise, and it really does read the prop we now pass.
  assert.match(primitive, /smooth = true/, "上游默认值变了，这条用例需要重新确认");
  assert.match(primitive, /useSmooth\(\s*processedMessagePart,\s*smooth\)/, "上游不再按 smooth 决定是否平滑，这条用例需要重新确认");
});

test("reasoning and answer text share the same rendered text component", () => {
  const reasoningSource = readFileSync(
    new URL("../src/components/assistant-ui/elements/reasoning.aui.tsx", import.meta.url),
    "utf8",
  );
  const threadSource = readFileSync(
    new URL("../src/components/assistant-ui/elements/thread.aui.tsx", import.meta.url),
    "utf8",
  );

  // One implementation, so the reasoning panel cannot drift back to a smoothed
  // reveal while the answer text stays faithful (or the other way around).
  assert.match(
    reasoningSource,
    /const ReasoningImpl: ReasoningMessagePartComponent = \(\{ text, status \}\) => \(/,
    "推理渲染器必须把 part 的 text/status 交给本仓库的 MarkdownText",
  );
  assert.match(reasoningSource, /<MarkdownText text=\{text\} status=\{status\} \/>/);
  assert.match(threadSource, /<MarkdownText \{\.\.\.part\} \/>/);
  assert.equal(
    reasoningSource.includes("MarkdownTextPrimitive"),
    false,
    "推理渲染器必须走本仓库的 MarkdownText，而不是直接用上游 primitive",
  );
  // The answer text has to carry a status too, otherwise a live text block would
  // stay on the deferred path while the tool card behind it paints eagerly. It is
  // built in ChatThread, not here. `running` is reserved for the tail block: it
  // also drives the streaming caret, and a status that stayed `running` on earlier
  // paragraphs parked that caret until the run ended (see `liveTextTail`).
  const chatThreadSource = readFileSync(
    new URL("../src/features/chat/ChatThread.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    chatThreadSource,
    /status: isLiveTail \? \{ type: "running" \} : \{ type: "complete" \}/,
    "实文本块必须把运行状态传给 MarkdownText（决定能不能 defer、要不要画圆点）",
  );
  assert.match(
    chatThreadSource,
    /const liveTailIndex = liveTextTailIndex\(processBlocks, isStreaming\);/,
    "尾块必须由 liveTextTailIndex 判定，不能每个正文块都算运行中",
  );
});

test("live markdown text is not deferred (settled text still is)", () => {
  const source = readFileSync(
    new URL("../src/components/assistant-ui/elements/markdown-text.tsx", import.meta.url),
    "utf8",
  );

  // `useDeferredValue` lives *inside* the markdown component, so it can render an
  // older text value while a sibling tool card in the same parts array renders the
  // newest state - i.e. the tool card paints first and the text above it catches up
  // a render later. Live text must therefore opt out; settled text keeps the
  // deferral that shields session switches from a synchronous re-parse per message.
  assert.match(
    source,
    /defer=\{status\?\.type !== "running"\}/,
    "defer 必须按块的运行状态决定，而不是一律开启",
  );
  assert.match(source, /smooth=\{smooth\}/);
});

test("reasoning text follows the output instead of a fixed five-line window", () => {
  const threadSource = readFileSync(
    new URL("../src/components/assistant-ui/elements/thread.aui.tsx", import.meta.url),
    "utf8",
  );
  const reasoningSource = readFileSync(
    new URL("../src/components/assistant-ui/elements/reasoning.tsx", import.meta.url),
    "utf8",
  );

  // Scope the check to the reasoning group's own Reasoning.Text. Without the
  // anchor, a `max-h-64` on a tool card elsewhere in the file could make the
  // negative assertion below read as green for the wrong element.
  const element = /<Reasoning\.Text\b([^>]*)>/.exec(threadSource);
  assert.ok(element, "找不到推理分组的 Reasoning.Text");
  const override =
    /className=(["'`])([^"'`]*)\1/.exec(element[1])?.[2] ?? "";
  assert.ok(override, "推理分组的 Reasoning.Text 必须给出高度覆盖");

  // Reproduce what ReasoningText actually renders: cn(base, override). The
  // override has to win over the base `max-h-64` default, so assert on the
  // merged result rather than on the literal class name - `max-h-none` (which
  // tailwind-merge 3.6 does not recognise as a `max-h` utility) would leave the
  // base cap in place and pass a naive `includes("max-h-none")` check while the
  // panel stayed capped.
  const base = /"([^"]*aui-reasoning-text[^"]*)"/.exec(reasoningSource)?.[1];
  assert.ok(base, "找不到 ReasoningText 的基础 className");
  assert.ok(base.split(/\s+/).includes("max-h-64"), "基础类不再自带 max-h-64，用例需要更新");

  const merged = cn(base, override).split(/\s+/);
  const maxHeights = merged.filter((token) => token.startsWith("max-h-"));
  assert.deepEqual(
    maxHeights,
    [override],
    `合并后只应保留推理分组给出的高度覆盖（实际：${merged.join(" ")}）`,
  );

  // ...and that surviving override has to lift the cap, not trade the five-line
  // window for another finite one (`max-h-full` / `max-h-screen` would still
  // clip a long answer). The arbitrary-value form is also what tailwind-merge
  // 3.6 needs in order to win over the base `max-h-64`.
  const arbitrary = /^max-h-\[(.+)\]$/.exec(override)?.[1];
  assert.ok(
    arbitrary,
    `高度覆盖必须是任意值写法才能压过基础类，当前：${override}`,
  );
  assert.ok(
    ["none", "unset", "initial", "inherit"].includes(arbitrary),
    `高度覆盖必须真正解除上限，当前：${arbitrary}`,
  );
});
