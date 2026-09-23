/**
 * The two flags a live reasoning group needs, kept apart on purpose.
 *
 * `streaming` drives the *look*: the shimmering "Reasoning" trigger plus the
 * bottom-pinned live preview in `reasoning.tsx` (`isPreview = streaming && open`).
 * It must describe this group only. When it was defined as
 * `messageRunning || ownStreaming`, every reasoning panel in the bubble looked like
 * it was still thinking for the whole turn - measured on a real 7-tool-round run
 * (2m14s), so a panel whose text finished in the first second shimmered and
 * auto-scrolled for two more minutes, right above tool cards that were visibly
 * running. That is the "工具都出来了，上面的 thinking 还在输出" report, and it was 100%
 * reproducible regardless of what the server did - which also masked the settle
 * latency the server-side synthetic close fixes.
 *
 * `holdOpen` drives the *layout*: keeping the disclosure expanded until the turn
 * ends, because collapsing a panel in the middle of a run lifts everything below it
 * (the collapse gate can only defer a transition on a mounted block).
 */
export type ReasoningGroupFlags = {
  /** This group's own tokens are still arriving - shimmer + live preview. */
  streaming: boolean;
  /** Hold the disclosure open - true while any part of the message is running. */
  holdOpen: boolean;
};

export function reasoningGroupFlags(input: {
  messageRunning: boolean;
  ownStreaming: boolean;
}): ReasoningGroupFlags {
  return {
    streaming: input.ownStreaming,
    holdOpen: input.messageRunning || input.ownStreaming,
  };
}
