import { buildChatBubbles, messageToText } from "../src/shared/chatBubbles.ts";
import { searchDocuments } from "../src/shared/sessionSearch.ts";
import { sessionTitleMaxWords } from "../src/shared/sessionTitle.ts";
import { inferAttachmentMimeType } from "./attachmentHelpers.mjs";
import { corsHeaders } from "./cors.mjs";
import { sessionDetails } from "./diagnosticsHelpers.mjs";
import { parseByteRange, resolveLocalMediaPath } from "./localMedia.mjs";
import { usageFields } from "./modelHelpers.mjs";
import { oneShotThinkingEffort } from "./oneShotModel.mjs";
import { SessionManager } from "./piKernel.mjs";
import { PROTOCOL_VERSION } from "./protocolVersion.mjs";
import { assistantContentText, inferConversationTitle, normalizeGeneratedTitle } from "./sessionHelpers.mjs";
import { normalizeComposerDefaults } from "./sessionModelPolicy.mjs";
import { diagnosticLog, getProjectSessionDir } from "./sessionStoreFactory.mjs";
import { displayTranscript } from "./sessionTranscript.mjs";
import { errorDetails, formatAgentError, isSessionBusy, parseTime, sendJson } from "./smallHelpers.mjs";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * 会话快照、标题、搜索与中止
 *
 * 从 `server/index.mjs` 抽出的域：这些定义原来住在请求内核里，靠共享的可变状态与互相调用咬在一起。
 * 现在改成**注入**——共享状态走 `state`，外部函数/常量走 `deps`（按名字解构，函数体不改），
 * 由 index.mjs 在末尾组合区调用本工厂并解构成同名局部变量，所以调用点零改动。
 */
export function createSessionSnapshots(state, deps) {
  const { directoryMimeType, generatedTitleMaxChars, modelRuntime, openRuntimes, projectAttachmentRoot, searchDocumentCache, searchDocumentCacheLimit, sessionStore } = deps;
  const activeProject = /** @type {any} */ ((...args) => deps.activeProject(...args));
  const fallbackSessionTitle = /** @type {any} */ ((...args) => deps.fallbackSessionTitle(...args));
  const findProject = /** @type {any} */ ((...args) => deps.findProject(...args));
  const listArchivedSessions = /** @type {any} */ ((...args) => deps.listArchivedSessions(...args));
  const localMediaRoots = /** @type {any} */ ((...args) => deps.localMediaRoots(...args));
  const setSessionTitleIfEmpty = /** @type {any} */ ((...args) => deps.setSessionTitleIfEmpty(...args));
  const listProjectsWithSessions = /** @type {any} */ ((...args) => deps.listProjectsWithSessions(...args));
  const isUsableModel = /** @type {any} */ ((...args) => deps.isUsableModel(...args));
  const listAvailableModels = /** @type {any} */ ((...args) => deps.listAvailableModels(...args));
  const buildCapabilitiesSnapshot = /** @type {any} */ ((...args) => deps.buildCapabilitiesSnapshot(...args));
  const toolSettingsSnapshotFor = /** @type {any} */ ((...args) => deps.toolSettingsSnapshotFor(...args));

const sessionAbortPromises = new WeakMap();

function latestAssistantError(messages) {
  if (!Array.isArray(messages)) {
    return "";
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.stopReason === "error" && message.errorMessage) {
      return formatAgentError(message.errorMessage);
    }

    if (message?.role === "assistant" && message.stopReason === "aborted") {
      return formatAgentError(message.errorMessage || "Request aborted");
    }
  }

  return "";
}

