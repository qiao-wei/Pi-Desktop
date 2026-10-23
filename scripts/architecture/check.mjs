#!/usr/bin/env node
/**
 * Architecture checker for Pi Desktop.
 *
 * One command, deterministic rules, no network. Two modes:
 *
 *   node scripts/architecture/check.mjs            verify (exit 1 on violations)
 *   node scripts/architecture/check.mjs --write    regenerate the frozen artefacts:
 *                                                  - architecture/generated/bridge-surface.json
 *                                                  - the generated regions in docs/architecture/*.md
 *                                                  - ratchet ceilings for oversized files
 *
 * The design goal is that **the documentation cannot drift from the code and neither can
 * silently lie to the other**: the layer table, the module table, the protocol table and the
 * debt register inside `docs/architecture/*.md` are generated from `architecture/policy.json`
 * and compared byte-for-byte on every run, while the policy is checked against the real import
 * graph, the real bridge routes and the real client call sites.
 *
 * Rules and why each exists:
 *
 *   layer-direction     a module may only import layers its layer allows (type-only imports
 *                       are exempt: erased at runtime, no init cycles, no hidden coupling).
 *   module-cycle        runtime cycle between files. Initialisation order bugs live here.
 *   unregistered-file   new source file outside every declared module. New code cannot dodge
 *                       the rules by landing in an unmanaged directory.
 *   bridge-closure      anything reachable at runtime from a bridge entry must be bridgeSafe.
 *                       `scripts/build-bridge-runtime.mjs` copies only `server/` and
 *                       `src/shared/`, so an i18n or adapter import reached from the bridge
 *                       works in dev and breaks in the packaged app.
 *   max-lines           per-glob line ceilings with a ratchet: an excepted file may shrink,
 *                       never grow. Debt is scheduled, not grandfathered forever.
 *   process-boundary    every process boundary names a tsconfig that really includes its files,
 *                       and every scanned source root is claimed by exactly one boundary. Adding a
 *                       new source tree without deciding who typechecks it fails here.
 *   node-typecheck      the non-renderer half (`server/`, `src-electron/`, `scripts/`) under
 *                       `checkJs`, with the diagnostic pile recorded per file+code as a ratchet.
 *                       Same policy as max-lines: it may only go down, and the end state is an
 *                       empty pile and a deleted baseline.
 *   protocol-version    the bridge's announced version equals the renderer's.
 *   protocol-surface    every client call site, every bridge route and the frozen surface
 *                       agree in both directions.
 *   shell-commands      preload whitelist == declared host commands == invoke() call sites.
 *   protocol-seam       every boundary in the seam registry is a real, tested swap point.
 *   no-bypass           globals/raw fetch/raw host invoke stay inside their seam (with reasons).
 *   docs-regions        generated doc regions match the policy.
 *   exceptions          expired or stale exceptions are violations of their own.
 *
 * Imported by `tests/architecture.test.ts`; the CLI is a thin wrapper over `runCheck`.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, externalSpecifiers, listSourceFiles, posix, relativeTo } from "./lib/graph.mjs";
import { renderDocRegions } from "./lib/render.mjs";
import { checkProcessBoundaries } from "./lib/boundaries.mjs";
import { PROTOCOL_SEAMS } from "../../src/shared/protocol/seams.ts";
import {
  NODE_TYPECHECK_BASELINE,
  NODE_TYPECHECK_CONFIG,
  collectNodeDiagnostics,
  compareToBaseline,
  readBaseline,
  writeBaseline,
} from "./lib/typecheck.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");

export function loadPolicy(root = REPO_ROOT) {
  return JSON.parse(readFileSync(join(root, "architecture", "policy.json"), "utf8"));
}

/** Minimal glob: `**` spans directories, `*` stays inside a segment.
 *
 *Minimal glob: `**` spans directories (including zero segments), `*` stays inside a segment. */
export function matchGlob(pattern, file) {
  return matchSegments(pattern.split("/"), file.split("/"));
}

/** One segment against one path segment: `*` matches inside the segment only. */
function globSegmentMatches(patternSegment, pathSegment) {
  if (!patternSegment.includes("*")) return patternSegment === pathSegment;
  const escaped = patternSegment
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(pathSegment);
}

