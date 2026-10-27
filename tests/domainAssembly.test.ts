/**
 * 域装配（`server/domainContainer.mjs`）的不变式。
 *
 * `server/index.mjs` 拆成 15 个域之后，"谁在什么时候把什么填进共享袋"曾经是一条**隐式**契约：
 * 工厂用 `const { x } = deps` 立即取值、跨域用 `const x = (...args) => deps.x(...args)` 延迟取值，
 * 喂养关系只存在于 `server/domains.mjs` 的**书写顺序**里。写错不会有任何类型错误（`deps` 是 `any`），
 * 只会在某条请求路径上炸 —— 这条测试文件原本就是在守那些写法（见 e2e/README.md 里"上线第一天
 * 就抓到的真 bug"）。
 *
 * A1 之后装配交给容器：顺序与依赖变成 `server/domainTable.mjs` 里的**数据**，上面那些不变式
 * 由容器在**启动时**检查（名字闸 / 建厂期就绪 / 重名 / 完整性），所以这里改测**容器自己的契约** ——
 * 用合成域跑，不依赖真实域表：装错时不再是"某条路径炸"，而是桥起不来且指名道姓。
 *
 * 真实域表与真实模块的一致性由 `domain-deps` 规则管（`npm run architecture:check`）。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDomainContainer } from "../server/domainContainer.mjs";
import { loadPolicy, runCheck } from "../scripts/architecture/check.mjs";
import { domainDepsViolations, generatedDomainTable } from "../scripts/architecture/lib/domainRules.mjs";

const REPO_ROOT = join(import.meta.dirname, "..");

/** 合成域：只看装配契约，不牵扯真实模块。 */
const domain = (id, create, opts = {}) => ({
  id,
  create,
  eager: opts.eager ?? [],
  lazy: opts.lazy ?? [],
});

test("正常装配：按声明顺序建域，返回值并集交给入口，袋里的名字闭包随时可读", () => {
  const seen = [];
  const exports = createDomainContainer({
    domains: [
      domain("first", () => ({ alpha: 1 })),
      domain("second", (state, deps) => {
        seen.push({ state, alpha: deps.alpha });
        return { beta: () => deps.alpha + 1 };
      }, { lazy: ["alpha"] }),
    ],
    constants: { cwd: "/tmp" },
    state: { marker: true },
  });

  assert.deepEqual(seen, [{ state: { marker: true }, alpha: 1 }], "state 与已发布的 deps 都传下去了");
  assert.equal(exports.alpha, 1);
  assert.equal(exports.beta(), 2, "闭包读到的是袋里的值");
  assert.deepEqual(Object.keys(exports).sort(), ["alpha", "beta"], "两个域的导出并集");
});

test("外部注入的常量从头就在袋里（建厂期读到不会 undefined）", () => {
  const exports = createDomainContainer({
    domains: [domain("only", (state, deps) => ({ got: deps.cwd }), { eager: ["cwd"] })],
    constants: { cwd: "/tmp" },
    state: {},
  });
  assert.equal(exports.got, "/tmp");
});

test("名字闸：读没声明的名字立刻抛，并指名域与名字", () => {
  assert.throws(
    () =>
      createDomainContainer({
        domains: [domain("sneaky", (state, deps) => ({ value: deps.notDeclared }))],
        constants: {},
        state: {},
      }),
    /域 sneaky 读了没声明的名字 deps\.notDeclared/,
  );
});

test("名字闸：建厂期读到还没就绪的名字 → 装配失败（这就是顺序错误的报错样子）", () => {
  // `late` 提供 `thing`，但 `early` 声明在它前面并且建厂期就要读 —— 只可能是顺序错了。
  assert.throws(
    () =>
      createDomainContainer({
        domains: [
          domain("early", (state, deps) => ({ got: deps.thing }), { eager: ["thing"] }),
          domain("late", () => ({ thing: 42 })),
        ],
        constants: {},
        state: {},
      }),
    /域 early 建厂期读到的 deps\.thing 还没有值.*把提供它的域挪到它前面/s,
  );
});

