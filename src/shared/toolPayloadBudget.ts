/**
 * 线上载荷的字节预算。
 *
 * 一个 `write` 的参数就是整份文件正文，一个 MCP 工具的结果可能比整个会话还大。
 * 这些值以前原样进帧、原样进快照：帧写入器的 4 MiB 上限一开火，整轮就被判死；
 * 快照则每次全量重发一遍。这里的做法是**在具名边界上裁**，并且把「裁掉了多少」
 * 一起带走，这样界面能如实说「内容过大，已省略」，而不是悄悄少一段。
 *
 * 切法（head + 标记 + tail）而不是「只留开头」，理由和 ZCode 的
 * `toolOutputFinalHeadBytes / TailBytes` 一样：读日志、读构建错误、读 diff 时，
 * 结尾往往才是读者要的那一部分。
 *
 * 注意这是一层**显示预算**，不是数据策略：真正的全文仍然在磁盘上（`write` 写的
 * 文件、bash 的 `fullOutputPath`），界面要「展开全文」应当去读文件，而不是要求
 * 线上把 MB 级正文再发一遍。
 */

/** 单个参数字符串上线的上限（裁到 head + tail）。 */
export const TOOL_ARG_STRING_MAX_BYTES = 32 * 1024;
/** 工具结果正文上线的上限（裁到 head + tail）。 */
export const TOOL_RESULT_HEAD_BYTES = 32 * 1024;
export const TOOL_RESULT_TAIL_BYTES = 32 * 1024;
/**
 * 参数流（`tool_call_stream_delta`）转发上限。
 *
 * 这些 delta 是模型正在生成的 JSON 文本，客户端把它们拼成 `callText` 打字机。
 * 一份 4 MB 的正文会因此产生 4 MB 的客户端状态、每次 `+N −M` 预览都要重新解析
 * 前缀；超过这个量之后动画已经没有意义，直接停发，让 `tool_call_stream_end`
 * （带裁剪后的 args）收尾。
 */
export const TOOL_ARGS_STREAM_MAX_BYTES = 64 * 1024;
/** 参数对象里记录省略信息的保留键。 */
export const OMITTED_ARGS_KEY = "__omitted";
/**
 * 一条流帧的硬上限。
 *
 * 帧写入器的 4 MiB 待发上限是**传输**的刹车，不是**载荷**的；一帧本身要是就有 4 MiB，
 * 那第一帧就会把待发预算一次性吃满，下一帧必然越限（`droppedFrames: 0` 的那种）。
 * 所以载荷在这一层也要有预算，且必须落在**进日志之前**：日志里存的是订阅者会收到的
 * 那一份，重放时给出同样的东西，续订才不会拼出一条比原流更肥的流。
 */
export const MAX_STREAM_FRAME_BYTES = 1024 * 1024;
/** 第二档（以及最后降级时）用的字符串上限：只为让帧还能被解析，不再追求可读。 */
const SALVAGE_STRING_BYTES = 4 * 1024;
/** 递归裁剪的最大深度，避免病态结构把这一层变成 O(n) 的深拷贝器。 */
const MAX_DEPTH = 8;

/** 一段文本被裁掉了多少。 */
export interface PayloadCut {
  bytes: number;
  lines: number;
}

/** 一个被裁掉的字段（`path` 是相对参数根的路径，如 `content`、`edits[0].newText`）。 */
export interface OmittedField extends PayloadCut {
  path: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 字节数（浏览器与 Node 都有 `TextEncoder`，不用 `Buffer`）。 */
export function textByteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * 行数，读法与 `toolDisplay.textLines` 一致：末尾那个换行不算多一行。
 *
 * 必须一致，因为界面上的 `+N` 来自 `textLines`：裁剪后如果数出 8001 而行里本来
 * 该显示 8000，用户看到的就是一个凭空多出来的数——宁可这条数不存在，也不要它说谎。
 */
export function countTextLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const body = text.charCodeAt(text.length - 1) === 10 ? text.slice(0, -1) : text;
  if (body.length === 0) {
    return 1;
  }
  let lines = 1;
  for (let index = 0; index < body.length; index += 1) {
    if (body.charCodeAt(index) === 10) {
      lines += 1;
    }
  }
  return lines;
}

