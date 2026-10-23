/**
 * 读 `src/app/` 的源码文本。
 *
 * `App.tsx` 正在按「一簇一文件」拆（`max-lines` 棘轮冻着它，不许它再长），所以
 * 「这段代码在 App 里」这类断言不能再钉死某一个文件 —— 钉了就会在每次合法拆分时假红。
 *
 * - `appSource()`：整个 `src/app/` 目录拼起来的文本（正向断言用这个）；
 * - `appEntrySource()`：只看 `src/app/App.tsx`（「入口里不许再有本地实现」这类否定断言用）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(import.meta.dirname, "..", "..", "src", "app");

/** 按文件名排序的 `src/app/` 下的源码文件。 */
export function appFiles(): readonly (readonly [name: string, text: string])[] {
  return readdirSync(APP_DIR)
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .sort()
    .map((name) => [name, readFileSync(join(APP_DIR, name), "utf8")] as const);
}

/** `src/app/` 全目录拼接（每份文件带一行来源注释）。 */
export function appSource(): string {
  return appFiles()
    .map(([name, text]) => `// ---- src/app/${name} ----\n${text}`)
    .join("\n");
}

/** 只看 `src/app/App.tsx`。 */
export function appEntrySource(): string {
  return readFileSync(join(APP_DIR, "App.tsx"), "utf8");
}