test("闭包里的读取不参与排序：晚于自己的域提供的名字也能读（读到的是调用时的值）", () => {
  const exports = createDomainContainer({
    domains: [
      domain("reader", (state, deps) => ({ read: () => deps.lateValue }), { lazy: ["lateValue"] }),
      domain("late", () => ({ lateValue: "ready" })),
    ],
    constants: {},
    state: {},
  });
  assert.equal(exports.read(), "ready");
});

test("两个域返回同一个名字 → 装配失败（今天是静默覆盖）", () => {
  assert.throws(
    () =>
      createDomainContainer({
        domains: [domain("a", () => ({ dup: 1 })), domain("b", () => ({ dup: 2 }))],
        constants: {},
        state: {},
      }),
    /名字 dup 同时由域 a 与 b 返回/,
  );
});

test("声明的名字最终没人提供（也不是常量）→ 装配失败（拼错/被删的导出在这里现形）", () => {
  assert.throws(
    () =>
      createDomainContainer({
        domains: [domain("wants", () => ({ ok: 1 }), { lazy: ["missing"] })],
        constants: {},
        state: {},
      }),
    /域 wants 声明要用的 missing 没有任何域提供/,
  );
});

test("域 id 重名 → 装配失败", () => {
  assert.throws(
    () =>
      createDomainContainer({
        domains: [domain("twice", () => ({ a: 1 })), domain("twice", () => ({ b: 2 }))],
        constants: {},
        state: {},
      }),
    /域 id 重名：twice/,
  );
});

test("被 await 时读到的 then / toJSON / Symbol 不触发名字闸；整体枚举会（枚举不是声明）", async () => {
  const exports = createDomainContainer({
    domains: [
      domain(
        "ambient",
        (state, deps) => ({
          thenable: async () => (await Promise.resolve(deps)).cwd,
          enumerate: () => JSON.stringify(deps),
        }),
        { lazy: ["cwd"] },
      ),
    ],
    constants: { cwd: "/tmp" },
    state: {},
  });
  assert.equal(await exports.thenable(), "/tmp", "被 await 会读 then，放行");
  assert.throws(
    () => exports.enumerate(),
    /域 ambient 读了没声明的名字 deps\./,
    "枚举整个袋子会碰到别的域的名字 —— 这正是闸该拦的：要读什么就声明什么",
  );
});

test("装配失败是一次性报全部问题（不是第一个就停），方便一次看完", () => {
  assert.throws(
    () =>
      createDomainContainer({
        domains: [
          domain("a", () => ({ dup: 1 }), { lazy: ["nowhere"] }),
          domain("b", () => ({ dup: 2 })),
        ],
        constants: {},
        state: {},
      }),
    /装配失败（2 条）[\s\S]*名字 dup 同时由域 a 与 b 返回[\s\S]*域 a 声明要用的 nowhere/,
  );
});

// ---------------------------------------------------------------------------------------
// 治理钩子：域依赖是**生成 + 校验**的这件事本身要被咬住（A1 的 domain-deps 规则）
// ---------------------------------------------------------------------------------------

const policy = loadPolicy(REPO_ROOT);

/** 一棵最小的假仓库：一个域模块 + 一张由它生成的表 + 一个走容器的入口。 */
function fakeRepo({ modules = {}, entry } = {}) {
  const root = mkdtempSync(join(tmpdir(), "domain-deps-"));
  mkdirSync(join(root, "server"));
  writeFileSync(
    join(root, "server", "domainContainer.mjs"),
    "export function createDomainContainer() {\n  return {};\n}\n",
  );
  writeFileSync(
    join(root, "server", "domains.mjs"),
    entry ?? 'import { DOMAINS } from "./domainTable.mjs";\nimport { createDomainContainer } from "./domainContainer.mjs";\ncreateDomainContainer({ domains: DOMAINS });\n',
  );
  for (const [name, text] of Object.entries<string>(modules)) {
    writeFileSync(join(root, "server", name), `${text}\n`);
  }
  // 表由同一个渲染器生成 —— 这样"表过期"这个反例测的是比对，而不是我手抄的期望值。
  writeFileSync(join(root, "server", "domainTable.mjs"), generatedDomainTable(root, policy.domainDeps));
  return root;
}

