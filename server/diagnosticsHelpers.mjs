/**
 * 诊断与错误详情的纯函数.
 *
 * 把 Error / session 的形状拍平成可 JSON 化的字段。
 *
 * 从 `server/index.mjs` 搬出来的纯函数（只依赖 import 进来的东西，不碰模块状态）——
 * 那个文件曾经 8.7k 行、棘轮不许它再长，所以按「一簇一文件」往外搬。
 */
function sessionDetails(targetRuntime) {
  const session = targetRuntime?.session;
  if (!session) {
    return {};
  }

  return {
    sessionPath: session.sessionFile,
    sessionId: session.sessionId,
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    isIdle: session.isIdle,
    isRetrying: session.isRetrying,
    autoRetryEnabled: session.autoRetryEnabled,
    pendingMessageCount: session.pendingMessageCount,
    retryAttempt: session.retryAttempt,
    messageCount: Array.isArray(session.state?.messages) ? session.state.messages.length : undefined,
  };
}

function sanitizeDiagnosticDetails(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) {
    return value === undefined ? undefined : value;
  }
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeDiagnosticDetails(item, depth + 1));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      if (/api.?key|authorization|token|secret|password|attachment.?data|prompt/i.test(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = sanitizeDiagnosticDetails(item, depth + 1);
      }
    }
    return result;
  }
  return String(value);
}

export { sessionDetails, sanitizeDiagnosticDetails };
