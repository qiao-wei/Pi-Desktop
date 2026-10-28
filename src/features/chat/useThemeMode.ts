/**
 * 当前是明还是暗 —— 唯一的真相是 `<html>` 上的 `dark` 类（`useAppWiring` 负责同步它，
 * 顺带把 `color-scheme` 设成同一个值）。
 *
 * 为什么不把 `theme` 一路当 prop 传下来：内联 diff 在气泡深处，为了一个 `"light" | "dark"`
 * 穿过五层组件不值得；而 shiki 的 token 颜色**必须**和页面同一档，写死不跟主题切换就是 bug。
 */
import { useEffect, useState } from "react";

function readThemeMode(): "light" | "dark" {
  if (typeof document === "undefined") {
    return "light";
  }
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function useThemeMode(): "light" | "dark" {
  const [mode, setMode] = useState<"light" | "dark">(readThemeMode);

  useEffect(() => {
    if (typeof MutationObserver === "undefined") {
      return undefined;
    }
    const observer = new MutationObserver(() => setMode(readThemeMode()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  return mode;
}
