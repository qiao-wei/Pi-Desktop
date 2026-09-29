/**
 * 「滚到某条消息」的一次性信号，与 `chatScrollBus` 同一套路由规则。
 *
 * 为什么不能用 React state 传：全局搜索点结果时会先切会话，目标会话的
 * `ChatThread` 此刻还没挂载（甚至 bootstrap 还没到），等它挂载后 entry 恢复逻辑
 * 又会把视口拉回上次的阅读位置。信号必须能**先请求、后订阅**（parked），并在
 * 到达时直接交给管理视口的那个 owner，而不是经过一次重新渲染。
 *
 * 无 DOM、无 React，路由规则（按 sessionPath、只保留最新一条、挂载前暂存）可单测。
 */

export interface ChatJumpRequest {
  sessionPath: string;
  /** 目标气泡 id，例如 `t3#assistant`。 */
  messageId: string;
  /** 谁发起的，只用于性能计数。 */
  reason: string;
}

export type ChatJumpListener = (request: ChatJumpRequest) => void;

export interface ChatJumpBus {
  subscribe(sessionPath: string, listener: ChatJumpListener): () => void;
  /** 交给该会话的 owner；没有订阅者时暂存，等它挂载。返回是否立即送达。 */
  request(sessionPath: string, messageId: string, reason: string): boolean;
  hasSubscriber(sessionPath: string): boolean;
}

export function createChatJumpBus(): ChatJumpBus {
  const listeners = new Map<string, Set<ChatJumpListener>>();
  // 同一会话只可能有一个「最终要跳到的位置」：后来的请求覆盖先前的。
  const parked = new Map<string, ChatJumpRequest>();

  return {
    subscribe(sessionPath, listener) {
      let owners = listeners.get(sessionPath);
      if (!owners) {
        owners = new Set();
        listeners.set(sessionPath, owners);
      }
      owners.add(listener);

      const pending = parked.get(sessionPath);
      if (pending) {
        parked.delete(sessionPath);
        listener(pending);
      }

      return () => {
        owners.delete(listener);
        if (owners.size === 0) {
          listeners.delete(sessionPath);
        }
      };
    },
    request(sessionPath, messageId, reason) {
      const request: ChatJumpRequest = { sessionPath, messageId, reason };
      const owners = listeners.get(sessionPath);
      if (owners && owners.size > 0) {
        for (const listener of Array.from(owners)) {
          listener(request);
        }
        return true;
      }
      parked.set(sessionPath, request);
      return false;
    },
    hasSubscriber(sessionPath) {
      return (listeners.get(sessionPath)?.size ?? 0) > 0;
    },
  };
}

/** 应用共用的一条总线：搜索结果发起，`ChatThread` 的视口 owner 消费。 */
export const chatJumpBus = createChatJumpBus();