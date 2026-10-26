/**
 * NDJSON 响应的**逐条**读法：`next()` 拿一条（流结束返回 null），`rest()` 收完剩下的。
 *
 * 为什么不能就用 `response.text()`：这些用例要在**一轮还没跑完时**接上去（订阅、断开），
 * 缓冲整段就等于等到结束。两份测试都要这个能力，所以放在这里一份，避免各写一遍解析。
 */
export function ndjson(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;

  const next = async (): Promise<any | null> => {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          return JSON.parse(line);
        }
        continue;
      }
      if (ended) {
        const tail = buffer.trim();
        buffer = "";
        return tail ? JSON.parse(tail) : null;
      }
      const chunk = await reader.read();
      if (chunk.done) {
        ended = true;
        continue;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  const rest = async (): Promise<any[]> => {
    const frames: any[] = [];
    for (;;) {
      const frame = await next();
      if (frame === null) {
        return frames;
      }
      frames.push(frame);
    }
  };

  return { next, rest };
}