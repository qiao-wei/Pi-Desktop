/**
 * 架构约束本身的自检。
 *
 * 这个文件要回答两件事：
 * 1. 当前仓库满足 `docs/architecture/architecture.md` 与 `architecture/policy.json` 描述的规则吗？
 * 2. 那些规则**真的会拦东西**吗？—— 一个写坏了、永远返回 0 违规的检查器会让上面那个问题
 *    永远是"是"。所以下面既有真实仓库的断言，也有对规则语义的直接断言（含两个曾经真出过的 bug）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  REPO_ROOT,
  bridgeAnswers,
  extractBridgeRoutes,
  extractDeclaredEndpoints,
  extractInvokeSites,
  extractPreloadWhitelist,
  extractProtocolVersion,
  loadPolicy,
  matchGlob,
  mayImport,
  runCheck,
  structuralMatch,
} from "../scripts/architecture/check.mjs";
import { bridgeSource } from "./lib/bridgeSource.ts";

const policy = loadPolicy(REPO_ROOT);
const result = runCheck(REPO_ROOT, policy);

const docPaths = Object.values(policy.docs);
const docsLanded = docPaths.every((docPath) => existsSync(join(REPO_ROOT, docPath)));

test("仓库没有未登记的架构违规", () => {
  // docs-regions 单独一个用例：docs/ 有写保护，落盘需要显式开启（见 .wiki/output/）。
  const unexpected = result.violations.filter((item) => item.rule !== "docs-regions");
  assert.deepEqual(
    unexpected.map((item) => `[${item.rule}] ${item.message}`),
    [],
  );
});

test("架构文档在盘上，且生成的区域与策略逐字一致", { skip: docsLanded ? false : "docs/architecture 尚未落盘（需要 /pw allow-docs-write on），草稿在 .wiki/output/" }, () => {
  const stale = result.violations.filter((item) => item.rule === "docs-regions");
  assert.deepEqual(
    stale.map((item) => item.message),
    [],
  );
  for (const docPath of docPaths) {
    const text = readFileSync(join(REPO_ROOT, docPath), "utf8");
    assert.ok(text.includes("architecture:begin layers") || text.includes("architecture:begin protocols"), `${docPath} 缺少生成区域标记`);
  }
});

test("每个例外都带负责人和期限（债务是排过期的，不是永久豁免）", () => {
  assert.ok(policy.exceptions.length > 0, "预期登记了存量超大文件");
  for (const entry of policy.exceptions) {
    assert.ok(entry.reason?.length > 8, `例外缺少可读理由: ${entry.file ?? entry.key}`);
    assert.match(entry.owner ?? "", /^@/, `例外缺少负责人: ${entry.file ?? entry.key}`);
    assert.match(entry.deadline ?? "", /^\d{4}-\d{2}-\d{2}$/, `例外缺少期限: ${entry.file ?? entry.key}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(
    policy.exceptions.filter((entry) => entry.deadline < today).map((entry) => entry.file),
    [],
    "有例外已过期：要么处理，要么在 policy 里说明为什么延期",
  );
});

test("棘轮：被登记的文件不能超过登记时的行数", () => {
  const grown = result.violations.filter((item) => item.rule === "max-lines");
  assert.deepEqual(
    grown.map((item) => item.message),
    [],
  );
});

test("层方向语义：契约层可以被任何人 import，装配层可以 import 任何层，反向不行", () => {
  assert.equal(mayImport(policy, "kernel", "contracts"), true);
  assert.equal(mayImport(policy, "kernel", "protocol"), true);
  assert.equal(mayImport(policy, "presentation", "kernel"), true);
  assert.equal(mayImport(policy, "app", "presentation"), true);
  assert.equal(mayImport(policy, "tooling", "app"), true);

  // 反向就是违规
  assert.equal(mayImport(policy, "contracts", "kernel"), false);
  assert.equal(mayImport(policy, "kernel", "adapters"), false);
  assert.equal(mayImport(policy, "bridge", "adapters"), false);
  assert.equal(mayImport(policy, "foundation", "adapters"), false);
  assert.equal(mayImport(policy, "presentation", "app"), false);
});

test("桥的闭包：i18n 与 adapters 都不在 sidecar 里", () => {
  const safe = new Set(policy.modules.filter((module) => module.bridgeSafe).map((module) => module.id));
  assert.equal(safe.has("kernel"), true);
  assert.equal(safe.has("protocol"), true);
  assert.equal(safe.has("i18n"), false, "i18n 不进 sidecar：bridge 一旦可达它，打包后会崩");
  assert.equal(safe.has("adapters"), false);
});

test("glob 语义：** 跨目录、* 不跨目录", () => {
  assert.equal(matchGlob("src/**", "src/app/App.tsx"), true);
  assert.equal(matchGlob("src/**", "src/main.tsx"), true);
  assert.equal(matchGlob("server/**", "server/index.mjs"), true);
  assert.equal(matchGlob("**/*.test.ts", "tests/architecture.test.ts"), true);
  assert.equal(matchGlob("src/*", "src/app/App.tsx"), false);
  assert.equal(matchGlob("server/**", "src/index.mjs"), false);
});

