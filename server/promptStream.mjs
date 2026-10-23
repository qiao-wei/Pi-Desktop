import { assistantThinkingBlocks, countTranscriptTurns, createBubbleTracker, messageDisplayText } from "../src/shared/chatBubbles.ts";
import { appendAttachmentContext, sanitizeAttachmentName } from "./attachmentHelpers.mjs";
import { normalizeMessageParts } from "./conversationParts.mjs";
import { corsHeaders } from "./cors.mjs";
import { sessionDetails } from "./diagnosticsHelpers.mjs";
import { readJson } from "./httpHelpers.mjs";
import { usageFields } from "./modelHelpers.mjs";
import { rewindSessionToTurn, shouldGenerateInitialTitle } from "./sessionHelpers.mjs";
import { diagnosticLog } from "./sessionStoreFactory.mjs";
import { displayTranscript } from "./sessionTranscript.mjs";
import { attachmentOnlyPrompt, capabilityOnlyPrompt, errorDetails, formatAgentError, partialToolCall, toolStreamId } from "./smallHelpers.mjs";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

/**
 * 提示词提交：组装、附件落盘、流式执行
 *
 * 从 `server/index.mjs` 抽出的域：这些定义原来住在请求内核里，靠共享的可变状态与互相调用咬在一起。
 * 现在改成**注入**——共享状态走 `state`，外部函数/常量走 `deps`（按名字解构，函数体不改），
 * 由 index.mjs 在末尾组合区调用本工厂并解构成同名局部变量，所以调用点零改动。
 */
