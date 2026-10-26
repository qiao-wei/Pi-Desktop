/**
 * 路由表的缝：**匹配语义**在这里被观测（`server/routeTable.mjs` 是纯数据 + 纯函数）。
 *
 * 为什么要有一组测试：路由以前是 `server/index.mjs` 里的一长串 `if`，"哪条先匹配" 靠的是
 * 书写顺序，所以「固定路径排在参数化规则前面」是一条注释里的约定 —— 谁把它挪到后面，
 * 表面上看起来只是换了个位置，实际把 `/api/model-providers/login/respond` 交给了
 * `endsWith("/login")` 那行。现在顺序变成显式优先级字段，这组测试就是它的钉子。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ROUTE_KINDS, ROUTE_PRIORITY, ROUTES, matchRoute } from "../server/routeTable.mjs";
import { listSourceFiles, relativeTo } from "../scripts/architecture/lib/graph.mjs";
import { bridgeAnswers, routesFromTable } from "../scripts/architecture/lib/extractors.mjs";
import { checkRouteTable } from "../scripts/architecture/lib/routeRules.mjs";
import { loadPolicy, runCheck } from "../scripts/architecture/check.mjs";

const REPO_ROOT = join(import.meta.dirname, "..");

/** 一行路由（测匹配语义时用局部表，不需要为了验优先级去改真表）。 */
const row = (over: Record<string, unknown> = {}) => ({
  method: "GET",
  kind: "exact",
  priority: 0,
  path: "/api/x",
  handler: "handle_x",
  ...over,
});

test("三种形态各看各的那一段：exact 整条、prefix 开头、suffix 结尾", () => {
  const routes = [
    row({ path: "/api/models" }),
    row({ kind: "prefix", priority: 10, path: "/api/model-providers/" }),
    row({ method: "POST", kind: "suffix", priority: 10, path: "/login" }),
  ];
  assert.equal(matchRoute("GET", "/api/models", routes)?.path, "/api/models");
  assert.equal(matchRoute("GET", "/api/models/extra", routes), null, "exact 不吞前缀相同的别的路径");
  assert.equal(matchRoute("GET", "/api/model-providers/openai", routes)?.kind, "prefix");
  assert.equal(matchRoute("POST", "/api/model-providers/openai/login", routes)?.kind, "suffix");
});

test("方法参与匹配：同一条路径的 GET 与 POST 是两行", () => {
  const routes = [row({ method: "GET" }), row({ method: "POST", handler: "handle_post_x" })];
  assert.equal(matchRoute("GET", "/api/x", routes)?.handler, "handle_x");
  assert.equal(matchRoute("POST", "/api/x", routes)?.handler, "handle_post_x");
  assert.equal(matchRoute("DELETE", "/api/x", routes), null, "没声明的方法不该被别的行接住");
});

test("没有匹配就是 null —— 调用方据此回 404，而不是随便找一行兜底", () => {
  assert.equal(matchRoute("GET", "/api/nothing-here"), null);
  assert.equal(matchRoute("POST", "/api/models"), null, "路径对了方法不对也算没匹配");
});

test("优先级是显式字段：参数化那行写在前面，也赢不了固定路径", () => {
  const routes = [
    row({ method: "POST", kind: "suffix", priority: 10, path: "/login", handler: "handle_login" }),
    row({ method: "POST", path: "/api/model-providers/login/respond", handler: "handle_respond" }),
  ];
  assert.equal(
    matchRoute("POST", "/api/model-providers/login/respond", routes)?.handler,
    "handle_respond",
    "固定路径必须赢，和它在表里排第几无关",
  );
});

test("真表：每条路由都能匹配到自己（没有被谁吞掉）", () => {
  const shadowed = ROUTES.filter((route: any) => {
    const hit = matchRoute(route.method, route.path);
    return hit?.handler !== route.handler || hit?.kind !== route.kind;
  });
  assert.deepEqual(
    shadowed.map((route: any) => `${route.method} ${route.kind} ${route.path}`),
    [],
    "有一条路由被别人抢走，说明优先级或路径写错了",
  );
});

test("真表：固定路径的优先级是参数化的下界（顺序语义只由这一个数字决定）", () => {
  for (const route of ROUTES as any[]) {
    assert.ok(ROUTE_KINDS.includes(route.kind), `${route.path} 的 kind 不认识：${route.kind}`);
    assert.equal(typeof route.priority, "number", `${route.path} 必须写显式优先级`);
    if (route.kind === "exact") assert.equal(route.priority, ROUTE_PRIORITY.exact);
    else assert.ok(route.priority >= ROUTE_PRIORITY.exact, `${route.path} 不能排到固定路径前面`);
  }
});

test("真表：路径按方法唯一，处理器写的是名字", () => {
  const seen = new Set<string>();
  for (const route of ROUTES as any[]) {
    const key = `${route.method} ${route.kind} ${route.path}`;
    assert.equal(seen.has(key), false, `重复的路由：${key}`);
    seen.add(key);
    assert.match(route.handler, /^handle_\w+$/, `${key} 的处理器必须是组合区导出的名字`);
  }
});

