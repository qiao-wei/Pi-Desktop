/**
 * 一条 prompt 流坏了之后怎么办：**先续订同一条 run**，续不上才退回快照。
 *
 * 为什么值得一个模块：桥侧的帧日志（`server/runStreams.mjs`）早就能让后来者从
 * `(runId, fromSeq)` 接上，`streamSeq` 也一直盖在每一帧上，但渲染侧从来没人用——于是
 * 任何一次传输故障（背压越限、坏行、连接被截断）都只能把这一轮**当成失败**收尾：
 * 气泡提前标成 done、发一条「本轮完成」通知、停止按钮消失，而桥上的 run 其实还在跑。
 * 这个模块把那段缺失的客户端补上，并且把"坏到什么程度"分清楚：
 *
 * 1. **能续**：按「我收到第 N 帧了」从 `N+1` 续订。帧日志里那条从没送达的帧会被重放，
 *    客户端看到的事件流因此是连续的（`done` 也会补上）。
 * 2. **续不上**：run 已经结束（404）、日志已经滚出窗口（409）、桥明确拒绝（400/403）——
 *    这些都交给 `onLost`，由调用方用一次强制 bootstrap 追平。再退订重试没有意义。
 * 3. **暂时续不上**：网络抖动/5xx 才重试，次数有限。
 *
 * 两条容易写错、这里钉住的规则：
 *
 * - **传输错误帧没有 `streamSeq`**（见 `server/frameWriter.mjs`）：它不属于 run，不能推游标。
 *   否则「从 N+1 续订」会正好跳过那条被丢掉的 run 帧。
 * - **坏掉的 feed 之后到的帧一律丢弃**（`deadFeed`）：背压越限时后面本来就没有帧，但坏行/漏帧
 *   的那条流可能还在继续吐。如果让这些帧推进游标，那个洞就永远补不回来了。
 */

import type { PromptStreamEvent } from "../../lib/api";
import { bridgeStreamStatus, isAbortError } from "../../lib/bridge/transport.ts";

/** 续订地址：`(runId, lastSeq)` 就是「这条 run 我读到第几帧了」。 */
export interface StreamCursor {
  runId: string | null;
  /** 最后一条**属于 run** 的帧的序号；传输层自己的话不算。 */
  lastSeq: number;
}

/** 一帧进来之后，调用方该做什么。 */
export type FeedDecision =
  /** 已经交给 `apply`。 */
  | "applied"
  /** 这条 feed 坏了：这一帧不应用，续订/追平已经开始。 */
  | "damaged"
  /** 属于已经被取代的 feed（或这一轮已经结束），必须忽略。 */
  | "stale";

export type FeedLossReason =
  /** 连 runId 都还没拿到：没有可续订的地址，只能走快照。 */
  | "no-address"
  /** run 已经结束，或者从来没存在过。 */
  | "not-found"
  /** run 还在，但它的帧日志已经从我们要的那一帧滚出去了。 */
  | "truncated"
  /** 桥明确拒绝这次订阅（会话不属于这条 run 之类）。 */
  | "rejected"
  /** 重试用完。 */
  | "exhausted";

export interface FeedLoss {
  reason: FeedLossReason;
  runId: string | null;
  lastSeq: number;
  /** 桥给的原文，只进诊断日志，不给用户看。 */
  message?: string;
}

export interface FeedRepair {
  attempt: number;
  fromSeq: number;
}

/** 与 `BridgeTransport.stream` 同形，注入进来才能不碰真桥就测完所有分支。 */
export type FeedStream = (
  path: string,
  body: unknown,
  onEvent: (event: PromptStreamEvent) => void,
  options: { signal?: AbortSignal },
) => Promise<void>;

export interface PromptFeedOptions {
  sessionPath: string;
  stream: FeedStream;
  /** 这条 feed 还是不是这一轮该看的那条（generation + controller 身份）。 */
  isCurrent: () => boolean;
  /** 用户按停止时会 abort；插话那种没人能中止的 feed 返回 `null`。 */
  ownerSignal: () => AbortSignal | null;
  apply: (event: PromptStreamEvent) => void;
  /** 续订这条路走不通了：调用方该用一次强制 bootstrap 追平。 */
  onLost: (loss: FeedLoss) => void;
  onRepair?: (repair: FeedRepair) => void;
  /** 次数与间隔可注入：测试不该等真实时钟。 */
  maxAttempts?: number;
  retryDelayMs?: number;
}