test("路由匹配：前缀/后缀/参数段各自的语义（回归：前导 ** 曾经匹配一切）", () => {
  assert.equal(structuralMatch("/api/model-providers/**", "/api/model-providers/x/verify-key"), true);
  assert.equal(structuralMatch("/api/model-providers/**", "/api/model-providers/x"), true);
  assert.equal(structuralMatch("/api/model-providers/**", "/api/bootstrap"), false, "前缀模式不能吞掉别的路由");
  assert.equal(structuralMatch("**/verify-key", "/api/model-providers/:param/verify-key"), true);
  assert.equal(structuralMatch("**/verify-key", "/api/bootstrap"), false);
  assert.equal(structuralMatch("/api/sessions/:param", "/api/sessions/abc"), true);
  assert.equal(structuralMatch("/api/sessions/:param", "/api/sessions/abc/def"), false);
  assert.equal(structuralMatch("/api/sessions/:param", "/api/bootstrap"), false);
});

test("bridge 路由提取：真的从 server/index.mjs 里读出了方法+路径", () => {
  const routes = extractBridgeRoutes(bridgeSource());
  assert.ok(routes.size > 80, `只提取到 ${routes.size} 条路由，提取器很可能坏了`);
  const bootstrap = routes.get("/api/bootstrap");
  assert.ok(bootstrap, "没有提取到 /api/bootstrap");
  assert.equal([...bootstrap].includes("GET"), true);
  assert.equal(bridgeAnswers(routes, "/api/bootstrap"), true);
  assert.equal(bridgeAnswers(routes, "/api/nope"), false);
});

test("客户端调用点都被冻结表面覆盖（协议表面双向一致）", () => {
  const surface = JSON.parse(
    readFileSync(join(REPO_ROOT, "architecture/generated/bridge-surface.json"), "utf8"),
  ).routes;
  const unregistered = result.violations.filter((item) => item.rule === "protocol-surface");
  assert.deepEqual(
    unregistered.map((item) => item.message),
    [],
  );
  // 表面里每一条都必须是"桥真的应答"（否则冻结的就是一个不存在的协议）
  const lying = Object.entries(surface)
    .filter(([, entry]) => entry.bridge !== true)
    .map(([path]) => path);
  assert.deepEqual(lying, []);
});

test("手写核心端点不许说谎：都在桥里、since 不超过当前版本", () => {
  const endpoints = extractDeclaredEndpoints(
    readFileSync(join(REPO_ROOT, "src/shared/protocol/bridgeEndpoints.ts"), "utf8"),
  );
  assert.ok(endpoints.length >= 8, `只解析到 ${endpoints.length} 个核心端点`);
  assert.deepEqual(
    result.violations.filter((item) => item.rule === "protocol-core").map((item) => item.message),
    [],
  );
});

test("宿主命令三方一致：协议声明 == preload 白名单 == invoke 调用点", () => {
  const declared = readFileSync(join(REPO_ROOT, "src/shared/protocol/hostCommands.ts"), "utf8");
  const ids = [...declared.matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map((match) => match[1]);
  const preload = extractPreloadWhitelist(readFileSync(join(REPO_ROOT, "src-electron/preload.js"), "utf8"));
  assert.deepEqual([...preload].sort(), [...ids].sort(), "preload 白名单与协议声明不一致");

  const sites = extractInvokeSites(
    [join(REPO_ROOT, "src/app/App.tsx"), join(REPO_ROOT, "src/lib/shell/host.ts")],
    REPO_ROOT,
  );
  const undeclared = sites.filter((site) => !ids.includes(site.command));
  assert.deepEqual(undeclared, [], "有调用点使用了未声明的宿主命令");
});

test("边界协议版本两侧字面量相等", () => {
  const { declared, mirrored } = extractProtocolVersion(
    readFileSync(join(REPO_ROOT, "src/shared/protocol/version.ts"), "utf8"),
    readFileSync(join(REPO_ROOT, "server/protocolVersion.mjs"), "utf8"),
  );
  assert.equal(declared, mirrored);
  assert.equal(typeof declared, "number");
});

test("内核只从 piKernel.mjs 进入桥", () => {
  assert.deepEqual(
    result.violations.filter((item) => item.rule === "kernel-boundary").map((item) => item.message),
    [],
  );
});