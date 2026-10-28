import type { PromptStreamEvent } from "../../lib/api";
/**
 * 「服务端已经接住这次提交」的证据事件。
 *
 * 单独成模块是为了让 `usePiDesktopApp.ts` 留出行数额度。判定本身是协议性的：
 * 这些事件里的任何一个先到，就说明这一轮确实起跑了，本地的乐观气泡不必再回滚。
 */
/** Events that prove the server took the submission over. */
export const ACCEPTED_EVENT_TYPES = new Set<PromptStreamEvent["type"]>([
  "user_message_start",
  "assistant_message_start",
  "delta",
  "assistant_partial",
  "tool_execution_start",
  "tool_execution_end",
  "snapshot",
  "queued",
  "error",
  "done",
]);

