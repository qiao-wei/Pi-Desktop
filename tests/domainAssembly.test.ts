/**
 * 域装配（B1 拆分后的接缝）的不变式。
 *
 * `server/index.mjs` 拆成 18 个域 + `server/domains.mjs` 组合区之后，"谁在什么时候把什么填进
 * `deps`"变成了一条**隐式**契约：域工厂用 `const { x } = deps` 立即取值，域之间用
 * `const x = (...args) => deps.x(...args)` 延迟取值。这两条写错都不会有任何类型错误，
 * 只会在某条请求路径上炸 —— 而且 node 级测试通常碰不到，因为那条路径从来没人真跑过。
 *
 * 这里把两处**已经真的炸过**的写法钉成断言（见 e2e/README.md「它上线第一天就抓到的真 bug」）：
 *
 * 1. 立即解构只能列"建厂前就填好"的名字（否则捕获到 `undefined`）；
 * 2. 延迟转发的名字**不能**被当成对象用（`X.get(...)` / `X.register(...)`）——
 *    转发体是函数，属性访问会丢；Map 与对象必须直接用 `deps.X`。
 * 3. 一个工厂在组合区只能建一次（拆出两行 `createX(...)` 会让两个实例各持一份外部状态）。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { stripComments } from "../scripts/architecture/lib/extractors.mjs";

const ROOT = join(import.meta.dirname, "..");
const SERVER_DIR = join(ROOT, "server");
const DOMAINS = readFileSync(join(SERVER_DIR, "domains.mjs"), "utf8").split("\n");

const serverFiles = readdirSync(SERVER_DIR)
  .filter((name) => name.endsWith(".mjs"))
  .sort();

/** 工厂名 → 定义它的文件。 */
const factoryFiles = new Map();
for (const name of serverFiles) {
  const source = readFileSync(join(SERVER_DIR, name), "utf8");
  const factory = source.match(/export function (create\w+)\(/);
  if (factory) {
    factoryFiles.set(factory[1], name);
  }
}

/** 组合区里，名字最早在第几行被填进 deps。 */
function depsFillLines() {
  const filled = new Map();
  const remember = (name, line) => {
    if (!filled.has(name) || line < filled.get(name)) {
      filled.set(name, line);
    }
  };
  // 整份文件一起看：`const { … } = scope;` 与 `Object.assign(deps, { … });` 都可能跨行，
  // 逐行匹配会在多行时静默少记（然后假红：把正确的立即解构判成「从没填过」）。
  const whole = DOMAINS.join("\n");
  const lineAt = (offset) => whole.slice(0, offset).split("\n").length;
  for (const match of whole.matchAll(/const \{([\s\S]*?)\} = scope;/g)) {
    for (const entry of match[1].split(",")) {
      if (entry.trim()) remember(entry.trim(), lineAt(match.index));
    }
  }
  for (const match of whole.matchAll(/Object\.assign\(deps, \{([\s\S]*?)\}\);/g)) {
    for (const entry of match[1].split(",")) {
      const name = entry.split(":")[0].trim();
      if (name) remember(name, lineAt(match.index));
    }
  }
  DOMAINS.forEach((text, index) => {
    const line = index + 1;
    // 整域注入：`Object.assign(deps, mcpServers)` —— 成员就是该厂 `return { ... }` 列出的名字。
    const injected = text.match(/Object\.assign\(deps, (\w+)\);/);
    if (injected) {
      const factory = factoryNamesByVariable().get(injected[1]);
      const file = factory ? factoryFiles.get(factory) : undefined;
      if (file) {
        const returned = readFileSync(join(SERVER_DIR, file), "utf8").match(
          /return \{ ([^}]*) \};/,
        );
        if (returned) {
          for (const entry of returned[1].split(",")) {
            if (entry.trim()) remember(entry.trim(), line);
          }
        }
      }
    }
  });
  return filled;
}

