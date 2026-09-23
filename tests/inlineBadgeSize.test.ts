/**
 * 行内徽标（composer 与聊天用户消息里的技能 / 附件 chip）紧凑化回归测试。
 *
 * 背景：2026-09-19 用户反馈「composer 和聊天对话的问题里的 inline badge 都有点太大了，
 * 可以重新设计显示的内容」。改法是统一成单行 chip：
 * - 编辑区（composer）34/28px → 22px，图标 26/20 → 16px，名字 0.78/0.85rem → 0.72/0.74rem；
 * - 聊天用户消息 26px → 20px，图标 20 → 14px，名字 0.68rem；
 * - 附件的大小不再占第二行，改成名字后面的灰色后缀（copy 由 grid 改 flex），
 *   徽标高度因此从「两行」降到「一行」。
 *
 * 纯样式值在 node 里跑不了行为级验证，按仓库惯例（见 chatTypography.test.ts /
 * composerResponsive.test.ts）做「区域限定」的结构断言，先用 ruleBody 定位到具体规则再检查，
 * 避免被文件其它位置的相同写法假绿。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stylesCss = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");
const appTsx = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const threadTsx = readFileSync(
  new URL("../src/components/assistant-ui/elements/thread.aui.tsx", import.meta.url),
  "utf8",
);

/** 以 selector 开头的第一个规则块正文（不含选择器与花括号）。 */
function ruleBody(source: string, selector: string): string {
  const start = source.indexOf(selector);
  assert.ok(start >= 0, `找不到规则: ${selector}`);
  const open = source.indexOf("{", start);
  assert.ok(open >= 0, `规则没有正文: ${selector}`);
  const close = source.indexOf("}", open);
  assert.ok(close > open, `规则没有收尾: ${selector}`);
  return source.slice(open + 1, close);
}

test("附件徽标收紧为单行 22px，图标 16px", () => {
  const badge = ruleBody(stylesCss, ".attachment-badge {");
  assert.match(badge, /height:\s*22px\s*;/, "附件徽标高度应为 22px");
  assert.doesNotMatch(badge, /height:\s*34px\s*;/, "旧的 34px 高度必须消失");

  const icon = ruleBody(stylesCss, ".attachment-badge img,\n.attachment-badge-icon {");
  assert.match(icon, /width:\s*16px\s*;/, "徽标图标应为 16px");
  assert.doesNotMatch(icon, /width:\s*26px\s*;/, "旧的 26px 图标必须消失");
});

test("附件的大小作为单行后缀，不再占第二行", () => {
  const copy = ruleBody(stylesCss, ".attachment-badge-copy {");
  assert.match(copy, /display:\s*flex\s*;/, "copy 应为单行 flex，而不是两行 grid");
  assert.doesNotMatch(copy, /display:\s*grid\s*;/, "旧的 grid（两行堆叠）必须消失");
  assert.match(copy, /align-items:\s*center\s*;/, "名字与大小要在同一基线上");

  const small = ruleBody(stylesCss, ".attachment-badge-copy small {");
  assert.match(small, /margin-top:\s*0\s*;/, "大小后缀不应再有顶部间距（那是第二行的痕迹）");
  assert.match(small, /flex:\s*none\s*;/, "大小后缀不应被压缩");
});

test("技能徽标收紧为 22px / 图标 16px，名字不再 0.85rem", () => {
  const badge = ruleBody(stylesCss, ".capability-badge {");
  assert.match(badge, /height:\s*22px\s*;/, "技能徽标高度应为 22px");
  assert.doesNotMatch(badge, /height:\s*28px\s*;/, "旧的 28px 高度必须消失");

  const icon = ruleBody(stylesCss, ".capability-badge .attachment-badge-icon {");
  assert.match(icon, /width:\s*16px\s*;/, "技能图标应为 16px");

  const strong = ruleBody(stylesCss, ".capability-badge .attachment-badge-copy strong {");
  assert.match(strong, /font-size:\s*0\.74rem\s*;/, "技能名字应为 0.74rem");
  assert.doesNotMatch(strong, /font-size:\s*0\.85rem\s*;/, "旧的 0.85rem 名字必须消失");
});

test("聊天用户消息里的徽标再小一档：20px / 图标 14px", () => {
  const badge = ruleBody(stylesCss, ".aui-user-message-content .attachment-badge {");
  assert.match(badge, /height:\s*20px\s*;/, "聊天里的徽标应为 20px");
  assert.doesNotMatch(badge, /height:\s*26px\s*;/, "旧的 26px 高度必须消失");

  const icon = ruleBody(stylesCss, ".aui-user-message-content .attachment-badge img,\n.aui-user-message-content .attachment-badge-icon {");
  assert.match(icon, /width:\s*14px\s*;/, "聊天里的图标应为 14px");

  const capStrong = ruleBody(stylesCss, ".aui-user-message-content .capability-badge .attachment-badge-copy strong {");
  assert.match(capStrong, /font-size:\s*0\.68rem\s*;/, "聊天里的技能名字应为 0.68rem");
});

test("内联图标尺寸跟着缩，不再用 15px 硬编码", () => {
  assert.match(appTsx, /width="12" height="12"/, "composer 的附件 svg 图标应缩到 12");
  assert.doesNotMatch(appTsx, /width="15" height="15"/, "旧的 15px svg 必须消失");
  assert.match(threadTsx, /<FileTextIcon size=\{12\} \/>/, "聊天附件图标应为 12");
});