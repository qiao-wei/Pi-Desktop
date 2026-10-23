import {
  mcpConfigPath,
  mcpToolExposure,
  mergeMcpServerEntries,
  readMcpConfigPath,
} from "./mcpConfig.mjs";
import { agentDir } from "./sessionStoreFactory.mjs";
import { mcpMetaKey } from "./smallHelpers.mjs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/**
 * MCP 探针（检查/连接/断开）
 *
 * 从 `server/index.mjs` 抽出的域：这些定义原来住在请求内核里，靠共享的可变状态与互相调用咬在一起。
 * 现在改成**注入**——共享状态走 `state`，外部函数/常量走 `deps`（按名字解构，函数体不改），
 * 由 index.mjs 在末尾组合区调用本工厂并解构成同名局部变量，所以调用点零改动。
 */
export function createMcpInspector(state, deps) {
  // `mcpToolProbeTimeoutMs` 在本厂之前就填好了（domains.mjs 第 32 行），可以立即解构；
  // 其余四个是**别的域**提供的（findMcpServer 来自 mcpServers、findProject 来自 bridgeUtils、
  // getRuntimeForRequest 来自 runtimeDomain、readCapabilitiesConfig 来自 capabilitySnapshot），
  // 而本厂在它们之前就建好了 —— 立即解构会拿到 undefined，所以必须按调用时取值。
  const { mcpToolProbeTimeoutMs } = deps;
  const findMcpServer = /** @type {any} */ ((...args) => deps.findMcpServer(...args));
  const findProject = /** @type {any} */ ((...args) => deps.findProject(...args));
  const getRuntimeForRequest = /** @type {any} */ ((...args) => deps.getRuntimeForRequest(...args));
  const readCapabilitiesConfig = /** @type {any} */ (
    (...args) => deps.readCapabilitiesConfig(...args)
  );

  /**
   * MCP 探测超时（毫秒）：只用于能力页显式的「测试连接」，不参与会话自身的连接流程。
   */
  /* moved to server/smallHelpers.mjs */

  /* moved to server/capabilityMetadata.mjs */

  /**
   * 全局 + 项目两份 `mcp.json` 的运行视图。同名时项目覆盖全局（pi 的语义），
   * `pinned` / 描述这些 pi 不认识的字段来自 capabilities.json 的 `mcp` 段。
   */
  function readMcpRuntimeState(targetRuntime) {
    const project = findProject(targetRuntime.projectId);
    const globalPath = mcpConfigPath({ agentDir, projectCwd: project.cwd, scope: "user" });
    const projectPath = mcpConfigPath({ agentDir, projectCwd: project.cwd, scope: "project" });
    const globalConfig = readMcpConfigPath(globalPath);
    // 项目 `.pi/mcp.json` 和 `.pi/extensions` 同一条规矩：项目没被信任就根本不会加载，
    // 这里也不读，免得 UI 显示一堆内核看不见的服务器。
    const projectTrusted = targetRuntime.settingsManager?.isProjectTrusted?.() !== false;
    const projectConfig = projectTrusted
      ? readMcpConfigPath(projectPath)
      : { config: { mcpServers: {} }, servers: [], errors: [] };
    const config = readCapabilitiesConfig();
    const metaMap = (scope, servers) =>
      Object.fromEntries(
        servers.map((server) => [server.name, config.mcp?.[mcpMetaKey(scope, server.name)] ?? {}]),
      );
    return {
      project,
      globalPath,
      projectPath,
      globalConfig,
      projectConfig,
      servers: mergeMcpServerEntries(
        globalConfig.servers,
        projectConfig.servers,
        metaMap("user", globalConfig.servers),
        metaMap("project", projectConfig.servers),
      ),
      errors: [...globalConfig.errors, ...projectConfig.errors],
    };
  }

  async function connectMcpInspector(targetRuntime, server) {
    if (server.transport === "stdio") {
      const environment = Object.fromEntries(
        Object.entries({ ...process.env, ...server.env })
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      );
      return connectMcpInspectorWithTransport(
        server,
        new StdioClientTransport({
          command: server.command,
          args: server.args,
          env: environment,
          cwd: resolveMcpInspectorCwd(findProject(targetRuntime.projectId), server),
          stderr: "pipe",
        }),
      );
    }
    const requestInit = Object.keys(server.headers).length
      ? { headers: server.headers }
      : undefined;
    return connectMcpInspectorWithTransport(
      server,
      new StreamableHTTPClientTransport(new URL(server.url), { requestInit }),
    );
  }

  async function connectMcpInspectorWithTransport(server, transport) {
    const client = new Client({ name: "pi-desktop-mcp-inspector", version: "0.1.0" });
    try {
      await withMcpProbeTimeout(
        client.connect(transport, { timeout: mcpToolProbeTimeoutMs }),
        `${server.name} connect`,
      );
      return { client, transport };
    } catch (error) {
      await closeMcpInspector(client, transport);
      throw error;
    }
  }

  /** 相对 cwd 按项目目录解析，`~/` 展开 home——和 pi 读配置时的规则一致。 */
  function resolveMcpInspectorCwd(project, server) {
    const raw = String(server.cwd ?? "").trim();
    if (!raw) {
      return project.cwd;
    }
    if (raw === "~") {
      return homedir();
    }
    if (raw.startsWith("~/")) {
      return resolve(homedir(), raw.slice(2));
    }
    return isAbsolute(raw) ? raw : resolve(project.cwd, raw);
  }

  async function closeMcpInspector(client, transport) {
    await Promise.allSettled([client?.close?.(), transport?.close?.()]);
  }

  async function withMcpProbeTimeout(promise, label) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${mcpToolProbeTimeoutMs}ms`)),
            mcpToolProbeTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 显式探测：连一次、列出工具、把连接错误原文带回来。 */
  async function inspectMcpServer(targetRuntime, id) {
    const found = findMcpServer(targetRuntime, id);
    if (!found) {
      throw new Error("MCP server not found.");
    }
    const { server } = found;
    let client;
    let transport;
    try {
      ({ client, transport } = await connectMcpInspector(targetRuntime, server));
      const result = await withMcpProbeTimeout(client.listTools(), `${server.name} listTools`);
      const tools = (Array.isArray(result?.tools) ? result.tools : [])
        .filter((tool) => tool?.name)
        .map((tool) => ({
          name: String(tool.name),
          title: String(tool.title ?? tool.name),
          description: String(tool.description ?? ""),
          exposure: mcpToolExposure(server, String(tool.name)),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
      return { id, name: server.name, status: "ready", tools, error: "" };
    } catch (error) {
      return {
        id,
        name: server.name,
        status: "error",
        tools: [],
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await closeMcpInspector(client, transport);
    }
  }

  async function inspectMcpServerCapability(body) {
    const targetRuntime = getRuntimeForRequest(body);
    return { inspection: await inspectMcpServer(targetRuntime, String(body?.id ?? "")) };
  }

  return {
    closeMcpInspector,
    connectMcpInspector,
    connectMcpInspectorWithTransport,
    inspectMcpServer,
    inspectMcpServerCapability,
    readMcpRuntimeState,
    resolveMcpInspectorCwd,
    withMcpProbeTimeout,
  };
}