/**
 * 按 UTF-8 字节数裁成 `head + "\n…\n" + tail`。
 *
 * 多字节字符被切开时 `TextDecoder` 会留下 U+FFFD，两端各剥掉即可——宁可少半个
 * 字符，也不要让预览里出现一串「无法解码」的方块。
 */
export function cutTextHeadTail(
  text: string,
  headBytes: number,
  tailBytes: number,
): { text: string; cut: PayloadCut | null } {
  const bytes = encoder.encode(text);
  if (bytes.length <= headBytes + tailBytes) {
    return { text, cut: null };
  }
  const head = decoder.decode(bytes.subarray(0, headBytes)).replace(/\uFFFD+$/u, "");
  const tail = decoder.decode(bytes.subarray(bytes.length - tailBytes)).replace(/^\uFFFD+/u, "");
  return {
    text: `${head}\n…\n${tail}`,
    cut: { bytes: bytes.length, lines: countTextLines(text) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface TrimResult {
  value: unknown;
  /** 是否有任何字段真的被裁过（没有时调用方可以原样返回，保住对象身份）。 */
  changed: boolean;
}

/**
 * 递归裁掉超长的字符串。
 *
 * 只复制被裁过的那条路径上的容器：整份 args 与转录在快照之间是共享的，就地改会
 * 把内存里唯一的全文也裁掉，之后的「展开全文」就再也拿不到真东西。
 * 保留键 `__omitted` 本身不参与递归，否则第二次预算会把书签也当成内容再裁一遍。
 */
function trimValue(
  value: unknown,
  path: string,
  cuts: OmittedField[],
  depth: number,
  maxStringBytes: number,
): TrimResult {
  if (typeof value === "string") {
    const { text, cut } = cutTextHeadTail(value, maxStringBytes, maxStringBytes);
    if (!cut) {
      return { value, changed: false };
    }
    cuts.push({ path, ...cut });
    return { value: text, changed: true };
  }

  if (depth >= MAX_DEPTH) {
    return { value, changed: false };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item, index) => {
      const result = trimValue(item, `${path}[${index}]`, cuts, depth + 1, maxStringBytes);
      changed = changed || result.changed;
      return result.value;
    });
    return changed ? { value: next, changed } : { value, changed: false };
  }

  if (isRecord(value)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (path === "" && key === OMITTED_ARGS_KEY) {
        // 已预算过的参数对象：原样返回，避免标记行被反复裁/反复追加。
        return { value, changed: false };
      }
      next[key] = item;
      const childPath = path === "" ? key : `${path}.${key}`;
      const result = trimValue(item, childPath, cuts, depth + 1, maxStringBytes);
      if (result.changed) {
        next[key] = result.value;
        changed = true;
      }
    }
    return changed ? { value: next, changed } : { value, changed: false };
  }

  return { value, changed: false };
}

/** 任意载荷的字符串预算（帧写入器的兜底用）。 */
export function budgetPayloadStrings(
  value: unknown,
  maxStringBytes: number = TOOL_ARG_STRING_MAX_BYTES,
): { value: unknown; cuts: OmittedField[] } {
  const cuts: OmittedField[] = [];
  const result = trimValue(value, "", cuts, 0, maxStringBytes);
  return result.changed ? { value: result.value, cuts } : { value, cuts: [] };
}

/**
 * 工具参数上线前的裁剪：超长字符串裁成 head + tail，并把每一处裁掉的字节数/行数
 * 记在 `__omitted` 里。
 *
 * 形状保持成一个合法 JSON 对象是刻意的：`write` 的路径、`bash` 的命令、`read` 的
 * 行区间都很短，裁完之后它们仍然可读，编辑器也能跳转；被裁掉的只有正文本身。
 */
