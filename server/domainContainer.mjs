/**
 * 域容器：所有域工厂的**唯一**装配点。
 *
 * 它接手的是原来手写在 `server/domains.mjs` 里的东西——「哪个域在谁之前建」「哪些名字在建厂时
 * 就得有值」。那套手写顺序靠 `Object.assign(deps, { … })` 夹块逐个满足，错了只会静默拿到
 * `undefined`；现在改成**声明 + 启动时校验**。
 *
 * 四件事，全部在启动时（fail fast，装配坏了桥起不来）：
 *
 * 1. **名字闸**：域拿到的是只认它声明过的名字的 ctx。读没声明的名字立刻抛异常，带上域 id 与名字，
 *    而不是塞个 `undefined` 让它烂进闭包（那正是 `@type {any}` ×250 掩盖的东西）。
 *    `then`/`toJSON`/`constructor` 这类**任何值都可能被读**的属性与 Symbol 放行（被 await、打日志、
 *    `String(x)` 都会碰）；但整体枚举（`JSON.stringify(deps)`、`{ ...deps }`、`Object.keys` 后逐个取值）
 *    **会命中闸** —— 枚举不是声明，拿到的是别的域的导出。今天 `server/` 里没有这种写法。
 * 2. **建厂期就绪校验**：建厂期（工厂函数体直接执行的部分）读到的名字必须已有值，否则**当场抛**。
 *    不抛的话读到的是 `undefined`，真正炸的是**调用点**（`deps.findProject is not a function`）——
 *    那句话指不出「哪个域缺哪个名字」，也就等于又回到 A1 之前那种「只在某条请求路径上炸」的状态。
 *    报错分三类：常量传了 undefined / 提供者返回了 undefined / 还没有人提供（给动作：去找哪个域 return 了它）。
 *    **闭包里的读取不参与排序**：袋子是共享可变的，闭包读到的时候早就填好了；把闭包读当排序约束
 *    会造出假环（实测 15 个域之间 130+ 条这种反向边，还有真环），收益是零。
 * 3. **发布**：域的返回值整包进共享袋；两个域返回同一个名字会在启动时抛（今天是静默覆盖）。
 * 4. **合并**：全部域导出的并集交给入口（路由表、入口自己用的那几个名字都从这里取）。
 *
 * `constants` 是「不属于任何域、以外部分注入的名字」（路径、环境、共享 Map…）。它们从头就在袋里，
 * 所以建厂期读到它们永远满足——这也是实测 63 个建厂期读取**全是常量**的原因：域之间今天没有
 * 任何建厂期依赖，声明顺序因此不被任何约束绑住（将来真出现了，第 2 条会在启动时点名告诉你要把哪一行往上搬）。
 */

/**
 * 读 `then`/`toJSON`/`constructor` 这类名字是任何 JS 值都可能发生的（被 await、被打日志、
 * `String(x)`），它们不是依赖声明，直接放行。Symbol（`Symbol.iterator` 等）同理。
 */
const AMBIENT_PROPS = new Set(["then", "toJSON", "constructor", "toString", "valueOf", "inspect"]);

/**
 * @param {object} options
 * @param {ReadonlyArray<{id: string, create: Function, eager: string[], lazy: string[]}>} options.domains
 *   域表：`eager` 是建厂期要读的名字，`lazy` 是闭包里可能读的名字（两者都是名字闸的白名单）。
 * @param {Record<string, unknown>} options.constants 外部注入的名字（路径/环境/共享结构）。
 * @param {unknown} options.state 共享可变状态，原样传给每个工厂。
 * @returns {Record<string, any>} 全部域导出的并集。
 */
