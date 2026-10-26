/**
 * E2E 的桥夹具：**隔离的 agent 目录** + 假模型端点 + 真的 `server/index.mjs` 进程。
 *
 * 隔离靠 `PI_CODING_AGENT_DIR`（桥自己认的变量，见 server/sessionStoreFactory.mjs），
 * 不动 `HOME`：python/node runtime 的解析、缓存目录都不受影响，于是"每个用例一套全新状态"
 * 不需要去猜哪些路径是从 HOME 推出来的。
 *
 * 端口用 `PI_DESKTOP_PORT=0`：由桥自己选并把它打印出来（`PI_DESKTOP_BRIDGE_URL=` 前缀），
 * 所以并行跑用例不会互相抢端口，也不需要"先探测再绑定"那种竞态。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { E2E_MODEL_ID, E2E_MODEL_NAME, E2E_PROVIDER_ID, startFakeModel } from "./fakeModel.mjs";

export const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BRIDGE_URL_PREFIX = "PI_DESKTOP_BRIDGE_URL=";

/** 造一份 `models.json`：自定义 provider + 内联 apiKey（等于"已经配好了 key"）。 */
export function writeModelsConfig(agentDir, modelBaseUrl) {
  const config = {
    providers: {
      [E2E_PROVIDER_ID]: {
        name: "E2E",
        baseUrl: modelBaseUrl,
        api: "openai-completions",
        authHeader: true,
        apiKey: "e2e-key",
        models: [
          {
            id: E2E_MODEL_ID,
            name: E2E_MODEL_NAME,
            contextWindow: 128000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(config, null, 2), "utf8");
}

function waitForUrl(child, urlPromise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`桥在 30s 内没有公告地址。\n${urlPromise.stderr}`)), 30_000);
    const onData = (chunk) => {
      urlPromise.stdout += String(chunk);
      const line = String(chunk)
        .split("\n")
        .find((item) => item.startsWith(BRIDGE_URL_PREFIX));
      if (!line) {
        return;
      }
      clearTimeout(timer);
      resolve(line.slice(BRIDGE_URL_PREFIX.length).trim());
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`桥在公告地址前退出（code ${code}）。\n${urlPromise.stdout}\n${urlPromise.stderr}`));
    });
  });
}

/**
 * 起一套 e2e 环境。
 *
 * @param {object} [options]
 * @param {object} [options.model] 传给 `startFakeModel` 的选项。
 * @param {Record<string, string>} [options.env] 额外的桥环境变量（比如协议版本覆盖）。
 * @param {boolean} [options.fakeModel] 传 false 表示不起假模型，只借这份 `models.json` 配置。
 */
export async function startE2E(options = {}) {
  const model = options.fakeModel === false ? null : await startFakeModel(options.model ?? {});
  const runDir = mkdtempSync(join(tmpdir(), "pi-desktop-e2e-"));
  const agentDir = join(runDir, "agent");
  const workspaceDir = join(runDir, "workspace");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  writeModelsConfig(agentDir, model?.baseUrl ?? "http://127.0.0.1:1/v1");

  const seen = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, [join(ROOT_DIR, "server", "index.mjs")], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_DESKTOP_HOST: "127.0.0.1",
      PI_DESKTOP_PORT: "0",
      PI_DESKTOP_DIAGNOSTICS_ENABLED: "0",
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    seen.stderr += String(chunk);
  });
  child.stdout.on("data", (chunk) => {
    seen.stdout += String(chunk);
  });

  const apiBase = await waitForUrl(child, seen);
  const api = createApi(apiBase);

  return {
    apiBase,
    api,
    agentDir,
    workspaceDir,
    model,
    /** 桥的 stdout/stderr 快照：用例断言失败时贴出来，比"超时了"有用得多。 */
    logs: () => ({ stdout: seen.stdout, stderr: seen.stderr }),
    async stop() {
      child.kill("SIGTERM");
      await /** @type {Promise<void>} */ (new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      }));
      await model?.stop();
    },
  };
}

/** 桥的 HTTP 面。用例只碰这几条路径，于是"桥怎么走路由"这件事只写在这里一份。 */
export function createApi(apiBase) {
  const json = async (path, init) => {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${path} -> ${response.status}: ${text.slice(0, 400)}`);
    }
    return text ? JSON.parse(text) : null;
  };

  return {
    apiBase,
    json,
    get: (path) => json(path),
    post: (path, body) => json(path, { method: "POST", body: JSON.stringify(body ?? {}) }),

    /** 建一个项目并把会话切过去；返回项目 id（id 藏在快照里，所以从 bootstrap 里找回来）。 */
    async openProject(cwd, name = "E2E Project") {
      await json("/api/projects", { method: "POST", body: JSON.stringify({ cwd, name }) });
      const bootstrap = await json("/api/bootstrap");
      const snapshot = bootstrap?.snapshot ?? bootstrap ?? {};
      const projectId =
        snapshot.project?.id ??
        snapshot.projects?.find((project) => project.cwd === cwd)?.id ??
        snapshot.conversation?.projectId;
      if (!projectId) {
        throw new Error(`建项目之后 bootstrap 里找不到项目 id：${JSON.stringify(bootstrap).slice(0, 400)}`);
      }
      await json("/api/projects/select", { method: "POST", body: JSON.stringify({ projectId }) });
      return projectId;
    },

    /** 把这一轮的模型固定到假模型上（免得依赖对方机器上"上次选过什么"）。 */
    selectE2EModel: (extra = {}) =>
      json("/api/model", {
        method: "POST",
        body: JSON.stringify({ provider: E2E_PROVIDER_ID, model: E2E_MODEL_ID, ...extra }),
      }),

    /** 发一轮消息，收集 NDJSON 事件；返回收到的全部事件。 */
    async prompt(input, extra = {}) {
      const response = await fetch(`${apiBase}/api/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input, ...extra }),
      });
      if (!response.ok) {
        throw new Error(`/api/prompt -> ${response.status}: ${(await response.text()).slice(0, 400)}`);
      }
      const events = [];
      const text = await response.text();
      for (const line of text.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        try {
          events.push(JSON.parse(line));
        } catch {
          events.push({ type: "unparsed", raw: line });
        }
      }
      return events;
    },
  };
}