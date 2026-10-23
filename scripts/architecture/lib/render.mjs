import { PROTOCOL_SEAMS } from "../../../src/shared/protocol/seams.ts";

/**
 * Renders the generated regions of `docs/architecture/*.md` from `architecture/policy.json`
 * (plus the seam registry `src/shared/protocol/seams.ts` and a few live counts from the checker).
 *
 * The regions are compared byte-for-byte on every check, so the documentation cannot describe
 * a layer, a module, a protocol boundary or a piece of scheduled debt that the policy does not
 * contain - and the policy cannot declare something the docs never mention.
 */

function table(headers, rows) {
  const header = `| ${headers.join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

function codeList(values) {
  if (!values.length) return "—";
  return values.map((value) => `\`${value}\``).join(", ");
}

export function renderDocRegions(policy, stats) {
  const layers = table(
    ["层", "序号", "职责", "允许导入"],
    [...policy.layers]
      .sort((a, b) => a.order - b.order)
      .map((layer) => [
        `\`${layer.id}\``,
        String(layer.order),
        layer.summary,
        layer.mayImport.includes("*") ? "全部（装配层）" : codeList(layer.mayImport),
      ]),
  );

  const modules = table(
    ["模块", "层", "目录", "负责人", "进 bridge sidecar"],
    [...policy.modules]
      .sort((a, b) => (a.layer === b.layer ? a.id.localeCompare(b.id) : a.layer.localeCompare(b.layer)))
      .map((module) => [
        `\`${module.id}\``,
        `\`${module.layer}\``,
        codeList(module.roots),
        module.owner,
        module.bridgeSafe ? "是" : "否",
      ]),
  );

  const protocols = table(
    ["边界", "契约文件", "版本源", "另一端镜像", "一致性测试", "换实现的方式", "可替换性证据"],
    policy.protocols.map((protocol) => [
      `**${protocol.title}** (\`${protocol.id}\`)`,
      `\`${protocol.contract}\``,
      protocol.versionSource ? `\`${protocol.versionSource}\`` : "—（形状即契约）",
      protocol.mirror ? `\`${protocol.mirror}\`` : "—",
      `\`${protocol.conformance}\``,
      protocol.swap,
      protocol.seam
        ? `\`${protocol.seam}\`（见下表，规则 \`protocol-seam\` 强制）`
        : `**未证明**：${protocol.seamGap ?? "没有登记缺口原因"}`,
    ]),
  );

  // The seams table is rendered from the registry the checker also validates, so the document
  // cannot claim a boundary is swappable after the test that proved it was deleted.
  const seams = table(
    ["边界", "跨越什么", "契约", "真实现", "装配点", "换实现", "证据（测试）"],
    PROTOCOL_SEAMS.map((seam) => [
      `\`${seam.id}\``,
      seam.crosses,
      `\`${seam.contract}\``,
      `\`${seam.production}\``,
      `\`${seam.assemblyPoint}\``,
      `\`${seam.install}()\``,
      `\`${seam.swapTest}\``,
    ]),
  );

  const bridges = policy.exceptions.filter((entry) => entry.rule === "max-lines");
  const others = policy.exceptions.filter((entry) => entry.rule !== "max-lines");
  const debtRows = [
    ...bridges.map((entry) => [
      "`max-lines`",
      `\`${entry.file}\``,
      `${entry.ceiling} 行（只降不升）`,
      entry.deadline,
      entry.reason,
    ]),
    ...others.map((entry) => [
      `\`${entry.rule}\``,
      `\`${entry.file ?? entry.key}\``,
      "—",
      entry.deadline,
      entry.reason,
    ]),
  ];
  const debt = debtRows.length
    ? table(["规则", "对象", "上限", "最迟处理", "为什么现在不减"], debtRows)
    : "无。当前没有登记在案的架构债务。";

  const surface = [
    `- 边界协议版本：**v${stats.protocolVersion.declared}**（渲染进程与 bridge 两侧各有一个字面量，检查器要求相等）`,
    `- 冻结的协议表面：**${stats.frozenRouteCount}** 条路由（\`architecture/generated/bridge-surface.json\`）`,
    `- bridge 实际应答：**${stats.bridgeRoutes}** 条；渲染进程命名：**${stats.clientPathCount}** 条`,
    `- 扫描范围：${policy.scanRoots.map((root) => `\`${root}\``).join(", ")}`,
  ].join("\n");

  return {
    "docs/architecture/architecture.md": { layers, modules, debt, surface },
    "docs/architecture/protocols.md": { protocols, seams },
  };
}