async function stopSession(targetRuntime, options = {}) {
  const activeSession = targetRuntime.session;
  const shouldClearQueues = options.clearQueues !== false;
  const requestId = options.requestId;
  const stopStartedAt = Date.now();
  diagnosticLog("stop.start", {
    requestId,
    clearQueues: shouldClearQueues,
    ...sessionDetails(targetRuntime),
  });
  const clearedQueue = shouldClearQueues && typeof activeSession.clearQueue === "function"
    ? activeSession.clearQueue()
    : { steering: [], followUp: [] };
  diagnosticLog("stop.queue_cleared", {
    requestId,
    clearedSteering: clearedQueue.steering?.length ?? 0,
    clearedFollowUp: clearedQueue.followUp?.length ?? 0,
    ...sessionDetails(targetRuntime),
  });

  if (activeSession.isCompacting) {
    diagnosticLog("stop.compaction_abort.start", { requestId, ...sessionDetails(targetRuntime) });
    activeSession.abortCompaction();
    diagnosticLog("stop.compaction_abort.success", { requestId, ...sessionDetails(targetRuntime) });
  }

  if (!shouldClearQueues && activeSession.isStreaming) {
    diagnosticLog("stop.abort.fire_and_forget", { requestId, ...sessionDetails(targetRuntime) });
    void abortSession(activeSession, { requestId, reason: "stop_preserve_queue" }).catch(() => undefined);
    return {
      clearedQueue,
      snapshot: await buildSnapshot(targetRuntime),
    };
  }

  if (isSessionBusy(activeSession)) {
    diagnosticLog("stop.abort.start", { requestId, ...sessionDetails(targetRuntime) });
    await abortSession(activeSession, { requestId, reason: "api_stop" });
    diagnosticLog("stop.abort.success", { requestId, durationMs: Date.now() - stopStartedAt, ...sessionDetails(targetRuntime) });
  } else {
    diagnosticLog("stop.abort.skipped", { requestId, ...sessionDetails(targetRuntime) });
  }

  diagnosticLog("stop.snapshot.start", { requestId, ...sessionDetails(targetRuntime) });
  const snapshot = await buildSnapshot(targetRuntime);
  diagnosticLog("stop.success", { requestId, durationMs: Date.now() - stopStartedAt, ...sessionDetails(targetRuntime) });
  return {
    clearedQueue,
    snapshot,
  };
}

/**
 * @param {any} session 真实类型是内核的 `AgentSession`（无类型保护），只用到 `abort()`。
 * @param {{ requestId?: string, reason?: string }} [options]
 * @returns {Promise<void>}
 */
async function abortSession(session, { requestId, reason } = {}) {
  const existing = sessionAbortPromises.get(session);
  if (existing) {
    diagnosticLog("session.abort.join", {
      requestId,
      reason,
      ...sessionDetails({ session }),
    });
    return existing;
  }

  const startedAt = Date.now();
  diagnosticLog("session.abort.start", {
    requestId,
    reason,
    ...sessionDetails({ session }),
  });

  /** @type {Promise<void> | undefined} */
  let promise;
  promise = (async () => {
    const watchdog = setTimeout(() => {
      diagnosticLog("session.abort.pending", {
        requestId,
        reason,
        durationMs: Date.now() - startedAt,
        ...sessionDetails({ session }),
      });
    }, 5000);

    try {
      await session.abort();
      diagnosticLog("session.abort.success", {
        requestId,
        reason,
        durationMs: Date.now() - startedAt,
        ...sessionDetails({ session }),
      });
    } catch (error) {
      diagnosticLog("session.abort.error", {
        requestId,
        reason,
        durationMs: Date.now() - startedAt,
        ...sessionDetails({ session }),
        ...errorDetails(error),
      });
      throw error;
    } finally {
      clearTimeout(watchdog);
      if (sessionAbortPromises.get(session) === promise) {
        sessionAbortPromises.delete(session);
      }
    }
  })();

  sessionAbortPromises.set(session, promise);
  return promise;
}

async function refreshSnapshot(options = {}) {
  return buildSnapshot(state.runtime, options);
}

/**
 * The part of a snapshot that can change without the transcript moving, in O(1) in
 * conversation size.
 *
 * While this window owns a run, its own SSE stream is the authoritative transcript
 * feed, so the periodic poll exists only to pick up what the stream cannot carry:
 * pi's queues (a 插话 the server dropped or consumed), pending extension approval
 * prompts, which sessions are still busy, and whether a stop has landed. Answering
 * that with `buildSnapshot` costs a full conversation build plus a ~0.3-0.9 MB
 * `JSON.stringify` and md5 on the server, and a parse + normalise + merge on the
 * client's main thread - a stall that grows with context size, which is the wrong
 * shape for a watchdog. `done`/`error` already reconcile with a full snapshot, and
 * the stream carries pushed `snapshot` events, so nothing depends on the poll
 * carrying messages.
 */