function sizeLimit(policy, file) {
  let limit = 0;
  for (const rule of policy.sizeRules) {
    if (matchGlob(rule.match, file)) limit = rule.limit;
  }
  return limit;
}

function moduleForFile(policy, relativePath) {
  for (const module of policy.modules) {
    for (const root of module.roots) {
      const normalized = posix(root);
      if (relativePath === normalized) return module;
      if (relativePath.startsWith(`${normalized}/`)) {
        // `src/shared/protocol` is its own module; the longer root must win over `src/shared`.
        const longer = policy.modules.some(
          (other) =>
            other !== module &&
            other.roots.some(
              (otherRoot) =>
                posix(otherRoot).startsWith(`${normalized}/`) &&
                (relativePath === posix(otherRoot) || relativePath.startsWith(`${posix(otherRoot)}/`)),
            ),
        );
        if (longer) continue;
        return module;
      }
    }
  }
  return null;
}

function layerFor(policy, layerId) {
  return policy.layers.find((layer) => layer.id === layerId);
}

export function mayImport(policy, fromLayerId, toLayerId) {
  if (fromLayerId === toLayerId) return true;
  const from = layerFor(policy, fromLayerId);
  if (!from) return false;
  if (from.mayImport.includes("*")) return true;
  return from.mayImport.includes(toLayerId);
}

// ---------------------------------------------------------------------------------------
// sources of truth: bridge routes, client call sites, shell whitelist, protocol version
// ---------------------------------------------------------------------------------------

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

const CLIENT_CALL = /(fetchJson|postJson|streamNdjson|fetchBootstrap|fetchAmbientBootstrap|reportDiagnostic)\s*(?:<[^>\n]*>)?\s*\(\s*(`[^`]*`|"[^"]*")/g;
const API_LITERAL = /["'`](\/api\/[A-Za-z0-9/_:.-]*)/g;

