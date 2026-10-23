/**
 * B2 的契约测试：`App()` 拆成「7 个顺序 hook + 视图」之后，结构本身不能悄悄变形。
 *
 * 拆法（`.scratch/split-hook-segments.mjs`）是**顺序切段**：
 *   · `useAppModel()` 把 7 段按原语句顺序调用，段之间用一个共享 `deps` 传绑定；
 *   · 早的段需要的名字从 `deps` 解构，晚的段才声明的名字就地写成 `deps.X`
 *     （签名快照在 `src/app/appForwarded.ts`）；
 *   · 视图（`AppShell` / `ComposerRegion`）从 `view` 解构出需要的字段。
 *
 * 这里钉住四件会真出事的事：
 *   1. **hook 调用顺序**：React 靠顺序认 state，顺序一变状态就串位（比类型错误更难发现）；
 *   2. **段之间不许有运行时依赖**：只能 type-only 引用（互相 import 会绕成环，初始化顺序也乱）；
 *   3. **`deps.X` 与 `AppForwarded` 快照一一对应**：快照多一个键 = 快照漂移，少一个键 = 类型漏了；
 *   4. **model 装配点里不许再长出 hook**：`useAppModel.ts` 只该是「调用 7 段 + 拼返回值」。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const APP_DIR = join(import.meta.dirname, "..", "src", "app");
const read = (name: string) => readFileSync(join(APP_DIR, name), "utf8");

/** 拆分出来的段，顺序即 hook 调用顺序（与原 `useAppModel()` 的语句顺序一一对应）。 */
const SEGMENTS = [
  "useAppCore",
  "useAppWiring",
  "useAppComposer",
  "useAppTurn",
  "useAppComposerEditing",
  "useAppCaretSync",
  "useAppSearch",
] as const;

const parse = (name: string, text: string) =>
  ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    true,
    name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

test("useAppModel 按固定顺序调用 7 段（顺序变了 React 的 state 会串位）", () => {
  const source = read("useAppModel.ts");
  const sf = parse("useAppModel.ts", source);
  const hook = sf.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === "useAppModel",
  );
  assert.ok(hook?.body, "useAppModel 不见了");

  const order: string[] = [];
  const walk = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      (SEGMENTS as readonly string[]).includes(n.expression.text)
    )
      order.push(n.expression.text);
    ts.forEachChild(n, walk);
  };
  walk(hook.body);

  assert.deepEqual(order, [...SEGMENTS], "段的调用顺序必须与拆分前语句顺序一致");
});

