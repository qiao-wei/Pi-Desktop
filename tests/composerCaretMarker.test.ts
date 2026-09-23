/**
 * Composer / 消息编辑框里方向键越过行内徽标的光标行为回归测试。
 *
 * 背景：2026-09-19 用户反馈「在 composer 里用键盘左右移动时，经过 inline badge 需要点
 * 两次才能过去」，补上单徽标后又反馈「连续 3 个徽标，中间的无论往左往右都要两次」。
 *
 * 原因：徽标是 `contenteditable=false` 原子节点，旁边跟一个零宽标记 \u200b 供光标落点。
 * 零宽标记没有宽度，于是同一个「徽标右侧」位置存在等价但不同的表示，默认方向键会在其中
 * 空按一次：
 * - 标记节点内部的 offset 0 / 1；
 * - Chrome 跨过徽标后把光标规范成的父子边界 `(parent, index)`；
 * - 标记与正文并进同一个文本节点后的开头若干偏移（打字之后）。
 * 另外连续徽标之间只有一个视觉停点，按 → 从标记落到下一个徽标左侧也是同一个点。
 *
 * 修法：共享逻辑 `src/features/chat/caretMarkerStep.ts` 把上面这些等价表示都识别为
 * 「徽标右侧边界」，← 落到徽标前的文本末尾，→ 跳过标记并直接跨过一个徽标/一个码点。
 *
 * composer / 编辑框的按键处理挂在 React 组件内部（App.tsx 没导出这些函数），仓库惯例是
 * 对源码做「函数体限定」的结构断言（见 messageEdit.test.ts / attachmentHoverGate.test.ts）。
 * 真实 DOM 的按键位移另用 playwright 实测：3 个连续徽标 + 左右各一次按键 = 逐个跨过，
 * 无空按；单个徽标（两侧有文字）与技能徽标同样。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appTsx = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const editBoxTsx = readFileSync(new URL("../src/features/chat/MessageEditBox.tsx", import.meta.url), "utf8");
const stepTs = readFileSync(new URL("../src/features/chat/caretMarkerStep.ts", import.meta.url), "utf8");
const stylesCss = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");

/** Extract a named `function name(...) { ... }` body by brace counting. */
function functionBody(source: string, name: string): string {
  const declaration = source.indexOf(`function ${name}(`);
  assert.notEqual(declaration, -1, `function ${name} not found`);
  const openParen = source.indexOf("(", declaration);
  let parenDepth = 0;
  let cursor = openParen;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") parenDepth += 1;
    if (source[cursor] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }
  const openBrace = source.indexOf("{", cursor);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBrace, index + 1);
      }
    }
  }
  assert.fail(`function ${name} body never closes`);
}

