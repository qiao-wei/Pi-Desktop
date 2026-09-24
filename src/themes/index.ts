import type { Locale } from "../i18n/index.ts";

/**
 * 配色主题的注册表 —— **按目录自动发现，不需要登记**。
 *
 * 一个主题 = 一个目录：
 *
 *   src/themes/<id>/
 *     meta.ts     → `export const meta = { id, label, desc }`（设置页文案，双语）
 *     theme.css   → 该主题的全部 token + 主题作用域的 chrome 覆盖
 *
 * 因此「新增主题」= 新建目录，不用改本文件、不用改 `App.tsx`、不用改 i18n、
 * 不用改 `index.html`（详见 `README.md`；`tests/themeRegistry.test.ts` 钉住这些约束）。
 *
 * ## 为什么未知主题名是安全的
 *
 * 只有 `default` 写裸 `:root`/`.dark`，它就是所有人的**基础层**。其它主题的每条规则
 * 都带 `:root[data-appearance="<id>"]` 门控（0,2,0 > 0,1,0）。于是 `<html
 * data-appearance="…">` 指向一个不存在的主题时，没有任何主题块命中，界面就渲染成
 * 默认主题 —— 所以这里（以及 `index.html` 的首帧脚本）都不需要维护白名单。
 *
 * ## 顺序
 *
 * 主题之间**不依赖加载顺序**：门控属性让它们互斥，权重高于默认主题的裸 `:root`。
 * 只有主题**内部**的顺序要紧（浅色 → 深色 → darwin，同权重靠先后定胜负），
 * 那由各自的 `theme.css` 自己保证，所以每个主题只有一个 CSS 文件。
 */
export interface ThemeMeta {
  id: string;
  label: Record<Locale, string>;
  desc: Record<Locale, string>;
}

/** 主题 id。刻意是开放字符串：清单来自目录，不是编译期枚举。 */
export type ThemeId = string;

const metaModules = import.meta.glob<{ meta: ThemeMeta }>("./*/meta.ts", { eager: true });

// 样式按目录自动注入。这是副作用导入：`.css` 模块没有导出，`import.meta.glob` 的
// eager 模式在模块求值时就把它们交给打包器（dev 注入 <style>，build 进 CSS 包）。
// 放在 `App.tsx` 的模块图里，所以首帧之前一定已经生效。
import.meta.glob("./*/theme.css", { eager: true });

/** 默认主题永远排第一（设置页的第一个选项），其余按 id 字母序。 */
export const themes: readonly ThemeMeta[] = Object.values(metaModules)
  .map((module) => module.meta)
  .sort((a, b) => (a.id === "default" ? -1 : b.id === "default" ? 1 : a.id.localeCompare(b.id)));

export function isKnownTheme(id: unknown): id is ThemeId {
  return typeof id === "string" && themes.some((theme) => theme.id === id);
}

/**
 * 把持久化（或外部）来的值解析成已知主题；未知或损坏 → 默认主题。
 *
 * 为什么不放进 `lib/ui-preferences.ts`：清单来自目录（要读 vite 的 glob），
 * 而那个模块必须能在 `node --test` 里加载（它只做「卫生检查」，见那里的注释）。
 */
export function resolveAppearance(value: unknown): ThemeId {
  return isKnownTheme(value) ? value : "default";
}