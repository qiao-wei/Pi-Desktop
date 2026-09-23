import { Fragment, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { perfStartReporter } from "./lib/perf";
// tailwind.css pulls in styles.css via `layer(legacy)`. Importing styles.css
// directly here would add a second, unlayered copy that outranks every utility.
import "./app/tailwind.css";

perfStartReporter();

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
  import.meta.env.DEV && globalThis.localStorage?.getItem("pi-desktop.strict") !== "1" ? Fragment : StrictMode;

createRoot(document.getElementById("root")!).render(
  <Profile>
    <App />
  </Profile>,
);
