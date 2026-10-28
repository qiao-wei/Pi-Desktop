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

/** 把一段文本切成固定长度的块（工具参数要像真 provider 那样逐块下发）。 */
function chunkText(text, size) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

/**
 * 写一个大文件：参数本身分块到达时，行里的 `+N` 应该在**工具跑起来之前**就一路涨起来
 * （ZCode 的形态）。这里的正文够长，好让用例真的观察到中间的某个值。
 */
const WRITE_FILE_LINES = Array.from(
  { length: 24 },
  (_, index) => `第 ${index + 1} 条：这是 demo.md 里的一行说明文字。`,
);

/**
 * 一个**大到必须被预算裁掉**的 write：正文约 300 KB，远超线上单字段上限（32 KiB）。
 *
 * 参数分块要放大（默认 32 字符/块会让 300 KB 变成近万次 tick），但仍然是分块到达的——
 * 用例要验证的正是「流式参数超过上限后停发、收尾帧带裁剪后的对象」这条路径。
 */
const BIG_WRITE_LINES = Array.from(
  { length: 8000 },
  (_, index) => `第 ${index + 1} 行：这一行存在的目的是把参数撑到预算之外（big write）。`,
);

/**
 * 脚本化工具调用：用户消息里出现 marker 时，这一轮先回一个工具调用，拿到工具结果后再回文本。
 *
 * 为什么需要它：过程行（思考行 / 工具行）只在**工具真的跑过一轮**之后才存在，而工具是 pi
 * 真执行的（这里是 edit / bash，参数是相对工作区路径）。断言"行画成什么样"必须建立在
 * 真实的工具结果上 —— 手写一份假的 transcript 就等于把投影层和渲染层一起绕过。
 */
const TOOL_REQUESTS = {
  "E2E-TOOL-EDIT": {
    name: "edit",
    arguments: JSON.stringify({
      path: "demo.ts",
      edits: [{ oldText: "alpha", newText: "beta" }],
    }),
  },
  /**
   * 嵌套目录里的文件：行要把「文件名 + 相对路径」分开显示，并且两个目标分工不同
   * （点名字开右面板、点路径展开内联）。
   */
  "E2E-TOOL-EDIT-NESTED": {
    name: "edit",
    arguments: JSON.stringify({
      path: "src/notes/demo.ts",
      edits: [{ oldText: "alpha", newText: "beta" }],
    }),
  },
  "E2E-TOOL-WRITE": {
    name: "write",
    arguments: JSON.stringify({
      path: "notes.md",
      content: `${WRITE_FILE_LINES.join("\n")}\n`,
    }),
  },
  "E2E-TOOL-WRITE-BIG": {
    name: "write",
    chunkSize: 8192,
    arguments: JSON.stringify({
      path: "big.md",
      content: `${BIG_WRITE_LINES.join("\n")}\n`,
    }),
  },
  "E2E-TOOL-BASH": {
    name: "bash",
    arguments: JSON.stringify({ command: "printf 'e2e-stdout-line\\n'" }),
  },
};

/**
 * 脚本化思考流：用户消息里出现 `E2E-THINK` 时，先在回答前发两段 `reasoning_content`
 * （pi 会把它变成 `thinking_delta` → 聚合出一个 thinking 块），再发普通文本。
 * 思考行必须在**真实的思考事件**上验证：手拼一段假 transcript 会把投影层绕过去。
 */
const THINKING_CHUNKS = ["先看这一段的前半句，", "然后这是思考的尾巴（最后一行）。"];

/**
 * 长思考流：展开态的吸底跟随只有在**正文超过限高（`max-h-60`）且还在继续追加**时才看得见。
 * 一行一句、共 40 行，chunk 之间给一点延迟，好让用例有机会在流式途中点开它。
 */
const LONG_THINKING_CHUNKS = Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 行：这是一段较长思考的正文。\n`);

/** 本轮该先发思考流吗？ */
function reasoningChunks(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  const text =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : JSON.stringify(lastUser?.content ?? "");
  // 长的先判：`E2E-THINK-LONG` 里也含 `E2E-THINK`。
  if (text.includes("E2E-THINK-LONG")) {
    return LONG_THINKING_CHUNKS;
  }
  return text.includes("E2E-THINK") ? THINKING_CHUNKS : null;
}

/**
 * 本轮该回工具调用吗？
 *
 * 判据是「**最后一条用户消息之后**还没有工具结果」——不能只看整段会话里有没有出现过
 * 工具结果：多个用例共用桥的会话，上一条用例的工具结果会一直留在历史里，只看全局就会
 * 让后续的 marker 永远静默失效（本文件第一版就这么错过）。
 */
function pendingToolCall(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastUserIndex = messages.findLastIndex((message) => message?.role === "user");
  if (lastUserIndex < 0) {
    return null;
  }
  if (messages.slice(lastUserIndex + 1).some((message) => message?.role === "tool")) {
    return null;
  }
  const lastUser = messages[lastUserIndex];
  const text =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : JSON.stringify(lastUser?.content ?? "");
  // 最长匹配优先：`E2E-TOOL-EDIT` 是 `E2E-TOOL-EDIT-NESTED` 的前缀，按声明顺序取第一个
  // 会把嵌套目录的用例静默变成「编辑根目录那个文件」。
  const marker = Object.keys(TOOL_REQUESTS)
    .filter((candidate) => text.includes(candidate))
    .sort((a, b) => b.length - a.length)[0];
  return marker ? TOOL_REQUESTS[marker] : null;
}

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

    const toolCall = pendingToolCall(body);
    if (toolCall) {
      await sleep(firstTokenDelayMs);
      // 动手之前先想一下：同一个 marker 也能带 `E2E-THINK`，于是这一轮的事件序是
      // 「思考 → 工具调用 → 文本」，正好用来验证**相邻两行**的间距（不是只有 行→正文）。
      for (const chunk of reasoningChunks(body) ?? []) {
        delta({ reasoning_content: chunk });
        await sleep(chunkDelayMs);
      }
      delta({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            index: 0,
            id: `call_e2e_${requests.length}`,
            type: "function",
            function: { name: toolCall.name, arguments: "" },
          },
        ],
      });
      await sleep(chunkDelayMs);
      // 参数**分块**发：真实 provider 就是这样逐 token 吐 `arguments` 的，而「行里的 +N 会不会
      // 跟着涨」只有在参数真的分段到达时才验得出来（一次性发完就等于跳过整段流式形态）。
      for (const chunk of chunkText(toolCall.arguments, toolCall.chunkSize ?? 32)) {
        delta({ tool_calls: [{ index: 0, function: { arguments: chunk } }] });
        await sleep(chunkDelayMs);
      }
      delta({}, "tool_calls");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    await sleep(firstTokenDelayMs);
    delta({ role: "assistant", content: "" });
    for (const chunk of reasoningChunks(body) ?? []) {
      delta({ reasoning_content: chunk });
      await sleep(chunkDelayMs);
    }
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