export function budgetToolArgs(args: unknown): unknown {
  if (!isRecord(args) || Array.isArray(args[OMITTED_ARGS_KEY])) {
    return args;
  }
  const { value, cuts } = budgetPayloadStrings(args);
  if (cuts.length === 0 || !isRecord(value)) {
    return args;
  }
  return { ...value, [OMITTED_ARGS_KEY]: cuts };
}

/** 参数对象里被裁掉的字段（被裁过才有）。 */
export function omittedFieldsOf(args: unknown): OmittedField[] {
  if (!isRecord(args)) {
    return [];
  }
  const list = args[OMITTED_ARGS_KEY];
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter(
    (item): item is OmittedField =>
      isRecord(item) && typeof item.path === "string" && typeof item.bytes === "number",
  );
}

/** 某个具体字段的裁剪信息。 */
export function omittedFieldOf(args: unknown, path: string): OmittedField | undefined {
  return omittedFieldsOf(args).find((field) => field.path === path);
}

/** 工具结果正文的裁剪（`result` 里的文本可能来自任意扩展）。 */
export function budgetToolResultText(text: string): { text: string; cut: PayloadCut | null } {
  return cutTextHeadTail(text, TOOL_RESULT_HEAD_BYTES, TOOL_RESULT_TAIL_BYTES);
}

/** 帧预算的结果：`cuts` 非空代表这一帧被改写过（调用方应当记一笔诊断）。 */
export interface FrameBudget {
  payload: unknown;
  cuts: OmittedField[];
  bytes: number;
  /** 全网字段都保不住时的最后一招：只留下便宜字段（`true` 时界面会看到一次缺字段的事件）。 */
  salvaged: boolean;
}

/** 消息条数：只数数组长度，不为了一句话把 MB 级文档再序列化一遍。 */
function snapshotMessageCount(snapshot: Record<string, unknown>): number | undefined {
  // 流里的快照帧是 `{ type, snapshot: BootstrapResponse }`，而会话在
  // `snapshot.snapshot.conversation`；`state` 文件里也可能只有一层。两种都认。
  const root = isRecord(snapshot.snapshot) ? snapshot.snapshot : snapshot;
  const conversation = root.conversation;
  const messages = isRecord(conversation) ? conversation.messages : undefined;
  return Array.isArray(messages) ? messages.length : undefined;
}

/**
 * 整份状态文档超限时的降级：保留帧的**结构字段**（`type` / `runId` / …），
 * 把文档本身换成一句可读的说明，客户端据此跳过这次 reconcile。
 */
function omitStateDocument(payload: Record<string, unknown>, original: number): FrameBudget {
  const shallow: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(payload)) {
    if (key === "snapshot" || key === OMITTED_ARGS_KEY || key === "__cuts") {
      continue;
    }
    if (serializedBytes(item) <= 2048) {
      shallow[key] = item;
    }
  }
  shallow.snapshotOmitted = {
    bytes: original,
    messages: snapshotMessageCount(payload.snapshot as Record<string, unknown>),
    reason: "oversize",
  };
  return { payload: shallow, cuts: [], bytes: serializedBytes(shallow), salvaged: true };
}

function serializedBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? textByteLength(text) : 0;
  } catch {
    return 0;
  }
}

/**
 * 一条流帧上线前的字节预算。
 *
 * 顺序是：整帧在限内 → 原样（绝大多数帧走到这一步）；超了 → 逐个裁长字符串（形状不变，
 * 事件仍然能落到正确的气泡/工具行）；还超 → 只保留便宜字段并把丢掉的字节数记在
 * `__dropped` 里。**永远不返回空**：一条被降级的事件仍然比一条凭空消失的事件好，
 * 因为客户端的游标是按帧推进的。
 */
