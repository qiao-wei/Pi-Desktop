# 配色主题（appearance themes）

一个主题 = 一个目录。**新增主题不需要改这个目录之外的任何文件。**

```
src/themes/
  README.md
  index.ts            ← 注册表：按目录自动发现（import.meta.glob），不用改
  default/
    meta.ts           ← 名片：设置页里的标题/说明（中英双语）
    theme.css         ← 全部 token（浅色 + 深色）
  codex/
    meta.ts
    theme.css         ← token + 主题作用域的窗口 chrome（三列通高、标题栏留白、拖拽区…）
```

## 加一个主题

1. `cp -r src/themes/codex src/themes/nord`（或从 `default` 抄）
2. 改 `meta.ts`：`id` 必须**等于目录名**，写上中英 `label` / `desc`
3. 改 `theme.css`：一套 token，浅色 + 深色都要给全
4. 跑 `npm test`

没了。设置页的选项、首帧贴到 `<html data-appearance>` 的值、样式注入、持久化校验
全部自动跟上。

## 硬约束（`tests/themeRegistry.test.ts` 钉住）

- **目录名 = `meta.id`**，且必须有 `meta.ts` + `theme.css`。
- **只有 `default` 可以写裸 `:root` / `.dark`**。它同时是「基础层」和「未知主题名的
  回落目标」——所以任何一个主题 id 不存在时，界面渲染成默认主题，不需要白名单。
- **其它主题的每条规则都必须带 `:root[data-appearance="<id>"]` 门控**
  （深色那条再加 `.dark`：`(0,3,0)` 才能压过浅色块的 `(0,2,0)`）。
- 主题 id 字符串不允许出现在 `src/themes/` 之外（出现即回归）。

## 主题内部顺序

每个主题只有一个 CSS 文件，文件内顺序**必须**是：

1. 浅色 token（`:root[data-appearance="<id>"]`）
2. 浅色的平台覆盖（如 `:root[data-platform="darwin"][data-appearance="<id>"]`）
3. 深色 token（`:root[data-appearance="<id>"].dark`）
4. 深色的平台覆盖（`:root[data-platform="darwin"][data-appearance="<id>"].dark`）
5. 该主题的 chrome / 结构覆盖（同样要门控）

主题之间的**加载顺序无所谓**：门控属性让它们互斥，且权重高于默认主题的裸 `:root`。

## 能做什么 / 不能做什么

能做（纯主题）：配色、圆角、阴影、层级、侧栏玻璃 tint/sheen/blur、标题栏高度、
`-webkit-app-region` 拖拽区、主题作用域的布局覆盖（负 margin 通高那套）。

不能做（要动共享代码，那不属于「主题」）：
- 需要新的 DOM 钩子/类名（例如 codex 那轮给会话列补的 `.conversation-column`）；
- 需要不同的组件树或交互行为；
- 需要改**原生窗口配置**（`frame` / `titleBarStyle` / `vibrancy` 参数）——
  这些在两个壳（`src-electron/main.js`、`src-tauri/src/lib.rs`）里是全局的，
  按主题分要单独设计。注意 macOS 的原生侧栏材质是全局开着的，**主题通过 token
  决定露不露**（`--app-sidebar-glass-tint` / `--app-shell-surface`），所以想用/不用
  玻璃都不用碰原生代码。

## 两个不在主题目录里的尺寸

- `--titlebar-height: 40px`（默认值）在 `src/app/styles.css` 的 `:root`，
  主题可以在自己的 `theme.css` 里覆盖（codex 就是 46px）。
- `--left-sidebar-width` / `--right-panel-width` 是运行时状态（`App.tsx` 挂在
  `.app-shell-surface` 上），不是主题属性。