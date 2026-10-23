import { useAppCore } from "./useAppCore";
import { useAppWiring } from "./useAppWiring";
import { useAppComposer } from "./useAppComposer";
import { useAppTurn } from "./useAppTurn";
import { useAppComposerEditing } from "./useAppComposerEditing";
import { useAppCaretSync } from "./useAppCaretSync";
import { useAppSearch } from "./useAppSearch";

/**
 * App 的 model：把 5 个顺序段拼起来交给 `AppShell`。
 *
 * 拆分前这里是单个 2,058 行的 `useAppModel()`；现在每段一个文件：
 *   · `useAppCore` —— 状态、ref 与基础派生值（骨架）
 *   · `useAppWiring` —— 订阅与副作用：模型/项目/git/扩展 UI/滚动/焦点/通知
 *   · `useAppComposer` —— 提交、拖放/粘贴、输入处理（composer 输入面）
 *   · `useAppTurn` —— 轮次动作：刷新 / 编辑 / 停止 / 排队恢复
 *   · `useAppComposerEditing` —— slash 命令、插入与光标写入（composer 编辑面）
 *   · `useAppCaretSync` —— 徽标/光标簿记 + 面板尺寸与折叠
 *   · `useAppSearch` —— 会话内搜索、全局搜索与上下文面板开关
 *
 * 段与段之间用一个共享的 `deps` 传递绑定：段 N 解构前面的段、把后面的段就地写成 `deps.X`。
 * 语句顺序与 hook 调用顺序和原实现完全一致 —— React 靠调用顺序认 state，这一点不能动。
 *
 * 由 `.scratch/split-hook-segments.mjs` 机械生成。
 */

export type PendingTurnAction = { kind: "edit" | "refresh"; messageId: string };;

/** 各段返回值拼成的取值表。段内解构与延迟读取都从这里来，类型精确（只有几处前向读取是 any）。 */
export type AppDeps = ReturnType<typeof useAppCore> & ReturnType<typeof useAppWiring> & ReturnType<typeof useAppComposer> & ReturnType<typeof useAppTurn> & ReturnType<typeof useAppComposerEditing> & ReturnType<typeof useAppCaretSync> & ReturnType<typeof useAppSearch>;

export function useAppModel() {
  const deps = {} as AppDeps;
  const appCore = useAppCore(deps);
  Object.assign(deps, appCore);
  const appWiring = useAppWiring(deps);
  Object.assign(deps, appWiring);
  const appComposer = useAppComposer(deps);
  Object.assign(deps, appComposer);
  const appTurn = useAppTurn(deps);
  Object.assign(deps, appTurn);
  const appComposerEditing = useAppComposerEditing(deps);
  Object.assign(deps, appComposerEditing);
  const appCaretSync = useAppCaretSync(deps);
  Object.assign(deps, appCaretSync);
  const appSearch = useAppSearch(deps);
  Object.assign(deps, appSearch);
  return { ...appCore, ...appWiring, ...appComposer, ...appTurn, ...appComposerEditing, ...appCaretSync, ...appSearch };
}

/** 视图 props 的类型：取 hook 的返回类型。 */
export type AppModel = ReturnType<typeof useAppModel>;
