/**
 * E2E 用的**假模型端点**（OpenAI 兼容的 `/v1/chat/completions` + `/v1/models`）。
 *
 * 为什么是假模型而不是假内核：桥的会话生命周期（建 runtime、pi 的 session、事件流、SSE、
 * ETag、渲染进程的 reducer 与 DOM）**全都要真跑**才有意义；只要模型端点是我们自己的，
 * 一整轮对话就是确定性的。反过来在 `server/piKernel.mjs` 里塞假内核，等于把桥最核心的那段
 * 逻辑（它自己的 plumbing）换掉，测到的反而更少，还得为"生产不许打开"再配一道闸。
 *
 * 因此这里只做两件事：说清楚 OpenAI 的线协议（流式与非流式各一条），以及把收到的请求记下来，
 * 让用例可以断言"桥到底把什么发给了模型"。文本是脚本化的固定串（`E2E-1`/`E2E-2`…），
 * 分块之间的延迟用来观察"首字先到、后面才补齐"。
 */

/** Provider/model 标识：`models.json`、`/api/models` 与用例断言共用这三个常量。 */
export const E2E_PROVIDER_ID = "e2e";
export const E2E_MODEL_ID = "e2e-model";
export const E2E_MODEL_NAME = "E2E Model";

const DEFAULT_CHUNKS = ["E2E-1 ", "E2E-2 ", "E2E-3 done"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(req) {
  const parts = [];
  for await (const part of req) {
    parts.push(part);
  }
  return Buffer.concat(parts).toString("utf8");
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 起一个假模型端点。
 *
 * @param {object} [options]
 * @param {string[]} [options.chunks] 流式分块（顺序即到达顺序）。
 * @param {number} [options.chunkDelayMs] 分块之间的间隔，默认 120ms：够慢到能看见中间态，又不拖慢用例。
 * @param {number} [options.firstTokenDelayMs] 首块之前的等待，默认 80ms（模拟真实的思考停顿）。
 * @returns {Promise<{baseUrl: string, port: number, requests: Array<{path: string, body: any}>, stop: () => Promise<void>, reset: () => void}>}
 */
export async function startFakeModel(options = {}) {
  const chunks = options.chunks ?? DEFAULT_CHUNKS;
  const chunkDelayMs = options.chunkDelayMs ?? 120;
  const firstTokenDelayMs = options.firstTokenDelayMs ?? 80;
  /** @type {Array<{path: string, body: any}>} */
  const requests = [];

  const server = (await import("node:http")).createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const raw = await readBody(req);

    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      sendJson(res, 200, {
        object: "list",
        data: [{ id: E2E_MODEL_ID, object: "model", owned_by: E2E_PROVIDER_ID }],
      });
      return;
    }

    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      sendJson(res, 404, { error: { message: `unexpected ${req.method} ${url.pathname}` } });
      return;
    }

    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      body = { unparsable: raw };
    }
    requests.push({ path: url.pathname, body });

    const content = chunks.join("");
    const id = `chatcmpl-e2e-${requests.length}`;
    const model = body.model ?? E2E_MODEL_ID;
    const created = Math.floor(Date.now() / 1000);

    // 非流式：标题生成、一次性路径走这条。整段一次给完。
    if (body.stream !== true) {
      sendJson(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const frame = (value) => {
      res.write(`data: ${JSON.stringify(value)}\n\n`);
    };
    const delta = (payload, finishReason = /** @type {string|null} */ (null)) =>
      frame({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: payload, finish_reason: finishReason }],
      });

    await sleep(firstTokenDelayMs);
    delta({ role: "assistant", content: "" });
    for (const chunk of chunks) {
      delta({ content: chunk });
      await sleep(chunkDelayMs);
    }
    delta({}, "stop");
    // 有些客户端（含 pi 的 usage 统计）会要 `stream_options.include_usage`，按要求补一段 usage。
    if (body.stream_options?.include_usage) {
      frame({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    port,
    reset: () => {
      requests.length = 0;
    },
    stop: () =>
      /** @type {Promise<void>} */ (new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })),
  };
}