/**
 * The two bits of arithmetic behind a thinking row: which line to show while the
 * thought is still arriving, and how long it took.
 *
 * Both are pure so they can be tested directly — the React component only decides
 * *when* to call them (see `elements/thinking-row.tsx`).
 */

/**
 * The newest non-empty line of a thought.
 *
 * The row shows one line while streaming. It has to be the last one, not the
 * first: reasoning arrives as an append-only stream, and a growing paragraph in a
 * single-line viewport would either be cut off (hiding the newest tokens) or push
 * the answer off-screen (what the removed bottom-pinned preview did).
 */
export function lastReasoningLine(text: string): { key: string; text: string } | null {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length > 0) {
      return { key: String(index), text: line };
    }
  }
  return null;
}

/**
 * Seconds to show for a thought that streamed here, or `undefined` for one that
 * was already finished when it mounted (a reloaded transcript has no start time,
 * and inventing a duration would be a lie the reader can check).
 *
 * Rounding is up, with a floor of one: a 200ms thought is "1 second", never "0".
 */
export function reasoningSeconds(
  startedAt: number | null,
  endedAt: number = Date.now(),
): number | undefined {
  if (startedAt === null) {
    return undefined;
  }
  return Math.max(1, Math.ceil((endedAt - startedAt) / 1000));
}