function buildAmbientSnapshot(targetRuntime = state.runtime) {
  const session = targetRuntime.session;
  const model = isUsableModel(session.model) ? session.model : undefined;

  return {
    ambient: true,
    protocolVersion: PROTOCOL_VERSION,
    activeSessionPath: session.sessionFile,
    sessionFile: session.sessionFile,
    canPrompt: Boolean(model && modelRuntime.hasConfiguredAuth(model.provider)) && !session.isStreaming,
    projectTrusted: targetRuntime.settingsManager.isProjectTrusted(),
    streamingSessionPaths: [...openRuntimes.values()]
      .filter((candidate) => candidate.session.isStreaming)
      .map((candidate) => candidate.session.sessionFile),
    compactingSessionPaths: [...openRuntimes.values()]
      .filter((candidate) => candidate.session.isCompacting)
      .map((candidate) => candidate.session.sessionFile),
    pendingExtensionUiRequests: targetRuntime.uiBridge?.getPendingRequests() ?? [],
    pendingQueues: pendingQueues(session),
  };
}

/**
 * Sessions that count as streaming in a snapshot.
 *
 * `assumeStreaming` covers the edit's pre-prompt snapshot: the client has already
 * accepted the rewind and drawn the optimistic streaming turn, but
 * `session.isStreaming` only flips inside `prompt()`, which has not been called
 * yet (the snapshot has to go out first so bubble ordinals line up). Without this
 * the snapshot said "not streaming", the reducer rebuilt `isStreaming` from it,
 * and the composer's stop button disappeared for the whole edited run.
 */
function liveStreamingSessionPaths(targetRuntime, options = {}) {
  const paths = new Set(
    [...openRuntimes.values()]
      .filter((candidate) => candidate.session.isStreaming)
      .map((candidate) => candidate.session.sessionFile),
  );
  if (options.assumeStreaming === true) {
    paths.add(targetRuntime.session.sessionFile);
  }
  return [...paths];
}

function sessionIsStreaming(targetRuntime, options = {}) {
  return targetRuntime.session.isStreaming || options.assumeStreaming === true;
}

