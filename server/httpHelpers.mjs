/**
 * 桥的 HTTP 读写小工具.
 *
 * bootstrap 回写、NDJSON 分帧、请求体读取与超时包装。
 *
 * 从 `server/index.mjs` 搬出来的纯函数（只依赖 import 进来的东西，不碰模块状态）——
 * 那个文件曾经 8.7k 行、棘轮不许它再长，所以按「一簇一文件」往外搬。
 */
import { assertBridgePayload } from "../src/shared/protocol/bridgeMessages.ts";
import { corsHeaders } from "./cors.mjs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";


function sendBootstrapJson(res, req, snapshot) {
  // 边界 `bridge` 报文自检：按协议字段集检查快照，少了必填字段就在日志里点名。
  assertBridgePayload(snapshot, "bootstrap");
  const body = JSON.stringify(snapshot);
  // Change detection only - no adversary can choose the input - so md5 is the cheap
  // and sufficient choice, and it stays cheap on a ~1 MB body.
  const etag = `"${createHash("md5").update(body).digest("hex")}"`;
  const headers = {
    ETag: etag,
    // `no-cache` (not `no-store`): the client may keep the last body and must be able
    // to ask whether it is still current.
    "Cache-Control": "no-cache",
    // The app runs on another origin, so `fetch` can only read ETag when it is exposed.
    "Access-Control-Expose-Headers": "ETag",
    ...corsHeaders(),
  };

  if (String(req.headers["if-none-match"] ?? "").trim() === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(body);
}

function sendNdjson(res, events) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...corsHeaders(),
  });
  for (const event of events) {
    res.write(`${JSON.stringify(event)}\n`);
  }
  res.end();
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function readJsonFile(path) {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export { sendBootstrapJson, sendNdjson, readJson, readJsonFile, withTimeout };
