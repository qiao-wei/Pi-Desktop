/**
 * 「添加模型」里登录方式的纯规则（`loginAuthTypes` / `defaultLoginAuthType`）。
 *
 * 这两条规则决定弹窗显示哪些登录入口、默认站在哪一档。判据必须和 TUI 的 `/login`
 * 一致：读 pi 的 provider.auth 元数据（桥归一化成 authMethods / oauth / apiKeyLogin），
 * 前端**不维护任何供应商名单** —— pi 目录新增一家支持 OAuth 的，这里自动就有。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { defaultLoginAuthType, loginAuthTypes } from "../src/features/models/customModelForm.ts";

test("两种都支持：入口两个，默认填 key（老用户习惯）", () => {
  const row = { authMethods: ["apiKey", "oauth"], oauth: { name: "X", label: "", subscription: true }, apiKeyLogin: true };
  assert.deepEqual(loginAuthTypes(row), ["api_key", "oauth"]);
  assert.equal(defaultLoginAuthType(row), "api_key");
});

test("已经用账号登录的：默认继续账号登录", () => {
  const row = { authMethods: ["apiKey", "oauth"], oauth: { name: "X", label: "", subscription: true }, authKind: "oauth" };
  assert.equal(defaultLoginAuthType(row), "oauth");
});

test("纯 OAuth（openai-codex 那种）：只有账号登录一档", () => {
  const row = { authMethods: ["oauth"], oauth: { name: "OpenAI (ChatGPT Plus/Pro)", label: "", subscription: true } };
  assert.deepEqual(loginAuthTypes(row), ["oauth"]);
  assert.equal(defaultLoginAuthType(row), "oauth");
});

test("只有 key：没有账号登录入口", () => {
  const row = { authMethods: ["apiKey"], apiKeyLogin: true };
  assert.deepEqual(loginAuthTypes(row), ["api_key"]);
  assert.equal(defaultLoginAuthType(row), "api_key");
});

test("apiKey 没实现 login()（ambient-only）：不算能填 key 的入口", () => {
  const row = { authMethods: ["apiKey"], apiKeyLogin: false };
  assert.deepEqual(loginAuthTypes(row), []);
  // 没有可用入口时不能默认 key（那会给出一个填不了的表单）；落到 OAuth 分支由调用方兜底。
  assert.equal(defaultLoginAuthType(row), "oauth");
});

test("OAuth 元数据在、但 authMethods 没写 oauth 时也认（扩展注册的 provider）", () => {
  const row = { authMethods: [], oauth: { name: "Ext", label: "Sign in with Ext", subscription: false } };
  assert.deepEqual(loginAuthTypes(row), ["oauth"]);
  assert.equal(defaultLoginAuthType(row), "oauth");
});

test("空行 / 缺字段不会抛，也不假装支持登录", () => {
  assert.deepEqual(loginAuthTypes({}), []);
  assert.deepEqual(loginAuthTypes(), []);
  assert.deepEqual(loginAuthTypes({ authMethods: ["oauth"], oauth: null }), ["oauth"]);
  assert.equal(defaultLoginAuthType({}), "oauth");
});