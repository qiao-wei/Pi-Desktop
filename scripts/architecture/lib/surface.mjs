/**
 * 冻结的协议表面（`architecture/generated/bridge-surface.json`）怎么生成。
 *
 * 从 `check.mjs` 搬出来：那个文件顶着 900 行的上限，而这是一段纯函数 —— 输入是
 * 「桥的路由表 + 客户端调用点」，输出是可以逐字节比对的文件内容，与规则判断无关。
 * 搬出来还顺带把 `check.mjs` 里唯一一处 `structuralMatch` 的用法收进了它自己的模块。
 */
import { structuralMatch } from "./extractors.mjs";

/**
 * @param {Map<string, Set<string>>} bridgeRoutes 路由表（`routesFromTable`）
 * @param {Map<string, {methods: Set<string>, callers: Set<string>}>} clientPaths 客户端调用点
 * @param {object} previous 上一次的表面（保留位；当前不参与生成）
 */
export function buildSurface(bridgeRoutes, clientPaths, previous) {
  const routes = {};
  const allPaths = new Set([...bridgeRoutes.keys(), ...clientPaths.keys()]);
  for (const path of allPaths) {
    if (path.includes("*") && !clientPaths.has(path)) continue;
    const callers = [...(clientPaths.get(path)?.callers ?? [])].sort();
    const methods = [
      ...new Set([...(clientPaths.get(path)?.methods ?? []), ...(bridgeRoutes.get(path) ?? [])]),
    ].sort();
    const transport = /\/prompt$/.test(path) || /\/diagnostic$/.test(path) ? "ndjson" : "json";
    routes[path] = {
      methods,
      transport,
      bridge: [...bridgeRoutes.keys()].some((pattern) => structuralMatch(pattern, path)),
      callers,
    };
  }
  const sorted = {};
  for (const path of Object.keys(routes).sort()) sorted[path] = routes[path];
  void previous;
  return { version: 1, routes: sorted };
}
