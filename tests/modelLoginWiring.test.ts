/**
 * 「设置 → 添加模型」里的登录接线（TUI `/login` 的桌面版）。
 *
 * 桥没法在单测里整个起来（会拉起 runtime + 监听端口），所以这里盯的是**路由与判据**：
 *   1. 登录能力从 `provider.auth` 归一化出来，路由按它放行 —— TUI 能登的，这里就登得了；
 *   2. 登录方式（oauth / api_key）和供应商 id 无关，代码里不能出现供应商白名单；
 *   3. 客户端只用 `loginAuthTypes` 这两个纯规则决定入口，不自己列名单。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const serverSource = readFileSync(join(root, "server", "index.mjs"), "utf8");
const brokerSource = readFileSync(join(root, "server", "modelLogin.mjs"), "utf8");
const dialogSource = readFileSync(join(root, "src", "features", "models", "AddModelsDialog.tsx"), "utf8");
const loginDialogSource = readFileSync(join(root, "src", "features", "models", "ModelLoginDialog.tsx"), "utf8");

function functionBody(source, name) {
  const asyncAt = source.indexOf(`async function ${name}(`);
  const start = asyncAt === -1 ? source.indexOf(`function ${name}(`) : asyncAt;
  assert.notEqual(start, -1, `找不到 ${name}，实现被挪走了？`);
  let paren = source.indexOf("(", start);
  let depth = 0;
  for (; paren < source.length; paren += 1) {
    if (source[paren] === "(") depth += 1;
    else if (source[paren] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  let brace = 0;
  for (let index = source.indexOf("{", paren); index < source.length; index += 1) {
    if (source[index] === "{") brace += 1;
    else if (source[index] === "}") {
      brace -= 1;
      if (brace === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error("函数体没闭合");
}

/** 在任何一行里找一个「写死的供应商名单」的痕迹（pi 目录里出现过的 id）。 */
const providerIds = ["openai-codex", "anthropic", "github-copilot", "kimi-coding", "openrouter", "radius"];

test("桥用 pi 的登录实现，而不是自己拼一套：ModelRuntime.login + AuthInteraction", () => {
  const body = functionBody(serverSource, "streamModelLogin");
  assert.match(body, /modelRuntime\.login\(providerId, authType, interaction/, "要走 pi 的登录流程");
  assert.match(body, /getDeviceId: \(\) => runtime\.settingsManager\.getOrCreateDeviceId\(\)/, "OpenAI 订阅登录需要的 device id 要接上");
  assert.match(body, /providerLoginMethods\(provider\)/, "支持哪些登录方式按 provider.auth 判，不写死");
  assert.match(body, /modelLoginBroker\.start\(/, "交互事件要通过 broker 转成 NDJSON");
  assert.match(body, /res\.on\("close", \(\) => modelLoginBroker\.cancel\(sessionId\)\)/, "客户端断开要取消这次登录");
});

test("登录路由按 :id + authType 分派，respond / cancel 是独立口", () => {
  assert.match(serverSource, /url\.pathname === "\/api\/model-providers\/login\/respond"/);
  assert.match(serverSource, /url\.pathname === "\/api\/model-providers\/login\/cancel"/);
  assert.match(serverSource, /url\.pathname\.endsWith\("\/login"\)/);
  assert.match(serverSource, /await streamModelLogin\(req, res, providerId, requestId\)/);
  // respond / cancel 必须排在 /:id/login 之前，否则会被当成某家的登录。
  const respondAt = serverSource.indexOf('"/api/model-providers/login/respond"');
  const loginAt = serverSource.indexOf('url.pathname.endsWith("/login")');
  assert.ok(respondAt > 0 && loginAt > respondAt, "固定路由要排在参数化路由前面");
});

test("供应商行带上 OAuth 元数据，设置页才知道该显示哪几个入口", () => {
  const body = functionBody(serverSource, "providerRows");
  assert.match(body, /oauth: loginOauthMetadata\(provider\)/);
  assert.match(body, /apiKeyLogin: typeof provider\.auth\?\.apiKey\?\.login === "function"/);
  const meta = functionBody(serverSource, "loginOauthMetadata");
  assert.match(meta, /provider\?\.auth\?\.oauth/);
});

test("登录相关代码里没有供应商白名单：名单只可能来自 pi 的目录", () => {
  for (const id of providerIds) {
    assert.ok(!brokerSource.includes(id), `server/modelLogin.mjs 不该出现供应商 id: ${id}`);
    assert.ok(!dialogSource.includes(id), `AddModelsDialog 不该出现供应商 id: ${id}`);
    assert.ok(!loginDialogSource.includes(id), `ModelLoginDialog 不该出现供应商 id: ${id}`);
  }
});

test("客户端：入口由 loginAuthTypes / defaultLoginAuthType 决定，且用同一个弹窗跑流程", () => {
  assert.match(dialogSource, /loginAuthTypes\(provider \?\? \{\}\)/);
  assert.match(dialogSource, /setAuthType\(defaultLoginAuthType\(provider\)\)/);
  assert.match(dialogSource, /<ModelLoginDialog/);
  assert.match(loginDialogSource, /startModelLogin\(providerId, authType, handle/);
  assert.match(loginDialogSource, /respondModelLogin\(prompt\.id/);
  assert.match(loginDialogSource, /cancelModelLogin\(sessionId\)/);
});

test("pi 的事件 / 提问词汇原样透传，新增类型也能显示出来（不吞）", () => {
  assert.match(loginDialogSource, /payload\.event\.type === "auth_url"/);
  assert.match(loginDialogSource, /payload\.event\.type === "device_code"/);
  assert.match(loginDialogSource, /prompt\.prompt\.type === "select"/);
  // 认不出来的事件至少把 message / JSON 显示出来，而不是当没发生。
  assert.match(loginDialogSource, /JSON\.stringify\(event\)/);
});