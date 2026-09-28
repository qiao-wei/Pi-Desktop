/**
 * pi 扩展命令的 `getArgumentCompletions(prefix)` 返回值 → 桥给 composer 的精简透传。
 *
 * pi 的 `AutocompleteItem` 是 `{ value, label, description? }`，但扩展返回脏数据
 * （缺 label、value 为 null、根本不是数组）时不能让前端拿 undefined 去替换参数：
 * 统一成字符串，并丢掉空 value 的候选。
 */
export function normalizeCommandArgumentItems(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => ({
      value: String(item?.value ?? ""),
      label: String(item?.label ?? item?.value ?? ""),
      ...(item?.description ? { description: String(item.description) } : {}),
    }))
    .filter((item) => item.value);
}