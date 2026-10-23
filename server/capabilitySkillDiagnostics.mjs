/**
 * pi 加载器的技能诊断 → 渲染进程能吃的形状。
 *
 * 我们**不生成**这些诊断，只是搬运 pi 的 `ResourceDiagnostic`
 * （`dist/core/diagnostics.d.ts`：`{type, message, path?, collision?}`）。以前 `getSkills()`
 * 只取 `.skills`，诊断全丢，于是重名技能（pi 保留先发现的那份、丢掉后来的）在能力页里表现成
 * 「某个技能莫名不见了」。
 *
 * 搬运是必须的（渲染进程不接受任意对象），但字段名一旦被上游改掉就会静默变成 null ——
 * `tests/skillDiscoveryParity.test.ts` 用 pi 真 loader 造一次重名冲突来对照，改名字那里会红。
 */

/** @param {Array<{type?: string, message?: string, path?: string, collision?: {name?: string, winnerPath?: string, loserPath?: string}}>} diagnostics */
export function normalizeSkillDiagnostics(diagnostics) {
  return (diagnostics ?? [])
    .map((diagnostic) => ({
      type: diagnostic?.type ?? "warning",
      message: String(diagnostic?.message ?? "").trim(),
      path: diagnostic?.path ? String(diagnostic.path) : "",
      collision: diagnostic?.collision
        ? {
            name: String(diagnostic.collision.name ?? ""),
            winnerPath: String(diagnostic.collision.winnerPath ?? ""),
            loserPath: String(diagnostic.collision.loserPath ?? ""),
          }
        : null,
    }))
    .filter((diagnostic) => diagnostic.message.length > 0);
}