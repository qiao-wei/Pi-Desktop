#!/usr/bin/env node
/**
 * Test bench for context compaction. Two modes, nothing else:
 *
 *   node scripts/compaction-env.mjs change   # 窗口 64k + keepRecentTokens 2000（压缩压得动）
 *   node scripts/compaction-env.mjs reset    # 窗口 256k + 删掉 compaction 配置（走 pi 默认）
 *
 * Why these two knobs: a compaction needs *both*
 *   ① 上下文用量 > contextWindow - reserveTokens（默认 16384）→ 64k 时是 47,616
 *   ② 可折叠历史估算 > keepRecentTokens（默认 20000）
 * Short test sessions never satisfy ②, so pi decides "should compact", finds
 * nothing foldable and bails without a single event. Lowering keepRecentTokens is
 * what makes a test session actually compact; shrinking the window instead only
 * starves the answer (pi floors max_tokens at 1 once the window is full, 64k 时是
 * 59,904 tokens).
 *
 * 改的是 pi 的全局配置，终端里跑的 pi 也会共用；改完要重启 app 才生效。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AGENT_DIR = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
const MODELS_FILE = join(AGENT_DIR, "models.json");
const SETTINGS_FILE = join(AGENT_DIR, "settings.json");
const PROVIDER = "bailian";
const MODEL = "qwen3.8-flash";

function readJson(file) {
  if (!existsSync(file)) {
    throw new Error(`找不到 ${file}`);
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`读不了 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Swap one model's `contextWindow` in the raw text instead of re-dumping the JSON:
 * the file is hand-edited, and a re-serialisation would reflow every array and
 * object in it while changing exactly one number.
 */
function patchContextWindow(file, contextWindow) {
  const source = readFileSync(file, "utf8");
  // 先定位到本 provider 的片段，再在里头找这个模型，免得同名模型挂在另一个 provider 下被改错。
  const providerAt = source.search(new RegExp(`"${PROVIDER}"\\s*:\\s*\\{`));
  const start = providerAt > -1 ? providerAt : 0;
  const idAt = source.slice(start).search(new RegExp(`"id"\\s*:\\s*"${MODEL}"`));
  if (idAt < 0) {
    throw new Error(`${file} 里没有 ${PROVIDER}/${MODEL} 条目`);
  }
  const idFrom = start + idAt;
  const nextId = source.indexOf('"id"', idFrom + 4);
  const block = source.slice(idFrom, nextId > -1 ? nextId : source.length);
  const match = /"contextWindow"\s*:\s*\d+/.exec(block);
  if (!match) {
    throw new Error(`${MODEL} 条目里没有 contextWindow 字段`);
  }
  const from = idFrom + match.index;
  const next = `${source.slice(0, from)}"contextWindow": ${contextWindow}${source.slice(from + match[0].length)}`;
  if (modelEntry(JSON.parse(next)).contextWindow !== contextWindow) {
    throw new Error(`改完再读回来不是 ${contextWindow}，没写入`);
  }
  writeFileSync(file, next);
  return contextWindow;
}

function modelEntry(config) {
  const models = config?.providers?.[PROVIDER]?.models;
  const entry = Array.isArray(models) ? models.find((item) => item?.id === MODEL) : undefined;
  if (!entry) {
    throw new Error(`models.json 里没有 ${PROVIDER}/${MODEL}`);
  }
  return entry;
}

/** @param {"change" | "reset"} mode */
export function applyCompactionEnv(mode, agentDir = AGENT_DIR) {
  const modelsFile = join(agentDir, "models.json");
  const settingsFile = join(agentDir, "settings.json");

  const models = readJson(modelsFile);
  const entry = modelEntry(models);
  const contextWindow = patchContextWindow(modelsFile, mode === "change" ? 64000 : 256000);

  const settings = readJson(settingsFile);
  if (mode === "change") {
    settings.compaction = { ...(settings.compaction ?? {}), keepRecentTokens: 2000 };
  } else {
    delete settings.compaction;
  }
  writeJson(settingsFile, settings);

  return {
    contextWindow,
    compaction: settings.compaction ?? "（未设置，走 pi 默认：reserveTokens 16384 / keepRecentTokens 20000）",
    compactAbove: contextWindow - 16384,
    starvesAbove: contextWindow - 4096,
  };
}

const USAGE = "用法：node scripts/compaction-env.mjs change|reset";

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  if (mode !== "change" && mode !== "reset") {
    console.error(USAGE);
    process.exit(1);
  }
  try {
    const result = applyCompactionEnv(mode);
    console.log(`${mode === "change" ? "已切成压缩测得动的配置" : "已恢复原样"}：${MODELS_FILE}`);
    console.log(`  contextWindow    ${result.contextWindow}`);
    console.log(`  compaction       ${JSON.stringify(result.compaction)}`);
    console.log(`  该压缩           上下文 > ${result.compactAbove} tokens`);
    console.log(`  输出饿死         上下文 > ${result.starvesAbove} tokens`);
    console.log("  重启 app 后生效");
  } catch (error) {
    console.error(`compaction-env: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