export interface PromptFeed {
  /** 喂一帧「提交/插话那条流」上的事件。续订进来的帧由模块自己喂。 */
  accept: (event: PromptStreamEvent) => FeedDecision;
  /** 等手上这次续订跑完（测试与停止路径用）。 */
  settled: () => Promise<void>;
  readonly cursor: StreamCursor;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 300;

export function createPromptFeed(options: PromptFeedOptions): PromptFeed {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const cursor: StreamCursor = { runId: null, lastSeq: 0 };
  /** 0 = 提交那条流本身；每开一次续订 +1。旧 feed 的帧因此自动作废。 */
  let activeFeed = 0;
  /** 已经判死的 feed。它后面再到的帧不能应用（见文件头第二坑）。 */
  let deadFeed = -1;
  let repairing: Promise<void> | null = null;

  const current = () => options.isCurrent();

  /**
   * 记下帧序号。返回「这一帧之前有洞吗」。
   *
   * 洞只在**已经有过序号**时才判定：一帧都没有的时候，第一个序号是多少都不能说明漏帧
   * （比如从订阅入口接上来的第一条本来就是 `fromSeq`）。有洞时**不推进游标**——它就停在
   * 洞前面，续订才会把漏掉的那帧重放回来。
   */
  const note = (event: PromptStreamEvent): boolean => {
    if (typeof event.streamSeq !== "number") {
      return false;
    }
    if (cursor.lastSeq > 0 && event.streamSeq > cursor.lastSeq + 1) {
      return true;
    }
    if (event.streamSeq > cursor.lastSeq) {
      cursor.lastSeq = event.streamSeq;
    }
    return false;
  };

  /** 喂一帧到指定 feed。`stale` 的帧连游标都不碰——那是另一个 feed 的历史。 */
  const feed = (which: number, event: PromptStreamEvent): FeedDecision => {
    if (which !== activeFeed || which === deadFeed) {
      return "stale";
    }
    if (!current()) {
      return "stale";
    }
    if (typeof event.runId === "string" && event.runId) {
      cursor.runId = event.runId;
    }
    // 传输错误是**关于这条流**的一句话，不是 run 的一帧：即使旧桥给它盖了序号也不采信。
    // 采信就会把游标推到「被丢掉的那条帧」上，续订正好跳过它（见文件头第一个坑）。
    if (event.type === "transport_error") {
      deadFeed = which;
      return "damaged";
    }
    if (note(event)) {
      deadFeed = which;
      return "damaged";
    }
    options.apply(event);
    return "applied";
  };

  const accept = (event: PromptStreamEvent): FeedDecision => {
    const decision = feed(0, event);
    if (decision === "damaged") {
      // `repair()` 自己不会 reject（所有失败都通向 `onLost`），这里只是不让调用方 await。
      void repair();
    }
    return decision;
  };

  const repair = (): Promise<void> => {
    if (!repairing) {
      repairing = repairLoop().finally(() => {
        repairing = null;
      });
    }
    return repairing;
  };

  async function repairLoop(): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (!current()) {
        return;
      }
      const runId = cursor.runId;
      if (!runId || cursor.lastSeq < 1) {
        options.onLost({ reason: "no-address", runId, lastSeq: cursor.lastSeq });
        return;
      }

      const feedEpoch = ++activeFeed;
      const fromSeq = cursor.lastSeq + 1;
      options.onRepair?.({ attempt, fromSeq });
      const controller = new AbortController();
      const unlink = linkAbort(options.ownerSignal(), controller);
      /** 这次订阅自己也坏了：游标已经停在洞前面，直接拿它再续一次。 */
      let again = false;
      /** 等一会儿再来。不能用 `!again` 推导：正常收尾和「该重试」都不是坏，但去向不同。 */
      let retry = false;
      try {
        await options.stream(
          "/api/runs/stream",
          { sessionPath: options.sessionPath, runId, fromSeq },
          (event) => {
            if (feed(feedEpoch, event) === "damaged") {
              again = true;
              controller.abort();
            }
          },
          { signal: controller.signal },
        );
      } catch (error) {
        if (!again) {
          // 用户按了停止 / 这一轮已经被新的一轮取代：交给调用方的 abort 路径，别抢 UI。
          if (!current() || options.ownerSignal()?.aborted || isAbortError(error)) {
            return;
          }
          const reason = lossForStatus(bridgeStreamStatus(error));
          if (reason) {
            options.onLost({
              reason,
              runId,
              lastSeq: cursor.lastSeq,
              message: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          // 网络抖动 / 5xx：等一会儿再来。
          await wait(retryDelayMs * attempt, controller.signal);
          retry = true;
        }
      } finally {
        unlink();
      }
      if (retry) {
        continue;
      }
      if (!again) {
        // 订阅流正常收尾 = 这条 run 关了，`done` 已经应用过。
        return;
      }
    }
    if (!current()) {
      return;
    }
    options.onLost({ reason: "exhausted", runId: cursor.runId, lastSeq: cursor.lastSeq });
  }

  return {
    accept,
    settled: async () => {
      // 续订期间又坏一次会开新的一次，所以要等到真的没有在跑为止。
      while (repairing) {
        await repairing.catch(() => undefined);
      }
    },
    cursor,
  };
}

function lossForStatus(status: number | undefined): FeedLossReason | null {
  if (status === 404) {
    return "not-found";
  }
  if (status === 409) {
    return "truncated";
  }
  if (status === 400 || status === 403) {
    return "rejected";
  }
  return null;
}

/** 订阅请求跟着「这一轮」一起死，但它不是 owner：断开只摘自己的 sink。 */
function linkAbort(owner: AbortSignal | null, controller: AbortController): () => void {
  if (!owner) {
    return () => undefined;
  }
  if (owner.aborted) {
    controller.abort();
    return () => undefined;
  }
  const forward = () => controller.abort();
  owner.addEventListener("abort", forward, { once: true });
  return () => owner.removeEventListener("abort", forward);
}

/** 可被 abort 提前结束的等待：停止按钮不该等完退避。 */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}