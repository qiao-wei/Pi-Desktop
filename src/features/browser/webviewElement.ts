/**
 * `<webview>` 的方法面（React 的 `HTMLWebViewElement` 只有 `extends HTMLElement`，没有方法）。
 *
 * 为什么手写而不是申明 `any`：内置浏览器是**宿主能力的消费者**，它和宿主之间的每一次接触都
 * 应该是显式的。这里列出的每个方法都对应 `webviewLifecycle.safeWebviewCall` 的一次保护 ——
 * 多一个方法进来，就要多一处生命周期判断。
 *
 * 元素本身由 React 的内建 `webview` intrinsic 声明（`@types/react` 里有，`HTMLWebViewElement`），
 * 所以这里不重复声明 JSX，只补方法。
 */
export interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  goBack(): void;
  canGoForward(): boolean;
  goForward(): void;
  reload(): void;
  stop(): void;
  /** 注入页面脚本；`browserController` 的全部页面内命令都走它。 */
  executeJavaScript(code: string): Promise<unknown>;
  /** 截图；返回的 `NativeImage` 只需要 `toDataURL()`。 */
  capturePage(rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<{ toDataURL(): string }>;
}

/** React 的 ref 给的是空的 `HTMLWebViewElement`，方法要从这里补上。 */
export function asWebviewElement(node: unknown): WebviewElement | null {
  return node ? (node as WebviewElement) : null;
}
