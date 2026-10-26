import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ROUTES, matchRoute } from "../../server/routeTable.mjs";

const SERVER_DIR = join(import.meta.dirname, "..", "..", "server");

/**
 * 桥的全部源码，按文件拼接。
 *
 * 为什么不是只读 `server/index.mjs`：桥的实现已经按领域拆成多个文件（`server/*.mjs`），
 * 而「结构性命中」这类断言想钉的是**桥里有这段行为**，不是「这段在哪个文件里」。
 * 钉文件的断言会在每次拆分时假红，逼人改断言 —— 那是把实现细节当契约。
 * 反过来，`bridgeFiles()` 给需要按文件看的场合（如逐文件的 bridge-closure 检查）用。
 */
export function bridgeSource(): string {
  return bridgeFiles()
    .map(([name, text]) => `\n// ---- ${name} ----\n${text}`)
    .join("\n");
}

/**
 * 只读桥的入口文件 `server/index.mjs`。
 *
 * 用在「处理器层不许再自己实现一份 X」这类断言上：X 可能**合法地**定义在别的模块里
 * （比如 `server/capabilityReload.mjs` 就定义 `sameCapabilityIds`），所以不能对整个树做否定断言。
 */
export function bridgeEntrySource(): string {
  return readFileSync(join(SERVER_DIR, "index.mjs"), "utf8");
}

/** 每份桥源码的（相对路径, 内容）。含 `server/` 下的所有 `.mjs`。 */
export function bridgeFiles(): [string, string][] {
  return readdirSync(SERVER_DIR)
    .filter((name) => name.endsWith(".mjs"))
    .sort()
    .map((name) => [`server/${name}`, readFileSync(join(SERVER_DIR, name), "utf8")]);
}

/** 截取某个函数的函数体（从 `function <name>(` 到下一个顶层 `}`），供结构性断言限定范围。 */
export function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start === -1) {
    throw new Error(`bridgeSource 里找不到 ${declaration}`);
  }
  const end = source.indexOf("\n}\n", start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

/**
 * 表里有没有这条路由。参数化路由传 `kind`（`"prefix"` / `"suffix"`）。
 *
 * 断言「桥上有这个端点」时问表，不要在源码里找 `url.pathname === "…"`：路由已经是数据
 * （`server/routeTable.mjs`），`if` 链那种写法不存在了，而且找字符串只能证明"某处提过这个路径"。
 */
export function hasRoute(method: string, path: string, kind = "exact"): boolean {
  return ROUTES.some((route) => route.method === method && route.kind === kind && route.path === path);
}

/** 这条请求会命中哪一行的处理器？（匹配语义的真源是表，不是这里的复述。） */
export function handlerFor(method: string, path: string): string {
  const route = matchRoute(method, path);
  if (!route) throw new Error(`路由表里没有能接住 ${method} ${path} 的一行`);
  return route.handler;
}

/** 把断言里的标记（`url.pathname === "/x"` / `.endsWith("/y")`，可带方法前缀）翻成表里的一行。 */
function routeForMarker(marker: string): { method: string; path: string; handler: string } {
  const method = /req\.method === "([A-Z]+)"/.exec(marker)?.[1];
  const path = /url\.pathname(?:\s*===\s*|\.startsWith\(|\.endsWith\()"([^"]+)"/.exec(marker)?.[1];
  const kind = marker.includes(".startsWith(")
    ? "prefix"
    : marker.includes(".endsWith(")
      ? "suffix"
      : "exact";
  if (!path) throw new Error(`routeBody: 认不出这个标记 ${marker}`);
  const candidates = ROUTES.filter(
    (route) => route.kind === kind && route.path === path && (!method || route.method === method),
  );
  if (candidates.length !== 1) {
    const found = candidates.map((route) => `${route.method} ${route.path}`).join("、") || "没有";
    throw new Error(`routeBody: ${marker} 对应 ${candidates.length} 行（${found}）；标记里带上方法`);
  }
  return candidates[0];
}

/**
 * 取某个路由**处理器函数**的函数体。
 *
 * 为什么需要它：路由分支体已从 `server` 回调里抽成 `handle_xxx(ctx)` 顶层函数
 * （见 `.scratch/branch-to-handlers.mjs`），再按域搬到 `server/routes*.mjs`。
 * 「钉分支体源码」的断言如果按 `url.pathname === "…"` 到下一个标记去切区间，会随拆分假红。
 * 这里由**路由表**反查处理器名，再取它的函数体 —— 断言写的是「这个路由的行为」，
 * 不绑「它在哪个文件/哪一段」，也不绑「那条分支写在表的第几行」。
 *
 * @param source 桥源码（`bridgeSource()`）
 * @param marker 路由的匹配条件片段，如 `url.pathname === "/api/builtin-command"`、
 *   `url.pathname.endsWith("/login")`（可带 `req.method === "X" && ` 前缀）
 */
export function routeBody(source: string, marker: string): string {
  return functionBody(source, `async function ${routeForMarker(marker).handler}(`);
}

/** 处理器函数体里是否引用了某个东西（`routeBody` 的便捷版）。 */
export function routeBodyHas(source: string, marker: string, pattern: RegExp): boolean {
  return pattern.test(routeBody(source, marker));
}
