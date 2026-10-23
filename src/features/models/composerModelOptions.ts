import type { ModelSummary } from "../../types";
import type { CustomModelEntry } from "./customModelsApi";

/**
 * 输入框旁「可切换模型」下拉的纯规则（从 `customModelForm.ts` 搬出来）。
 *
 * 为什么单独一份：这些规则只服务一件事 —— **把几百个内置模型收敛成一份能用的下拉列表**
 * （自己加的永远在、配好鉴权的在、当前会话在用的在），以及按供应商分组。设置页的表单校验、
 * 价格规则和它没有关系，原来它们挤在同一个 700 行的文件里。
 *
 * `modelKey` / `prettifyModelId` 也放这里：它们是这份列表的**身份与显示名**规则，
 * 是这组函数唯一的依赖（`customModelForm.ts` 需要它们时从这里取，方向是单向的，不成环）。
 */

/** `qwen3.7-plus` -> `Qwen3.7 Plus`，和桥的 `prettifyModelId` 同规则。 */
export function prettifyModelId(id: string): string {
  return String(id ?? "")
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export interface ComposerModelOption {
  key: string;
  provider: string;
  model: string;
  /** 下拉里的主标题。 */
  label: string;
  /** 副标题：供应商名，自定义行用它区分同名模型。 */
  detail: string;
  custom: boolean;
  available: boolean;
}

/**
 * 输入框旁的可切换模型列表。
 *
 * 内置目录有几百个模型，全塞进下拉框等于没有列表，所以这里只放：
 * 用户自己加的模型（永远放，缺 key 也要放，否则刚加完就找不到）+ 已经配好鉴权的内置模型
 * + 当前会话正在用的那个（可能既不是自定义也没有鉴权）。
 */
export function buildComposerModelOptions({
  availableModels = [],
  customModels = [],
  currentProvider = "",
  currentModel = "",
}: {
  availableModels?: ModelSummary[];
  customModels?: CustomModelEntry[];
  currentProvider?: string;
  currentModel?: string;
}): ComposerModelOption[] {
  const options: ComposerModelOption[] = [];
  const seen = new Set<string>();

  const push = (option: ComposerModelOption) => {
    if (seen.has(option.key)) {
      return;
    }
    seen.add(option.key);
    options.push(option);
  };

  for (const entry of customModels) {
    if (!entry.managed || !entry.model) {
      continue;
    }
    push({
      key: modelKey(entry.providerId, entry.model),
      provider: entry.providerId,
      model: entry.model,
      label: entry.modelLabel || prettifyModelId(entry.model),
      detail: entry.providerName,
      custom: true,
      available: Boolean(entry.available),
    });
  }

  const builtIn = availableModels
    .filter((model) => model.available && !seen.has(modelKey(model.provider, model.model)))
    .map((model) => ({
      key: modelKey(model.provider, model.model),
      provider: model.provider,
      model: model.model,
      label: model.name || prettifyModelId(model.model),
      detail: model.provider,
      custom: false,
      available: true,
    }))
    .sort(
      (left, right) =>
        left.detail.localeCompare(right.detail) || left.label.localeCompare(right.label),
    );

  for (const option of builtIn) {
    push(option);
  }

  if (currentProvider && currentModel && !seen.has(modelKey(currentProvider, currentModel))) {
    const summary = availableModels.find(
      (model) => model.provider === currentProvider && model.model === currentModel,
    );
    push({
      key: modelKey(currentProvider, currentModel),
      provider: currentProvider,
      model: currentModel,
      label: summary?.name || prettifyModelId(currentModel),
      detail: summary?.provider ?? currentProvider,
      custom: false,
      available: Boolean(summary?.available),
    });
  }

  return options;
}

export interface ComposerModelGroup {
  /** provider id，作为分组 key。 */
  key: string;
  /** 分组标题：供应商展示名。 */
  label: string;
  custom: boolean;
  options: ComposerModelOption[];
}

/**
 * 下拉框按供应商分组。
 *
 * 顺序沿用列表本身的顺序（自定义在前），组内不变；自定义组按首次出现排，
 * 内置组按名字排，这样几十个模型不至于糊成一条平铺的长列表。
 */
export function groupComposerOptionsByProvider(
  options: ComposerModelOption[],
): ComposerModelGroup[] {
  const groups = new Map<string, ComposerModelGroup>();
  for (const option of options) {
    const existing = groups.get(option.provider);
    if (existing) {
      existing.options.push(option);
      continue;
    }
    groups.set(option.provider, {
      key: option.provider,
      label: option.detail || option.provider,
      custom: option.custom,
      options: [option],
    });
  }

  const list = [...groups.values()];
  const rank = (group: ComposerModelGroup) => (group.custom ? 0 : 1);
  return list.sort(
    (left, right) =>
      rank(left) - rank(right) || (rank(left) === 1 ? left.label.localeCompare(right.label) : 0),
  );
}
