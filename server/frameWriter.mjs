/**
 * 桥 → 客户端这条流的帧写入器：**序号、背压、上限、收尾**都归它。
 *
 * 它是 `server/promptStream.mjs` 里 `writeEvent` 的下沉。以前那个闭包只做一件事：
 * `res.write(JSON.stringify(payload) + "\n")`，于是三件事都没人管——
 *
 * 1. **序号**：客户端拿到一串帧，却没有任何办法判断自己是否漏了一帧（断线重连、半路丢包、
 *    解析失败都变得不可观测）。现在每帧带 `streamSeq`，run 内从 1 开始、单调递增、不跳号。
 * 2. **背压**：`res.write()` 返回 `false` 表示 socket 缓冲区满了。返回值以前被忽略，于是
 *    客户端不读时桥继续往内存里堆帧——堆到进程被杀为止。现在返回 `false` 就停下等 `drain`。
 * 3. **上限**：断在半路的客户端永远不会 drain。等不到 `drain` 时队列会一直涨，所以给
 *    "还没交出去的字节"定一个上限：越限就**丢积压**，改发一帧 `transport_error` + `code:"overflow"`
 *    然后闭嘴。这条流的语义已经坏了，硬撑只会把桥拖死；客户端该做的是重新同步（bootstrap）。
 *
 * 为什么 `close()` 是异步的：背压期间帧还在队列里，直接 `res.end()` 会把尾帧切掉
 * （最典型的是 `done`——客户端会以为这一轮还没结束）。`close()` 先排空队列再 end。
 */

import { transportErrorFrame } from "../src/shared/protocol/bridgeStreamFrames.ts";

/** 4 MiB：正常的会话帧量级是几十 KB，留出的余量足够吸收一次慢渲染，又不至于让桥替客户端攒下整轮快照。 */
const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;

/**
 * 等一次 `drain`。response 已经关掉/出错时立即返回——否则一个断开的客户端能让写入器永远停在这。
 * @param {any} res
 * @returns {Promise<void>}
 */
function waitForDrain(res) {
  if (res.destroyed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      res.off("error", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
    // 一个没有监听者的 `error` 在 Node 里是致命的：这是唯一能保证它不把桥带下去的地方。
    res.once("error", done);
  });
}

/**
 * 造一个写入器。调用方只做两件事：`write(payload)`（不 await，顺序由队列保证）和 `close()`。
 *
 * @param {any} res Node 的 `ServerResponse`（或测试里的同形替身）。
 * @param {{ maxPendingBytes?: number }} [options]
 */
export function createFrameWriter(res, options = {}) {
  const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
  /** @type {Array<{ text: string, bytes: number }>} */
  const queue = [];
  /** 已排队的字节。 */
  let queuedBytes = 0;
  /** 已交给 socket、但还没等到 `drain` 的字节（Node 已经收下了，只是还没发出去）。 */
  let awaitingBytes = 0;
  let seq = 0;
  let closed = false;
  let overflowed = false;
  /** 上次 flush 的尾：每次入队接在它后面，顺序有保证，也不会漏掉"上一轮已经跑完"时才入队的帧。 */
  let flushing = Promise.resolve();

  const pendingBytes = () => queuedBytes + awaitingBytes;

  const enqueue = (payload) => {
    seq += 1;
    const text = `${JSON.stringify({ ...payload, streamSeq: seq })}\n`;
    const bytes = Buffer.byteLength(text);
    queue.push({ text, bytes });
    queuedBytes += bytes;
    void schedule();
  };

  /** 越限：丢掉积压，只留一帧说明**为什么**这条流没了。 */
  const overflow = () => {
    if (overflowed) {
      return;
    }
    overflowed = true;
    queue.length = 0;
    queuedBytes = 0;
    enqueue(
      transportErrorFrame(
        "overflow",
        `stream backlog exceeded ${maxPendingBytes} bytes; resync through bootstrap`,
      ),
    );
  };

  /** 一帧一帧写；`res.write()` 返回 `false` 就等 `drain`。 */
  const flushOnce = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) {
        // 队列长度 > 0 时不可能发生；只是让类型收窄（`shift()` 的返回值是可空的）。
        return;
      }
      queuedBytes -= item.bytes;
      if (res.destroyed) {
        queue.length = 0;
        queuedBytes = 0;
        return;
      }
      let waiting = false;
      try {
        waiting = !res.write(item.text);
      } catch {
        // 写坏的 socket 不该把桥带下去：这条流到此为止，剩下的帧丢掉。
        queue.length = 0;
        queuedBytes = 0;
        awaitingBytes = 0;
        closed = true;
        return;
      }
      if (waiting) {
        awaitingBytes = item.bytes;
        await waitForDrain(res);
        awaitingBytes = 0;
      }
    }
  };

  const schedule = () => {
    flushing = flushing.then(flushOnce);
    return flushing;
  };

  return {
    /** 记一帧并附上序号。返回后不代表已经写出去（背压期间在队列里等）。 */
    write(payload) {
      if (closed || overflowed || res.destroyed) {
        return;
      }
      if (pendingBytes() >= maxPendingBytes) {
        overflow();
        return;
      }
      enqueue(payload);
    },
    /** 排空队列再 `end()`。已经断开的 response 不再 end。 */
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await schedule();
      if (!res.destroyed) {
        res.end();
      }
    },
  };
}