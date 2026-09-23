/**
 * Message action bars during streaming.
 *
 * While a turn is streaming, every icon under a question and an answer must be
 * visible but greyed out and inoperable. The old behaviour hid the assistant bar
 * entirely (`hideWhenRunning`) while the user bar stayed fully operable - copy
 * could grab a half-written answer and edit/reload could corrupt the run.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const thread = readFileSync(
  new URL("../src/components/assistant-ui/elements/thread.aui.tsx", import.meta.url),
  "utf8",
);
const button = readFileSync(new URL("../src/components/ui/button.tsx", import.meta.url), "utf8");

/** Slice from one top-level `const name =` to the next top-level declaration. */
function topLevelBlock(source: string, name: string, next: string): string {
  const start = source.indexOf(`const ${name}`);
  assert.notEqual(start, -1, `${name} not found`);
  const end = source.indexOf(next, start);
  assert.notEqual(end, -1, `${next} not found after ${name}`);
  return source.slice(start, end);
}

test("assistant action bar greys out instead of hiding while streaming", () => {
  const bar = topLevelBlock(thread, "AssistantActionBar", "const AssistantToolGroup");
  // The old disappearing act re-flowed the footer; disabled is the contract now.
  assert.doesNotMatch(bar, /hideWhenRunning/);
  assert.match(bar, /const actionsDisabled = useActionsDisabled\(\)/);
  assert.match(bar, /ActionBarPrimitive\.Copy asChild>\s*\n\s*<TooltipIconButton[^>]*disabled=\{actionsDisabled\}/);
  assert.match(bar, /ActionBarPrimitive\.Reload asChild>\s*\n\s*<TooltipIconButton[^>]*disabled=\{actionsDisabled\}/);
  assert.match(bar, /ActionBarMorePrimitive\.Trigger asChild>\s*\n\s*<TooltipIconButton[\s\S]*?disabled=\{actionsDisabled\}/);
});

test("user message footer copy and edit grey out while streaming", () => {
  const footer = topLevelBlock(thread, "UserMessageFooter", "function formatMessageTime");
  assert.match(footer, /const actionsDisabled = useActionsDisabled\(\)/);
  assert.match(
    footer,
    /tooltip=\{t\("message.copy"\)\}\s*\n\s*side="top"\s*\n\s*className="aui-user-action-copy"\s*\n\s*disabled=\{actionsDisabled\}/,
  );
  assert.match(
    footer,
    /tooltip=\{t\("message.edit"\)\}\s*\n\s*side="top"\s*\n\s*className="aui-user-action-edit"\s*\n\s*disabled=\{actionsDisabled\}/,
  );
});

test("the disabled flag follows the thread's running state", () => {
  assert.match(
    thread,
    /const useActionsDisabled = \(\) => useAuiState\(\(s\) => s\.thread\.isRunning\)/,
    "must key off the same running signal the runtime uses",
  );
});

test("greying comes from the native disabled style on the shared button", () => {
  assert.match(
    button,
    /disabled:pointer-events-none disabled:opacity-50/,
    "TooltipIconButton (Button) must grey out and ignore pointer events when disabled",
  );
});