async function buildSnapshot(targetRuntime = state.runtime, options = {}) {
  const traceSessionSwitch = options.traceSessionSwitch === true;
  const startedAt = traceSessionSwitch ? Date.now() : 0;
  const project = findProject(targetRuntime.projectId);
  const visibleMessages = buildChatBubbles(displayTranscript(targetRuntime.session), {
    isStreaming: targetRuntime.session.isStreaming,
    now: Date.now(),
    toAttachment: toConversationAttachment,
  });
  if (traceSessionSwitch) {
    diagnosticLog("session.switch.snapshot_messages", {
      sessionPath: targetRuntime.session.sessionFile,
      durationMs: Date.now() - startedAt,
      messageCount: visibleMessages.length,
    });
  }
  const stats = targetRuntime.session.getSessionStats();
  const contextUsage = targetRuntime.session.getContextUsage();
  const entries = targetRuntime.session.sessionManager.getEntries();
  if (traceSessionSwitch) {
    diagnosticLog("session.switch.snapshot_stats", {
      sessionPath: targetRuntime.session.sessionFile,
      durationMs: Date.now() - startedAt,
      entryCount: entries.length,
    });
  }
  const compactionEntries = entries.filter((entry) => entry.type === "compaction");
  const latestCompaction = compactionEntries.at(-1);
  const model = isUsableModel(targetRuntime.session.model) ? targetRuntime.session.model : undefined;
  const modelProvider = model?.provider ? String(model.provider) : targetRuntime.settingsManager.getDefaultProvider() ?? "";
  const modelId = model?.id ?? targetRuntime.settingsManager.getDefaultModel() ?? "";
  const messageCount = visibleMessages.length;
  const userMessages = visibleMessages.filter((message) => message.role === "user");
  const assistantMessages = visibleMessages.filter((message) => message.role === "assistant");
  const result = {
    snapshot: {
      conversation: {
        id: targetRuntime.session.sessionId,
        title: targetRuntime.session.sessionName ?? inferConversationTitle(userMessages),
        createdAt: parseTime(targetRuntime.session.sessionManager.getHeader()?.timestamp) ?? visibleMessages[0]?.createdAt ?? Date.now(),
        updatedAt: visibleMessages.at(-1)?.createdAt ?? Date.now(),
        messages: visibleMessages,
        projectId: project.id,
        // worktree 会话这里就是 worktree 路径，前端靠它区分“会话在哪个检出里跑”。
        workingDirectory: targetRuntime.workspaceCwd ?? project.cwd,
        sessionFile: targetRuntime.session.sessionFile,
      },
      project,
      modelConfig: {
        provider: modelProvider,
        model: modelId,
        thinkingLevel: targetRuntime.session.thinkingLevel,
        // 「新任务从哪个等级开始」按项目记；没记过的项目回退到 pi 的全局默认。
        defaultThinkingLevel:
          normalizeComposerDefaults(project?.composerDefaults)?.thinkingLevel
          ?? targetRuntime.settingsManager.getDefaultThinkingLevel()
          ?? "off",
        agentUrl: state.apiBase,
        apiKeyConfigured: model ? modelRuntime.hasConfiguredAuth(model.provider) : false,
      },
      stats: {
        turnCount: userMessages.length,
        userMessageCount: userMessages.length,
        assistantMessageCount: assistantMessages.length,
        messageCount,
        compactionCount: compactionEntries.length,
        toolCallCount: stats.toolCalls,
        latestCompactionSummary: latestCompaction?.summary ?? "",
        ...usageFields(targetRuntime.session, { stats, entries, contextUsage }),
        lastMessageAt: visibleMessages.at(-1)?.createdAt,
      },
    },
    projects: listProjectsWithSessions(),
    archivedSessions: listArchivedSessions(),
    activeProjectId: project.id,
    activeSessionPath: targetRuntime.session.sessionFile,
    availableModels: listAvailableModels(),
    skills: targetRuntime.resourceLoader.getSkills().skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.filePath,
      disableModelInvocation: skill.disableModelInvocation,
    })),
    capabilities: await buildCapabilitiesSnapshot(targetRuntime),
    server: {
      url: state.apiBase,
      ready: true,
    },
    // 边界 `bridge` 的版本声明：渲染进程启动时先比对它，不一致就直接报错，
    // 而不是让少了/改名的字段以 undefined 的形式静默穿过 UI（见 src/shared/protocol/version.ts）。
    protocolVersion: PROTOCOL_VERSION,
    projectTrusted: targetRuntime.settingsManager.isProjectTrusted(),
    // 工具开关（codemode）：全局层 + 当前项目层 + 实际生效，和 pi 自己的 defaultTools 同一个算法。
    toolSettings: toolSettingsSnapshotFor(targetRuntime),
    canPrompt: Boolean(model && modelRuntime.hasConfiguredAuth(model.provider)) && !sessionIsStreaming(targetRuntime, options),
    sessionFile: targetRuntime.session.sessionFile,
    streamingSessionPaths: liveStreamingSessionPaths(targetRuntime, options),
    compactingSessionPaths: [...openRuntimes.values()]
      .filter((candidate) => candidate.session.isCompacting)
      .map((candidate) => candidate.session.sessionFile),
    pendingExtensionUiRequests: targetRuntime.uiBridge?.getPendingRequests() ?? [],
    // pi owns the steering/follow-up queue; exposing it is what lets the UI show
    // a queued 插话 before it is delivered, and survive a page reload.
    pendingQueues: pendingQueues(targetRuntime.session),
    personalization: state.personalization,
  };
  if (traceSessionSwitch) {
    diagnosticLog("session.switch.snapshot_complete", {
      sessionPath: targetRuntime.session.sessionFile,
      durationMs: Date.now() - startedAt,
    });
  }
  return result;
}

/**
 * pi emits one `queue_update` object per queue mutation and hands the same
 * instance to every subscriber, so counting it per session (deduped by object
 * identity) gives all clients one monotonic sequence. They need it because the
 * queue is reported as a snapshot: without a sequence, a duplicate or a late
 * `queued` would resurrect a 插话 that has already been delivered.
 */
const queueSeqBySession = new WeakMap();

function queueSeq(session, event) {
  const seen = queueSeqBySession.get(session);
  if (seen && seen.event === event) {
    return seen.seq;
  }
  const seq = (seen?.seq ?? 0) + 1;
  queueSeqBySession.set(session, { event, seq });
  return seq;
}

function pendingQueues(session, seq = queueSeqBySession.get(session)?.seq ?? 0) {
  return {
    steering: [...(session?.getSteeringMessages?.() ?? [])],
    followUp: [...(session?.getFollowUpMessages?.() ?? [])],
    seq,
  };
}

