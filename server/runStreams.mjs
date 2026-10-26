/**
 * 一次运行的**帧日志 + 多 sink 扇出**：让「提交」与「订阅」成为两件事。
 *
 * 背景：帧以前只写进提交那一个 response（`writeEvent` 闭包），所以谁错过了就永远错过了；
 * `streamSeq` 只能告诉你漏了几条，`runId` 只能告诉你属于哪次运行——两者都不足以**回到**那条流。
 * 这个模块补上最后一块：run 级日志 + 任意多个 sink。
 *
 * 两段式（`plan()` → `attach()`）不是啰嗦，而是因为**能不能服务必须在下流之前定**
 * （HTTP 已经上了 200 就没法再改口）：调用方先问 `plan(fromSeq)` 拿到判定，能服务才写头、
 * 再 `attach(res, plan)`。拒绝是一条明确的结论（`truncated` / `beyond` / `closed`），
 * 不是"接上去再发一帧告诉你坏了"——那正是 spec 里禁止的静默降级。
 *
 * 日志有**上限**：客户端断在半路时不能拿桥的内存替它保留整轮帧。上限到了就丢最旧的，
 * 于是来晚的订阅者会被明确告知"你要的那条已经不在窗口里"（`truncated` + `oldestSeq`），
 * 它该做的是走 bootstrap 重新同步，而不是从中间假装接上。
 */

import { createFrameWriter } from "./frameWriter.mjs";

/** 4 MiB：与单流待发上限同量级。一轮会话的帧量级是几十 KB，这里挡的是"断线的客户端 + 长回复"。 */
const DEFAULT_MAX_LOG_BYTES = 4 * 1024 * 1024;

/**
 * @param {{ maxLogBytes?: number }} [options]
 */
export function createRunStreams(options = {}) {
  const maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  /** @type {Map<string, any>} */
  const runs = new Map();

  /**
   * @param {{ runId: string, sessionPath: string }} attrs
   */
  function open({ runId, sessionPath }) {
    if (!runId) {
      throw new Error("runStreams.open: runId 必填（帧的归属不能是空的）");
    }
    /** @type {Array<{ seq: number, payload: any, bytes: number }>} */
    const log = [];
    /** @type {Set<any>} */
    const sinks = new Set();
    let logBytes = 0;
    let seq = 0;
    let closed = false;

    const run = {
      runId,
      sessionPath,
      get seq() {
        return seq;
      },
      get oldestSeq() {
        return log.length > 0 ? log[0].seq : seq + 1;
      },
      /** 发一帧：编号 → 落日志 → 扇给每个 sink。 */
      publish(payload) {
        if (closed) {
          return;
        }
        seq += 1;
        const bytes = Buffer.byteLength(JSON.stringify(payload));
        log.push({ seq, payload, bytes });
        logBytes += bytes;
        while (logBytes > maxLogBytes && log.length > 1) {
          const dropped = log.shift();
          if (dropped === undefined) {
            break;
          }
          logBytes -= dropped.bytes;
        }
        for (const sink of sinks) {
          sink.write(payload);
        }
      },
      /**
       * 能不能从 `fromSeq` 接上。结果是一份**数据**，调用方据此决定 HTTP 状态。
       * @param {number} [fromSeq]
       */
      plan(fromSeq) {
        const requested = Number.isFinite(fromSeq) ? Math.floor(Number(fromSeq)) : 1;
        const start = Math.max(1, requested);
        if (closed) {
          return { kind: "closed", fromSeq: start };
        }
        if (start > seq + 1) {
          // 客户端声称收到过这条流还没发出的帧：不是"晚到"，是地址不对。
          return { kind: "beyond", fromSeq: start, seq };
        }
        if (start < run.oldestSeq) {
          return { kind: "truncated", fromSeq: start, oldestSeq: run.oldestSeq };
        }
        return {
          kind: "ok",
          fromSeq: start,
          // sink 的本地计数从 start-1 起，于是它写出的第一条就是 `start`——与 run 的编号严丝合缝。
          startSeq: start - 1,
          replay: log.filter((entry) => entry.seq >= start).map((entry) => entry.payload),
        };
      },
      /**
       * 接上一个 sink（只有 `plan().kind === "ok"` 时才该调用）。返回的 sink 可以单独摘掉，
       * 不影响这条 run 与别的订阅者。
       * @param {any} res
       * @param {{ startSeq: number, replay: any[] }} plan
       */
      attach(res, plan) {
        const sink = createFrameWriter(res, { runId, startSeq: plan.startSeq });
        for (const payload of plan.replay) {
          sink.write(payload);
        }
        sinks.add(sink);
        // 订阅者自己走了：只摘它这一条。run 归提交者所有，别人的流不受影响。
        const drop = () => sinks.delete(sink);
        res.once?.("close", drop);
        return {
          close() {
            res.off?.("close", drop);
            sinks.delete(sink);
            return sink.close();
          },
        };
      },
      /** 运行结束：收尾每一个 sink（各自的队列排空 + end），并从注册表消失。 */
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        runs.delete(runId);
        log.length = 0;
        logBytes = 0;
        const pending = [...sinks].map((sink) => sink.close());
        sinks.clear();
        await Promise.all(pending);
      },
    };

    runs.set(runId, run);
    return run;
  }

  return {
    open,
    /** 这一条流还在不在。地址（runId）猜不出来，所以这里只回答"在/不在"。 */
    get(runId) {
      return runs.get(runId);
    },
  };
}