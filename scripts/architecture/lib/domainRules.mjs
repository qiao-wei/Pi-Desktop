/**
 * `domain-deps` 规则的支撑：域依赖是**生成 + 校验**的，不是手写的第二份真源。
 *
 * 为什么需要检查器：A1 之前，15 个域工厂的建厂顺序靠 `server/domains.mjs` 里手写的顺序，
 * 每个工厂建厂期要读的名字靠一串 `Object.assign(deps, { … })` 夹块逐个喂饱 —— 喂养关系
 * 只存在于**书写顺序**里，漏一个就静默拿到 `undefined`（正是 `@type {any}` ×250 掩盖的东西）。
 * 现在装配交给 `server/domainContainer.mjs`，但表本身还是数据，数据会漂：
 * 有人在某个域模块里读了新名字而没更新表 → 启动时被名字闸拦下（好），但只有**跑起来**才发现；
 * 我们要它同时被 `npm run architecture:check` 拦住。
 *
 * 所以：`server/domainTable.mjs` 由 `scripts/architecture/lib/domainDeps.mjs` 的提取结果
 * **生成**（`npm run architecture:write`），本规则逐字节比对。表里的每一行都必须是提取器
 * 真读出来的，多一个少一个都红 —— 于是"声明"与"实际"不可能再各自漂移。
 *
 * 为什么不把 requires 手写：313 个名字（63 个建厂期 + 250 个闭包读取）手抄一遍必然有错，
 * 而它们 100% 可从模块文本推导。生成不是偷懒 —— 生成物的价值在于它同时是**启动期名字闸的白名单**（见 domainContainer.mjs）
 * 和**完整性校验的输入**（每个名字最终都得有人提供）。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { domainDeps } from "./domainDeps.mjs";

export const DOMAIN_TABLE = "server/domainTable.mjs";

/** `server/` 下带 `deps` 形参的工厂函数：`export function createX(state, deps) { … }`。 */
const FACTORY = /export function (create[A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/;

/**
 * 纯转发（`const X = (...args) => deps.X(...args)`）：A1 之前每个跨域读取都抄一份（实测 248 份，
 * 它们正是 `@type {any}` ×250 的来源）。容器建好后不需要了 —— 直接在调用点写 `deps.X(...)`：
 * 同样是调用时才取值，还少一层手写副本，名字闸也照旧管着。留着弊大于利：它看起来像本地函数
 * （`X.get(...)` 这类误用就由此而来，`tests/domainAssembly.test.ts` 曾专门写一条测试守它）。
 */
const PASS_THROUGH = /\((\.\.\.args)\)\s*=>\s*deps\.(\w+)\((\1)\)/;

/** 提取一个模块的域行；不是域模块（没有带 deps 的工厂）就返回 null。 */
export function domainRowOf(file, text) {
  const match = FACTORY.exec(text);
  if (!match || !/(^|,)\s*deps\s*(,|$)/.test(match[2])) return null;
  const { eager, lazy, dynamic } = domainDeps(file, text);
  return {
    id: file.replace(/\.mjs$/, ""),
    create: match[1],
    eager,
    lazy,
    dynamic,
  };
}

/**
 * 扫 `server/` 下所有域模块。`order` = 现有表里的 id 顺序（生成是**保序**的：新域追加在末尾，
 * 不重排既有行 —— 声明顺序是容器建厂顺序，改动应该是显式的 diff，不是生成器的副作用）。
 *
 * `exclude` 排掉入口与容器自己：它们也不巧带 `deps` 形参（`createBridgeDomains(state, deps, scope)`），
 * 但它们是**装配者**，不是被装配的域。
 */
export function scanDomainRows(root, order = [], exclude = []) {
  const dir = join(root, "server");
  const skip = new Set(exclude.map((file) => file.replace(/^server\//, "")));
  const rows = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) {
    if (skip.has(name)) continue;
    const text = readFileSync(join(dir, name), "utf8");
    const row = domainRowOf(name, text);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    if (ia === -1 && ib === -1) return a.id.localeCompare(b.id);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return rows;
}

/** 现有表里的 id 顺序（`id: "x"` 出现的先后）。 */
export function declaredOrder(tableText) {
  return [...tableText.matchAll(/^\s*id: "([^"]+)",$/gm)].map((m) => m[1]);
}

/**
 * 表里有多少个建厂期/闭包读取，以及两份清单涉及多少个**不同**的名字。
 * 生成器把统计写进文件头，好让「15 个域 / 63 / 250」这类数字跟着代码走，而不是烂在注释里。
 */
function describe(rows) {
  const declared = new Set();
  for (const row of rows) for (const name of [...row.eager, ...row.lazy]) declared.add(name);
  const eagerReads = rows.reduce((n, row) => n + row.eager.length, 0);
  const lazyReads = rows.reduce((n, row) => n + row.lazy.length, 0);
  return { eagerReads, lazyReads, declaredNames: declared.size };
}

function renderList(indent, key, names) {
  const head = `${indent}${key}: `;
  const one = `${head}[${names.map((n) => JSON.stringify(n)).join(", ")}],`;
  if (one.length <= 100) return [one];
  return [`${head}[`, ...names.map((n) => `${indent}  ${JSON.stringify(n)},`), `${indent}],`];
}

/** 渲染整张表（`--write` 写它，`--check` 逐字节比它）。 */
export function renderDomainTable(rows) {
  const stats = describe(rows);
  // import 由行生成（按 id 排序）：这是一份会随域增减的列表，手写它等于给生成器又塞一份会漂的真源。
  const imports = [...rows]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((row) => `import { ${row.create} } from "./${row.id}.mjs";`);
  const lines = [
    ...imports,
    "",
    "/**",
    " * 域表：每个域工厂从共享袋里读哪些名字，以及这些读取发生在**建厂期**还是**闭包里**。",
    " *",
    " * **本文件是生成物**（`npm run architecture:write`，`npm run architecture:check` 逐字节校验）：",
    " * 内容来自各域模块的真实读取（`scripts/architecture/lib/domainDeps.mjs` 用 TypeScript 解析器提取，",
    " * 不是正则 —— 正则数不清 `deps.x` 在不在嵌套函数里）。要改这张表，改模块或在提取器里补规则，",
    " * 然后重跑 `architecture:write`；手改这里会立刻被 `domain-deps` 规则打回。",
    " *",
    " * 两份清单是 `server/domainContainer.mjs` 的输入：",
    " *",
    ` * - \`eager\`：**建厂期**就要读到的名字（工厂函数体直接执行的部分）。容器建厂时校验它们已有值，`,
    " *   读到空值**当场抛**（报错点名域与名字）—— 这是**真排序约束**。不可放宽：返回 `undefined`",
    " *   只会炸在调用点（`deps.x is not a function`），那条信息对不上下一步干什么。",
    " * - `lazy`：**闭包里**可能读到的名字（请求处理器/回调里）。袋子是共享可变的，读到的时候早就填好了，",
    " *   它们不参与排序，只是名字闸的白名单。",
    " *",
    " * 为什么必须分这两类：按「模块文本里出现了哪些名字」做拓扑排序会把闭包读取也算成排序约束，",
    " * 实测 15 个域之间会凭空多出 130+ 条反向边和一个真环（`promptStream` ⇄ `sessionSnapshots`），",
    " * 而闭包读取对建厂顺序没有任何要求。",
    " *",
    ` * 当前规模：${rows.length} 个域 / ${stats.eagerReads} 个建厂期读取 / ${stats.lazyReads} 个闭包读取（去重后 ${stats.declaredNames} 个名字）。`,
    " * 今天这些建厂期读取没有一个指向别的域的导出（都是外部注入的常量，实测见 ADR-005），所以下面的顺序",
    " * 不被任何约束绑住 —— 但容器仍按这个顺序建，并校验每个域建厂期读到的名字都已就绪：将来真出现域间",
    " * 建厂期依赖，启动会点名告诉你要把哪一行往上搬。",
    " */",
    "export const DOMAINS = [",
  ];
  for (const row of rows) {
    lines.push("  {");
    lines.push(`    id: ${JSON.stringify(row.id)},`);
    lines.push(`    create: ${row.create},`);
    lines.push(...renderList("    ", "eager", row.eager));
    lines.push(...renderList("    ", "lazy", row.lazy));
    lines.push("  },");
  }
  lines.push("];", "");
  return lines.join("\n");
}

/** 当前应有的表文本（`check.mjs` 的 `generated` 用它，`--write` 写它；保序：沿用盘上已有的 id 顺序）。 */
export function generatedDomainTable(root, config = {}) {
  const tablePath = config.table ?? DOMAIN_TABLE;
  const existing = existsSync(join(root, tablePath)) ? readFileSync(join(root, tablePath), "utf8") : "";
  return renderDomainTable(
    scanDomainRows(root, declaredOrder(existing), [
      config.entry ?? "server/domains.mjs",
      config.container ?? "server/domainContainer.mjs",
    ]),
  );
}

/**
 * 规则本体：表必须与真实读取逐字节一致，且入口必须真的用容器装（表存在没人读 = 又一份死数据）。
 *
 * @param {object} config `policy.domainDeps`
 * @param {{ root: string, violation: Function }} helpers
 */
export function domainDepsViolations(config, helpers) {
  const { root, violation } = helpers;
  const tablePath = config?.table ?? DOMAIN_TABLE;
  const entry = config?.entry ?? "server/domains.mjs";
  const container = config?.container ?? "server/domainContainer.mjs";
  const violations = [];

  let tableText = "";
  try {
    tableText = readFileSync(join(root, tablePath), "utf8");
  } catch {
    violations.push(violation("domain-deps", `域表 ${tablePath} 不存在（跑 npm run architecture:write）`, { file: tablePath }));
    return violations;
  }

  const rows = scanDomainRows(root, declaredOrder(tableText), [entry, container]);
  const rendered = renderDomainTable(rows);
  if (rendered !== tableText) {
    const declared = declaredOrder(tableText);
    const actual = rows.map((r) => r.id);
    const added = actual.filter((id) => !declared.includes(id));
    const removed = declared.filter((id) => !actual.includes(id));
    const detail = added.length
      ? `新域没进表：${added.join(", ")}`
      : removed.length
        ? `表里有已消失的域：${removed.join(", ")}`
        : "某个域声明要用的名字与它真实读取的不一致";
    violations.push(
      violation("domain-deps", `${tablePath} 与各域模块的真实读取不一致（${detail}）—— 跑 npm run architecture:write`, {
        file: tablePath,
      }),
    );
  }

  for (const row of rows) {
    for (const expression of row.dynamic) {
      violations.push(
        violation("domain-deps", `${row.id} 用 ${expression} 动态读依赖：名字闸括不住动态读取，改成静态名字或把它写进白名单`, {
          file: `server/${row.id}.mjs`,
        }),
      );
    }
    const source = readFileSync(join(root, "server", `${row.id}.mjs`), "utf8");
    const passThrough = PASS_THROUGH.exec(source);
    if (passThrough) {
      violations.push(
        violation(
          "domain-deps",
          `${row.id} 又手写了一份纯转发（deps.${passThrough[2]}）：直接在调用点写 deps.${passThrough[2]}(...)`,
          { file: `server/${row.id}.mjs` },
        ),
      );
    }
  }

  // 表存在但没人读 = 又一份死数据：入口必须走容器。
  for (const required of [
    { file: container, needle: "export function createDomainContainer", why: "容器没有导出装配函数" },
    { file: entry, needle: "createDomainContainer(", why: "入口没调用容器（表没人读）" },
    { file: entry, needle: "DOMAINS", why: "入口没读域表" },
  ]) {
    let text = "";
    try {
      text = readFileSync(join(root, required.file), "utf8");
    } catch {
      violations.push(violation("domain-deps", `${required.file} 不存在`, { file: required.file }));
      continue;
    }
    if (!text.includes(required.needle)) {
      violations.push(
        violation("domain-deps", `${required.file} 里找不到 ${required.needle}（${required.why}）`, { file: required.file }),
      );
    }
  }

  return violations;
}