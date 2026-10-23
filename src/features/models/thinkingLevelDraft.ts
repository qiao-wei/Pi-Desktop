/**
 * 思考档位映射的纯规则（从 `customModelForm.ts` 搬出来）。
 *
 * 为什么单独一份：这部分是「pi 的七档 ↔ 编辑弹窗的草稿」的**双向往返**规则
 * （`thinkingLevelsFromMap` / `buildThinkingLevelMap`），设置页、添加弹窗、邀请码输入框
 * 与测试都只看这一件事；原来它和表单校验、列表合并、价格规则挤在同一个 700 行的文件里。
 * 唯一真源仍然是 `server/customModels.mjs` 里的同一套口径（桥会再校验一次）。
 */

/** pi 的思考档位全集（与桥 THINKING_LEVELS 同序同值）；编辑弹窗用它渲染档位映射表。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * 档位映射草稿：每档一个字符串，**留空 = 该档不存在**（落盘 `null`）。
 * 填的值就是选中该档时发给端点的 effort —— 可以和档位同名，也可以改名（high → xhigh）。
 * pi 那边「未声明的档」只有两种效果：基础档按同名放行、xhigh/max 算不支持，都能用这两个状态表达。
 */
export type ThinkingLevelDraftMap = Record<ThinkingLevel, string>;

export function emptyThinkingLevels(): ThinkingLevelDraftMap {
  return Object.fromEntries(
    THINKING_LEVELS.map((level) => [level, level === "xhigh" || level === "max" ? "" : level]),
  ) as ThinkingLevelDraftMap;
}

/** 桥下发的档位表 → 草稿；null/缺失都显示成空框（= 该档不存在）。 */
export function thinkingLevelsFromMap(map?: Record<string, string | null>): ThinkingLevelDraftMap {
  const draft = emptyThinkingLevels();
  for (const level of THINKING_LEVELS) {
    const value = map?.[level];
    draft[level] = value === null || value === undefined ? "" : String(value);
  }
  return draft;
}

/** 草稿 → 落盘映射表：七档全写（空 = `null`），所见即所发。 */
export function buildThinkingLevelMap(draft: ThinkingLevelDraftMap): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  for (const level of THINKING_LEVELS) {
    map[level] = draft[level]?.trim() ? draft[level].trim() : null;
  }
  return map;
}

/** 档位值的字符集：就是个 effort 名，不接受空白/控制字符（桥也会再拦一次）。 */
export const THINKING_VALUE_MAX = 40;