/** 组合区里 `const x = createY(state, deps)` 建立变量名到工厂的映射。 */
function factoryNamesByVariable() {
  const byVariable = new Map();
  for (const text of DOMAINS) {
    const match = text.match(/const (\w+) = (create\w+)\(state, deps\);/);
    if (match) {
      byVariable.set(match[1], match[2]);
    }
  }
  return byVariable;
}

/** 工厂名 → 组合区里第一次建它的行号。 */
function factoryCreationLines() {
  const created = new Map();
  DOMAINS.forEach((text, index) => {
    const match = text.match(/= (create\w+)\(state, deps\);/);
    if (match && !created.has(match[1])) {
      created.set(match[1], index + 1);
    }
  });
  return created;
}

test("域工厂立即解构的 deps 成员，必须在建厂之前就已经填好", () => {
  const filled = depsFillLines();
  const created = factoryCreationLines();
  const findings = [];

  for (const [factory, file] of factoryFiles) {
    const line = created.get(factory);
    if (line === undefined) {
      continue;
    }
    const source = readFileSync(join(SERVER_DIR, file), "utf8");
    const body = source.slice(source.indexOf(`export function ${factory}(`));
    for (const match of body.matchAll(/^[ \t]{2}const \{([^}]*)\} = deps;$/gm)) {
      for (const entry of match[1].split(",")) {
        const name = entry.trim();
        if (!name) {
          continue;
        }
        const available = filled.get(name);
        if (available === undefined) {
          findings.push(`${file}: ${name} 从没被填进 deps（立即解构 → 永久 undefined）`);
        } else if (available > line) {
          findings.push(
            `${file}: ${name} 第 ${available} 行才填，但第 ${line} 行就建厂了（立即解构 → 永久 undefined）`,
          );
        }
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    `跨域名字要写成延迟转发（\`(...args) => deps.X(...args)\`）：\n${findings.join("\n")}`,
  );
});

test("延迟转发的名字不能被当成对象用（Map / 带方法的对象必须直接用 deps.X）", () => {
  const findings = [];
  for (const name of serverFiles) {
    const raw = readFileSync(join(SERVER_DIR, name), "utf8");
    // 找转发声明要在**原文**上找：`stripComments` 会把 `/** @type {any} */` 当成块注释删掉，
    // 声明本身就不成形状了（这个坑第一次写这条测试时踩到了 —— 扫描找到 0 个转发，于是永远绿）。
    const wrappers = [
      ...raw.matchAll(
        /^[ \t]*const (\w+) = \/\*\* @type \{any\} \*\/ \(\(\.\.\.args\) => deps\.(\w+)\(\.\.\.args\)\);$/gm,
      ),
    ];
    const source = stripComments(raw);
    for (const [, local, target] of wrappers) {
      // 允许 `deps.NAME.get(...)` 与裸 `NAME.get(...)` 两种写法：后者是历史写法，前者是修好之后的写法。
      const propertyUse = new RegExp(`(?:\\bdeps\\.)?\\b${local}\\s*[.[]`);
      if (propertyUse.test(source)) {
        findings.push(
          `${name}: ${local} 被当成对象用了（转发体是函数 → 属性访问丢失），应改为直接用 deps.${target}`,
        );
      }
    }
  }

  assert.deepEqual(findings, [], findings.join("\n"));
});

test("一个域工厂在组合区只建一次", () => {
  const counts = new Map();
  for (const text of DOMAINS) {
    const match = text.match(/= (create\w+)\(state, deps\);/);
    if (match) {
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    }
  }
  const duplicated = [...counts]
    .filter(([, count]) => count > 1)
    .map(([factory, count]) => `${factory} 建了 ${count} 次`);
  assert.deepEqual(
    duplicated,
    [],
    `重复建厂会让同一个域出现两份实例，各自持有自己的外部状态：\n${duplicated.join("\n")}`,
  );
  assert.ok(counts.size >= 15, `组合区里应该建起全部域工厂（现在 ${counts.size} 个）`);
});
