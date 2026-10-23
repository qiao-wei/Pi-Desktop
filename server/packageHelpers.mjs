/**
 * 包条目的小工具.
 *
 * 自动加载判定、条目匹配、资源路径收集。
 *
 * 从 `server/index.mjs` 搬出来的纯函数（只依赖 import 进来的东西，不碰模块状态）——
 * 那个文件曾经 8.7k 行、棘轮不许它再长，所以按「一簇一文件」往外搬。
 */
import { canonicalPath } from "./capabilityPathIdentity.mjs";
import { statSync } from "node:fs";

function packageAutoloadEnabled(settingsManager, pkg) {
  const settings = pkg.scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
  const entry = (settings.packages ?? []).find((candidate) =>
    (typeof candidate === "string" ? candidate : candidate.source) === pkg.source,
  );
  return !(typeof entry === "object" && entry.autoload === false);
}

function enabledResourcePaths(resolved, type) {
  return (resolved?.[type] ?? [])
    .filter((resource) => resource.enabled)
    .map((resource) => canonicalPath(resource.path));
}

function statMaybeDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function packageCapabilityId(pkg) {
  return `${pkg.scope}:${pkg.source}`;
}

export { packageAutoloadEnabled, enabledResourcePaths, statMaybeDirectory, packageCapabilityId };