async function generateInitialSessionTitle(targetRuntime) {
  if (targetRuntime.session.sessionManager.getSessionName()) {
    return;
  }

  const visibleMessages = buildChatBubbles(displayTranscript(targetRuntime.session), { isStreaming: false, toAttachment: toConversationAttachment });
  const userMessage = visibleMessages.find((message) => message.role === "user");
  const assistantMessage = visibleMessages.find((message) => message.role === "assistant");
  const fallbackTitle = fallbackSessionTitle(userMessage ? messageToText(userMessage) : "") || "New session";
  if (!userMessage || !assistantMessage || !isUsableModel(targetRuntime.session.model)) {
    setSessionTitleIfEmpty(targetRuntime, fallbackTitle);
    return;
  }

  try {
    const response = await modelRuntime.complete(
      targetRuntime.session.model,
      {
        systemPrompt: [
          "你是会话标题生成器。",
          "根据第一条用户消息和第一条助手回复，生成一个短标题。",
          `只输出标题，不要解释。中文标题不超过 ${generatedTitleMaxChars} 字；英文标题不超过 ${sessionTitleMaxWords} 个词；写不下就在标点处收尾，不要把词截成一半。`,
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  "第一条用户消息：",
                  messageToText(userMessage),
                  "",
                  "第一条助手回复：",
                  messageToText(assistantMessage),
                ].join("\n"),
              },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      // 同提交信息生成：maxTokens 要覆盖思考模型的 reasoning 消耗；始终思考的模型
      // 不显式给档位会被端点 400（见 server/oneShotModel.mjs）。
      {
        maxTokens: 512,
        cacheRetention: "none",
        sessionId: randomUUID(),
        reasoningEffort: oneShotThinkingEffort(targetRuntime.session.model),
      },
    );
    const generatedTitle = normalizeGeneratedTitle(assistantContentText(response));
    setSessionTitleIfEmpty(targetRuntime, generatedTitle || fallbackTitle);
  } catch {
    setSessionTitleIfEmpty(targetRuntime, fallbackTitle);
  }
}

/**
 * @param {any} attachment
 * @returns {{ id: string, name: string, mimeType: string, size: number, kind: "directory" | "image" | "file", sourcePath?: string, previewUrl?: string }}
 */
function toConversationAttachment(attachment) {
  const mimeType = String(attachment?.mimeType ?? "application/octet-stream");
  // 目录和图片一样是自成一类：旧消息里只有 image/file 两种 kind，所以两边都看。
  const kind = attachment?.kind === "directory" || mimeType.trim().toLowerCase() === directoryMimeType
    ? "directory"
    : attachment?.kind === "image" || mimeType.startsWith("image/")
      ? "image"
      : "file";
  const path = String(attachment?.path ?? "");
  return {
    id: String(attachment?.id ?? randomUUID()),
    name: String(attachment?.name ?? "Attachment"),
    mimeType,
    size: Number(attachment?.size ?? 0),
    kind,
    sourcePath: path || undefined,
    previewUrl: kind === "image" && path
      ? `${state.apiBase}/api/attachments?path=${encodeURIComponent(path)}`
      : undefined,
  };
}

