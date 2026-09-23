/**
 * Which assistant text block is still being written.
 *
 * The answer text is split into one part per block (a tool call or a thinking
 * round in between starts a new one), and every part carries a status that the
 * markdown renderer reads twice:
 *
 * - `@assistant-ui/react-markdown/styles/dot.css` appends its pulsing caret
 *   (`::after { content: "●" }`) to `.aui-md[data-status="running"]`;
 * - `MarkdownText` opts out of `useDeferredValue` when the status is `running`,
 *   so a live block lands in the same commit as the tool card behind it.
 *
 * Only the last block can still be growing. The previous rule marked *every*
 * text block `running` for the whole turn, which parked the caret at the tail
 * of each earlier paragraph until the run ended — the reported
 * 「工具前面的正文尾部一直有个黑点」.
 *
 * A trailing tool/thinking block means no text is streaming: the caret belongs
 * to that card (or to the synthetic indicator) instead.
 */
export function liveTextTailIndex(
  blocks: readonly { readonly kind: string }[],
  isStreaming: boolean,
): number {
  if (!isStreaming) {
    return -1;
  }
  const lastIndex = blocks.length - 1;
  return lastIndex >= 0 && blocks[lastIndex]?.kind === "text" ? lastIndex : -1;
}