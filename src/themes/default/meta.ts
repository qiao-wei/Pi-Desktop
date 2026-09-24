/**
 * 默认主题的名片（设置页里的标题与说明）。
 *
 * 新增主题：照抄本文件，把 `id` 改成目录名、写上中英两版文案即可。
 * 这里刻意不 import 任何东西 —— 测试会用 `node --test` 直接加载它，
 * 而类型约束在 `../index.ts` 的 `import.meta.glob<{ meta: ThemeMeta }>` 上。
 */
export const meta = {
  id: "default",
  label: { zh: "默认", en: "Default" },
  desc: {
    zh: "原有配色：暖白底、暖色描边，绿色作为强调色。",
    en: "The original palette: warm off-white surfaces, warm borders, green accent.",
  },
};