export function budgetFramePayload(
  payload: unknown,
  maxFrameBytes: number = MAX_STREAM_FRAME_BYTES,
): FrameBudget {
  const original = serializedBytes(payload);
  if (original <= maxFrameBytes || !isRecord(payload)) {
    return { payload, cuts: [], bytes: original, salvaged: false };
  }

  // 快照是一份**状态文档**，不是增量：把它按字段裁短，等于用一份更小的历史去覆盖
  // 客户端已经有的历史（旧工具行的正文会凭空变短，而界面看不出这是被裁的）。
  // 所以整份超限时**不裁内容，明确省略整份**——客户端本来就已经从增量帧拿到了同样的
  // 对话，随后的 `done` → bootstrap 才是权威追平点。少一次 reconcile 是无害的，
  // 拿半份快照去合并是有害的。
  if (payload.type === "snapshot" && isRecord(payload.snapshot)) {
    return omitStateDocument(payload, original);
  }

  // 两档字符串预算，每一档都基于**原载荷**重算（在上一档结果上再裁会把已经变短
  // 的预览当成原文，报出来的 bytes 就不是原文了）。第一档保住可读性；第二档只在
  // 「很多中等字符串合起来超限」时才用到。
  for (const maxStringBytes of [TOOL_ARG_STRING_MAX_BYTES, SALVAGE_STRING_BYTES]) {
    const { value, cuts } = budgetPayloadStrings(payload, maxStringBytes);
    if (cuts.length === 0 || !isRecord(value)) {
      continue;
    }
    const trimmed = { ...value, __cuts: cuts };
    const bytes = serializedBytes(trimmed);
    if (bytes <= maxFrameBytes) {
      return { payload: trimmed, cuts, bytes, salvaged: false };
    }
  }

  // 最后一招：结构字段（type/bubbleId/toolCallId…）留着，大字段整体换一句说明。
  const shallow: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(payload)) {
    if (key === OMITTED_ARGS_KEY || key === "__cuts") {
      continue;
    }
    if (serializedBytes(item) <= 2048) {
      shallow[key] = item;
    }
  }
  const { cuts } = budgetPayloadStrings(payload, SALVAGE_STRING_BYTES);
  shallow.__dropped = { bytes: original, paths: cuts.map((cut) => cut.path) };
  return { payload: shallow, cuts, bytes: serializedBytes(shallow), salvaged: true };
}

/**
 * 取一段文本的**字节**前缀（按 UTF-8 边界收尾，不留下半个字符）。
 *
 * 预算都是字节数，而 `String.prototype.slice` 数的是字符：中文正文里两者差三倍，
 * 按字符裁会悄悄超限（这正是 64 KiB 上限被读成 143 KB 的原因）。
 */
export function takePrefixBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) {
    return "";
  }
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) {
    return text;
  }
  return decoder.decode(bytes.subarray(0, maxBytes)).replace(/\uFFFD+$/u, "");
}

/**
 * 一段参数流 delta 还能转发多少：返回要发的文本与新的已发字节数。
 *
 * 打字机动画是"看着参数长出来"，不是"看完整份文件"；超过预算之后继续转发只是在
 * 替客户端攒内存（4 MB 的正文 ≈ 4 MB 的 React 状态 + 每次预览都重新解析前缀）。
 * 收尾由 `tool_call_stream_end` 负责——它带的是裁剪后的**对象**，形状仍然完整。
 */
export function budgetArgsDelta(
  forwardedBytes: number,
  delta: string,
  maxBytes: number = TOOL_ARGS_STREAM_MAX_BYTES,
): { text: string; forwardedBytes: number } {
  if (delta.length === 0 || forwardedBytes >= maxBytes) {
    return { text: "", forwardedBytes };
  }
  const text = takePrefixBytes(delta, maxBytes - forwardedBytes);
  return { text, forwardedBytes: forwardedBytes + textByteLength(text) };
}
