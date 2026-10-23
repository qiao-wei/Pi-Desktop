/**
 * 能力（MCP / 包 / 扩展）元数据的纯函数.
 *
 * 能力 id 解析、元数据归一、包条目匹配与展示文案。
 *
 * 从 `server/index.mjs` 搬出来的纯函数（只依赖 import 进来的东西，不碰模块状态）——
 * 那个文件曾经 8.7k 行、棘轮不许它再长，所以按「一簇一文件」往外搬。
 */
import { emptyPackageResources } from "./capabilityPackageResources.mjs";
import { canonicalPath } from "./capabilityPathIdentity.mjs";
import { normalizeMcpServerName } from "./mcpConfig.mjs";
import { parseMcpImportText } from "./mcpImport.mjs";
import { DefaultPackageManager } from "./piKernel.mjs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function normalizeMcpCapabilityMetadataMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const result = {};
  for (const [id, entry] of Object.entries(value)) {
    const normalizedId = String(id).trim();
    if (!normalizedId) {
      continue;
    }
    const source = entry && typeof entry === "object" ? entry : {};
    result[normalizedId] = {
      defaultEnabled: source.defaultEnabled !== false,
      pinned: Boolean(source.pinned),
      description: typeof source.description === "string" ? source.description : "",
    };
  }
  return result;
}

function normalizeCapabilityMetadataMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const result = {};
  for (const [id, entry] of Object.entries(value)) {
    const normalizedId = String(id).trim();
    if (!normalizedId) {
      continue;
    }
    const source = entry && typeof entry === "object" ? entry : {};
    result[normalizedId] = {
      defaultEnabled: source.defaultEnabled !== false,
      pinned: Boolean(source.pinned),
    };
  }
  return result;
}

function parseMcpImportRequest(body) {
  const parsed = parseMcpImportText(body?.text, { defaultName: body?.defaultName });
  if (!parsed.ok) {
    throw new Error(parsed.errors[0] ?? "Failed to parse the MCP config.");
  }
  return {
    import: {
      format: parsed.format,
      servers: parsed.servers.map((item) => ({ ...item.server, extras: item.extras, warnings: item.warnings })),
      errors: parsed.errors,
      warnings: parsed.warnings,
    },
  };
}

function parseMcpCapabilityId(value) {
  const raw = String(value ?? "").trim();
  const separator = raw.indexOf(":");
  if (separator === -1) {
    return null;
  }
  const scope = raw.slice(0, separator) === "project" ? "project" : "user";
  const name = normalizeMcpServerName(raw.slice(separator + 1));
  return name ? { scope, name } : null;
}

function splitArgs(value) {
  if (Array.isArray(value)) {
    return value.map((arg) => String(arg));
  }
  const raw = String(value ?? "").trim();
  if (!raw) {
    return [];
  }
  return raw.split(/\s+/g).filter(Boolean);
}

function normalizeStringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, nextValue]) => [String(key).trim(), String(nextValue ?? "")])
      .filter(([key]) => Boolean(key)),
  );
}

function collectExtensionEntries(root) {
  if (!existsSync(root)) return [];
  const entries = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && /\.(ts|js)$/.test(entry.name)) {
      entries.push(path);
    } else if (entry.isDirectory()) {
      const index = ["index.ts", "index.js"].find((name) => existsSync(join(path, name)));
      if (index) entries.push(join(path, index));
      else entries.push(...collectExtensionEntries(path));
    }
  }
  return entries;
}

function commandMatchesPackage(command, pkg, extensionPaths) {
  const sourceInfo = command.sourceInfo;
  if (!sourceInfo) {
    return false;
  }

  if (sourceInfo.origin === "package" && sourceInfo.source === pkg.source) {
    return true;
  }

  return extensionPaths.has(canonicalPath(sourceInfo.path));
}

function setPackageAutoload(settingsManager, pkg, enabled) {
  const scope = pkg.scope === "project" ? "project" : "user";
  const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
  const packages = [...(settings.packages ?? [])];
  const index = packages.findIndex((candidate) =>
    (typeof candidate === "string" ? candidate : candidate.source) === pkg.source,
  );
  if (index < 0) {
    throw new Error("Package source is not configured.");
  }

  const current = packages[index];
  if (enabled) {
    packages[index] = typeof current === "string"
      ? current
      : (() => {
          const next = { ...current };
          delete next.autoload;
          return next;
        })();
  } else {
    packages[index] = {
      ...(typeof current === "string" ? { source: current } : current),
      autoload: false,
    };
  }

  if (scope === "project") {
    settingsManager.setProjectPackages(packages);
  } else {
    settingsManager.setPackages(packages);
  }
}

/**
 * @param {{ project: any, settingsManager: any, agentDir: string, pkg: any }} options
 */
async function resolvePackageResources({ project, settingsManager, agentDir, pkg }) {
  if (!pkg.installedPath) {
    return emptyPackageResources();
  }
  const packageManager = new DefaultPackageManager({ cwd: project.cwd, agentDir, settingsManager });
  return packageManager.resolveExtensionSources([pkg.installedPath], {
    local: pkg.scope === "project",
    temporary: true,
  });
}

function packageDisplayName(pkg) {
  if (!pkg.installedPath) return pkg.source;
  try {
    const manifest = JSON.parse(readFileSync(join(pkg.installedPath, "package.json"), "utf8"));
    return String(manifest.name ?? pkg.source);
  } catch {
    return pkg.source;
  }
}

function packageDescription(pkg) {
  if (!pkg.installedPath) return pkg.source;
  try {
    const manifest = JSON.parse(readFileSync(join(pkg.installedPath, "package.json"), "utf8"));
    return String(manifest.description ?? pkg.source);
  } catch {
    return pkg.source;
  }
}

export { normalizeMcpCapabilityMetadataMap, normalizeCapabilityMetadataMap, parseMcpImportRequest, parseMcpCapabilityId, splitArgs, normalizeStringMap, collectExtensionEntries, commandMatchesPackage, setPackageAutoload, resolvePackageResources, packageDisplayName, packageDescription };
