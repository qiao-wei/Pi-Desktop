/**
 * 路由表的缝：**匹配语义**在这里被观测（`server/routeTable.mjs` 是纯数据 + 纯函数）。
 *
 * 为什么要有一组测试：路由以前是 `server/index.mjs` 里的一长串 `if`，"哪条先匹配" 靠的是
 * 书写顺序，所以「固定路径排在参数化规则前面」是一条注释里的约定 —— 谁把它挪到后面，
 * 表面上看起来只是换了个位置，实际把 `/api/model-providers/login/respond` 交给了
 * `endsWith("/login")` 那行。现在顺序变成显式优先级字段，这组测试就是它的钉子。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ROUTE_KINDS, ROUTE_PRIORITY, ROUTES, matchRoute } from "../server/routeTable.mjs";
import { bridgeAnswers, routesFromTable } from "../scripts/architecture/lib/extractors.mjs";

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