test("段之间只有 type-only 依赖，运行时靠 useAppModel 装配", () => {
  for (const name of SEGMENTS) {
    const source = read(`${name}.ts`);
    const sf = parse(`${name}.ts`, source);
    const runtimeImports = sf.statements
      .filter((n): n is ts.ImportDeclaration => ts.isImportDeclaration(n))
      .filter((n) => !n.importClause?.isTypeOnly)
      .map((n) => n.moduleSpecifier.getText(sf).replace(/["']/g, ""));
    for (const other of SEGMENTS) {
      assert.ok(
        !runtimeImports.includes(`./${other}`),
        `${name}.ts 不能运行时 import ./${other}（会绕成环；要类型就用 import type）`,
      );
    }
    assert.ok(
      !runtimeImports.includes("./useAppModel"),
      `${name}.ts 不能运行时 import useAppModel（那是它自己的装配点）`,
    );
  }
});

test("deps.X 的读取集合与 appForwarded 快照一一对应", () => {
  const snapshot = read("appForwarded.ts");
  const snapshotSf = parse("appForwarded.ts", snapshot);
  const alias = snapshotSf.statements.find(
    (n): n is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(n) && n.name.text === "AppForwarded",
  );
  assert.ok(alias, "appForwarded.ts 里应有 AppForwarded 类型");
  const keys = new Set<string>();
  for (const member of (alias.type as ts.TypeLiteralNode).members) {
    assert.ok(ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name));
    keys.add((member.name as ts.Identifier).text);
  }
  assert.ok(keys.size > 10, `快照里的前向签名应有十几个；现在 ${keys.size} 个`);

  // 用 AST 取 `deps.X`（正则会把注释里举例的 `deps.X` 也算进来）。
  const readKeys = new Set<string>();
  for (const name of SEGMENTS) {
    const sf = parse(`${name}.ts`, read(`${name}.ts`));
    const walk = (n: ts.Node) => {
      if (
        ts.isPropertyAccessExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "deps"
      )
        readKeys.add(n.name.text);
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  // `deps.X` 也用在「解构出来的前段值」上吗？不会 —— 前段值走 `const { … } = deps;`（不带前缀），
  // 所以这里读到的名字**应该**正好是快照键集合（例外：`Object.assign` 之外的装配细节没有）。
  assert.deepEqual(
    [...readKeys].sort(),
    [...keys].sort(),
    "快照多一个键说明它漂移了（没人再前向读它）；少一个键说明某处 deps.X 没有签名兜底",
  );
});

test("model 装配点里不再长出 hook（只剩调用 + 拼返回值）", () => {
  const source = read("useAppModel.ts");
  for (const forbidden of [
    "useState(",
    "useEffect(",
    "useRef(",
    "useCallback(",
    "useMemo(",
    "useLayoutEffect(",
  ]) {
    assert.ok(!source.includes(forbidden), `useAppModel.ts 里不该再出现 ${forbidden}`);
  }
  assert.match(source, /return \{ \.\.\./, "应该用展开把各段返回值拼起来");
});

test("视图解构的字段都在各段导出里（拆出的字段名就是视图的契约）", () => {
  const exported = new Set<string>();
  for (const name of SEGMENTS) {
    const text = read(`${name}.ts`);
    const m = /return \{ ([^}]*)\};/.exec(text);
    assert.ok(m, `${name}.ts 结尾应有 return { … }（导出本段声明的名字）`);
    for (const field of m[1]
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean))
      exported.add(field);
  }

  for (const view of ["AppShell.tsx", "ComposerRegion.tsx"]) {
    const sf = parse(view, read(view));
    const fields = new Set<string>();
    const walk = (n: ts.Node) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isObjectBindingPattern(n.name) &&
        ts.isIdentifier(n.initializer) &&
        n.initializer.text === "view"
      )
        for (const el of n.name.elements)
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) fields.add(el.name.text);
      ts.forEachChild(n, walk);
    };
    walk(sf);
    assert.ok(fields.size > 20, `${view} 应该从 view 解构不少字段；现在 ${fields.size} 个`);
    const unknown = [...fields].filter((f) => !exported.has(f));
    assert.deepEqual(unknown, [], `${view} 解构了 model 上没有的字段`);
  }
});

test("App.tsx 只剩胶水：model + 视图，没有别的实现", () => {
  const source = read("App.tsx");
  assert.ok(source.split("\n").length < 40, "App.tsx 应该是两行胶水（+ 注释）");
  assert.match(source, /const model = useAppModel\(\)/);
  assert.match(source, /<AppShell view=\{model\} \/>/);
  for (const forbidden of ["useState(", "useEffect(", "useCallback(", "className="]) {
    assert.ok(!source.includes(forbidden), `App.tsx 里不该再有 ${forbidden}`);
  }
});

test("拆分没有留下孤儿的段文件（每个段文件都被 useAppModel 引用）", () => {
  const declared = readdirSync(APP_DIR).filter(
    (n) => /^useApp[A-Z].*\.ts$/.test(n) && n !== "useAppModel.ts",
  );
  assert.deepEqual(
    declared.map((n) => n.replace(/\.ts$/, "")).sort(),
    [...SEGMENTS].sort(),
    "src/app 下的 useAppXxx 段文件应与本文件的清单一致",
  );
});