export function createPromptStream(state, deps) {
  const { directoryMimeType, maxAttachmentBytes, maxAttachmentCount, maxAttachmentTotalBytes, modelRuntime, projectAttachmentRoot } = deps;
  const findProject = /** @type {any} */ ((...args) => deps.findProject(...args));
  const sanitizePathPart = /** @type {any} */ ((...args) => deps.sanitizePathPart(...args));
  const activeSessionCapabilitySelection = /** @type {any} */ ((...args) => deps.activeSessionCapabilitySelection(...args));
  const manualSkillPrefixFor = /** @type {any} */ ((...args) => deps.manualSkillPrefixFor(...args));
  const skillCapabilityId = /** @type {any} */ ((...args) => deps.skillCapabilityId(...args));
  const abortSession = /** @type {any} */ ((...args) => deps.abortSession(...args));
  const generateInitialSessionTitle = /** @type {any} */ ((...args) => deps.generateInitialSessionTitle(...args));
  const isUsableModel = /** @type {any} */ ((...args) => deps.isUsableModel(...args));
  const latestAssistantError = /** @type {any} */ ((...args) => deps.latestAssistantError(...args));
  const pendingQueues = /** @type {any} */ ((...args) => deps.pendingQueues(...args));
  const queueSeq = /** @type {any} */ ((...args) => deps.queueSeq(...args));
  const readRuntimeCapabilityContext = /** @type {any} */ ((...args) => deps.readRuntimeCapabilityContext(...args));
  const updateRuntimeSessionCapabilities = /** @type {any} */ ((...args) => deps.updateRuntimeSessionCapabilities(...args));
  const updateSessionStoreFromRuntime = /** @type {any} */ ((...args) => deps.updateSessionStoreFromRuntime(...args));
  const buildSnapshot = /** @type {any} */ ((...args) => deps.buildSnapshot(...args));
  const getRuntimeForRequest = /** @type {any} */ ((...args) => deps.getRuntimeForRequest(...args));

async function streamPrompt(req, res, requestId, options = {}) {
  const promptStartedAt = Date.now();
  const body = options.body ?? await readJson(req);
  const rawInput = String(body?.input ?? "");
  const displayInput = String(body?.displayInput ?? rawInput);
  const streamingBehavior = body?.streamingBehavior === "followUp" ? "followUp" : "steer";
  const activeRuntime = getRuntimeForRequest(body);
  // 编辑重发：先回退分支，之后所有 bubble ordinal / 上下文都按回退后的分支计算。
  if (options.rewindTurn != null) {
    await rewindSessionToTurn(activeRuntime.session, options.rewindTurn);
  }
  diagnosticLog("prompt.start", {
    requestId,
    streamingBehavior,
    inputLength: rawInput.length,
    attachmentCount: Array.isArray(body?.attachments) ? body.attachments.length : 0,
    ...sessionDetails(activeRuntime),
  });
  const attachments = persistPromptAttachments(activeRuntime, body?.attachments);
  const { parts: messageParts, manualSkillPrefix } = await normalizePromptMessageParts(
    activeRuntime,
    body?.messageParts,
    displayInput,
    attachments,
  );
  // 只挂了技能徽标、一个字没写也算一次提交（TUI 的 `/skill:name` 无参数形态）：此时
  // baseInput 由 capabilityOnlyPrompt 顶上一个短句，别把空消息交给模型。
  const requestedCapabilities = messageParts.filter((part) => part?.kind === "capability");
  if (!rawInput.trim() && !attachments.length && !requestedCapabilities.length) {
    throw new Error("input is required");
  }
  if (!isUsableModel(activeRuntime.session.model)) {
    throw new Error("请先选择 provider 和 model。");
  }
  if (!modelRuntime.hasConfiguredAuth(activeRuntime.session.model.provider)) {
    throw new Error(`请先配置 ${activeRuntime.session.model.provider} 的 API key。`);
  }

  const baseInput = rawInput
    || (attachments.length ? attachmentOnlyPrompt(attachments) : capabilityOnlyPrompt(requestedCapabilities));
  // manual-only 技能的正文得顶在用户消息最前面（见 manualSkillPrompt.mjs）；
  // metadata 里的 displayInput 不变，所以气泡里仍然只显示用户打的那句话 + 徽标。
  const input = appendAttachmentContext(
    manualSkillPrefix ? `${manualSkillPrefix}${baseInput}` : baseInput,
    displayInput,
    attachments,
    messageParts,
  );
  const images = activeRuntime.session.model.input?.includes("image")
    ? attachments
        .filter((attachment) => attachment.kind === "image")
        .map((attachment) => ({
          type: "image",
          data: attachment.data,
          mimeType: attachment.mimeType,
        }))
    : [];

  const activeSession = activeRuntime.session;
  const wasStreaming = activeSession.isStreaming;
  const shouldTitleAfterFirstTurn = !wasStreaming && streamingBehavior !== "followUp" && shouldGenerateInitialTitle(activeRuntime);
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...corsHeaders(),
  });

  let closed = false;
  let finalAgentError = "";
  let assistantMessageStreamIndex = -1;
  // Bubble identity for this run, computed with the very same rule the snapshot
  // builder uses, so every event addresses the bubble the client already shows.
  const bubbleTracker = createBubbleTracker(countTranscriptTurns(displayTranscript(activeSession)));
  const bubbleOf = () => bubbleTracker.currentAssistant()?.bubbleId ?? null;
  const toolArgsById = new Map();
  const toolStreamIdsByCallId = new Map();
  // Identity of a thinking block across the delta stream and the cumulative
  // snapshots. Keyed by pi's own content index (not the ordinal among thinking
  // blocks) so it lines up with `contentIndex` on `thinking_delta`, even when the
  // message interleaves text and tool calls around the thinking.
  const thinkingStreamKeyOf = (contentIndex) =>
    `assistant-${assistantMessageStreamIndex}-thinking-${contentIndex}`;
  const writeEvent = (payload) => {
    if (closed || res.destroyed) {
      return;
    }

    res.write(`${JSON.stringify(payload)}\n`);
  };
  // 回退后先播一次权威快照：旧轮次从 UI 消失、剩下来的轮次编号与新 stream 一致，
  // 否则新 prompt 的 `t{turn}#...` 事件会和客户端里还没清掉的旧轮次撞号。
  if (options.rewindTurn != null) {
    // `assumeStreaming`: this snapshot is emitted before `prompt()` starts the run,
    // but the client is already showing it as streaming - without the flag the
    // snapshot would tell the client the run is over and kill the stop button.
    writeEvent({ type: "snapshot", snapshot: await buildSnapshot(activeRuntime, { assumeStreaming: true }) });
  }
  // The thinking block whose end the provider has not reported yet.
  //
  // pi streams a message's content blocks one after another, so the start of any
  // later block proves the one before it is over. That matters because the
  // OpenAI-compatible providers (`openai-completions` and friends) only finalize
  // blocks once the whole message stream has ended - measured 0.4-4.1s after the
  // last thinking token on a real session, during which the tool card below is
  // already running and the reasoning panel above would keep spinning. The
  // Anthropic-style providers close each block where it happens, so they never
  // take this path.
  //
  // The settle event is a *textless* `assistant_partial`: the client clears the
  // panel's `open` flag from it and never touches the streamed text (see
  // `projectProcessBlocks`), and the provider's real `thinking_end` still gets to
  // publish the authoritative cumulative body afterwards.
  let openThinkingKey = null;
  const settleThinking = () => {
    const key = openThinkingKey;
    if (!key) {
      return;
    }

    openThinkingKey = null;
    writeEvent({
      type: "assistant_partial",
      bubbleId: bubbleOf(),
      closeThinking: true,
      blocks: [{ type: "thinking", thinking: "", streamKey: key }],
    });
  };
  // pi reports thinking and tool-argument progress twice over: an incremental
  // `delta` *and* the cumulative `partial` message. Only the delta is forwarded per
  // token - forwarding the cumulative body would re-serialise the whole block ~60x/s
  // - but that is no reason to throttle: a 120ms coalescer here is what turned
  // reasoning into "hang, then a chunk of text" and hid the tool-argument typewriter
  // completely. The cumulative snapshot goes out at the structural edges instead.
  const unsubscribeUi = activeRuntime.uiBridge?.subscribe(writeEvent);
  const unsubscribe = activeSession.subscribe((event) => {
    if (
      event.type === "agent_start" ||
      event.type === "agent_end" ||
      event.type === "auto_retry_start" ||
      event.type === "auto_retry_end" ||
      event.type === "compaction_start" ||
      event.type === "compaction_end" ||
      event.type === "message_end"
    ) {
      diagnosticLog("session.event", {
        requestId,
        eventType: event.type,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        success: event.success,
        finalError: event.finalError,
        reason: event.reason,
        willRetry: event.willRetry,
        aborted: event.aborted,
        ...sessionDetails(activeRuntime),
      });
    }

    if (event.type === "message_start") {
      const bubble = bubbleTracker.messageStarted(event.message.role);
      if (event.message.role === "user") {
        writeEvent({
          type: "user_message_start",
          bubbleId: bubble?.bubbleId,
          turn: bubble?.turn,
          content: messageDisplayText(event.message),
        });
      }

      if (event.message.role === "assistant") {
        assistantMessageStreamIndex += 1;
        writeEvent({
          type: "assistant_message_start",
          bubbleId: bubble?.bubbleId,
          turn: bubble?.turn,
        });
      }
    }

    if (event.type === "message_end") {
      // A message that ends with a thinking block still tracked as open means
      // the provider never reported the block end (openai-completions defers
      // every finishBlock to the message tail and skips them on abort). The
      // message is over, so the thinking is over - settle before anything else
      // (tool executions, the next message) can flow past the stale key.
      if (event.message.role === "assistant") {
        settleThinking();
      }
      if (event.message.role === "user") {
        // AgentSession persists the message immediately after notifying
        // subscribers, so defer the index refresh until that append completes.
        queueMicrotask(() => updateSessionStoreFromRuntime(activeRuntime));
      }
    }

    if (event.type === "message_end" || event.type === "compaction_end") {
      // pi's usage numbers can only change when a message lands in
      // `state.messages` - exactly here - so publish them at that granularity
      // instead of making the meter wait for the end-of-run snapshot. The
      // microtask is the same deferral as above: the cumulative totals are read
      // from the persisted entries, which AgentSession appends after it has
      // finished notifying subscribers.
      queueMicrotask(() => {
        writeEvent({ type: "context_usage", ...usageFields(activeSession) });
      });
    }

    if (event.type === "message_update") {
      const assistantEvent = event.assistantMessageEvent;

      if (assistantEvent.type === "text_delta") {
        // Answer text can only follow a finished thinking block in this message.
        settleThinking();
        writeEvent({ type: "delta", bubbleId: bubbleOf(), delta: assistantEvent.delta });
      }

      if (assistantEvent.type === "thinking_delta" && assistantEvent.delta) {
        // Track from the deltas rather than `thinking_start`: some providers name
        // the block only when its first token arrives. A different key here is the
        // next thinking round beginning, which ends the one before it.
        const thinkingKey = thinkingStreamKeyOf(assistantEvent.contentIndex);
        if (openThinkingKey && openThinkingKey !== thinkingKey) {
          settleThinking();
        }
        openThinkingKey = thinkingKey;
        writeEvent({
          type: "thinking_delta",
          bubbleId: bubbleOf(),
          contentIndex: assistantEvent.contentIndex,
          thinkingStreamKey: thinkingKey,
          delta: assistantEvent.delta,
        });
      }

      if (assistantEvent.type === "thinking_end" && assistantEvent.partial?.content) {
        // Publish the authoritative cumulative text once - when the block closes.
        // `partial` is a live object the provider keeps mutating, so a snapshot
        // taken at `thinking_start` carries text belonging to deltas that are still
        // on their way: seeding a block with it and then appending those same
        // chunks is the "reasoning repeats its first chunk" bug. Nothing is lost by
        // waiting - the panel opens on the first delta anyway.
        writeEvent({
          type: "assistant_partial",
          bubbleId: bubbleOf(),
          contentIndex: assistantEvent.contentIndex,
          closeThinking: true,
          blocks: assistantThinkingBlocks(assistantEvent.partial.content, thinkingStreamKeyOf),
        });
        if (openThinkingKey === thinkingStreamKeyOf(assistantEvent.contentIndex)) {
          openThinkingKey = null;
        }
      }

      if (assistantEvent.type === "toolcall_start") {
        // A tool call is the next content block: whatever was thinking is done.
        settleThinking();
        const toolCall = partialToolCall(assistantEvent);
        const streamId = toolStreamId(assistantMessageStreamIndex, assistantEvent.contentIndex);
        if (toolCall?.id) {
          toolStreamIdsByCallId.set(toolCall.id, streamId);
        }
        writeEvent({
          type: "tool_call_stream_start",
          bubbleId: bubbleOf(),
          toolStreamId: streamId,
          contentIndex: assistantEvent.contentIndex,
          toolCallId: toolCall?.id,
          toolName: toolCall?.name,
          args: toolCall?.arguments ?? {},
        });
      }

      if (assistantEvent.type === "toolcall_delta") {
        const toolCall = partialToolCall(assistantEvent);
        const streamId = toolStreamId(assistantMessageStreamIndex, assistantEvent.contentIndex);
        if (toolCall?.id) {
          toolStreamIdsByCallId.set(toolCall.id, streamId);
        }
        // `delta` is the raw JSON text still being produced, which is exactly what
        // the argument typewriter animates; `tool_call_stream_end` follows with the
        // parsed arguments.
        writeEvent({
          type: "tool_call_stream_delta",
          bubbleId: bubbleOf(),
          toolStreamId: streamId,
          contentIndex: assistantEvent.contentIndex,
          toolCallId: toolCall?.id,
          toolName: toolCall?.name,
          argsText: assistantEvent.delta ?? "",
        });
      }

      if (assistantEvent.type === "toolcall_end") {
        const streamId = toolStreamId(assistantMessageStreamIndex, assistantEvent.contentIndex);
        toolArgsById.set(assistantEvent.toolCall.id, assistantEvent.toolCall.arguments ?? {});
        toolStreamIdsByCallId.set(assistantEvent.toolCall.id, streamId);
        writeEvent({
          type: "tool_call_stream_end",
          bubbleId: bubbleOf(),
          toolStreamId: streamId,
          contentIndex: assistantEvent.contentIndex,
          toolCallId: assistantEvent.toolCall.id,
          toolName: assistantEvent.toolCall.name,
          args: assistantEvent.toolCall.arguments ?? {},
        });
      }
    }

    if (event.type === "tool_execution_start") {
      // Tool execution only ever happens between assistant messages, so an
      // open thinking key at this point is stale (a block the provider never
      // closed). Settle it - the client must not keep a panel spinning above a
      // tool card that is already producing output just because one settle
      // event was lost.
      settleThinking();
      if (event.args !== undefined) {
        toolArgsById.set(event.toolCallId, event.args);
      }
      writeEvent({
        type: "tool_execution_start",
        bubbleId: bubbleOf(),
        toolCallId: event.toolCallId,
        toolStreamId: toolStreamIdsByCallId.get(event.toolCallId),
        toolName: event.toolName,
        args: event.args ?? toolArgsById.get(event.toolCallId),
      });
    }

    if (event.type === "tool_execution_update") {
      settleThinking();
      if (event.args !== undefined) {
        toolArgsById.set(event.toolCallId, event.args);
      }
      writeEvent({
        type: "tool_execution_update",
        bubbleId: bubbleOf(),
        toolCallId: event.toolCallId,
        toolStreamId: toolStreamIdsByCallId.get(event.toolCallId),
        toolName: event.toolName,
        args: event.args ?? toolArgsById.get(event.toolCallId),
        partialResult: event.partialResult,
      });
    }

    if (event.type === "tool_execution_end") {
      settleThinking();
      writeEvent({
        type: "tool_execution_end",
        bubbleId: bubbleOf(),
        toolCallId: event.toolCallId,
        toolStreamId: toolStreamIdsByCallId.get(event.toolCallId),
        toolName: event.toolName,
        args: event.args ?? toolArgsById.get(event.toolCallId),
        result: event.result,
        isError: event.isError,
      });
    }

    if (event.type === "queue_update") {
      writeEvent({
        type: "queued",
        behavior: streamingBehavior,
        ...pendingQueues(activeSession, queueSeq(activeSession, event)),
      });
      return;
    }

    if (event.type === "compaction_start") {
      writeEvent({ type: "compaction_start", reason: event.reason });
    }

    if (event.type === "compaction_end") {
      // `aborted` is the user pressing stop (or an extension refusing), not a
      // fault; only a failure carries `errorMessage` and has to be surfaced.
      writeEvent({
        type: "compaction_end",
        reason: event.reason,
        aborted: event.aborted === true,
        errorMessage: typeof event.errorMessage === "string" ? event.errorMessage : undefined,
      });
    }

    if (event.type === "auto_retry_end" && event.success === false && event.finalError) {
      finalAgentError = formatAgentError(event.finalError);
    }

    if (event.type === "agent_end" && event.willRetry === false) {
      const assistantError = latestAssistantError(event.messages);
      if (assistantError) {
        finalAgentError = assistantError;
      }
    }

  });

  const onClientClose = () => {
    diagnosticLog("prompt.client_close", {
      requestId,
      wasStreaming,
      closed,
      ...sessionDetails(activeRuntime),
    });
    if (!wasStreaming && !closed && activeSession.isStreaming) {
      diagnosticLog("prompt.client_close_abort.start", { requestId, ...sessionDetails(activeRuntime) });
      void abortSession(activeSession, { requestId, reason: "prompt_client_close" })
        .catch(() => undefined);
    }
  };

  res.on("close", onClientClose);

  // 聊天输入永远是文本，不以 "/" 开头就例外。pi 的 prompt() 看到文本以 "/" 开头，会先把首个 token
  // 交给已注册的扩展命令执行（_tryExecuteExtensionCommand），于是打 "/run 命令行里的补全…" 时
  // pi-subagents 的 /run 被真的跑起来，报 "Unknown agent: 命令行里的补全…"。
  // 「这句是问题还是命令」文本本身分不出来，所以规则只能是：聊天框不派发命令。
  // 命令有自己的入口——斜杠菜单点选走 /api/capabilities/package/command（那里仍是
  // expandPromptTemplates: true），技能走徽标激活，都不经过这里。
  try {
    await activeSession.prompt(input, {
      images,
      streamingBehavior,
      expandPromptTemplates: false,
      preflightResult: () => undefined,
    });
    if (!closed) {
      if (wasStreaming) {
        writeEvent({ type: "queued", behavior: streamingBehavior, ...pendingQueues(activeSession) });
      } else {
        if (shouldTitleAfterFirstTurn) {
          await generateInitialSessionTitle(activeRuntime).catch((error) => {
            console.error(`Failed to generate initial session title: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        updateSessionStoreFromRuntime(activeRuntime);
        writeEvent({ type: "snapshot", snapshot: await buildSnapshot(activeRuntime) });
      }
      if (finalAgentError) {
        writeEvent({ type: "error", message: finalAgentError });
      }
      // `lifecycle` tells the client whether this stream merely acknowledged a
      // queue insert (the run keeps going) or actually ended the run.
      writeEvent({ type: "done", lifecycle: wasStreaming ? "queued" : "run" });
      closed = true;
      res.end();
    }
    diagnosticLog("prompt.success", {
      requestId,
      durationMs: Date.now() - promptStartedAt,
      wasStreaming,
      ...sessionDetails(activeRuntime),
    });
  } catch (error) {
    if (closed || res.destroyed) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    diagnosticLog("prompt.error", {
      requestId,
      wasStreaming,
      ...sessionDetails(activeRuntime),
      ...errorDetails(error),
    });
    if (!closed) {
      writeEvent({ type: "error", message });
      closed = true;
      res.end();
    }
  } finally {
    diagnosticLog("prompt.finally", { requestId, closed, ...sessionDetails(activeRuntime) });
    unsubscribe();
    unsubscribeUi?.();
    res.off("close", onClientClose);
  }
}

function persistPromptAttachments(activeRuntime, values) {
  const attachmentValues = Array.isArray(values) ? values : [];
  if (attachmentValues.length > maxAttachmentCount) {
    throw new Error(`A maximum of ${maxAttachmentCount} attachments is allowed.`);
  }

  const project = findProject(activeRuntime.projectId);
  const sessionHeader = activeRuntime.session.sessionManager.getHeader();
  const sessionId = String(sessionHeader?.id ?? basename(activeRuntime.session.sessionFile, extname(activeRuntime.session.sessionFile)));
  const attachmentDir = join(projectAttachmentRoot, project.id, sanitizePathPart(sessionId));
  let totalBytes = 0;

  return attachmentValues.map((attachment, index) => {
    const originalName = String(attachment?.name ?? `attachment-${index + 1}`).trim() || `attachment-${index + 1}`;
    const id = sanitizePathPart(String(attachment?.id ?? randomUUID())) || randomUUID();
    const sourcePath = typeof attachment?.sourcePath === "string" ? attachment.sourcePath : "";
    const resolvedSource = sourcePath ? resolve(sourcePath) : "";

    // 目录是一条「引用」，不是字节。客户端只把宿主解析到的绝对路径交过来（详见
    // src/shared/composerDrop.ts），这里既不复制也不当文件读：复制一个目录没有意义（模型
    // 要的是可以在原地 ls/grep 的那份），而且可能巨大。代价是这份路径是「活」的 —— 文件是
    // 快照，目录不是；回放旧消息时它可能已经不在，所以先校验再说清楚。
    if (String(attachment?.mimeType ?? "").trim().toLowerCase() === directoryMimeType) {
      if (!resolvedSource || !existsSync(resolvedSource) || !statSync(resolvedSource).isDirectory()) {
        throw new Error(`Folder "${originalName}" is no longer available at ${resolvedSource || "(no path)"}.`);
      }
      return {
        id,
        name: originalName,
        mimeType: directoryMimeType,
        size: 0,
        kind: "directory",
        path: resolvedSource,
        data: "",
      };
    }

    const reusablePath = resolvedSource.startsWith(`${resolve(projectAttachmentRoot)}/`)
      && existsSync(resolvedSource)
      && statSync(resolvedSource).isFile()
      ? resolvedSource
      : "";
    let data = String(attachment?.data ?? "");
    let buffer = Buffer.from(data, "base64");
    // 编辑一条带附件的消息时，客户端手里只有已落盘的 `sourcePath`（没有原始 File），
    // 直接复用磁盘上的那份，不要求它把字节重新读一遍再 base64 回来。
    if (!buffer.length && reusablePath) {
      buffer = readFileSync(reusablePath);
      data = buffer.toString("base64");
    }
    if (!buffer.length && Number(attachment?.size ?? 0) > 0) {
      throw new Error(`Attachment ${index + 1} could not be decoded.`);
    }
    if (buffer.length > maxAttachmentBytes) {
      throw new Error(`${String(attachment?.name ?? `Attachment ${index + 1}`)} exceeds 25 MB.`);
    }

    totalBytes += buffer.length;
    if (totalBytes > maxAttachmentTotalBytes) {
      throw new Error("Attachments exceed the 50 MB total limit.");
    }

    const fileName = `${id}-${sanitizeAttachmentName(originalName)}`;
    const path = reusablePath || join(attachmentDir, fileName);
    const mimeType = String(attachment?.mimeType ?? "application/octet-stream");

    if (!reusablePath) {
      mkdirSync(attachmentDir, { recursive: true });
      writeFileSync(path, buffer);
    }

    return {
      id,
      name: originalName,
      mimeType,
      size: buffer.length,
      kind: mimeType.startsWith("image/") ? "image" : "file",
      path,
      data,
    };
  });
}

async function normalizePromptMessageParts(activeRuntime, parts, displayInput, attachments) {
  const normalized = normalizeMessageParts(parts, displayInput, attachments);
  const requestedCapabilities = normalized
    .filter((part) => part.kind === "capability")
    .map((part) => part.capability);
  if (!requestedCapabilities.length) {
    return { parts: normalized, manualSkillPrefix: "" };
  }

  const context = await readRuntimeCapabilityContext(activeRuntime);
  const current = activeSessionCapabilitySelection(
    activeRuntime.session.sessionManager,
    context.allSkills,
    context.config,
    activeRuntime,
  );
  const requestedSkills = requestedCapabilities.filter((capability) => capability.kind === "skill");
  const selection = activeRuntime.session.isStreaming || !requestedSkills.length
    ? current
    : await updateRuntimeSessionCapabilities(activeRuntime, (currentSelection) => {
        const knownSkills = new Set(context.allSkills.map(skillCapabilityId));
        const enabledSkills = new Set(currentSelection.enabledSkills);
        const disabledSkills = new Set(currentSelection.disabledSkills);

        for (const capability of requestedSkills) {
          if (knownSkills.has(capability.id)) {
            enabledSkills.add(capability.id);
            disabledSkills.delete(capability.id);
          }
        }

        return {
          ...currentSelection,
          enabledSkills: [...enabledSkills],
          disabledSkills: [...disabledSkills],
        };
      });
  const activeSkills = new Set(selection.skills);
  const activeParts = normalized.map((part) => {
    if (part.kind !== "capability") {
      return part;
    }

    return {
      ...part,
      capability: {
        ...part.capability,
        active: activeSkills.has(part.capability.id),
      },
    };
  });
  return {
    parts: activeParts,
    manualSkillPrefix: manualSkillPrefixFor(context.allSkills, requestedSkills),
  };
}

  return { normalizePromptMessageParts, persistPromptAttachments, streamPrompt };
}
