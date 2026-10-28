import { assistantThinkingBlocks, countTranscriptTurns, createBubbleTracker, messageDisplayText } from "../src/shared/chatBubbles.ts";
import { domainErrorFrame } from "../src/shared/protocol/bridgeStreamFrames.ts";
import { budgetArgsDelta, budgetToolArgs } from "../src/shared/toolPayloadBudget.ts";
import { appendAttachmentContext, sanitizeAttachmentName } from "./attachmentHelpers.mjs";
import { normalizeMessageParts } from "./conversationParts.mjs";
import { corsHeaders } from "./cors.mjs";
import { sessionDetails } from "./diagnosticsHelpers.mjs";
import { readJson } from "./httpHelpers.mjs";
import { usageFields } from "./modelHelpers.mjs";
import { DELIVERY_POLICY } from "./protocolVersion.mjs";
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

async function streamPrompt(req, res, requestId, options = {}) {
  const promptStartedAt = Date.now();
  const body = options.body ?? await readJson(req);
  const rawInput = String(body?.input ?? "");
  const displayInput = String(body?.displayInput ?? rawInput);
  const streamingBehavior = body?.streamingBehavior === "followUp" ? "followUp" : "steer";
  const activeRuntime = deps.getRuntimeForRequest(body);
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
  if (!deps.isUsableModel(activeRuntime.session.model)) {
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
  // 已经转发了多少字节的**参数文本**（打字机动画）。一份 4 MB 的正文会产生 4 MB 的
  // 客户端状态，而超过这个量之后动画本身已经没有信息量：停发，让 `tool_call_stream_end`
  // （带裁剪后的参数）收尾。
  const streamedArgsBytes = new Map();
  // Identity of a thinking block across the delta stream and the cumulative
  // snapshots. Keyed by pi's own content index (not the ordinal among thinking
  // blocks) so it lines up with `contentIndex` on `thinking_delta`, even when the
  // message interleaves text and tool calls around the thinking.
  const thinkingStreamKeyOf = (contentIndex) =>
    `assistant-${assistantMessageStreamIndex}-thinking-${contentIndex}`;
  // 帧的归属（runId）、序号、背压、待发上限和收尾都在 run 的帧日志里
  // （见 server/runStreams.mjs / server/frameWriter.mjs）。`writeEvent` 不 await：
  // 顺序由队列保证，背压只影响它什么时候真的发出去。
  //
  // `runId` 是这一次**流**的身份，不是请求身份：pi 的一次运行可以被多个请求看见（插话那轮只有
  // 确认帧，真正的帧来自启动它的那个请求），而"我要续订哪条流"问的是后者。它是一个随机值，
  // 因为它要跨进程边界被客户端回传，语义上不该能猜。
  //
  // 提交的这个 response **就是第一个订阅者**（也是这条 run 的 owner：它断开即中止这一轮）。
  // 后来者走 `POST /api/runs/stream`，从同一份日志补齐——所以"提交"与"订阅"是两件事。
  const runId = randomUUID();
  const run = state.runStreams.open({ runId, sessionPath: activeSession.sessionFile });
  run.attach(res, run.plan(1));
  const writeEvent = (payload) => run.publish(payload);
  // 回退后先播一次权威快照：旧轮次从 UI 消失、剩下来的轮次编号与新 stream 一致，
  // 否则新 prompt 的 `t{turn}#...` 事件会和客户端里还没清掉的旧轮次撞号。
  if (options.rewindTurn != null) {
    // `assumeStreaming`: this snapshot is emitted before `prompt()` starts the run,
    // but the client is already showing it as streaming - without the flag the
    // snapshot would tell the client the run is over and kill the stop button.
    writeEvent({ type: "snapshot", snapshot: await deps.buildSnapshot(activeRuntime, { assumeStreaming: true }) });
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
        queueMicrotask(() => deps.updateSessionStoreFromRuntime(activeRuntime));
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
          // 整份文件正文就在里面：上线前裁（`__omitted` 记下原始行数/字节）。
          args: budgetToolArgs(toolCall?.arguments ?? {}),
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
        const forwarded = streamedArgsBytes.get(streamId) ?? 0;
        const argsDelta = budgetArgsDelta(forwarded, assistantEvent.delta ?? "");
        if (argsDelta.text !== "") {
          streamedArgsBytes.set(streamId, argsDelta.forwardedBytes);
          writeEvent({
            type: "tool_call_stream_delta",
            bubbleId: bubbleOf(),
            toolStreamId: streamId,
            contentIndex: assistantEvent.contentIndex,
            toolCallId: toolCall?.id,
            toolName: toolCall?.name,
            argsText: argsDelta.text,
          });
        }
      }

      if (assistantEvent.type === "toolcall_end") {
        const streamId = toolStreamId(assistantMessageStreamIndex, assistantEvent.contentIndex);
        streamedArgsBytes.delete(streamId);
        toolArgsById.set(assistantEvent.toolCall.id, assistantEvent.toolCall.arguments ?? {});
        toolStreamIdsByCallId.set(assistantEvent.toolCall.id, streamId);
        writeEvent({
          type: "tool_call_stream_end",
          bubbleId: bubbleOf(),
          toolStreamId: streamId,
          contentIndex: assistantEvent.contentIndex,
          toolCallId: assistantEvent.toolCall.id,
          toolName: assistantEvent.toolCall.name,
          args: budgetToolArgs(assistantEvent.toolCall.arguments ?? {}),
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
        args: budgetToolArgs(event.args ?? toolArgsById.get(event.toolCallId)),
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
        args: budgetToolArgs(event.args ?? toolArgsById.get(event.toolCallId)),
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
        args: budgetToolArgs(event.args ?? toolArgsById.get(event.toolCallId)),
        result: event.result,
        isError: event.isError,
      });
    }

    if (event.type === "queue_update") {
      writeEvent({
        type: "queued",
        behavior: streamingBehavior,
        ...deps.pendingQueues(activeSession, deps.queueSeq(activeSession, event)),
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
      const assistantError = deps.latestAssistantError(event.messages);
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
    // 断开策略是**档位上声明的值**（见 server/protocolVersion.mjs 的 DELIVERY_POLICY），
    // 不是这里临时判的条件：`local-live` = 启动这一轮的请求断开即中止该轮；
    // 将来的 `replayable` = 保持运行、为后来者保留事件（那时这里不需要再改条件）。
    //
    // `!wasStreaming` 那道门**不是**这条策略的一部分，而是"谁有权中止这一轮"的界定：
    // 只有*启动*这一轮的请求断开才中止；后到的订阅者断开不动别人的 run。
    if (DELIVERY_POLICY.onOwnerDisconnect === "abort-run" && !wasStreaming && !closed && activeSession.isStreaming) {
      diagnosticLog("prompt.client_close_abort.start", { requestId, ...sessionDetails(activeRuntime) });
      void deps.abortSession(activeSession, { requestId, reason: "prompt_client_close" })
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
        writeEvent({ type: "queued", behavior: streamingBehavior, ...deps.pendingQueues(activeSession) });
      } else {
        if (shouldTitleAfterFirstTurn) {
          await deps.generateInitialSessionTitle(activeRuntime).catch((error) => {
            console.error(`Failed to generate initial session title: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        deps.updateSessionStoreFromRuntime(activeRuntime);
        writeEvent({ type: "snapshot", snapshot: await deps.buildSnapshot(activeRuntime) });
      }
      if (finalAgentError) {
        writeEvent(domainErrorFrame(finalAgentError));
      }
      // `lifecycle` tells the client whether this stream merely acknowledged a
      // queue insert (the run keeps going) or actually ended the run.
      writeEvent({ type: "done", lifecycle: wasStreaming ? "queued" : "run" });
      closed = true;
      // 收尾这条 run 的**每一个** sink（自己的队列排空 + end，含后来接上的订阅者）：
      // 背压期间 `done` 可能还在队列里，直接 end 会把尾帧切掉。
      await run.close();
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
      writeEvent(domainErrorFrame(message));
      closed = true;
      await run.close();
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

  const project = deps.findProject(activeRuntime.projectId);
  const sessionHeader = activeRuntime.session.sessionManager.getHeader();
  const sessionId = String(sessionHeader?.id ?? basename(activeRuntime.session.sessionFile, extname(activeRuntime.session.sessionFile)));
  const attachmentDir = join(projectAttachmentRoot, project.id, deps.sanitizePathPart(sessionId));
  let totalBytes = 0;

  return attachmentValues.map((attachment, index) => {
    const originalName = String(attachment?.name ?? `attachment-${index + 1}`).trim() || `attachment-${index + 1}`;
    const id = deps.sanitizePathPart(String(attachment?.id ?? randomUUID())) || randomUUID();
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

  const context = await deps.readRuntimeCapabilityContext(activeRuntime);
  const current = deps.activeSessionCapabilitySelection(
    activeRuntime.session.sessionManager,
    context.allSkills,
    context.config,
    activeRuntime,
  );
  const requestedSkills = requestedCapabilities.filter((capability) => capability.kind === "skill");
  const selection = activeRuntime.session.isStreaming || !requestedSkills.length
    ? current
    : await deps.updateRuntimeSessionCapabilities(activeRuntime, (currentSelection) => {
        const knownSkills = new Set(context.allSkills.map(deps.skillCapabilityId));
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
    manualSkillPrefix: deps.manualSkillPrefixFor(context.allSkills, requestedSkills),
  };
}

  return { normalizePromptMessageParts, persistPromptAttachments, streamPrompt };
}
