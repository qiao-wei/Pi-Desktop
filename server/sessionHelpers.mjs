/**
 * 会话标题、回退命令与项目 id 的纯函数.
 *
 * 标题生成判定与归一、回退到某一轮、命令工作目录解析。
 *
 * 从 `server/index.mjs` 搬出来的纯函数（只依赖 import 进来的东西，不碰模块状态）——
 * 那个文件曾经 8.7k 行、棘轮不许它再长，所以按「一簇一文件」往外搬。
 */
import { messageToText } from "../src/shared/chatBubbles.ts";
import { userMessageEntryIdForTurn } from "../src/shared/sessionBranch.ts";
import { deriveSessionTitle } from "../src/shared/sessionTitle.ts";
import { isPathInside } from "./capabilityPathIdentity.mjs";
import { displayTranscript } from "./sessionTranscript.mjs";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function inferConversationTitle(messages) {
  const first = messages[0];
  if (!first) {
    return "New session";
  }

  const snippet = deriveSessionTitle({ text: messageToText(first) });
  return snippet || "New session";
}

function shouldGenerateInitialTitle(targetRuntime) {
  if (targetRuntime.session.sessionManager.getSessionName()) {
    return false;
  }

  const userMessageCount = displayTranscript(targetRuntime.session).filter((message) => message.role === "user").length;
  return userMessageCount === 0;
}

function normalizeGeneratedTitle(input) {
  // The prompt already bounds the length; whatever the model returns is kept as
  // written apart from whitespace and label/quote noise. Truncating here would
  // saw words in half (that is how "worktree多任" happened), so there is
  // deliberately no length cut on this path.
  const title = String(input ?? "")
    .replace(/^["'“”‘’「」『』《》【】\s]+|["'“”‘’「」『』《》【】\s.。!！?？:：,，;；]+$/gu, "")
    .replace(/^(?:标题|短标题)\s*[:：]\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return title;
}

function assistantContentText(message) {
  if (!Array.isArray(message?.content)) {
    return "";
  }

  return message.content
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n")
    .trim();
}

async function rewindSessionToTurn(session, turn) {
  if (session.isStreaming) {
    throw new Error("Wait for the current response to finish before editing.");
  }

  const manager = session.sessionManager;
  const entries = typeof manager?.getBranch === "function"
    ? manager.getBranch() ?? []
    : manager?.getEntries?.() ?? [];

  const targetEntryId = userMessageEntryIdForTurn(entries, turn);
  if (!targetEntryId) {
    throw new Error(`Message t${turn}#user is not in the current branch.`);
  }

  const result = await session.navigateTree(targetEntryId, { summarize: false });
  if (result?.cancelled) {
    throw new Error("Editing was cancelled.");
  }
}

function persistSessionShell(sessionManager) {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile || existsSync(sessionFile)) {
    return;
  }

  const entries = [sessionManager.getHeader(), ...sessionManager.getEntries()].filter(Boolean);
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  sessionManager.flushed = true;
}

function createProjectId(seed) {
  const prefix = String(seed ?? "project")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "project";
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function resolveCommandCwd(baseCwd, relativeCwd) {
  const relative = String(relativeCwd ?? "").trim();
  if (!relative) {
    return baseCwd;
  }
  const resolved = resolve(baseCwd, relative);
  if (!isPathInside(baseCwd, resolved)) {
    throw new Error(`命令目录超出项目范围：${relative}`);
  }
  return resolved;
}

export { inferConversationTitle, shouldGenerateInitialTitle, normalizeGeneratedTitle, assistantContentText, rewindSessionToTurn, persistSessionShell, createProjectId, resolveCommandCwd };