/**
 * Comments are not call sites. Without this, a JSDoc line that mentions a path (or an example
 * in a comment) lands in the frozen surface and pins a route nobody calls.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[\t ]*\/\/.*$/gm, "")
    .replace(/^[\t ]*\*.*$/gm, "");
}

/** Every `/api/...` path a renderer file names, with the helper it is called through. */
export function extractClientPaths(files, root) {
  const paths = new Map();
  const record = (path, file, method) => {
    const normalized = path.replace(/\$\{[^}]*\}/g, ":param").replace(/\?.*$/, "").replace(/\/$/, "");
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

/**
 * Proper segment matching. A `**` segment consumes any number of segments, so a suffix pattern
 * only matches paths that end that way. Before this, a leading `**` short-circuited to `true`,
 * which made every route look implemented and silently emptied the `protocol-surface` rule.
 */
function matchSegments(patternSegments, pathSegments) {
  if (patternSegments.length === 0) return pathSegments.length === 0;
  const [head, ...rest] = patternSegments;
  if (head === "**") {
    for (let index = 0; index <= pathSegments.length; index += 1) {
      if (matchSegments(rest, pathSegments.slice(index))) return true;
    }
    return false;
  }
  if (pathSegments.length === 0) return false;
  if (head !== ":param" && !globSegmentMatches(head, pathSegments[0])) return false;
  return matchSegments(rest, pathSegments.slice(1));
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

// ---------------------------------------------------------------------------------------
// the check
// ---------------------------------------------------------------------------------------

function violation(rule, message, extra = {}) {
  return { rule, message, ...extra };
}

export function runCheck(root = REPO_ROOT, policy = loadPolicy(root)) {
  const violations = [];
  const seams = PROTOCOL_SEAMS;
  const scanFiles = policy.scanRoots.flatMap((scanRoot) => listSourceFiles(join(root, scanRoot)));
  const relativeFiles = scanFiles.map((file) => relativeTo(root, file));
  const moduleByFile = new Map();
  for (const file of relativeFiles) {
    moduleByFile.set(file, moduleForFile(policy, file));
  }

  // --- unregistered-file ---------------------------------------------------------------
  for (const [file, module] of moduleByFile) {
    if (!module) {
      violations.push(
        violation("unregistered-file", `${file} is outside every declared module`, { file }),
      );
    }
  }

  // --- graph + layer direction + cycles -------------------------------------------------
  const { edges } = buildGraph(root, scanFiles);
  const knownFiles = new Set(relativeFiles);
  const runtimeEdges = [];
  for (const edge of edges) {
    const from = relativeTo(root, edge.from);
    const to = relativeTo(root, edge.to);
    if (!knownFiles.has(to)) continue;
    if (edge.kind === "runtime") runtimeEdges.push({ from, to });
    const fromModule = moduleByFile.get(from);
    const toModule = moduleByFile.get(to);
    if (!fromModule || !toModule || edge.kind === "type") continue;
    if (!mayImport(policy, fromModule.layer, toModule.layer)) {
      violations.push(
        violation(
          "layer-direction",
          `${from} (${fromModule.layer}) imports ${to} (${toModule.layer}); ${fromModule.layer} may import [${layerFor(policy, fromModule.layer).mayImport.join(", ")}]`,
          { file: from, to, fromLayer: fromModule.layer, toLayer: toModule.layer },
        ),
      );
    }
  }

  const adjacency = new Map();
  for (const edge of runtimeEdges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    adjacency.get(edge.from).add(edge.to);
  }
  const state = new Map();
  const stack = [];
  const cycleKeys = new Set();
  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (state.get(next) === 1) {
        const start = stack.indexOf(next);
        const cycle = stack.slice(start).concat(next);
        const key = [...new Set(cycle)].sort().join(" -> ");
        if (!cycleKeys.has(key)) {
          cycleKeys.add(key);
          violations.push(
            violation("module-cycle", `runtime cycle: ${cycle.join(" -> ")}`, {
              files: [...new Set(cycle)].sort(),
              key,
            }),
          );
        }
      } else if (!state.get(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of adjacency.keys()) if (!state.get(node)) visit(node);

  // --- bridge-closure -------------------------------------------------------------------
  const bridgeSafe = new Set(
    policy.modules.filter((module) => module.bridgeSafe === true).map((module) => module.id),
  );
  const bridgeEntries = policy.modules
    .filter((module) => Array.isArray(module.entries))
    .flatMap((module) => module.entries)
    .filter((entry) => existsSync(join(root, entry)));
  if (bridgeEntries.length) {
    const entryFiles = bridgeEntries.map((entry) => join(root, entry));
    const closure = buildGraph(root, entryFiles);
    const seen = new Set();
    const queue = [...entryFiles];
    while (queue.length) {
      const file = queue.pop();
      const relative = relativeTo(root, file);
      if (seen.has(relative)) continue;
      seen.add(relative);
      for (const edge of closure.edges) {
        if (edge.from !== file) continue;
        if (!edge.to.startsWith(join(root, "src"))) continue;
        const target = relativeTo(root, edge.to);
        const module = moduleForFile(policy, target);
        if (module && !bridgeSafe.has(module.id)) {
          violations.push(
            violation(
              "bridge-closure",
              `${relative} reaches ${target} (module ${module.id}) at runtime, but ${module.id} is not copied into the bridge sidecar`,
              { file: relative, to: target, module: module.id },
            ),
          );
        }
        queue.push(edge.to);
      }
    }
  }

  // --- kernel-boundary ------------------------------------------------------------------
  // The bridge talks to the pi kernel through exactly one file. Everywhere else in server/ the
  // package name must not appear, so a kernel bump has a single place to break.
  const KERNEL_ADAPTER = "server/piKernel.mjs";
  for (const file of relativeFiles) {
    if (!file.startsWith("server/") || file === KERNEL_ADAPTER) continue;
    for (const specifier of externalSpecifiers(join(root, file))) {
      if (specifier.startsWith("@earendil-works/")) {
        violations.push(
          violation(
            "kernel-boundary",
            `${file} imports ${specifier} directly; route it through ${KERNEL_ADAPTER}`,
            { file },
          ),
        );
      }
    }
  }

  // --- protocol-seam --------------------------------------------------------------------
  // "We have a protocol" is only a fact if an implementation can be replaced without touching call
  // sites - which means a test that installs a fake through the same door production uses. This rule
  // refuses the weaker claim (declaring an interface, or naming a boundary in a document) by
  // requiring, for every seam in `src/shared/protocol/seams.ts`:
  //   - the contract / production / port module / swap test files exist;
  //   - `install` is an exported binding of the port module (the swap door is real);
  //   - the swap test actually calls `install(` (proving swappability, not just existence);
  //   - when production assembles it somewhere else, that assembly point calls `install(`;
  //   - the register and `policy.protocols` agree, so a boundary cannot exist in one list only.
  const seamIds = new Set(seams.map((seam) => seam.id));
  for (const seam of seams) {
    for (const [field, path] of [
      ["contract", seam.contract],
      ["production", seam.production],
      ["portModule", seam.portModule],
      ["assemblyPoint", seam.assemblyPoint],
      ["swapTest", seam.swapTest],
    ]) {
      if (!existsSync(join(root, path))) {
        violations.push(
          violation("protocol-seam", `seam ${seam.id}: ${field} ${path} does not exist`, { file: path }),
        );
      }
    }

    if (existsSync(join(root, seam.portModule))) {
      const portText = stripComments(readFileSync(join(root, seam.portModule), "utf8"));
      const defines =
        new RegExp(`export\\s+(?:async\\s+)?function\\s+${seam.install}\\b`).test(portText) ||
        new RegExp(`export\\s+const\\s+${seam.install}\\b`).test(portText);
      if (!defines) {
        violations.push(
          violation(
            "protocol-seam",
            `seam ${seam.id}: ${seam.portModule} does not export ${seam.install}(); there is no door to swap the implementation`,
            { file: seam.portModule },
          ),
        );
      }
    }

    if (existsSync(join(root, seam.swapTest))) {
      const testText = stripComments(readFileSync(join(root, seam.swapTest), "utf8"));
      const callsInstall = new RegExp(`(?<![\\w$])${seam.install}\\s*\\(`).test(testText);
      if (!callsInstall) {
        violations.push(
          violation(
            "protocol-seam",
            `seam ${seam.id}: ${seam.swapTest} never calls ${seam.install}() - swappability is unproven (declare the interface is not enough)`,
            { file: seam.swapTest },
          ),
        );
      }
    }

    if (
      seam.assemblyPoint !== seam.portModule &&
      existsSync(join(root, seam.assemblyPoint)) &&
      !new RegExp(`(?<![\\w$])${seam.install}\\s*\\(`).test(
        stripComments(readFileSync(join(root, seam.assemblyPoint), "utf8")),
      )
    ) {
      violations.push(
        violation(
          "protocol-seam",
          `seam ${seam.id}: ${seam.assemblyPoint} does not assemble it (never calls ${seam.install}())`,
          { file: seam.assemblyPoint },
        ),
      );
    }
  }

  const policyProtocolIds = new Set(
    policy.protocols.filter((protocol) => protocol.seam).map((protocol) => protocol.id),
  );
  for (const id of seamIds) {
    if (!policyProtocolIds.has(id)) {
      violations.push(
        violation("protocol-seam", `seam ${id} is not declared in architecture/policy.json protocols`),
      );
    }
  }
  for (const id of policyProtocolIds) {
    if (!seamIds.has(id)) {
      violations.push(
        violation(
          "protocol-seam",
          `protocol ${id} is declared in the policy but has no seam entry (no proof it can be swapped); add it to src/shared/protocol/seams.ts`,
        ),
      );
    }
  }

  // --- no-bypass ------------------------------------------------------------------------
  // A protocol is only worth having if nobody walks around it. Each guard in the policy names a call
  // shape (a global, a raw `fetch`, a raw host `invoke`) and the one file allowed to use it; comments
  // are stripped first, so prose about the old behaviour does not count as a bypass.
  for (const guard of policy.bypassGuards ?? []) {
    const allowed = new Set((guard.allowed ?? []).map((entry) => entry.file));
    const filesToScan = relativeFiles.filter((file) => {
      if (!(guard.scope ?? []).some((pattern) => matchGlob(pattern, file))) return false;
      return !allowed.has(file);
    });
    const shape = new RegExp(guard.regex, "g");
    for (const file of filesToScan) {
      const text = stripComments(readFileSync(join(root, file), "utf8"));
      const hits = [...text.matchAll(shape)];
      if (!hits.length) continue;
      const locations = hits
        .map((hit) => text.slice(0, hit.index).split("\n").length)
        .join(",");
      violations.push(
        violation(
          "no-bypass",
          `${file}:${locations} uses ${guard.id} outside its seam (${guard.why}); allowed only in ${[...allowed].join(", ")}`,
          { file },
        ),
      );
    }
  }

  // --- max-lines (ratchet) --------------------------------------------------------------
  const ceilings = new Map(
    policy.exceptions
      .filter((entry) => entry.rule === "max-lines")
      .map((entry) => [entry.file, entry]),
  );
  for (const file of relativeFiles) {
    const limit = sizeLimit(policy, file);
    if (!limit) continue;
    const lines = readFileSync(join(root, file), "utf8").split("\n").length;
    const exception = ceilings.get(file);
    if (lines <= limit) {
      if (exception) {
        violations.push(
          violation(
            "exceptions",
            `${file} is down to ${lines} lines (limit ${limit}); delete its max-lines exception`,
            { file },
          ),
        );
      }
      continue;
    }
    if (!exception) {
      violations.push(
        violation("max-lines", `${file} is ${lines} lines (limit ${limit})`, { file, lines, limit }),
      );
      continue;
    }
    if (lines > exception.ceiling) {
      violations.push(
        violation(
          "max-lines",
          `${file} grew to ${lines} lines; its ratchet ceiling is ${exception.ceiling} (limit ${limit}) - split it instead of raising the ceiling`,
          { file, lines, ceiling: exception.ceiling },
        ),
      );
    }
  }

  // --- protocol version -----------------------------------------------------------------
  const versionFile = join(root, "src/shared/protocol/version.ts");
  const mirrorFile = join(root, "server/protocolVersion.mjs");
  /** @type {{ declared: number | null, mirrored: number | null }} */
  let protocolVersion = { declared: null, mirrored: null };
  if (existsSync(versionFile) && existsSync(mirrorFile)) {
    protocolVersion = extractProtocolVersion(
      readFileSync(versionFile, "utf8"),
      readFileSync(mirrorFile, "utf8"),
    );
    if (protocolVersion.declared !== protocolVersion.mirrored) {
      violations.push(
        violation(
          "protocol-version",
          `renderer says v${protocolVersion.declared}, bridge says v${protocolVersion.mirrored}; bump both in the same change`,
          {},
        ),
      );
    }
  }

  // --- protocol surface -----------------------------------------------------------------
  const bridgeSource = readFileSync(join(root, "server/index.mjs"), "utf8");
  const bridgeRoutes = extractBridgeRoutes(bridgeSource);
  const rendererFiles = scanFiles.filter((file) => relativeTo(root, file).startsWith("src/"));
  const clientPaths = extractClientPaths(rendererFiles, root);
  const surfacePath = join(root, "architecture/generated/bridge-surface.json");
  const surface = existsSync(surfacePath)
    ? JSON.parse(readFileSync(surfacePath, "utf8"))
    : { routes: {} };
  const frozen = surface.routes ?? {};

  for (const [path, entry] of clientPaths) {
    if (!bridgeAnswers(bridgeRoutes, path) && !frozen[path]) {
      violations.push(
        violation("protocol-surface", `client calls ${path} but the bridge never answers it`, {
          file: [...entry.callers][0] ?? "src",
          path,
        }),
      );
    }
    if (!frozen[path]) {
      violations.push(
        violation(
          "protocol-surface",
          `${path} is called from ${[...entry.callers].join(", ")} but is not in architecture/generated/bridge-surface.json (run: npm run architecture:write)`,
          { path },
        ),
      );
    }
  }
  for (const path of bridgeRoutes.keys()) {
    if (path.includes("*")) continue;
    if (!frozen[path]) {
      violations.push(
        violation(
          "protocol-surface",
          `bridge route ${path} is not in architecture/generated/bridge-surface.json (run: npm run architecture:write)`,
          { path },
        ),
      );
    }
  }

  // --- protocol core ---------------------------------------------------------------------
  // The typed core in src/shared/protocol/bridgeEndpoints.ts is the part humans read. It must
  // not lie: every endpoint it documents has to be answered by the bridge, at the version it
  // claims to have arrived in.
  const coreSource = readFileSync(join(root, "src/shared/protocol/bridgeEndpoints.ts"), "utf8");
  for (const endpoint of extractDeclaredEndpoints(coreSource)) {
    const path = endpoint.path.replace(/\?.*$/, "");
    if (!bridgeAnswers(bridgeRoutes, path)) {
      violations.push(
        violation(
          "protocol-core",
          `${endpoint.id} documents ${endpoint.path} but the bridge does not answer it`,
          { path },
        ),
      );
    }
    if (endpoint.since > (protocolVersion.declared ?? 0)) {
      violations.push(
        violation(
          "protocol-core",
          `${endpoint.id} claims since v${endpoint.since} but the boundary is at v${protocolVersion.declared}`,
          { path },
        ),
      );
    }
  }

  // --- shell commands -------------------------------------------------------------------
  const preloadPath = join(root, "src-electron/preload.js");
  let preloadCommands = null;
  if (existsSync(preloadPath)) {
    preloadCommands = extractPreloadWhitelist(readFileSync(preloadPath, "utf8"));
  }
  const protocolModulePath = join(root, "src/shared/protocol/hostCommands.ts");
  let declaredCommands = [];
  if (existsSync(protocolModulePath)) {
    const declared = readFileSync(protocolModulePath, "utf8");
    const body = declared.match(/export const HOST_COMMANDS = \{([\s\S]*?)\n\} as const/);
    if (body) declaredCommands = [...body[1].matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map((m) => m[1]);
  }
  if (preloadCommands) {
    const declaredSet = new Set(declaredCommands);
    const preloadSet = new Set(preloadCommands);
    for (const command of preloadSet) {
      if (!declaredSet.has(command)) {
        violations.push(
          violation("shell-commands", `preload allows "${command}" but the protocol does not declare it`, {
            file: "src-electron/preload.js",
          }),
        );
      }
    }
    for (const command of declaredSet) {
      if (!preloadSet.has(command)) {
        violations.push(
          violation(
            "shell-commands",
            `protocol declares "${command}" but the Electron preload never allows it`,
            { file: "src-electron/preload.js" },
          ),
        );
      }
    }
    for (const site of extractInvokeSites(rendererFiles, root)) {
      if (!declaredSet.has(site.command)) {
        violations.push(
          violation("shell-commands", `${site.file} invokes "${site.command}" which is not declared`, {
            file: site.file,
          }),
        );
      }
    }
  }

  // --- exceptions health ----------------------------------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  for (const entry of policy.exceptions) {
    if (entry.deadline && entry.deadline < today) {
      violations.push(
        violation(
          "exceptions",
          `${entry.rule} exception for ${entry.file ?? entry.key ?? "?"} expired on ${entry.deadline}`,
          { file: entry.file },
        ),
      );
    }
    if (entry.rule === "cycle" && !cycleKeys.has(entry.key)) {
      violations.push(
        violation("exceptions", `cycle exception ${entry.key} no longer exists; delete it`, {}),
      );
    }
  }

  // --- process-boundary -----------------------------------------------------------------
  violations.push(
    ...checkProcessBoundaries(policy, { root, violation, matchGlob, listSourceFiles, relativeTo }),
  );

  // --- node-typecheck -------------------------------------------------------------------
  // The non-renderer half is checked by a separate tsconfig (not referenced by `tsc -b`, so the
  // build stays fast and green). Enabling `checkJs` over 18k untyped lines produces a pile, so the
  // rule is a ratchet: recorded per file+code, only ever shrinking, empty in the end state.
  const nodeDiagnostics = collectNodeDiagnostics(root);
  let nodeTypecheck = null;
  if (nodeDiagnostics === null) {
    violations.push(
      violation(
        "node-typecheck",
        `${NODE_TYPECHECK_CONFIG} is missing: server/, src-electron/ and scripts/ are untyped`,
        {},
      ),
    );
  } else {
    const compared = compareToBaseline(nodeDiagnostics, readBaseline(root), { violation });
    violations.push(...compared.violations);
    nodeTypecheck = compared.baseline;
  }

  // --- docs regions ---------------------------------------------------------------------
  const docRegions = renderDocRegions(policy, {
    protocolVersion,
    routeCount: bridgeRoutes.size,
    clientPathCount: clientPaths.size,
    frozenRouteCount: Object.keys(frozen).length,
  });
  for (const [docPath, regions] of Object.entries(docRegions)) {
    const absolute = join(root, docPath);
    if (!existsSync(absolute)) {
      violations.push(violation("docs-regions", `${docPath} is missing`, { file: docPath }));
      continue;
    }
    const text = readFileSync(absolute, "utf8");
    for (const [name, expected] of Object.entries(regions)) {
      const actual = readRegion(text, name);
      if (actual === null) {
        violations.push(
          violation("docs-regions", `${docPath} has no "${name}" region`, { file: docPath }),
        );
        continue;
      }
      if (actual.trim() !== expected.trim()) {
        violations.push(
          violation(
            "docs-regions",
            `${docPath} "${name}" region is out of date (run: npm run architecture:write)`,
            { file: docPath },
          ),
        );
      }
    }
  }

  return {
    violations,
    stats: {
      files: relativeFiles.length,
      edges: edges.length,
      runtimeEdges: runtimeEdges.length,
      modules: policy.modules.length,
      bridgeRoutes: bridgeRoutes.size,
      clientPaths: clientPaths.size,
      frozenRoutes: Object.keys(frozen).length,
      protocolVersion,
      nodeDiagnostics: nodeDiagnostics?.length ?? null,
      processBoundaries: (policy.processBoundaries ?? []).length,
      protocolSeams: seams.length,
      bypassGuards: (policy.bypassGuards ?? []).length,
      bypassAllowlist: (policy.bypassGuards ?? []).reduce(
        (total, guard) => total + (guard.allowed ?? []).length,
        0,
      ),
    },
    generated: {
      surface: buildSurface(bridgeRoutes, clientPaths, frozen),
      docRegions,
      nodeTypecheck,
    },
  };
}

export const REGION_OPEN = "<!-- architecture:begin ";
export const REGION_CLOSE = "<!-- architecture:end ";

export function readRegion(text, name) {
  const open = `${REGION_OPEN}${name} -->`;
  const close = `${REGION_CLOSE}${name} -->`;
  const start = text.indexOf(open);
  if (start === -1) return null;
  const end = text.indexOf(close, start);
  if (end === -1) return null;
  return text.slice(start + open.length, end);
}

export function writeRegion(text, name, body) {
  const open = `${REGION_OPEN}${name} -->`;
  const close = `${REGION_CLOSE}${name} -->`;
  const start = text.indexOf(open);
  if (start === -1) return null;
  const end = text.indexOf(close, start);
  const next = `${open}\n${body.trim()}\n${close}`;
  return text.slice(0, start) + next + text.slice(end + close.length);
}

function buildSurface(bridgeRoutes, clientPaths, previous) {
  const routes = {};
  const allPaths = new Set([...bridgeRoutes.keys(), ...clientPaths.keys()]);
  for (const path of allPaths) {
    if (path.includes("*") && !clientPaths.has(path)) continue;
    const callers = [...(clientPaths.get(path)?.callers ?? [])].sort();
    const methods = [...new Set([
      ...(clientPaths.get(path)?.methods ?? []),
      ...(bridgeRoutes.get(path) ?? []),
    ])].sort();
    const transport = /\/prompt$/.test(path) || /\/diagnostic$/.test(path) ? "ndjson" : "json";
    routes[path] = {
      methods,
      transport,
      bridge: [...bridgeRoutes.keys()].some((pattern) => structuralMatch(pattern, path)),
      callers,
    };
  }
  const sorted = {};
  for (const path of Object.keys(routes).sort()) sorted[path] = routes[path];
  void previous;
  return { version: 1, routes: sorted };
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------

function main(argv) {
  const write = argv.includes("--write");
  let result = runCheck(REPO_ROOT);

  if (write) {
    writeGenerated(result);
    // Re-check against what was just written, so `--write` reports the state a reader will get
    // (and catches a generator that disagrees with its own checker).
    result = runCheck(REPO_ROOT);
  }

  if (write) {
    console.log("architecture: wrote surface + doc regions + ratchet");
  }

  const byRule = new Map();
  for (const item of result.violations) {
    byRule.set(item.rule, (byRule.get(item.rule) ?? 0) + 1);
  }

  if (!result.violations.length) {
    console.log(
      `architecture: clean (${result.stats.files} files, ${result.stats.edges} imports, ` +
        `${result.stats.modules} modules, ${result.stats.frozenRoutes} protocol routes, ` +
        `boundary v${result.stats.protocolVersion.declared})`,
    );
    return 0;
  }

  for (const item of result.violations) {
    console.error(`[${item.rule}] ${item.message}`);
  }
  console.error(
    `\narchitecture: ${result.violations.length} violation(s) in ${byRule.size} rule(s): ` +
      [...byRule.entries()].map(([rule, count]) => `${rule}=${count}`).join(" "),
  );
  return 1;
}

export function writeGenerated(result, policy = loadPolicy(REPO_ROOT)) {
  const surfacePath = join(REPO_ROOT, "architecture/generated/bridge-surface.json");
  mkdirSync(dirname(surfacePath), { recursive: true });
  writeFileSync(surfacePath, `${JSON.stringify(result.generated.surface, null, 2)}\n`);

  // Ratchet record for the node-side typecheck pile. Deleted automatically once it empties, so
  // the end state (zero diagnostics, no baseline file) is reached without anyone remembering to
  // clean up - and `compareToBaseline` with no baseline demands zero.
  const baselinePath = join(REPO_ROOT, NODE_TYPECHECK_BASELINE);
  if (result.generated.nodeTypecheck) {
    if (result.generated.nodeTypecheck.total === 0) {
      if (existsSync(baselinePath)) rmSync(baselinePath);
    } else {
      writeBaseline(REPO_ROOT, result.generated.nodeTypecheck);
    }
  }

  // Ratchet: register files that are currently over their limit, and tighten ceilings that no
  // longer match reality. A ceiling is never raised - growth must be fixed, not recorded.
  const nextPolicy = applyRatchet(REPO_ROOT, policy);
  writeFileSync(
    join(REPO_ROOT, "architecture/policy.json"),
    `${JSON.stringify(nextPolicy, null, 2)}\n`,
  );

  for (const [docPath, regions] of Object.entries(result.generated.docRegions)) {
    const absolute = join(REPO_ROOT, docPath);
    if (!existsSync(absolute)) continue;
    let text = readFileSync(absolute, "utf8");
    for (const [name, body] of Object.entries(regions)) {
      const next = writeRegion(text, name, body);
      if (next) text = next;
    }
    writeFileSync(absolute, text);
  }
}

/**
 * Add missing max-lines exceptions (ceiling = current size, only ever tightened afterwards) and
 * drop exceptions whose file is now under the general limit. Everything else is left alone.
 */
export function applyRatchet(root, policy) {
  const kept = [];
  const byFile = new Map();
  for (const entry of policy.exceptions) {
    if (entry.rule === "max-lines") byFile.set(entry.file, entry);
    else kept.push(entry);
  }

  const files = policy.scanRoots
    .flatMap((scanRoot) => listSourceFiles(join(root, scanRoot)))
    .map((file) => relativeTo(root, file));

  const next = new Map(byFile);
  for (const file of files) {
    const limit = sizeLimit(policy, file);
    if (!limit) continue;
    const lines = readFileSync(join(root, file), "utf8").split("\n").length;
    const existing = next.get(file);
    if (lines <= limit) {
      next.delete(file);
      continue;
    }
    if (!existing) {
      next.set(file, {
        rule: "max-lines",
        file,
        ceiling: lines,
        owner: "@qiaowei",
        deadline: "2026-12-31",
        reason:
          "存量超大文件：先冻结增长（棘轮），拆分后 ceiling 自动收紧，拆到上限以下时此例外必须删除。",
      });
    } else if (lines < existing.ceiling) {
      next.set(file, { ...existing, ceiling: lines });
    }
  }

  return { ...policy, exceptions: [...kept, ...[...next.values()].sort((a, b) => a.file.localeCompare(b.file))] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}