function ruleBody(source: string, selector: string): string {
  const start = source.indexOf(selector);
  assert.ok(start >= 0, `找不到规则: ${selector}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
}

const step = functionBody(stepTs, "stepOverCaretMarker");
const boundary = functionBody(stepTs, "badgeBeforeCaret");
const leading = functionBody(stepTs, "leadingMarkerLength");
const isBadge = functionBody(stepTs, "isBadgeElement");
const appWrapper = functionBody(appTsx, "stepOverCaretMarker");
const appKeydown = functionBody(appTsx, "handleComposerKeyDown");
const removable = functionBody(appTsx, "removableBadgeBeforeCaret");
const removeBadgeNode = functionBody(appTsx, "removeBadgeNode");
const appRemoveCapability = functionBody(appTsx, "removeCapability");
const appRemoveCapabilityBeforeCaret = functionBody(appTsx, "removeCapabilityBeforeCaret");
const editKeydown = functionBody(editBoxTsx, "handleKeyDown");

test("识别「徽标右侧边界」的所有等价表示，且只认真正的徽标", () => {
  // 1) 零宽标记节点本身
  assert.match(boundary, /isMarkerOnlyTextNode\(container, marker\)/, "标记节点要识别");
  // 2) 标记与正文并进同一文本节点后，开头标记范围内的偏移
  assert.match(boundary, /offset <= leadingMarkerLength\(text, marker\)/, "并入正文后的标记偏移要识别");
  // 3) Chrome 跨过后规范成的父子边界
  assert.match(boundary, /container\.childNodes\[offset - 1\] \?\? null/, "父子边界要识别");
  // 4) 连续徽标之间夹着的标记节点要先跳过，再看是不是徽标
  assert.match(boundary, /while \(candidate && isMarkerOnlyTextNode\(candidate, marker\)\)/, "跳过中间的标记节点");
  assert.match(boundary, /return isBadgeElement\(candidate\) \? candidate : null/, "最终只能返回徽标");
  assert.match(isBadge, /dataset\?\.attachmentId \|\| .*dataset\?\.capabilityId/, "只有带 dataset 的徽标才接管");
});

test("前置标记长度按零宽标记逐段量（打字会把标记和正文并进同一节点）", () => {
  assert.match(leading, /text\.startsWith\(marker, length\)/, "按偏移逐段判断开头是不是标记");
});

test("共享逻辑只在折叠光标上生效，其它情况交还浏览器", () => {
  assert.match(step, /selection\.isCollapsed/, "只在折叠光标上生效，不影响框选");
  assert.match(step, /badgeBeforeCaret\(range\.startContainer, range\.startOffset, marker\)/);
  assert.match(step, /editor\.contains\(badge\)/, "徽标必须仍在编辑器里");
  assert.match(step, /return null;/, "非徽标边界不能吞掉按键");
});

test("← 落到徽标之前的文本末尾（而不是元素偏移，否则 Chrome 画到行首）", () => {
  assert.match(step, /if \(direction < 0\)/, "必须先分流 ← / →");
  assert.match(step, /const before = badge\.previousSibling/, "看徽标前一个兄弟节点");
  assert.match(step, /before\.nodeType === Node\.TEXT_NODE/, "优先落到文本节点");
  assert.match(step, /next\.setStart\(before, \(before\.textContent \?\? ""\)\.length\)/, "落在文本末尾");
});

test("→ 跳过标记并跨过一个徽标 / 一个码点，一次按键就有位移", () => {
  assert.match(step, /while \(follower && isMarkerOnlyTextNode\(follower, marker\)\)/, "先跳过徽标后的零宽标记");
  assert.match(step, /if \(isBadgeElement\(follower\)\)/, "连续徽标要整体跨过下一个");
  assert.match(step, /next\.setStart\(parent, followerIndex \+ 1\)/, "落到下一个徽标右侧");
  assert.match(step, /leadingMarkerLength\(text, marker\)/, "文本节点要先跳过并进来的标记");
  assert.match(step, /codePointAt\(leading\)/, "用码点而不是码元，避免劈开 emoji 代理对");
  assert.match(step, /Math\.min\(leading \+ \(codePoint > 0xffff \? 2 : 1\), text\.length\)/);
});

test("composer 包装层写回 composerSelectionRef，供后续插入/删除复用", () => {
  assert.match(
    appWrapper,
    /stepSelectionOverCaretMarker\(\s*composerEditorRef\.current,\s*window\.getSelection\(\),\s*direction,\s*composerCaretMarker,?\s*\)/,
    "composer 要用共享逻辑",
  );
  assert.match(appWrapper, /composerSelectionRef\.current = next\.cloneRange\(\)/, "同步记忆的选区");
});

test("composer keydown 接线：方向键要挡修饰键与输入法组合，且真正处理了才 preventDefault", () => {
  assert.match(appKeydown, /event\.key === "ArrowLeft" \|\| event\.key === "ArrowRight"/);
  for (const guard of ["!event.shiftKey", "!event.altKey", "!event.metaKey", "!event.ctrlKey", "!event.nativeEvent.isComposing"]) {
    assert.ok(appKeydown.includes(guard), `方向键处理必须排除 ${guard}`);
  }
  assert.match(appKeydown, /stepOverCaretMarker\(event\.key === "ArrowLeft" \? -1 : 1\)/);
  // 只有 stepOverCaretMarker 返回 true 才接管，其它位置保持浏览器默认行为。
  assert.match(appKeydown, /stepOverCaretMarker\([^)]*\)\s*\n\s*\) \{\s*\n\s*event\.preventDefault\(\);/);
});

test("消息编辑框同样接线（编辑面与 composer 行为一致）", () => {
  assert.match(editBoxTsx, /import \{ badgeBeforeCaret, isMarkerOnlyTextNode, stepOverCaretMarker \} from "\.\/caretMarkerStep"/);
  assert.match(editKeydown, /event\.key === "ArrowLeft" \|\| event\.key === "ArrowRight"/);
  assert.match(editKeydown, /stepOverCaretMarker\(\s*editorRef\.current,\s*window\.getSelection\(\),/);
  assert.match(editKeydown, /rangeRef\.current = next\.cloneRange\(\)/, "编辑框要把新光标写回自己的 ref");
  for (const guard of ["!event.shiftKey", "!event.altKey", "!event.metaKey", "!event.ctrlKey", "!event.nativeEvent.isComposing"]) {
    assert.ok(editKeydown.includes(guard), `编辑框方向键处理必须排除 ${guard}`);
  }
});

test("编辑区徽标补 4px 左边距，光标不再贴着徽标边框", () => {
  const body = ruleBody(stylesCss, ".composer-editor .attachment-badge {");
  assert.match(body, /margin:\s*0\s+5px\s+3px\s+4px\s*;/, "左边距应为 4px（右 5px / 下 3px 保持不变）");
  assert.doesNotMatch(body, /margin:\s*0\s+5px\s+3px\s+0\s*;/, "旧的 0 左边距必须消失");
});

test("Backspace 用与方向键相同的边界识别，一次就删整个徽标", () => {
  // 不能只用「父子边界 + 前一个兄弟是徽标」："←" 停在父子边界、前一个兄弟是标记时，
  // 旧逻辑会漏掉，默认 Backspace 先把看不见的标记删掉（Chrome 还会补 <br>）。
  assert.match(removable, /badgeBeforeCaret\(range\.startContainer, range\.startOffset, composerCaretMarker\)/);
  assert.match(removable, /dataset\?\.\[dataKey\]/, "仍按 attachmentId / capabilityId 区分要删的类型");
  assert.doesNotMatch(removable, /childNodes\[startOffset - 1\]/, "旧的父子边界专用逻辑必须消失");
});

test("删徽标时一并收掉它的零宽标记，不留看不见的空白", () => {
  assert.match(removeBadgeNode, /const nextSibling = node\.nextSibling/, "先记住后面的标记节点");
  assert.match(removeBadgeNode, /removeLeadingCaretMarker\(nextSibling\)/, "删除后要清掉标记");
  // 附件、技能 × 按钮、技能 Backspace 三条路径都要走它，否则某一条会留下标记。
  for (const [name, body] of [
    ["removeAttachment", functionBody(appTsx, "removeAttachment")],
    ["removeCapability", appRemoveCapability],
    ["removeCapabilityBeforeCaret", appRemoveCapabilityBeforeCaret],
  ] as const) {
    assert.match(body, /removeBadgeNode\(/, `${name} 必须用 removeBadgeNode`);
    assert.doesNotMatch(body, /\.remove\(\);/, `${name} 不应再直接 node.remove()`);
  }
});

test("编辑框 Backspace 接线（编辑面删除行为与 composer 一致）", () => {
  assert.match(editKeydown, /event\.key === "Backspace"/);
  assert.match(editKeydown, /badgeBeforeCaret\(range\.startContainer, range\.startOffset, CARET_MARKER\)/);
  assert.match(editKeydown, /removeAttachment\(attachmentId\)/);
  assert.match(editKeydown, /removeCapability\(capability\)/);
});