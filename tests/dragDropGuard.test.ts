/**
 * Drag-and-drop file upload guards.
 *
 * 1. Tauri's webview ships with its own native file-drop interception enabled by
 *    default: OS file drags are swallowed and turned into Tauri events, so the
 *    composer's HTML5 dragenter/drop handlers never fire in the packaged app.
 *    The main window must disable that handler.
 * 2. The renderer must preventDefault window-level dragover/drop so a file
 *    dropped outside a dropzone (message list, sidebars) doesn't make the
 *    webview/browser navigate to and open that file.
 * 3. A drop must be read into facts (Entries API + File handles) and decided by
 *    `planComposerDrop` before anything reaches the byte channel. Handing the raw
 *    `dataTransfer.files` straight to `addFiles` is how a dropped folder became a
 *    zero-length attachment and blew up in `FileReader` at submit time.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainTsx = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const libRs = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const composerSources = ["../src/app/App.tsx", "../src/features/chat/MessageEditBox.tsx"].map((path) => ({
  path,
  source: readFileSync(new URL(path, import.meta.url), "utf8"),
}));

test("Tauri main window disables the native drag-drop handler", () => {
  const builder = libRs.slice(libRs.indexOf("fn create_main_window"));
  assert.match(builder, /\.disable_drag_drop_handler\(\)/);
});

test("renderer swallows window-level dragover/drop outside dropzones", () => {
  for (const type of ["dragover", "drop"]) {
    const listener = mainTsx.indexOf(`window.addEventListener("${type}"`);
    assert.notEqual(listener, -1, `missing window ${type} guard`);
    const body = mainTsx.slice(listener, listener + 120);
    assert.match(body, /event\.preventDefault\(\)/);
  }
});

test("两个 composer 都先把 drop 读成 facts 再决策，不把整包 files 交给字节通道", () => {
  for (const { path, source } of composerSources) {
    assert.doesNotMatch(
      source,
      /addFiles\(\s*event\.dataTransfer\.files\s*\)/,
      `${path} 不能把 dataTransfer.files 直接交给 addFiles：目录会被当成零长附件，提交时 FileReader 必爆`,
    );
    assert.match(
      source,
      /planComposerDrop\(collectDroppedItems\(event\.dataTransfer/,
      `${path} 的 drop 必须走 shared/composerDrop 的决策（两个 composer 不许分叉）`,
    );
  }
});
