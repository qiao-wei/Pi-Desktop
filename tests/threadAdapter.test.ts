import test from "node:test";
import assert from "node:assert/strict";

import { patchMessage } from "../src/features/chat/bootstrapPatch.ts";

/**
 * Hot-path cache behaviour of assistant-ui's external-store runtime.
 *
 * `ExternalStoreThreadRuntimeCore` keeps converted thread messages in a WeakMap
 * keyed by the *external* message object identity, and it resets that whole map
 * as soon as `adapter.convertMessage` is a different function:
 *
 *   if (oldStore.convertMessage !== store.convertMessage)
 *     this._converter = new ThreadMessageConverter();
 *
 * Two habits therefore multiply each other on every streamed token:
 *   - rebuilding the snapshot with a deep clone (every message identity changes), and
 *   - recreating the adapter object with an inline `convertMessage` arrow
 *     (the cache is dropped, so even stable identities get re-converted).
 *
 * This test drives the real runtime class and asserts the observable consequence:
 * how many thread-message objects have to be rebuilt per streamed token.
 */

const { ExternalStoreThreadRuntimeCore } = await import(
  "../node_modules/@assistant-ui/core/dist/internal.js"
);

const contextProvider = { getChildContext: () => ({}) };

type ExternalMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

function makeMessages(count: number): ExternalMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `body ${index}`,
  }));
}

function threadMessages(core: any): unknown[] {
  const direct = core.state?.messages ?? core.messages;
  if (Array.isArray(direct)) {
    return direct;
  }
  throw new Error("no message accessor on ExternalStoreThreadRuntimeCore");
}

/**
 * Stream `tokens` updates through the runtime.
 *
 * `inlineConverter: true` reproduces the old adapter shape (a fresh arrow per
 * store object); `false` is the fixed shape (one stable callback identity).
 */
function simulate({ tokens, inlineConverter }: { tokens: number; inlineConverter: boolean }) {
  const bootstrap = {
    snapshot: {
      conversation: {
        sessionFile: "/tmp/s.jsonl",
        updatedAt: 0,
        messages: [
          ...makeMessages(13),
          { id: "live", role: "assistant" as const, content: "" },
        ],
      },
    },
  };
  let state = bootstrap as unknown as Parameters<typeof patchMessage>[0];

  let conversions = 0;
  const convert = (message: ExternalMessage) => {
    conversions += 1;
    return { id: message.id, role: message.role, content: message.content };
  };
  const toExternal = (value: unknown) => value as ExternalMessage;

  const adapterFor = (messages: ExternalMessage[]) => ({
    messages,
    isRunning: true,
    onNew: async () => {},
    // The bug under test: a new function object on every store update.
    convertMessage: inlineConverter ? (message: ExternalMessage) => convert(message) : convert,
  });

  const first = (state as any).snapshot.conversation.messages as ExternalMessage[];
  const core = new ExternalStoreThreadRuntimeCore(contextProvider, adapterFor(first));
  core.__internal_setAdapter(adapterFor(first));

  let rebuilt = 0;
  let observed = 0;
  let previous = threadMessages(core);

  for (let token = 0; token < tokens; token += 1) {
    state = patchMessage(state, "live", (message) => ({
      ...message,
      content: `${message.content}tok${token}`,
    })).bootstrap;
    const messages = (state as any).snapshot.conversation.messages as ExternalMessage[];
    core.__internal_setAdapter(adapterFor(messages));

    const next = threadMessages(core);
    for (let index = 0; index < next.length; index += 1) {
      observed += 1;
      if (next[index] !== previous[index]) {
        rebuilt += 1;
      }
    }
    previous = next;
  }

  return { tokens, conversions, rebuilt, observed };
}

test("a stable convertMessage keeps untouched thread messages intact", () => {
  const fixed = simulate({ tokens: 10, inlineConverter: false });
  // 14 messages x 10 tokens = 140 observations; only the streaming message (the
  // last one) may change identity.
  assert.equal(fixed.tokens, 10);
  assert.ok(fixed.observed >= 140, `expected >=140 observations, got ${fixed.observed}`);
  assert.ok(
    fixed.rebuilt <= fixed.observed / 10,
    `thread messages should barely churn: rebuilt=${fixed.rebuilt} of ${fixed.observed}`,
  );
});

test("an inline convertMessage arrow rebuilds the whole thread per token", () => {
  const broken = simulate({ tokens: 10, inlineConverter: true });
  const fixed = simulate({ tokens: 10, inlineConverter: false });

  assert.ok(
    broken.rebuilt > fixed.rebuilt * 5,
    `expected the unstable callback to churn far more: broken=${broken.rebuilt} fixed=${fixed.rebuilt}`,
  );
  // Every one of the 14 messages is rebuilt on every token.
  assert.ok(broken.rebuilt / broken.observed > 0.9, `rebuilt=${broken.rebuilt}/${broken.observed}`);
});