test("表与冻结表面说的是同一件事：表面说接得住的，表接得住", () => {
  const surface = JSON.parse(
    readFileSync(join(REPO_ROOT, "architecture/generated/bridge-surface.json"), "utf8"),
  );
  const routes = routesFromTable(ROUTES as any);
  const lied = Object.entries<any>(surface.routes)
    .filter(([path, entry]) => entry.bridge && !bridgeAnswers(routes, path))
    .map(([path]) => path);
  assert.deepEqual(lied, [], "表面说桥回答这条路径，表里却没有对应的一行");
  const unlisted = [...routes.keys()].filter(
    (pattern) => !pattern.includes("*") && !surface.routes[pattern],
  );
  assert.deepEqual(unlisted, [], "表里有一行没进冻结表面（跑 `npm run architecture:write`）");
});
// ---------------------------------------------------------------------------------------
// 治理钩子：表是数据这件事本身要被咬住（A4 的 route-table 规则）
// ---------------------------------------------------------------------------------------

const policy = loadPolicy(REPO_ROOT);

/** 造一棵最小的假仓库：`server/` 下一个表、一个入口、一个想偷偷自己分流的文件。 */
function fakeRepo({ entry = 'import { matchRoute } from "./routeTable.mjs";\nmatchRoute("GET", "/");', stray = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "route-table-"));
  mkdirSync(join(root, "server"));
  writeFileSync(join(root, "server", "routeTable.mjs"), "export const ROUTES = [];\n");
  writeFileSync(join(root, "server", "index.mjs"), `${entry}\n`);
  if (stray) writeFileSync(join(root, "server", "sneaky.mjs"), `${stray}\n`);
  return root;
}

const ruleViolations = (root, routes: any[]) =>
  checkRouteTable(policy.routeTable, {
    root,
    violation: (rule, message, extra = {}) => ({ rule, message, ...extra }),
    listSourceFiles,
    relativeTo,
    routes,
  });

test("规则咬住：别的文件再长出「方法 + 路径」分流 → 报违规", () => {
  const stray = fakeRepo({
    stray: 'if (req.method === "GET" && url.pathname.startsWith("/api/other/")) return sendJson(res, 200, {});',
  });
  const violations = ruleViolations(stray, [
    { method: "GET", kind: "exact", priority: 0, path: "/api/x", handler: "handle_get_api_x" },
  ]);
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.match(violations[0].message, /sneaky\.mjs/);
  assert.equal(violations[0].rule, "route-table");
});

test("规则不冤枉人：处理器按路径取参数、注释里提到老分支，都不算第二份分发", () => {
  const innocent = fakeRepo({
    stray: [
      '/** 路由处理器：req.method === "GET" && url.pathname === "/api/x"（老写法，现在在表里） */',
      'export async function handle_get_api_x({ url }) {',
      '  return sendJson(res, 200, { id: url.pathname.slice("/api/x/".length) });',
      '}',
    ].join("\n"),
  });
  assert.deepEqual(
    ruleViolations(innocent, [
      { method: "GET", kind: "exact", priority: 0, path: "/api/x", handler: "handle_get_api_x" },
    ]),
    [],
  );
});

test("规则咬住：入口不查表 → 报违规（表存在但没人读也是死数据）", () => {
  const root = fakeRepo({ entry: '// 谁还记得这张表\nsendJson(res, 404, {});' });
  const violations = ruleViolations(root, [
    { method: "GET", kind: "exact", priority: 0, path: "/api/x", handler: "handle_get_api_x" },
  ]);
  assert.deepEqual(
    violations.map((item: any) => item.message),
    [`${policy.routeTable.dispatch} 没有用 matchRoute 查表：表存在但没人读`],
  );
});

test("规则咬住：优先级 / 形状 / 重复行各有各的违规", () => {
  const root = fakeRepo();
  const rows = [
    { method: "GET", kind: "exact", priority: 0, path: "/api/x", handler: "handle_get_api_x" },
    { method: "GET", kind: "suffix", priority: 0, path: "/login", handler: "handle_login" },
    { method: "GET", kind: "exact", priority: 0, path: "/api/x", handler: "handle_get_api_x" },
    { method: "GET", kind: "exact", priority: 0, path: "", handler: "handle_get_api_x" },
    { method: "GET", kind: "nope", priority: 0, path: "/api/y", handler: "handle_get_api_y" },
  ];
  const messages = ruleViolations(root, rows).map((item: any) => item.message);
  assert.deepEqual(
    messages.filter((message: string) => message.includes("priority 是")),
    ["GET suffix /login 的 priority 是 0，policy 声明 suffix 应为 10"],
    "参数化路由不能排到固定路径前面：优先级必须是声明值",
  );
  assert.deepEqual(
    messages.filter((message: string) => message.includes("重复")),
    ["重复的路由行：GET exact /api/x"],
  );
  assert.equal(messages.filter((message) => message.includes("缺少 path")).length, 1);
  assert.deepEqual(
    messages.filter((message) => message.includes("匹配种类")),
    ["GET nope /api/y 的匹配种类不认识：nope"],
  );
});

test("真仓库：route-table 规则零违规，且优先级下界就是 exact 声明的值", () => {
  const violations = runCheck(REPO_ROOT).violations.filter((item: any) => item.rule === "route-table");
  assert.deepEqual(violations.map((item: any) => item.message), []);
  assert.equal(policy.routeTable.priorities.exact, Math.min(...Object.values(policy.routeTable.priorities)));
});
