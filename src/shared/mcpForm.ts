/**
 * MCP 服务器表单的纯逻辑：key/value 行 ↔ 对象，以及提交给
 * `POST /api/capabilities/mcp/save` 的载荷。
 *
 * 拆出来是为了能测：App.tsx 里的对话框只是这些函数的皮。载荷必须是
 * transport-aware 的——切到 http 之后不能再把旧的 stdio 字段带过去，
 * 否则服务器上会留下一份自相矛盾的 mcp.json。
 */

export type McpKeyValueRow = { key: string; value: string };

export type McpFormTransport = "stdio" | "http";

export type McpServerFormInput = {
  /** 编辑时的原 id（`<scope>:<name>`）；新增时为空。 */
  originalId?: string;
  name: string;
  scope: "user" | "project";
  transport: McpFormTransport;
  enabled: boolean;
  exposure: string;
  description: string;
  command: string;
  args: string;
  cwd: string;
  url: string;
  env: McpKeyValueRow[];
  headers: McpKeyValueRow[];
  /** 单工具 exposure 覆盖；`{}` 表示全部跟随服务器默认。 */
  toolExposure: Record<string, string>;
  /** 导入带进来的 pi 认识字段（`oauth` ...）；表单不展示，保存时原样写回。 */
  extras?: Record<string, unknown>;
};

export function recordToRows(record: Record<string, string> | undefined): McpKeyValueRow[] {
  return Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));
}

/** 空 key 的行直接丢掉；空 value 保留（有些变量就是要空串）。 */
export function rowsToRecord(rows: McpKeyValueRow[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) {
      record[key] = row.value;
    }
  }
  return record;
}

/**
 * 表单 → 请求体。只带当前 transport 用得到的字段，另一路的字段一个都不发：
 * 服务端的 `upsertMcpServer` 是整条替换，多发就等于把旧配置的残渣写回文件。
 */
export function buildMcpServerPayload(input: McpServerFormInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    originalId: input.originalId,
    name: input.name.trim(),
    scope: input.scope,
    transport: input.transport,
    enabled: input.enabled,
    description: input.description.trim(),
    toolExposure: pruneToolExposure(input.toolExposure),
  };
  if (input.extras && Object.keys(input.extras).length) {
    payload.extras = input.extras;
  }
  // `exposure` 为空时交给服务端用默认值，别硬写一个可能是错的。
  if (input.exposure) {
    payload.exposure = input.exposure;
  }

  if (input.transport === "http") {
    payload.url = input.url.trim();
    payload.headers = rowsToRecord(input.headers);
  } else {
    payload.command = input.command.trim();
    payload.args = input.args;
    payload.cwd = input.cwd.trim();
    payload.env = rowsToRecord(input.env);
  }

  return payload;
}

/** 单工具覆盖里只留非空值；用来判断「有没有配过覆盖」。 */
export function pruneToolExposure(overrides: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(overrides).filter(([tool, exposure]) => tool && exposure));
}