const ruleViolations = (root: string) =>
  domainDepsViolations(policy.domainDeps, {
    root,
    violation: (rule: string, message: string, extra = {}) => ({ rule, message, ...extra }),
  });

const DOMAIN_MODULE = [
  'export function createWidgets(state, deps) {',
  '  const { timeout } = deps;',
  '  return {',
  '    readWidget: () => deps.thing,',
  '    getTimeout: () => timeout,',
  '  };',
  '}',
].join("\n");

test("规则不冤枉人：模块与表一致、入口走容器 → 零违规", () => {
  const root = fakeRepo({ modules: { "widgets.mjs": DOMAIN_MODULE } });
  assert.deepEqual(ruleViolations(root), []);
});

test("规则咬住：模块读了新名字而表没跟上 → 报违规（启动期名字闸之外的第二道）", () => {
  const root = fakeRepo({ modules: { "widgets.mjs": DOMAIN_MODULE } });
  writeFileSync(
    join(root, "server", "widgets.mjs"),
    `${DOMAIN_MODULE.replace("() => deps.thing", "() => deps.thing && deps.extra")}\n`,
  );
  const violations = ruleViolations(root) as any[];
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.equal(violations[0].rule, "domain-deps");
  assert.match(violations[0].message, /domainTable\.mjs 与各域模块的真实读取不一致/);
  assert.match(violations[0].message, /architecture:write/);
});

test("规则咬住：动态读依赖（deps[…]）→ 报违规（名字闸拦不住动态读取）", () => {
  const root = fakeRepo({
    modules: { "widgets.mjs": DOMAIN_MODULE.replace("deps.thing", "deps[name]") },
  });
  const messages = (ruleViolations(root) as any[]).map((item) => item.message);
  assert.ok(
    messages.some((message: string) => message.includes("动态读依赖")),
    JSON.stringify(messages),
  );
});

test("规则咬住：又手写一份纯转发 → 报违规（容器建好后直接在调用点写 deps.X）", () => {
  const root = fakeRepo({
    modules: {
      "widgets.mjs": [
        'export function createWidgets(state, deps) {',
        '  const thing = /** @type {any} */ ((...args) => deps.thing(...args));',
        '  return { readWidget: () => thing() };',
        '}',
      ].join("\n"),
    },
  });
  const messages = (ruleViolations(root) as any[]).map((item) => item.message);
  assert.deepEqual(
    messages,
    ["widgets 又手写了一份纯转发（deps.thing）：直接在调用点写 deps.thing(...)"],
  );
});

test("规则咬住：入口不调用容器 → 报违规（表存在但没人读也是死数据）", () => {
  const root = fakeRepo({
    modules: { "widgets.mjs": DOMAIN_MODULE },
    entry: '// 域表？谁记得住那张表\nsendJson(res, 404, {});',
  });
  const messages = (ruleViolations(root) as any[]).map((item) => item.message);
  assert.deepEqual(messages, [
    "server/domains.mjs 里找不到 createDomainContainer(（入口没调用容器（表没人读））",
    "server/domains.mjs 里找不到 DOMAINS（入口没读域表）",
  ]);
});

test("真仓库：domain-deps 规则零违规，且表里每个域都能在 server/ 里找到模块", () => {
  const violations = runCheck(REPO_ROOT).violations.filter((item: any) => item.rule === "domain-deps");
  assert.deepEqual(violations.map((item: any) => item.message), []);
  const table = readFileSync(join(REPO_ROOT, "server", "domainTable.mjs"), "utf8");
  const ids = [...table.matchAll(/^ {4}id: "([^"]+)",$/gm)].map((match) => match[1]) as string[];
  assert.ok(ids.length >= 15, `域表应有全部域（现在 ${ids.length}）`);
  for (const id of ids) {
    assert.ok(existsSync(join(REPO_ROOT, "server", `${id}.mjs`)), `域 ${id} 没有对应模块`);
  }
});
