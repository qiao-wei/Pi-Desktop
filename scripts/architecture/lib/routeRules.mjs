/**
 * `route-table` 规则的支撑：路由是数据，而且**只有这一张表**。
 *
 * 为什么需要检查器：A2 之前，桥有哪些路由、哪条先匹配、谁处理，全都编码在
 * `server/index.mjs` 那条 269 行的 `if` 链的**书写顺序**里 —— 表面靠正则回读（扒不到就
 * 静默少一条），"固定路由必须排在参数化规则前面" 只是注释里的约定。
 * 把路由变成表不难，难的是**不让它退回去**：只要还有人能在某个 `server/*.mjs` 里顺手写一句
 * `if (url.pathname === "/api/x")`，就会重新长出第二份真源、两处各自漂移。
 *
 * 所以这条规则检查四件事（每件都有反例测试）：
 *   1. 除了表本身，`server/` 里没有任何文件再按 `url.pathname` 比较字面量（没有第二份分发）；
 *   2. 每行都必须写显式 `priority`，且等于该 `kind` 在 policy 里声明的值 ——
 *      `exact` 的优先级因此永远是参数化的下界，与书写顺序无关；
 *   3. 行形状完整（method / kind / path / handler）且 `(method, kind, path)` 不重复；
 *   4. 入口文件真的用 `matchRoute` 查表（表存在但没人读 = 又一份死数据）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "../../../server/routeTable.mjs";
import { stripComments } from "./extractors.mjs";

/**
 * 整个 `server/` 里**按方法 + 路径字面量**分流的样子 —— 也就是那条 `if` 链的形态：
 * `req.method === "GET" && url.pathname === "/api/protocol"`（两个方向都算）。
 *
 * 为什么不是"只要出现 `url.pathname` 就报"：处理器内部按路径取参数（`url.pathname.slice(…)`）
 * 是正常写法，`server/index.mjs` 里的请求追踪名单也读 `url.pathname`；把那些当成"第二份分发"
 * 会让规则变成狼来了。命中它需要同时具备：方法比较 + 紧跟字面量的路径比较。注释先剥掉
 * （处理器上方的 JSDoc 会把老分支条件写成一句说明，那是文档，不是代码）。
 */
const ROUTE_BRANCH = [
  /req\.method\s*===[\s\S]{0,200}?url\.pathname\s*(?:===|\.startsWith\(|\.endsWith\()\s*"/,
  /url\.pathname\s*(?:===|\.startsWith\(|\.endsWith\()\s*"[\s\S]{0,200}?req\.method\s*===/,
];

/**
 * `routes` 由调用方传进来（`check.mjs` 已经 import 了表）：规则函数保持同步，
 * 反例测试也就能喂一张合成的表，不用为了造错误去改真表。
 *
 * @param {object} config `policy.routeTable`
 * @param {{ root: string, violation: Function, listSourceFiles: Function, relativeTo: Function, routes: ReadonlyArray<object> }} helpers
 */
/** 用真表跑一遍（`check.mjs` 的调用点）：一行接上，别让它再长成一段。 */
export function routeTableViolations(config, helpers) {
  return checkRouteTable(config, { ...helpers, routes: ROUTES });
}

export function checkRouteTable(config, helpers) {
  const { root, violation, listSourceFiles, relativeTo, routes } = helpers;
  const violations = [];
  const source = config?.source ?? "server/routeTable.mjs";
  const dispatch = config?.dispatch ?? "server/index.mjs";
  const kinds = config?.kinds ?? ["exact", "prefix", "suffix"];
  const priorities = config?.priorities ?? {};

  if (!existsSync(join(root, source))) {
    violations.push(violation("route-table", `路由表 ${source} 不存在`, { file: source }));
    return violations;
  }
  if (!existsSync(join(root, dispatch))) {
    violations.push(violation("route-table", `入口 ${dispatch} 不存在`, { file: dispatch }));
    return violations;
  }

  const files = listSourceFiles(join(root, "server")).map((file) => relativeTo(root, file));
  for (const file of files) {
    if (file === source) continue;
    const text = stripComments(readFileSync(join(root, file), "utf8"));
    if (ROUTE_BRANCH.some((pattern) => pattern.test(text))) {
      violations.push(
        violation(
          "route-table",
          `${file} 里又按 url.pathname 分流了：路由是数据，加一行到 ${source}（别再长第二份真源）`,
          { file },
        ),
      );
    }
  }

  const dispatchText = readFileSync(join(root, dispatch), "utf8");
  if (!dispatchText.includes("matchRoute(")) {
    violations.push(
      violation("route-table", `${dispatch} 没有用 matchRoute 查表：表存在但没人读`, { file: dispatch }),
    );
  }

  // 表本体：形状、显式优先级、重复行。读的是导入进来的真值（不是正则扒源码 —— 那正是 A2 之前的毛病）。
  const seen = new Set();
  for (const route of routes ?? []) {
    const where = `${route.method} ${route.kind} ${route.path}`;
    for (const field of ["method", "kind", "path", "handler"]) {
      if (typeof route[field] !== "string" || route[field].length === 0) {
        violations.push(
          violation("route-table", `路由行缺少 ${field}：${JSON.stringify(route)}`, { file: source }),
        );
      }
    }
    if (!kinds.includes(route.kind)) {
      violations.push(
        violation("route-table", `${where} 的匹配种类不认识：${route.kind}`, { file: source }),
      );
      continue;
    }
    if (typeof route.priority !== "number") {
      violations.push(
        violation("route-table", `${where} 必须写显式 priority（顺序不能是书写顺序）`, {
          file: source,
        }),
      );
    } else if (route.priority !== priorities[route.kind]) {
      violations.push(
        violation(
          "route-table",
          `${where} 的 priority 是 ${route.priority}，policy 声明 ${route.kind} 应为 ${priorities[route.kind]}`,
          { file: source },
        ),
      );
    }
    if (seen.has(where)) {
      violations.push(violation("route-table", `重复的路由行：${where}`, { file: source }));
    }
    seen.add(where);
  }
  if (!routes || routes.length === 0) {
    violations.push(violation("route-table", `${source} 里一条路由都没有`, { file: source }));
  }
  return violations;
}
