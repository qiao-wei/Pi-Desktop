/**
 * 供应商登录的桥接（`server/modelLogin.mjs`）。
 *
 * 这一层不 import pi、不碰 HTTP：`start()` 收一个 `login(interaction)` 函数，
 * 测试里给个假的就能把「事件 / 提问 / 答复 / 取消」整套走完。盯的是：
 *   1. pi 的 AuthEvent / AuthPrompt 原样上线，只有不可序列化的 signal 留在桥这边；
 *   2. 一个 prompt 只被答复一次，答复到达后 `login()` 里 await 的那个 Promise 拿到值；
 *   3. 取消（用户关弹窗 / 客户端断开）要真的 abort 掉登录，并且把等着的 prompt 放掉。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createModelLoginBroker,
  normalizeLoginAuthType,
  providerLoginMethods,
  serializableAuthEvent,
  serializableAuthPrompt,
} from "../server/modelLogin.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("AuthEvent / AuthPrompt 去掉 signal 后原样上线，空壳事件被丢弃", () => {
  const signal = new AbortController().signal;
  assert.deepEqual(
    serializableAuthEvent({ type: "auth_url", url: "https://a.dev", instructions: "x", signal }),
    { type: "auth_url", url: "https://a.dev", instructions: "x" },
  );
  assert.deepEqual(
    serializableAuthEvent({ type: "device_code", userCode: "ABCD", verificationUri: "https://b.dev" }),
    { type: "device_code", userCode: "ABCD", verificationUri: "https://b.dev" },
  );
  assert.equal(serializableAuthEvent({ url: "no-type" }), null);
  assert.equal(serializableAuthEvent(null), null);

  assert.deepEqual(
    serializableAuthPrompt({
      type: "select",
      message: "pick",
      signal,
      options: [{ id: "a", label: "A", description: "d" }, { id: "", label: "junk" }, null],
    }),
    { type: "select", message: "pick", options: [{ id: "a", label: "A", description: "d" }] },
  );
  assert.deepEqual(serializableAuthPrompt({ type: "manual_code", message: "paste", placeholder: "http://…" }), {
    type: "manual_code",
    message: "paste",
    placeholder: "http://…",
  });
  assert.equal(serializableAuthPrompt({ message: "no type" }), null);
});

test("登录方式元数据读 provider.auth，而不是任何写死的名单", () => {
  assert.deepEqual(providerLoginMethods({ auth: { oauth: { name: "X (sub)", loginLabel: "Sign in with X", isSubscription: true }, apiKey: { login: () => {} } } }), {
    apiKey: true,
    apiKeyLogin: true,
    oauth: true,
    oauthName: "X (sub)",
    oauthLabel: "Sign in with X",
    oauthSubscription: true,
  });
  // 只给 key、没给 login 的 ambient-only 供应商：能说它支持 key，但不该给「填 key」入口。
  assert.deepEqual(providerLoginMethods({ auth: { apiKey: {} } }), {
    apiKey: true,
    apiKeyLogin: false,
    oauth: false,
    oauthName: "",
    oauthLabel: "",
    oauthSubscription: false,
  });
  // 纯 OAuth（openai-codex 那种）。
  const oauthOnly = providerLoginMethods({ auth: { oauth: { name: "OpenAI (ChatGPT)" } } });
  assert.equal(oauthOnly.oauth, true);
  assert.equal(oauthOnly.apiKey, false);
  assert.equal(providerLoginMethods({}).oauth, false);
});

test("authType 只认 oauth / api_key，其余落到 api_key", () => {
  assert.equal(normalizeLoginAuthType("oauth"), "oauth");
  assert.equal(normalizeLoginAuthType("api_key"), "api_key");
  assert.equal(normalizeLoginAuthType(""), "api_key");
  assert.equal(normalizeLoginAuthType("nonsense"), "api_key");
});

test("一次完整登录：session → event → prompt → 答复 → done", async () => {
  const broker = createModelLoginBroker();
  const events = [];
  let received = null;
  const login = async (interaction) => {
    interaction.notify({ type: "progress", message: "starting" });
    interaction.notify({ type: "auth_url", url: "https://auth.dev", signal: new AbortController().signal });
    received = await interaction.prompt({ type: "text", message: "Paste the code", placeholder: "code" });
  };

  const { sessionId, done } = broker.start({
    providerId: "demo",
    authType: "oauth",
    login,
    onEvent: (event) => events.push(event),
  });

  assert.equal(broker.hasSession(sessionId), true);
  assert.deepEqual(events[0], { type: "session", sessionId });
  await tick();

  assert.deepEqual(events[1], { type: "event", event: { type: "progress", message: "starting" } });
  assert.deepEqual(events[2], { type: "event", event: { type: "auth_url", url: "https://auth.dev" } });
  const promptEvent = events.find((event) => event.type === "prompt");
  assert.ok(promptEvent, "prompt 要作为一条流事件发出去");
  assert.equal(promptEvent.prompt.type, "text");
  assert.equal(broker.respond(promptEvent.id, "abc-123"), true);

  await done;
  assert.equal(received, "abc-123");
  assert.deepEqual(events.at(-1), { type: "done" });
  assert.equal(broker.size(), 0);
  assert.equal(broker.pendingCount(), 0);
  // 同一个 prompt 不能答复两次。
  assert.equal(broker.respond(promptEvent.id, "again"), false);
});

test("select 的答复也用同一口：值就是 option id", async () => {
  const broker = createModelLoginBroker();
  const events = [];
  let received = null;
  const { done } = broker.start({
    providerId: "demo",
    authType: "oauth",
    onEvent: (event) => events.push(event),
    login: async (interaction) => {
      received = await interaction.prompt({
        type: "select",
        message: "Pick an account",
        options: [{ id: "pro", label: "Pro" }, { id: "team", label: "Team" }],
      });
    },
  });
  await tick();
  const promptEvent = events.find((event) => event.type === "prompt");
  assert.deepEqual(promptEvent.prompt.options.map((option) => option.id), ["pro", "team"]);
  broker.respond(promptEvent.id, "team");
  await done;
  assert.equal(received, "team");
});

test("登录失败：error 事件带上原因，会话照样收尾", async () => {
  const broker = createModelLoginBroker();
  const events = [];
  const { done } = broker.start({
    providerId: "demo",
    authType: "oauth",
    onEvent: (event) => events.push(event),
    login: async () => {
      throw new Error("invalid_grant");
    },
  });
  await done;
  assert.deepEqual(events.at(-1), { type: "error", message: "invalid_grant" });
  assert.equal(broker.size(), 0);
});

test("取消：abort 掉 signal，并拒绝还在等的 prompt（和 TUI 的 Esc 一致）", async () => {
  const broker = createModelLoginBroker();
  const events = [];
  let aborted = false;
  let promptError = null;
  const { sessionId, done } = broker.start({
    providerId: "demo",
    authType: "oauth",
    onEvent: (event) => events.push(event),
    login: async (interaction) => {
      interaction.signal.addEventListener("abort", () => {
        aborted = true;
      });
      try {
        await interaction.prompt({ type: "manual_code", message: "callback url" });
      } catch (error) {
        promptError = error;
        throw error;
      }
    },
  });
  await tick();
  assert.equal(broker.pendingCount(), 1);
  assert.equal(broker.cancel(sessionId), true);
  await done;
  assert.equal(aborted, true);
  assert.equal(promptError?.message, "Login cancelled");
  assert.deepEqual(events.at(-1), { type: "error", message: "Login cancelled" });
  assert.equal(broker.pendingCount(), 0);
  // 已经结束的会话再取消一次是 no-op。
  assert.equal(broker.cancel(sessionId), false);
});

test("答复里带 cancelled = 取消整个登录，而不只是跳过这一问", async () => {
  const broker = createModelLoginBroker();
  const events = [];
  let promptError = null;
  const { done } = broker.start({
    providerId: "demo",
    authType: "oauth",
    onEvent: (event) => events.push(event),
    login: async (interaction) => {
      try {
        await interaction.prompt({ type: "text", message: "code" });
      } catch (error) {
        promptError = error;
        throw error;
      }
    },
  });
  await tick();
  const promptEvent = events.find((event) => event.type === "prompt");
  assert.equal(broker.respond(promptEvent.id, "", { cancelled: true }), true);
  await done;
  assert.equal(promptError?.message, "Login cancelled");
  assert.equal(broker.size(), 0);
});

test("prompt 自带的 signal 被中断时，这一问也被拒绝（不占着不放）", async () => {
  const broker = createModelLoginBroker();
  const events = [];
  const promptSignal = new AbortController();
  let promptError = null;
  const { done } = broker.start({
    providerId: "demo",
    authType: "oauth",
    onEvent: (event) => events.push(event),
    login: async (interaction) => {
      try {
        await interaction.prompt({ type: "text", message: "code", signal: promptSignal.signal });
      } catch (error) {
        promptError = error;
        throw error;
      }
    },
  });
  await tick();
  assert.equal(broker.pendingCount(), 1);
  promptSignal.abort();
  await done;
  assert.equal(promptError?.message, "Login cancelled");
  assert.equal(broker.pendingCount(), 0);
});