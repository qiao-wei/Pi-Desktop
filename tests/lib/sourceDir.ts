/**
 * 读某个 `src/` 子目录的全部源码文本（拼接）。
 *
 * 用法：拆分把一个文件里的代码分到同目录的多个文件时，「这段代码在 X 里」这类结构性断言
 * 必须改成读整个目录，否则每次合法拆分都会假红（2026-10-23 起 App.tsx 与 MessageEditBox.tsx
 * 都这么拆过）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TESTS_DIR = join(import.meta.dirname, "..");

/** `src/<...dir>` 下所有 `.ts` / `.tsx` 拼接（每份带一行来源注释）。 */
export function sourceDir(relativeDir: string): string {
  const dir = join(TESTS_DIR, "..", relativeDir);
  return readdirSync(dir)
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .sort()
    .map((name) => `// ---- ${relativeDir}/${name} ----\n${readFileSync(join(dir, name), "utf8")}`)
    .join("\n");
}
