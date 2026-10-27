/**
 * 域依赖的**真值提取器**：一个域工厂从共享袋 `deps` 里读了哪些名字，以及这些读取发生在
 * **建厂期**还是**闭包内**。
 *
 * 为什么必须分开：
 *
 * - **建厂期读取**（工厂函数体里直接执行的那些）是**真的排序约束** —— 读到还没发布的
 *   名字只会得到 `undefined`，而且可能被闭包捕获后永久坏掉。今天这个约束是靠
 *   `server/domains.mjs` 里手写的 `Object.assign(deps, { … })` 块**顺序**满足的。
 * - **闭包内读取**（处理器/回调里）只是「我可能用到这个名字」，袋子是共享可变的，
 *   读到的时候早就填好了。把它们也当排序约束会造出**假约束与假环**：实测 15 个域之间有
 *   130+ 条这样的反向边，还存在真环（`promptStream` 读 `sessionSnapshots` 的 `buildSnapshot`，
 *   `sessionSnapshots` 又读 `promptStream` 的 `abortSession`）—— 按文本读取做拓扑排序会把
 *   工厂顺序搅乱（连带搅乱建厂期的副作用顺序），而收益是零。
 *
 * 所以容器与 `domain-deps` 规则都用这里的两份清单：`eager` 定顺序，`lazy` 是名字闸的白名单。
 *
 * 用 TypeScript 的 parser 而不是正则：正则数不清「这个 `deps.x` 在不在嵌套函数里」。
 */

import ts from "typescript";

/** `deps.x` / `const { a, b } = deps;` 两种读取形态都收。 */
function recordReads(node, lazy, found) {
  const bucket = lazy ? found.lazy : found.eager;
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "deps"
  ) {
    bucket.add(node.name.text);
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isObjectBindingPattern(node.name) &&
    node.initializer &&
    ts.isIdentifier(node.initializer) &&
    node.initializer.text === "deps"
  ) {
    for (const element of node.name.elements) {
      if (ts.isIdentifier(element.name)) bucket.add(element.name.text);
    }
  }
  // `deps["x"]` 这种动态读取：声明不了就别想绕过闸，直接报出来。
  if (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "deps"
  ) {
    found.dynamic.push(node.getText());
  }
}

const FUNCTION_KINDS = [
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunction",
  "MethodDeclaration",
  "GetAccessor",
  "SetAccessor",
  "Constructor",
];

/**
 * 读一个域模块的文本，返回它从 `deps` 里读到的名字。
 *
 * @param {string} file 文件路径（只用来给错误定位）
 * @param {string} text 模块源码
 * @returns {{ eager: string[], lazy: string[], dynamic: string[] }}
 */
export function domainDeps(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = { eager: new Set(), lazy: new Set(), dynamic: [] };

  /** 工厂函数：唯一那个带 `deps` 形参的函数（模块里别的一堆 `create*` 只是局部工具）。 */
  const factories = [];
  const collect = (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === "deps")
    ) {
      factories.push(node);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  if (factories.length !== 1) {
    throw new Error(
      `${file}: 期望恰好一个带 deps 形参的工厂函数，实际 ${factories.length} 个（${factories
        .map((f) => f.name?.text ?? "(匿名)")
        .join(", ")}）`,
    );
  }

  for (const factory of factories) {
    // 从工厂体开始走。工厂**自己**这一层是 eager（建厂期就执行），进到任何嵌套函数才是 lazy。
    const walk = (node, lazy) => {
      const nowLazy = lazy || FUNCTION_KINDS.includes(ts.SyntaxKind[node.kind]);
      recordReads(node, nowLazy, found);
      ts.forEachChild(node, (child) => walk(child, nowLazy));
    };
    if (factory.body) ts.forEachChild(factory.body, (child) => walk(child, false));
  }
  return {
    eager: [...found.eager].sort(),
    lazy: [...found.lazy].sort(),
    dynamic: [...found.dynamic].sort(),
  };
}