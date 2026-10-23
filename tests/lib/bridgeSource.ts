import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
 * 取某个路由分支**处理器函数**的函数体。
 *
 * 为什么需要它：路由分支体已从 `server` 回调里抽成 `handle_xxx(ctx)` 顶层函数
 * （见 `.scratch/branch-to-handlers.mjs`），再按域搬到 `server/routes*.mjs`。
 * 「钉分支体源码」的断言如果还按 `url.pathname === "…"` 到下一个标记去切区间，会随拆分假红。
 * 这里由分支里的 `return await handle_xxx(ctx)` 反查处理器名，再取它的函数体 —— 断言写的是
 * 「这个路由的行为」，不绑「它在哪个文件/哪一段」。
 *
 * @param source 桥源码（`bridgeSource()`）
 * @param marker 分支条件的片段，如 `url.pathname === "/api/builtin-command"`
 */
export function routeBody(source: string, marker: string): string {
  const at = source.indexOf(marker);
  if (at === -1) throw new Error(`routeBody: 找不到路由分支 ${marker}`);
  const call = /return await (handle_[a-z0-9_]+)\(/.exec(source.slice(at, at + 400));
  if (!call) throw new Error(`routeBody: 分支里没有处理器调用 ${marker}`);
  return functionBody(source, `async function ${call[1]}(`);
}

/** 处理器函数体里是否引用了某个东西（`routeBody` 的便捷版）。 */
export function routeBodyHas(source: string, marker: string, pattern: RegExp): boolean {
  return pattern.test(routeBody(source, marker));
}
