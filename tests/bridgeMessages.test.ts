/**
 * Boundary `bridge`: the message field sets are declared once and checked from both sides.
 *
 * The bug class this guards: `BootstrapResponse` (interface in `src/lib/api.ts`) and the object the
 * bridge builds (`server/index.mjs`) were never compared, so deleting a server-side field showed up as
 * `undefined` in the UI rather than as an error. Three checks below:
 *
 * 1. the registry matches the interfaces the renderer actually uses (parse both sides);
 * 2. the bridge calls `assertBridgePayload(...)` on both snapshot answers (a tripwire so the runtime
 *    check cannot be dropped without touching this test);
 * 3. the runtime check itself behaves (missing fields named, complete payload clean).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AMBIENT_FIELDS,
  AMBIENT_OPTIONAL_FIELDS,
  AMBIENT_REQUIRED_FIELDS,
  BOOTSTRAP_OPTIONAL_FIELDS,
  BOOTSTRAP_REQUIRED_FIELDS,
  assertBridgePayload,
  missingBridgeFields,
} from "../src/shared/protocol/bridgeMessages.ts";
import { bridgeSource as readBridgeSource } from "./lib/bridgeSource.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiSource = readFileSync(join(root, "src/lib/api.ts"), "utf8");
const bridgeSource = readBridgeSource();

const sorted = (values: readonly string[]) => [...values].sort();

/** Field names declared on a TS interface in `api.ts`, with required/optional split. */
function declaredFields(interfaceName: string): { required: string[]; optional: string[] } {
  const start = apiSource.indexOf(`export interface ${interfaceName} {`);
  assert.ok(start >= 0, `src/lib/api.ts 里找不到 interface ${interfaceName}`);
  const end = apiSource.indexOf("\n}", start);
  const body = apiSource.slice(start, end);
  const required: string[] = [];
  const optional: string[] = [];
  // 顶层字段：两空格缩进 + 名字（可选带 `?`）；缩进更深的属于嵌套对象，不算顶层字段。
  for (const match of body.matchAll(/^ {2}([A-Za-z_$][\w$]*)(\?)?:/gm)) {
    const [, name, optionalMark] = match;
    (optionalMark ? optional : required).push(name);
  }
  return { required, optional };
}

test("快照字段集与渲染进程声明的接口一致（两个方向都比）", () => {
  const declared = declaredFields("BootstrapResponse");
  // 比较与声明顺序无关：顺序不是契约，字段集合才是（否则每次挪一行都红一次，而那是无意义噪声）。
  assert.deepEqual(
    sorted(BOOTSTRAP_REQUIRED_FIELDS.filter((field) => field !== "protocolVersion")),
    sorted(declared.required),
    "BOOTSTRAP_REQUIRED_FIELDS 与 BootstrapResponse 的必填字段必须一致",
  );
  // 刻意的不对称（两侧要求本就不同，所以显式写出来而不是抹平）：
  // 客户端把 `protocolVersion` 声明成可选 —— 它靠**校验后抛错**处理缺失（见 assertProtocolVersion），
  // 类型上没有假装「一定存在」；桥侧则必须每次带上它，所以在这里算必填。
  assert.deepEqual(
    sorted(BOOTSTRAP_OPTIONAL_FIELDS),
    sorted(declared.optional.filter((field) => field !== "protocolVersion")),
    "BOOTSTRAP_OPTIONAL_FIELDS 与 BootstrapResponse 的可选字段必须一致",
  );
  assert.ok(
    declared.optional.includes("protocolVersion"),
    "客户端侧 protocolVersion 是可选（靠校验抛错）",
  );
  assert.ok(
    BOOTSTRAP_REQUIRED_FIELDS.includes("protocolVersion"),
    "桥侧 protocolVersion 必须每次发送",
  );
});

test("ambient 字段集与 AmbientBootstrap 接口一致", () => {
  const declared = declaredFields("AmbientBootstrap");
  assert.deepEqual(
    sorted(AMBIENT_REQUIRED_FIELDS.filter((field) => field !== "protocolVersion")),
    sorted(declared.required),
  );
  assert.deepEqual(
    sorted(AMBIENT_OPTIONAL_FIELDS),
    sorted(declared.optional.filter((field) => field !== "protocolVersion")),
  );
  // ambient 的 protocolVersion 由 fetchJson 的类型交叉声明（不在接口体里），单独钉住。
  assert.ok(AMBIENT_FIELDS.includes("protocolVersion"), "ambient 必须声明协议版本字段");
  assert.match(
    apiSource,
    /AmbientBootstrap & \{ protocolVersion\?: number \}/,
    "fetchAmbientBootstrap 必须校验版本",
  );
});

test("桥在两条快照出口都调用了报文自检（不调就没人检查）", () => {
  assert.match(
    bridgeSource,
    /assertBridgePayload\(snapshot, "bootstrap"\)/,
    "sendBootstrapJson 必须自检快照",
  );
  assert.match(
    bridgeSource,
    /assertBridgePayload\(buildAmbientSnapshot\(state\.runtime\), "ambient"\)/,
    "ambient 出口必须自检",
  );
  assert.match(
    bridgeSource,
    /import \{ assertBridgePayload \} from "\.\.\/src\/shared\/protocol\/bridgeMessages\.ts"/,
    "桥必须从共享协议模块拿字段集（不能自己抄一份）",
  );
});

test("缺字段时点名，缺的是已声明字段时才报（未知字段不报）", () => {
  assert.deepEqual(missingBridgeFields({}, "bootstrap"), [...BOOTSTRAP_REQUIRED_FIELDS]);
  assert.deepEqual(missingBridgeFields({ snapshot: 1, projects: [] }, "bootstrap"), [
    "activeProjectId",
    "availableModels",
    "skills",
    "capabilities",
    "server",
    "projectTrusted",
    "canPrompt",
    "personalization",
    "protocolVersion",
  ]);
  assert.deepEqual(
    missingBridgeFields(
      { ambient: true, canPrompt: true, projectTrusted: true, protocolVersion: 1 },
      "ambient",
    ),
    [],
  );
  assert.deepEqual(missingBridgeFields(null, "ambient"), [...AMBIENT_REQUIRED_FIELDS]);
});

test("自检返回原对象（所以出口那句 sendJson 没法悄悄绕过检查）", () => {
  const payload = {
    ambient: true,
    canPrompt: true,
    projectTrusted: true,
    protocolVersion: 1,
    extra: "kept",
  };
  assert.equal(assertBridgePayload(payload, "ambient"), payload);
});

test("自检失败只写警告，不抛（一个字段缺失不该让整个快照 500）", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: string) => void warnings.push(String(message));
  try {
    const payload = assertBridgePayload({ ambient: true }, "ambient");
    assert.equal(payload.ambient, true, "仍然把快照还给调用方");
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /ambient payload is missing required field\(s\): canPrompt, projectTrusted, protocolVersion/,
  );
});

test("可选字段的语义：缺席是「没设置」，不是缺字段", () => {
  const payload = {
    snapshot: {},
    projects: [],
    activeProjectId: "p1",
    availableModels: [],
    skills: [],
    capabilities: {},
    server: { url: "x", ready: true },
    projectTrusted: true,
    canPrompt: true,
    personalization: {},
    protocolVersion: 1,
  };
  assert.deepEqual(
    missingBridgeFields(payload, "bootstrap"),
    [],
    "必填齐了就不该报，可选字段缺席是正常的",
  );
});
