import { createDomainContainer } from "./domainContainer.mjs";
import { DOMAINS } from "./domainTable.mjs";

/**
 * 组合区：把各域工厂建起来。
 *
 * 这里原来有 450 行：15 个工厂按**手写顺序**建，每个工厂建厂期要读的名字靠一串
 * `Object.assign(deps, { … })` 夹块逐个喂饱 —— 喂养关系只存在于书写顺序里，漏一个就静默
 * 拿到 `undefined`（`@type {any}` 把这类错全盖住了），跨域要用的名字还得手工解构转发。
 *
 * 现在装配只有一句话：`createDomainContainer` 读 `server/domainTable.mjs`（域依赖的**生成物**，
 * 由 `npm run architecture:write` 从各域模块的真实读取生成、`architecture:check` 逐字节校验），
 * 按声明顺序建域，并做四件事（详见 `server/domainContainer.mjs`）：名字闸、建厂期就绪校验、
 * 发布（重名即抛）、合并导出。
 *
 * `scope` 是入口启动块里的值（`appCwd`、`openRuntimes` 这类外部注入的常量）：它们不是任何域的
 * 返回值，容器把它们作为**初始袋**，所以任何域在任何时候读到它们都有值。
 *
 * 入口自己用得到的名字（`activeProject`、`createRuntime`、`updateSessionStoreFromRuntime`）从
 * 返回值里解构；路由处理器不进这里 —— `server/routeTable.mjs` 按名字从 `domains` 取。
 */
export function createBridgeDomains(state, scope) {
  return createDomainContainer({ domains: DOMAINS, constants: scope, state });
}