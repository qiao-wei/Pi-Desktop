/**
 * 真源提取器：从**真实源码**里读出桥回答了哪些路由、客户端调了哪些路径、preload 白名单、
 * 协议版本号。它们被 `check.mjs` 的规则使用，也由 `tests/architecture.test.ts` 直接调用 ——
 * 所以做成独立模块（纯函数 + `root`/`files` 参数，不碰全局）。
 */
import { readFileSync } from "node:fs";
import { relativeTo } from "./graph.mjs";
import { matchSegments } from "./glob.mjs";

const METHOD_WINDOW = 160;

/** Every route the bridge answers, with the methods it answers on. */
export function extractBridgeRoutes(bridgeSource) {
  const routes = new Map();
  const add = (path, method) => {
    if (!routes.has(path)) routes.set(path, new Set());
    if (method) routes.get(path).add(method);
  };

  const exact = [
    new RegExp(
      `req\\.method\\s*===\\s*"([A-Z]+)"[\\s\\S]{0,${METHOD_WINDOW}}?url\\.pathname\\s*===\\s*"([^"]+)"`,
      "g",
    ),
    new RegExp(
      `url\\.pathname\\s*===\\s*"([^"]+)"[\\s\\S]{0,${METHOD_WINDOW}}?req\\.method\\s*===\\s*"([A-Z]+)"`,
      "g",
    ),
  ];
  for (const [index, regex] of exact.entries()) {
    for (const match of bridgeSource.matchAll(regex)) {
      if (index === 0) add(match[2], match[1]);
      else add(match[1], match[2]);
    }
  }
  for (const match of bridgeSource.matchAll(/url\.pathname\.startsWith\("([^"]+)"\)/g)) {
    add(`${match[1].replace(/\/$/, "")}/**`, null);
  }
  for (const match of bridgeSource.matchAll(/url\.pathname\.endsWith\("([^"]+)"\)/g)) {
    add(`**/${match[1].replace(/^\//, "")}`, null);
  }
  return routes;
}

const CLIENT_CALL =
  /(fetchJson|postJson|streamNdjson|fetchBootstrap|fetchAmbientBootstrap|reportDiagnostic)\s*(?:<[^>\n]*>)?\s*\(\s*(`[^`]*`|"[^"]*")/g;
const API_LITERAL = /["'`](\/api\/[A-Za-z0-9/_:.-]*)/g;

/**
 * Comments are not call sites. Without this, a JSDoc line that mentions a path (or an example
 * in a comment) lands in the frozen surface and pins a route nobody calls.
 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[\t ]*\/\/.*$/gm, "")
    .replace(/^[\t ]*\*.*$/gm, "");
}

/** Every `/api/...` path a renderer file names, with the helper it is called through. */
export function extractClientPaths(files, root) {
  const paths = new Map();
  const record = (path, file, method) => {
    const normalized = path
      .replace(/\$\{[^}]*\}/g, ":param")
      .replace(/\?.*$/, "")
      .replace(/\/$/, "");
    if (!normalized.startsWith("/api/")) return;
    if (normalized.includes("...")) return;
    if (!paths.has(normalized)) paths.set(normalized, { methods: new Set(), callers: new Set() });
    const entry = paths.get(normalized);
    if (method) entry.methods.add(method);
    entry.callers.add(relativeTo(root, file));
  };

  for (const file of files) {
    const relative = relativeTo(root, file);
    const text = stripComments(readFileSync(file, "utf8"));
    for (const match of text.matchAll(CLIENT_CALL)) {
      const helper = match[1];
      const raw = match[2].slice(1, -1);
      const method =
        helper === "fetchJson" || helper === "fetchBootstrap" || helper === "fetchAmbientBootstrap"
          ? "GET"
          : "POST";
      record(raw, file, method);
    }
    // The protocol module *declares* paths; it does not call them, so it is not a call site.
    if (relative.startsWith("src/shared/protocol/")) continue;
    for (const match of text.matchAll(API_LITERAL)) {
      record(match[1], file, null);
    }
  }
  return paths;
}

/** Declared core endpoints, read out of the protocol module (rule `protocol-core`). */
export function extractDeclaredEndpoints(protocolSource) {
  const body = protocolSource.match(/export const BRIDGE_ENDPOINTS = \{([\s\S]*?)\n\} as const/);
  if (!body) return [];
  return [...body[1].matchAll(/^\s{2}([A-Za-z]+):\s*\{([\s\S]*?)^\s{2}\},/gm)].map((match) => ({
    id: match[1],
    path: (match[2].match(/path:\s*"([^"]+)"/) ?? [])[1] ?? "",
    method: (match[2].match(/method:\s*"([A-Z]+)"/) ?? [])[1] ?? "",
    since: Number((match[2].match(/since:\s*(\d+)/) ?? [])[1] ?? 0),
  }));
}

export function structuralMatch(pattern, path) {
  return matchSegments(
    pattern.split("/").filter(Boolean),
    path.replace(/\?.*$/, "").split("/").filter(Boolean),
  );
}

/** Does the bridge answer this client path at all? */
export function bridgeAnswers(routes, path) {
  for (const [pattern] of routes) {
    if (structuralMatch(pattern, path)) return true;
  }
  return false;
}

export function extractPreloadWhitelist(preloadSource) {
  const match = preloadSource.match(/const HOST_COMMANDS = new Set\(\[([\s\S]*?)\]\)/);
  if (!match) return null;
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

export function extractInvokeSites(files, root) {
  const sites = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\binvoke(?:Host)?\(\s*"([^"]+)"/g)) {
      sites.push({ command: match[1], file: relativeTo(root, file) });
    }
  }
  return sites;
}

export function extractProtocolVersion(versionSource, mirrorSource) {
  const declared = versionSource.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
  const mirrored = mirrorSource.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
  return {
    declared: declared ? Number(declared[1]) : null,
    mirrored: mirrored ? Number(mirrored[1]) : null,
  };
}
