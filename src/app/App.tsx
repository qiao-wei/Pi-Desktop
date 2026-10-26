import { AppShell } from "./AppShell";
import { useAppModel } from "./useAppModel";


/**
 * 应用入口（胶水）
 *
 * `useAppModel()` 出 model，`AppShell` 出视图；具体逻辑与视图见同目录两个文件。
 *
 * 由 `.scratch/split-app-files.mjs` 从 `src/app/App.tsx` 机械搬出。
 */

export function App() {
  const model = useAppModel();
  return <AppShell view={model} />;
}