function sendAttachment(res, filePath) {
  const resolvedPath = resolve(filePath);
  const resolvedRoot = resolve(projectAttachmentRoot);
  if (!resolvedPath.startsWith(`${resolvedRoot}/`) || !existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    sendJson(res, 404, { error: "Attachment not found." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": inferAttachmentMimeType(resolvedPath),
    "Cache-Control": "private, max-age=3600",
    ...corsHeaders(),
  });
  res.end(readFileSync(resolvedPath));
}

/**
 * Serve a media file the agent wrote on disk, for `<img>` / `<video>` in answers.
 *
 * The WebView cannot read the filesystem, so every local path in an answer has to
 * come back through here; `resolveLocalMediaPath` owns which paths are allowed
 * (project directory, agent directory, temp directory, home) and refuses anything
 * else before a byte is read.
 *
 * Partial responses are implemented because WKWebView refuses to seek in a video
 * it cannot range-request, and a 200-only server makes every clip unscrubbable.
 */
function sendLocalMedia(res, rawPath, rangeHeader) {
  const decision = resolveLocalMediaPath(rawPath, {
    roots: localMediaRoots(),
    cwd: activeProject()?.cwd,
    homedir: homedir(),
  });
  if (!decision.ok) {
    sendJson(res, decision.status, { error: decision.error });
    return;
  }

  const headers = {
    "Content-Type": decision.mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    // An answer can name an .svg, and a document opened from that URL must not be
    // able to script against this server.
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'",
    ...corsHeaders(),
  };

  const range = parseByteRange(rangeHeader, decision.size);
  if (range) {
    res.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${range.start}-${range.end}/${decision.size}`,
      "Content-Length": range.end - range.start + 1,
    });
  } else {
    res.writeHead(200, { ...headers, "Content-Length": decision.size });
  }

  createReadStream(decision.path, range ? { start: range.start, end: range.end } : undefined)
    .on("error", () => res.destroy())
    .pipe(res);
}

function updateSessionStoreFromSession(project, sessionManager, options) {
  sessionStore.upsert(project, sessionManager, options);
}

function updateSessionStoreFromRuntime(targetRuntime) {
  const project = findProject(targetRuntime.projectId);
  updateSessionStoreFromSession(project, targetRuntime.session.sessionManager);
}

/**
 * 全局搜索：跨项目扫会话文件，返回「项目 › 会话 › 片段」。
 *
 * bootstrap 只带当前会话的完整正文，其它会话在 SQLite 索引里只有标题和首条消息，
 * 所以全文命中只能自己读会话文件。读文件是这里唯一的重活，用 mtime 做键的缓存把它
 * 摊到「第一次搜到某会话」上；正文没变就不重解析。
 */
/* moved to server/smallHelpers.mjs */


function readSessionSearchDocument(project, session) {
  const filePath = session.path;
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    // 文件被外部删掉：索引还没刷新，跳过即可，不要因此让整次搜索失败。
    return null;
  }
  const cached = searchDocumentCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.document;
  }

  let document = null;
  try {
    // 离线读：`SessionManager.open` 只解析文件，借 `displayTranscript` 的 branch 分支
    // 逻辑拿到「跟 UI 看到的同一批消息」（压缩折叠掉的历史仍在分支里），再用
    // `buildChatBubbles` 算出与页面上一致的气泡 id（`t3#assistant`）。
    const manager = SessionManager.open(filePath, getProjectSessionDir(project));
    const transcript = displayTranscript({ sessionManager: manager });
    const bubbles = buildChatBubbles(transcript, {
      isStreaming: false,
      toAttachment: (attachment) => attachment,
    });
    const messages = bubbles
      .map((bubble) => ({
        bubbleId: bubble.id,
        role: bubble.role,
        text: String(bubble.content ?? ""),
      }))
      .filter((message) => message.text.trim());
    document = {
      projectId: project.id,
      projectName: project.name,
      sessionPath: filePath,
      sessionTitle: session.title,
      updatedAt: Number(session.updatedAt ?? 0),
      messages,
    };
  } catch (error) {
    diagnosticLog("search.document.failed", {
      sessionPath: filePath,
      error: error instanceof Error ? error.message : String(error ?? ""),
    });
    return null;
  }

  searchDocumentCache.set(filePath, { mtimeMs, document });
  if (searchDocumentCache.size > searchDocumentCacheLimit) {
    let overflow = searchDocumentCache.size - searchDocumentCacheLimit;
    for (const key of searchDocumentCache.keys()) {
      if (overflow <= 0) {
        break;
      }
      searchDocumentCache.delete(key);
      overflow -= 1;
    }
  }
  return document;
}

async function searchSessionDocuments(query, limit) {
  const entries = [];
  for (const project of state.projects) {
    for (const session of sessionStore.list(project)) {
      // 归档会话不出现在侧栏，也就不该在全局搜索里冒出来。
      if (!session.messageCount) {
        continue;
      }
      entries.push({ project, session });
    }
  }
  // 最近的会话在前：结果按扫描顺序出，所以排序就是「命中优先级」。
  entries.sort((a, b) => Number(b.session.updatedAt ?? 0) - Number(a.session.updatedAt ?? 0));

  const results = [];
  let truncated = false;
  for (const [index, { project, session }] of entries.entries()) {
    const document = readSessionSearchDocument(project, session);
    if (!document) {
      continue;
    }
    // 逐条累积而不是全读再筛：会话按更新时间降序，结果一般在前几个会话就凑满了，
    // 不必为了多出来的命中把几万个会话文件都读一遍。
    const page = searchDocuments([document], query, { limit: limit - results.length });
    results.push(...page.results);
    if (page.truncated) {
      truncated = true;
      break;
    }
    if (results.length >= limit) {
      // 已经凑满上限；只有后面确实还有没扫的会话才叫「被截断」。
      truncated = index < entries.length - 1;
      break;
    }
  }
  return { results, truncated };
}

  return { abortSession, buildAmbientSnapshot, buildSnapshot, generateInitialSessionTitle, latestAssistantError, liveStreamingSessionPaths, pendingQueues, queueSeq, queueSeqBySession, readSessionSearchDocument, refreshSnapshot, searchSessionDocuments, sendAttachment, sendLocalMedia, sessionAbortPromises, sessionIsStreaming, stopSession, toConversationAttachment, updateSessionStoreFromRuntime, updateSessionStoreFromSession };
}
