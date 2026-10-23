/**
 * 技能目录/版本相关的纯函数.
 *
 * 技能名归一、相对路径校验、写入前断言，以及版本元数据与目录等价判断。
 *
 * 从 `server/index.mjs` 搬出来的纯函数（只依赖 import 进来的东西，不碰模块状态）——
 * 那个文件曾经 8.7k 行、棘轮不许它再长，所以按「一簇一文件」往外搬。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

function normalizeSkillRelativePath(value) {
  const path = String(value ?? "").trim().replace(/^@+/, "");
  if (!path) {
    throw new Error("relativePath is required.");
  }

  const normalized = path.replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("relativePath is invalid.");
  }

  if (normalized.split(/[\\/]+/).includes("..")) {
    throw new Error("relativePath cannot traverse outside the skill directory.");
  }

  return normalized;
}

function normalizeSkillFolderName(value, fallback) {
  const name = String(value ?? fallback ?? "").trim();
  if (!name) {
    throw new Error("Skill destination name is required.");
  }

  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw new Error("Skill destination name may only contain letters, numbers, dots, underscores, and hyphens.");
  }

  return name;
}

function assertSkillDirectory(path) {
  if (!existsSync(path)) {
    throw new Error(`Skill source does not exist: ${path}`);
  }

  const stats = statSync(path);
  if (!stats.isDirectory()) {
    throw new Error(`Skill source must be a directory: ${path}`);
  }

  if (!existsSync(join(path, "SKILL.md"))) {
    throw new Error(`Skill source must contain SKILL.md: ${path}`);
  }
}

function resolveToolPath(input, cwd) {
  const path = String(input ?? "").trim().replace(/^@+/, "");
  if (!path) {
    throw new Error("sourcePath is required.");
  }

  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }

  return resolve(cwd, path);
}

function directoriesHaveSameContent(left, right) {
  if (!existsSync(left) || !existsSync(right)) {
    return false;
  }

  const leftStats = statSync(left);
  const rightStats = statSync(right);
  if (leftStats.isDirectory() !== rightStats.isDirectory()) {
    return false;
  }

  if (!leftStats.isDirectory()) {
    return leftStats.size === rightStats.size && readFileSync(left).equals(readFileSync(right));
  }

  const leftEntries = readdirSync(left, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();
  const rightEntries = readdirSync(right, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();

  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  for (let index = 0; index < leftEntries.length; index += 1) {
    if (leftEntries[index] !== rightEntries[index]) {
      return false;
    }

    if (!directoriesHaveSameContent(join(left, leftEntries[index]), join(right, rightEntries[index]))) {
      return false;
    }
  }

  return true;
}

function readVersionMetadata(versionDir) {
  const metaPath = join(versionDir, "meta.json");
  if (!existsSync(metaPath)) {
    return null;
  }

  try {
    const raw = readFileSync(metaPath, "utf8");
    const meta = JSON.parse(raw);
    if (!meta || typeof meta !== "object") {
      return null;
    }

    return {
      versionId: String(meta.versionId ?? basename(versionDir)),
      skillName: String(meta.skillName ?? ""),
      scope: String(meta.scope ?? ""),
      reason: typeof meta.reason === "string" ? meta.reason : "",
      createdAt: String(meta.createdAt ?? ""),
      createdAtMs: Number(meta.createdAtMs ?? 0),
    };
  } catch {
    return null;
  }
}

export { normalizeSkillRelativePath, normalizeSkillFolderName, assertSkillDirectory, resolveToolPath, directoriesHaveSameContent, readVersionMetadata };
