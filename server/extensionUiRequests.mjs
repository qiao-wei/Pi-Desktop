/**
 * `ctx.ui.setWidget` 的请求体（纯函数）。
 *
 * 语义必须和 pi 自己的 RPC 出口一致（`dist/modes/rpc/rpc-mode.js`）：
 * - 纯文本行（`string[]`）原样透传；
 * - `undefined` 是「清除」，**也必须透传**。只透传 set 不透传 clear，扩展在
 *   `session_shutdown` 里 `setWidget(key, undefined)` 清掉的 widget 就会永远留在编辑器上方
 *   （前端只在收到 `widgetLines` 为空时才删除；缺失字段同样走删除路径，见 usePiDesktopApp）。
 * - 函数式组件（pi 支持 `(tui, theme) => Component`）在纯文本出口里没有对应表示，忽略。
 *
 * 这里单独成模块，是为了能被行为测试直接调用（`server/index.mjs` 是脚本，import 会起服务）。
 */
export function extensionWidgetRequest(widgetKey, content, options) {
	if (content !== undefined && !Array.isArray(content)) {
		return undefined;
	}
	return {
		widgetKey,
		widgetLines: content,
		widgetPlacement: options?.placement ?? "aboveEditor",
	};
}