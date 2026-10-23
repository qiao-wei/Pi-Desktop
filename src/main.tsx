import { Fragment, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { perfStartReporter } from "./lib/perf";
import { installLocalePreferencePort } from "./lib/localePreferences.ts";
import { getStoragePort, installStoragePort, storageVersionWarning } from "./lib/storage.ts";
// tailwind.css pulls in styles.css via `layer(legacy)`. Importing styles.css
// directly here would add a second, unlayered copy that outranks every utility.
// 配色主题的样式不在这里列举：`App.tsx` 从 `src/themes/index.ts` 导入注册表，
// 后者用 `import.meta.glob` 按目录注入每个主题的 theme.css（见 src/themes/README.md）。
import "./app/tailwind.css";

perfStartReporter();

// 装配点：i18n 是 foundation 层，不自己读存储；语言偏好的读写由适配层在这里接上。
// 必须在第一次渲染之前调用 —— i18n 懒解析当前语言（见 src/i18n/index.ts）。
installLocalePreferencePort();

// 存储边界：先校验 schema 版本（比本版本新的存档不读，否则会把用户设置静默重置），
// 再让第一次渲染落上去。`getStoragePort()` 在 DOM 缺席时会回退到内存实现，所以单测不需要这一步。
installStoragePort();
const storageWarning = storageVersionWarning();
if (storageWarning) {
  console.warn(storageWarning);
}

// 文件拖到窗口里非拖放区（消息列表、侧栏等）时，webview/浏览器的默认行为是导航打开
// 该文件。全局拦掉默认动作；composer 等真正的拖放区自己的 handler 先于这里执行，
// 不受影响（它们的 preventDefault 与这里是同一语义）。
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

// StrictMode double-invokes render and effects, but only in development builds -
// production never pays for it. That doubling is also why the dev app measured ~50 ms
// frames (300-430 thread commits/s) on a machine that runs the built bundle with zero
// long frames, i.e. dev-mode stutter is not a readout of the product.
//
// The check is worth switching on when touching render purity or effect lifetime (this
// app remounts `ChatThread` per session, so effect pairs are easy to get wrong).
// Opt in per browser profile: `localStorage.setItem("pi-desktop.strict", "1")` + reload.
const Profile =
  import.meta.env.DEV && getStoragePort().read("pi-desktop.strict") !== "1" ? Fragment : StrictMode;

createRoot(document.getElementById("root")!).render(
  <Profile>
    <App />
  </Profile>,
);
