/**
 * 气泡身份（`t{turn}#role` 与 `prov:...`）与排序。
 *
 * 单独成模块的原因只有一个：`chatBubbles.ts` 撞行数棘轮。但这两个格式确实是**协议**——
 * 服务端用它们编 id、客户端用它们排序与占位，所以它们不该埋在一个千行的渲染模块里。
 *
 * 无依赖：这里刻意只放"从 id 字符串能读出什么"，不放任何 `ChatMessage` 结构相关的逻辑，
 * 这样 `chatBubbles.ts` 和未来的其它消费者都能引用，不会循环。
 */

export type ChatBubbleRole = "user" | "assistant";

export interface ChatBubbleRef {
  /** Stable identity, shared by server and client. */
  bubbleId: string;
  /** 1-based ordinal of the user message that opened this bubble. */
  turn: number;
  role: ChatBubbleRole;
}

/**
 * Ids are namespaced with `t<turn>#` so they can never collide with the legacy
 * `${timestamp}-${index}` ids (or with locally generated `msg_…` ids) that may
 * still be on screen from an older server build.
 */
export function chatBubbleId(turn: number, role: ChatBubbleRole): string {
  return `t${turn}#${role}`;
}

export function parseChatBubbleId(id: string | undefined): ChatBubbleRef | null {
  const match = /^t(\d+)#(user|assistant)$/u.exec(id ?? "");
  if (!match) {
    return null;
  }
  return { bubbleId: id as string, turn: Number(match[1]), role: match[2] as ChatBubbleRole };
}

/** Turn ordinal of the bubble a message belongs to, or `null` for foreign ids. */
export function bubbleTurnOf(id: string | undefined): number | null {
  return parseChatBubbleId(id)?.turn ?? null;
}

/**
 * Ordering key: bubbles sort by turn, and inside a turn the user message comes
 * before the assistant answer. This is what makes placement authoritative
 * instead of "whatever order the events happened to arrive in".
 *
 * Provisional bubbles take part with the turn they predicted, so confirming a
 * message cannot drop it *above* the placeholder answer that is still waiting
 * for its own turn (that is what used to draw the loading dot before the
 * question instead of after it). Within one slot a confirmed bubble sorts
 * before a guess at the same slot; ids we cannot parse at all stay last.
 */
export function compareBubbleIds(a: string | undefined, b: string | undefined): number {
  const left = bubbleOrder(a);
  const right = bubbleOrder(b);
  if (left.turn !== right.turn) {
    return left.turn < right.turn ? -1 : 1;
  }
  if (left.roleRank !== right.roleRank) {
    return left.roleRank - right.roleRank;
  }
  return left.confirmed - right.confirmed;
}

const UNPLACED_TURN = Number.POSITIVE_INFINITY;

interface BubbleOrder {
  turn: number;
  roleRank: number;
  /** 0 = the server placed it, 1 = still an optimistic guess. */
  confirmed: number;
}

function bubbleOrder(id: string | undefined): BubbleOrder {
  const settled = parseChatBubbleId(id);
  if (settled) {
    return { turn: settled.turn, roleRank: settled.role === "user" ? 0 : 1, confirmed: 0 };
  }
  const guess = parseProvisionalBubbleId(id ?? "");
  if (guess && guess.predictedTurn != null) {
    return { turn: guess.predictedTurn, roleRank: guess.role === "user" ? 0 : 1, confirmed: 1 };
  }
  return { turn: UNPLACED_TURN, roleRank: 0, confirmed: 1 };
}


/**
 * Identity of an optimistic bubble.
 *
 * It carries the turn the client *predicted* for this submission, so a server
 * event can find its own slot instead of grabbing whatever provisional happens
 * to be oldest. Two submissions in flight (a run plus a queued 插话) otherwise
 * cross claims and leave an orphan placeholder behind.
 */
export function provisionalBubbleId(
  clientMessageId: string,
  role: ChatBubbleRole,
  predictedTurn?: number,
): string {
  const turn = predictedTurn == null ? "" : `t${predictedTurn}:`;
  return `prov:${role}:${turn}${clientMessageId}`;
}

const PROVISIONAL_ID = /^prov:(user|assistant):(?:t(\d+):)?(.*)$/;

export interface ParsedProvisionalBubbleId {
  role: ChatBubbleRole;
  /** Turn the client guessed when it drew the bubble, or `null` if unknown. */
  predictedTurn: number | null;
  clientMessageId: string;
}

export function parseProvisionalBubbleId(id: string): ParsedProvisionalBubbleId | null {
  const match = PROVISIONAL_ID.exec(id);
  if (!match) {
    return null;
  }
  return {
    role: match[1] as ChatBubbleRole,
    predictedTurn: match[2] ? Number(match[2]) : null,
    clientMessageId: match[3],
  };
}