export function createDomainContainer({ domains, constants, state }) {
  const bag = { ...constants };
  const constantNames = new Set(Object.keys(constants));
  /** @type {Map<string, string>} 名字 → 提供它的域（发布时检出重名）。 */
  const ownerOf = new Map();
  /** @type {Map<string, string[]>} 域 id → 它声明的名字。 */
  const declaredBy = new Map();
  const exports = {};

  const problems = [];

  /**
   * 建厂期读到还没值的名字。**当场抛**，因为返回 `undefined` 只会在调用点炸成
   * `deps.x is not a function`——那条信息既不说哪个域，也不说下一步干什么。
   *
   * 这里不能点名「提供它的域是谁」：顺序错误恰恰意味着那个域**还没建**，袋里根本没有它的导出
   * （静态名字表只记「谁读」，不记「谁提供」—— 后者是真实返回值，见 ADR-005 偏差 2）。
   * 所以顺序这一类给的是动作（去 `server/` 里找哪个域 `return` 了它），不是名字。
   * @param {string} domainId
   * @param {string} name
   */
  function notReady(domainId, name) {
    const why = constantNames.has(name)
      ? "它被当作外部注入的常量，但传进来的值就是 undefined（检查 constants 里这一项）"
      : ownerOf.has(name)
        ? "提供它的域确实已经建了，但它把那项返回成了 undefined"
        : "还没有任何域提供它：要么提供它的域排在这一行后面（去 server/ 里找哪个域 return 了它，挪到前面），要么这个名字拼错了";
    return new Error(`域 ${domainId} 建厂期读到的 deps.${name} 还没有值（${why}）`);
  }

  // 0) 声明自检：域 id 不能重名。（**读**同一个名字是正常的：`appCwd`、`findProject` 谁都可以用；
  // 两个域**返回**同名才算问题，那在第 3 步用真实返回值检出。）
  for (const domain of domains) {
    if (declaredBy.has(domain.id)) problems.push(`域 id 重名：${domain.id}`);
    declaredBy.set(domain.id, [...domain.eager, ...domain.lazy]);
  }

  // 1)+2)+3) 按声明顺序建域，名字闸 + 建厂期就绪校验 + 发布。
  for (const domain of domains) {
    const allowed = new Set([...domain.eager, ...domain.lazy, ...AMBIENT_PROPS]);
    let creating = true;
    const ctx = new Proxy(bag, {
      get(target, prop, receiver) {
        if (typeof prop !== "string" || AMBIENT_PROPS.has(prop)) return Reflect.get(target, prop, receiver);
        if (!allowed.has(prop)) {
          throw new Error(
            `域 ${domain.id} 读了没声明的名字 deps.${prop}：请在 server/domainTable.mjs 的该域声明里加上它` +
              (constantNames.has(prop) ? "（它是外部注入的常量）" : ""),
          );
        }
        const value = Reflect.get(target, prop, receiver);
        if (creating && value === undefined) throw notReady(domain.id, prop);
        return value;
      },
    });

    const provided = domain.create(state, ctx);
    creating = false;

    const keys = provided && typeof provided === "object" ? Object.keys(provided) : [];
    for (const key of keys) {
      const previous = ownerOf.get(key);
      if (previous) problems.push(`名字 ${key} 同时由域 ${previous} 与 ${domain.id} 返回`);
      ownerOf.set(key, domain.id);
      bag[key] = provided[key];
      exports[key] = provided[key];
    }
  }

  // 4) 完整性：声明的名字最终都要有值（建厂期没读到的名字，到这里才验得出「没人提供」）。
  //    注意这一步能一次报全，是因为它不依赖运行时值 —— 上一条（建厂期读到空值）必须当场抛。
  for (const [id, declared] of declaredBy) {
    for (const name of declared) {
      if (constantNames.has(name) || ownerOf.has(name)) continue;
      problems.push(`域 ${id} 声明要用的 ${name} 没有任何域提供，也不是外部注入的常量`);
    }
  }

  if (problems.length) {
    throw new Error(`域装配失败（${problems.length} 条）：\n- ${problems.join("\n- ")}`);
  }
  return exports;
}