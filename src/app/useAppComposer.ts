import type { useAppCore } from "./useAppCore";
import type { useAppWiring } from "./useAppWiring";
import type { AppForwarded } from "./appForwarded";
import { capabilityBadgeKey, composerCaretMarker, createAttachmentId, createCapabilityInstanceId, maxAttachmentCount, maxAttachmentSize, maxAttachmentTotalSize } from "./AppComposerHelpers";
import type {
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  escapeHtml,
  htmlToSanitizedMarkup,
} from "../features/chat/pasteSanitize";
import {
  replacePasteBadgePlaceholders,
  type ClipboardBadge,
} from "../features/chat/badgeClipboard";
import {
  findBuiltinCommand,
  findSlashCommand,
  applyManualSkillCommand,
  matchSlashCommandArgs,
  matchSlashTrigger,
  moveHighlight,
  readTriggerText,
} from "../features/chat/slashMenu";
import { ComposerAttachment, readAttachment } from "./AttachmentHoverCard";
import { ComposerCapability, escapeCssIdent, renamePastedImage, toPromptMessageParts } from "./AppComposerHelpers";
import { hasDraggedFiles } from "./Sidebar";
import { attachmentKindFromMimeType, DIRECTORY_MIME_TYPE } from "../shared/attachmentKind";
import { collectDroppedItems, type DroppedProjectFolder } from "../shared/droppedProjectFolder";
import { pickNewFolderDrops, planComposerDrop, type ComposerDropPlan } from "../shared/composerDrop";


/**
 * 本段**之后**才声明的名字：只在延迟执行位置（回调/副作用里）用到 —— 类型直接 `Pick`
 * 后段返回类型（精确，不是 any）。它们每次 render 由 `deps` 重新赋值，
 * 所以 `deps.X` 读到的是当前 render 的值（比原来的闭包捕获更难过期）。
 */
type Later =
  Pick<AppForwarded, "createAttachmentBadgeNode" | "createCapabilityBadgeNode" | "hideAttachmentHover" | "insertAttachmentsAtCursor" | "readComposerParts" | "rememberComposerSelection" | "rememberComposerSelectionFromPoint" | "removeAttachmentBeforeCaret" | "removeCapabilityBeforeCaret" | "removeLeadingCaretMarker" | "selectSlashItem" | "stepOverCaretMarker" | "syncComposerState" | "trackPendingCapabilitySync" | "waitForPendingCapabilitySync">;


/**
 * 提交、拖放/粘贴、输入处理（composer 输入面）
 *
 * `useAppModel()` 顺序切出的第 3 段（原 body 语句 106–121，783–1368 行）。
 *   · 本段**之前**声明的名字：从共享 `deps` 解构（拿到的是真值本身，闭包身份不变）。
 *   · 本段**之后**才声明的名字：就地写成 `deps.X`（只在延迟执行位置出现；读的是当前 render 的值）。
 * 段内语句一字未改 —— 正确性靠这一点，也靠 `tests/appModelSplit.test.ts` 的顺序与字段校验。
 *
 * 由 `.scratch/split-hook-segments.mjs` 机械搬出。
 */
export function useAppComposer(deps: ReturnType<typeof useAppCore> & ReturnType<typeof useAppWiring> & Later) {
  // 前面几段已经写进 deps 的值。
  const {
    activeSlashIndex, attachmentPreviewUrlsRef, attachments, bootstrap, canSubmitPrompt, capabilities,
    clearBuiltinNotice, composerAttachmentMapRef, composerCapabilityMapRef, composerEditorRef, composerSelectionRef, conversation,
    dragDepthRef, followLatestScroll, isPreparingAttachments, modelConfig, pendingPreviewUrlsRef, runBuiltinCommand,
    runPackageCommand, setAttachments, setComposerError, setComposerText, setIsDraggingFiles, setIsPreparingAttachments,
    setSessionSkill, setShowCapabilityPicker, setSlashArgumentArmed, setSlashCommandContext, setSlashHighlight, setSlashQuery,
    showBuiltinNotice, showCapabilityPicker, slashArgumentArmed, slashCommandContext, slashItems, slashQuery,
    state, submitTurn, t, visibleSessionPath,
  } = deps;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!(await deps.waitForPendingCapabilitySync())) {
      return;
    }
    const orderedParts = deps.readComposerParts(composerEditorRef.current);
    const orderedAttachments = orderedParts
      .filter((part): part is { kind: "attachment"; attachment: ComposerAttachment } => part.kind === "attachment")
      .map((part) => part.attachment);
    const orderedText = orderedParts
      .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
      .map((part) => part.text)
      .join("");
    const messageParts = toPromptMessageParts(orderedParts);

    // TUI 语义的手动技能调用：`/skill:<名字> [args]`（pi docs/skills.md）——
    // 桌面没有命令注册表，所以这里把它翻译成「挂上这个技能的徽标 + 后面的字当参数」
    // （纯函数在 slashMenu.ts，编辑框那条路共用同一份规则）。翻译完之后，后续路径与从
    // `/` 菜单选技能完全一致：manual-only 技能的正文由服务端顶进本次请求，已使能的技能
    // 只写 enabledSkills。名字打错则原样当普通提问。
    const manualSkillCommand = applyManualSkillCommand(orderedText, capabilities.skills, messageParts);
    const manualSkill = manualSkillCommand.matched;
    const promptText = manualSkillCommand.text;
    const promptParts = manualSkillCommand.parts;

    // 只有徽标（技能/扩展）也能提交，等价于 TUI 的 `/skill:name` 无参数形态：
    // 文字为空时服务端会用 capabilityOnlyPrompt 顶上一句，manual-only 技能的正文
    // 自己会顶在最前面（server/manualSkillPrompt.mjs）。
    const hasCapabilityPart = promptParts.some((part) => part.kind === "capability");
    if ((!promptText.trim() && orderedAttachments.length === 0 && !hasCapabilityPart) || isPreparingAttachments) {
      return;
    }
    if (state.isStopping) {
      setComposerError(t("composer.error.stopping"));
      return;
    }

    // TUI 语义：提交的如果是已加载的包命令（`/name [args]`）或 Pi Desktop 实现了的内置命令
    // （目前 `/reload`），执行动作而不是当问题发给模型。只认精确命中的；未知的 `/xxx` 仍走
    // 聊天（服务端 expandPromptTemplates:false），所以「问题里以 / 开头」不会再触发意外命令。
    const submittedCommand = matchSlashCommandArgs(promptText);
    const builtinCommand = submittedCommand ? findBuiltinCommand(capabilities, submittedCommand.name) : null;
    const slashCommand = submittedCommand && !builtinCommand
      ? findSlashCommand(capabilities, submittedCommand.name)
      : null;
    if (
      !manualSkill
      && (slashCommand || builtinCommand)
      && !state.isBootstrapping
      && orderedAttachments.length === 0
      && !orderedParts.some((part) => part.kind === "capability")
    ) {
      setComposerError("");
      clearComposer();
      const dispatchCommand = slashCommand
        ? runPackageCommand(slashCommand.packageId, slashCommand.name, submittedCommand?.prefix ?? "")
        : runBuiltinCommand(builtinCommand!.name, submittedCommand?.prefix ?? "");
      if (builtinCommand) {
        showBuiltinNotice(builtinCommand.name, "running");
      }
      void dispatchCommand.then(
        () => {
          if (builtinCommand) {
            showBuiltinNotice(builtinCommand.name, "done");
          }
        },
        (error) => {
          // 失败让给 composer 错误带（忙/带参数/未知命令 都比状态带具体）。
          if (builtinCommand) {
            clearBuiltinNotice();
          }
          setComposerError(error instanceof Error ? error.message : String(error));
        },
      );
      return;
    }

    if (!canSubmitPrompt) {
      if (!modelConfig.provider || !modelConfig.model) {
        setComposerError(t("composer.error.noModel"));
      } else if (!modelConfig.apiKeyConfigured) {
        setComposerError(t("composer.error.noApiKey", { provider: modelConfig.provider }));
      } else {
        setComposerError(t("composer.error.notReady"));
      }
      return;
    }

    const sessionPath = bootstrap.activeSessionPath ?? conversation.sessionFile;
    if (!sessionPath) {
      setComposerError(t("composer.error.noSession"));
      return;
    }
    if (state.isBootstrapping) {
      setComposerError(t("composer.error.loading"));
      return;
    }
    followLatestScroll(visibleSessionPath);
    setComposerError("");
    setIsPreparingAttachments(true);
    try {
      const payload = await Promise.all(
        orderedAttachments.map((attachment) =>
          // FileReader 对目录、以及拖进来之后又被移走的文件，只给平台原文一句
          // （"A requested file or directory could not be found at the time an operation
          // was processed."）—— 指名道姓地报是哪一条读不出来，否则用户无从下手。
          readAttachment(attachment).catch(() => {
            throw new Error(t("composer.error.attachmentUnreadable", { name: attachment.name }));
          }),
        ),
      );
      const submitPromise = submitTurn(promptText, payload, promptParts);
      const preservedPreviewUrls = new Set(
        orderedAttachments.map((attachment) => attachment.previewUrl).filter((url): url is string => Boolean(url)),
      );
      preservedPreviewUrls.forEach((url) => pendingPreviewUrlsRef.current.add(url));
      clearComposer(preservedPreviewUrls);
      void submitPromise
        .then((submitted) => {
          if (!submitted) {
            preservedPreviewUrls.forEach((url) => pendingPreviewUrlsRef.current.delete(url));
            const editor = composerEditorRef.current;
            if (!orderedAttachments.length && orderedText.trim() && editor && !editor.textContent?.trim()) {
              editor.textContent = orderedText;
              setComposerText(orderedText);
            }
            setComposerError(t("composer.error.submitFailed"));
          }
        })
        .catch((error) => {
          preservedPreviewUrls.forEach((url) => pendingPreviewUrlsRef.current.delete(url));
          setComposerError(error instanceof Error ? error.message : String(error));
        });
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPreparingAttachments(false);
    }
  }

  /**
   * 一次 drop 的落地：目录（宿主给了绝对路径）成引用徽标，文件读字节，读不到的当场说。
   *
   * 拒绝必须是可见的：静默吞掉会让用户以为拖进去了，直到提交才发现少东西。一条 drop 只能
   * 显示一条消息，优先级是「完全没接住」>「装不下」>「这条读不出来」。
   */
  function applyComposerDrop(plan: ComposerDropPlan) {
    const fileError = addFiles(plan.files);
    const folderError = addFolderAttachments(plan.folders);
    const refusedError = plan.refusedFolders.length
      ? t("composer.error.folderNotAttachable", { name: plan.refusedFolders[0] })
      : "";
    setComposerError(refusedError || folderError || fileError);
  }

  /**
   * 目录附件只带 `sourcePath`（绝对路径），不带字节也没有 `file`。服务端照 MIME 认出它，
   * 把路径原样交给模型，不复制、不计大小。同一个目录拖两次只留一个徽标。
   */
  function addFolderAttachments(folders: readonly DroppedProjectFolder[]): string {
    const existingPaths = [...composerAttachmentMapRef.current.values()]
      .filter((attachment) => attachment.kind === "directory")
      .map((attachment) => attachment.sourcePath)
      .filter((path): path is string => Boolean(path));
    const { folders: picked, overflow } = pickNewFolderDrops(
      folders,
      existingPaths,
      Math.max(0, maxAttachmentCount - composerAttachmentMapRef.current.size),
    );

    if (picked.length) {
      deps.insertAttachmentsAtCursor(
        picked.map((folder) => ({
          id: createAttachmentId(),
          name: folder.name,
          mimeType: DIRECTORY_MIME_TYPE,
          size: 0,
          kind: "directory" as const,
          sourcePath: folder.path,
        })),
      );
    }

    return overflow ? t("composer.error.tooManyAttachments", { count: maxAttachmentCount }) : "";
  }

  /** Returns the message to show, or "" when nothing went wrong. */
  function addFiles(fileList: FileList | File[]): string {
    const incoming = Array.from(fileList);
    if (!incoming.length) {
      return "";
    }

    const availableSlots = Math.max(0, maxAttachmentCount - attachments.length);
    const selected = incoming.slice(0, availableSlots);
    const existingSize = attachments.reduce((total, attachment) => total + attachment.size, 0);
    const next: ComposerAttachment[] = [];
    let totalSize = existingSize;
    let errorMessage = incoming.length > availableSlots ? t("composer.error.tooManyAttachments", { count: maxAttachmentCount }) : "";

    for (const file of selected) {
      if (file.size > maxAttachmentSize) {
        errorMessage = t("composer.error.attachmentTooLarge", { name: file.name, limit: maxAttachmentSize / 1024 / 1024 });
        continue;
      }
      if (totalSize + file.size > maxAttachmentTotalSize) {
        errorMessage = t("composer.error.attachmentsTooLargeTotal", { limit: maxAttachmentTotalSize / 1024 / 1024 });
        break;
      }

      const kind = attachmentKindFromMimeType(file.type);
      const isImage = kind === "image";
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
      const id = createAttachmentId();
      next.push({
        id,
        name: file.name || (isImage ? "Screenshot.png" : "Untitled file"),
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        kind,
        previewUrl,
        file,
      });
      totalSize += file.size;
    }

    if (next.length) {
      deps.insertAttachmentsAtCursor(next);
    }
    return errorMessage;
  }

  /**
   * 删除 徽标时连同它后面的零宽光标标记一起收掉。
   * 不清理的话会留下一个看不见的 \u200b：下一次 Backspace 先把它删掉（还什么都不动），
   * 看起来就像「要先删一个空白才能删徽标」。附件与技能走同一条路径。
   */
  function removeBadgeNode(node: Element | null) {
    if (!node) {
      return;
    }
    const nextSibling = node.nextSibling;
    node.parentNode?.removeChild(node);
    deps.removeLeadingCaretMarker(nextSibling);
  }

  function removeAttachment(id: string) {
    // 徽章被删时鼠标仍悬在它上面，mouseleave 永远不会触发，预览卡会一直残留。
    deps.hideAttachmentHover();
    const editor = composerEditorRef.current;
    const target = composerAttachmentMapRef.current.get(id);
    if (target?.previewUrl) {
      const previewEntry = [...attachmentPreviewUrlsRef.current.entries()].find(([, url]) => url === target.previewUrl);
      if (previewEntry) {
        URL.revokeObjectURL(previewEntry[1]);
        attachmentPreviewUrlsRef.current.delete(previewEntry[0]);
      }
    }
    composerAttachmentMapRef.current.delete(id);
    const node = editor?.querySelector(`[data-attachment-id="${escapeCssIdent(id)}"]`);
    removeBadgeNode(node ?? null);
    deps.syncComposerState();
  }

  function handlePaste(event: ReactClipboardEvent<HTMLDivElement>) {
    const clipboard = event.clipboardData;
    const images = Array.from(clipboard.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (images.length) {
      event.preventDefault();
      setComposerError(addFiles(images.map((file, index) => renamePastedImage(file, index))));
      return;
    }

    // 富文本粘贴（网页/文档/表格）只保留文本、简单文本样式与换行：
    // 表格拍平成行（单元格空格分隔），样式只留 b/i/u/code，其余全部剥掉。
    // 我们自己复制出来的 inline badge 除外：识别出来后原地还原成徽标。
    const html = clipboard.getData("text/html");
    const plain = clipboard.getData("text/plain");
    if (!html && !plain) {
      return;
    }
    event.preventDefault();
    const badges: ClipboardBadge[] = [];
    const markup = html
      ? htmlToSanitizedMarkup(parsedBody(html), { badges })
      : escapeHtml(plain).replaceAll("\n", "<br>");
    insertPastedMarkup(markup, badges);
  }

  function parsedBody(html: string): HTMLElement {
    return new DOMParser().parseFromString(html, "text/html").body;
  }

  /** 从剪贴板描述还原一个徽标；附件在 composer 里已有原件时复用它的 File。 */
  function createPastedBadge(badge: ClipboardBadge): Node | null {
    if (badge.kind === "capability") {
      const capability: ComposerCapability = {
        id: badge.capability.id,
        kind: "skill",
        name: badge.capability.name,
        description: badge.capability.description,
        active: true,
        instanceId: createCapabilityInstanceId(),
      };
      composerCapabilityMapRef.current.set(capabilityBadgeKey(capability), capability);
      const capabilityUpdate = setSessionSkill(capability.id, true);
      deps.trackPendingCapabilitySync(capabilityUpdate);
      void capabilityUpdate.catch((error) => {
        setComposerError(error instanceof Error ? error.message : String(error));
      });
      return deps.createCapabilityBadgeNode(capability);
    }

    if (composerAttachmentMapRef.current.size >= maxAttachmentCount) {
      setComposerError(t("composer.error.tooManyAttachments", { count: maxAttachmentCount }));
      return null;
    }
    const existing = composerAttachmentMapRef.current.get(badge.attachment.id);
    const source = existing ?? badge.attachment;
    const previewUrl = existing?.file && source.kind === "image"
      ? URL.createObjectURL(existing.file)
      : source.previewUrl;
    const attachment: ComposerAttachment = {
      id: createAttachmentId(),
      name: source.name,
      mimeType: source.mimeType,
      size: source.size,
      kind: source.kind,
      previewUrl,
      sourcePath: source.sourcePath,
      file: existing?.file,
    };
    composerAttachmentMapRef.current.set(attachment.id, attachment);
    if (attachment.previewUrl) {
      attachmentPreviewUrlsRef.current.set(attachment.id, attachment.previewUrl);
    }
    return deps.createAttachmentBadgeNode(attachment);
  }

  function insertPastedMarkup(markup: string, badges: ClipboardBadge[] = []) {
    if (!markup) {
      return;
    }
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    const template = document.createElement("template");
    template.innerHTML = markup;
    const fragment = template.content;
    replacePasteBadgePlaceholders(fragment, badges, createPastedBadge, composerCaretMarker);
    const selection = window.getSelection();
    deps.rememberComposerSelection();
    let range = composerSelectionRef.current?.cloneRange();
    if (!range || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }

    editor.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    range.deleteContents();
    const lastNode = fragment.lastChild;
    range.insertNode(fragment);
    if (lastNode) {
      range.setStartAfter(lastNode);
    }
    range.collapse(true);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    composerSelectionRef.current = range.cloneRange();
    deps.syncComposerState();
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (showCapabilityPicker) {
      if (event.key === "Escape") {
        event.preventDefault();
        setShowCapabilityPicker(false);
        setSlashCommandContext(null);
        setSlashArgumentArmed(false);
        return;
      }

      if (slashItems.length) {
        const argumentMenu = slashItems[0]?.kind === "argument";
        if (event.key === "ArrowDown") {
          event.preventDefault();
          // 参数菜单默认没有“选中项”（回车=提交）；第一次 ↓ 才落到第一项。
          if (argumentMenu && !slashArgumentArmed) {
            setSlashHighlight(0);
          } else {
            setSlashHighlight((current) => moveHighlight(current, 1, slashItems.length));
          }
          setSlashArgumentArmed(true);
          return;
        }

        if (event.key === "ArrowUp") {
          event.preventDefault();
          if (argumentMenu && !slashArgumentArmed) {
            setSlashHighlight(slashItems.length - 1);
          } else {
            setSlashHighlight((current) => moveHighlight(current, -1, slashItems.length));
          }
          setSlashArgumentArmed(true);
          return;
        }

        // Tab 把选中的项落进编辑器；对命令就是补 `/name `，不执行。
        if (event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          const item = slashItems[activeSlashIndex];
          if (item) {
            deps.selectSlashItem(item);
          }
          return;
        }

        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          const item = slashItems[activeSlashIndex];
          // 参数默认不一定必选：参数菜单刚弹出、用户没动过选择时，回车直接提交命令。
          // 动过 ↑↓ 或用鼠标点过某一项（`slashArgumentArmed`）才把回车当成「选这一项」。
          if (item?.kind === "argument" && !slashArgumentArmed) {
            event.preventDefault();
            setShowCapabilityPicker(false);
            setSlashCommandContext(null);
            event.currentTarget.closest("form")?.requestSubmit();
            return;
          }
          event.preventDefault();
          if (item) {
            deps.selectSlashItem(item);
          }
          return;
        }
      }
    }

    if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.nativeEvent.isComposing &&
      deps.stepOverCaretMarker(event.key === "ArrowLeft" ? -1 : 1)
    ) {
      event.preventDefault();
      return;
    }

    if (event.key === "Backspace" && deps.removeAttachmentBeforeCaret()) {
      event.preventDefault();
      return;
    }

    if (event.key === "Backspace" && deps.removeCapabilityBeforeCaret()) {
      event.preventDefault();
      return;
    }

    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    event.currentTarget.closest("form")?.requestSubmit();
  }

  function handleDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  }

  function handleDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false);
    }
  }

  function handleDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    deps.rememberComposerSelectionFromPoint(event.clientX, event.clientY);
    // 判目录只认 Entries API，而它和 File 句柄都只在 drop 回调的同步段里有效：先把这一拖
    // 读成 facts，再决定哪些是目录引用、哪些走字节。
    applyComposerDrop(planComposerDrop(collectDroppedItems(event.dataTransfer, window.__PI_DESKTOP_FILES__)));
  }

  function handleComposerInput() {
    deps.rememberComposerSelection();
    deps.syncComposerState();
    const editor = composerEditorRef.current;
    // textContent 会把徽章内部文字（图标/名字/×）算进去，导致徽章后打 / 看似词中；
    // 触发检测只看真实文本节点。
    const triggerText = editor ? readTriggerText(editor) : "";
    const query = matchSlashTrigger(triggerText);
    if (query != null) {
      // 命令名 / 技能补全。
      setSlashCommandContext(null);
      if (!showCapabilityPicker) {
        setSlashHighlight(0);
        setShowCapabilityPicker(true);
      }
      if (query !== slashQuery) {
        setSlashQuery(query);
        setSlashHighlight(0);
      }
      return;
    }

    // 已过命令名阶段：`/command args` 时接着补参数（TUI 的 getArgumentCompletions）。
    const commandArgs = editor ? matchSlashCommandArgs(triggerText) : null;
    const command = commandArgs ? findSlashCommand(capabilities, commandArgs.name) : null;
    if (commandArgs && command?.hasArgumentCompletions) {
      const changed = slashCommandContext?.packageId !== command.packageId
        || slashCommandContext.name !== command.name
        || slashCommandContext.prefix !== commandArgs.prefix;
      if (changed) {
        setSlashQuery("");
        setSlashCommandContext({ packageId: command.packageId, name: command.name, prefix: commandArgs.prefix });
        setSlashHighlight(0);
        setSlashArgumentArmed(false);
        // 新前缀的候选还没到，先收起，等 effect 拿到后自己打开。
        setShowCapabilityPicker(false);
      }
      return;
    }

    setSlashCommandContext(null);
    setSlashArgumentArmed(false);
    if (showCapabilityPicker) {
      setShowCapabilityPicker(false);
    }
    if (slashQuery) {
      setSlashQuery("");
    }
  }

  function clearComposer(preservedPreviewUrls = new Set<string>()) {
    // 提交/清空同样会移除悬停中的徽章，同步收掉预览卡。
    deps.hideAttachmentHover();
    const editor = composerEditorRef.current;
    composerAttachmentMapRef.current.forEach((attachment) => {
      if (attachment.previewUrl) {
        const previewEntry = [...attachmentPreviewUrlsRef.current.entries()].find(([, url]) => url === attachment.previewUrl);
        if (previewEntry && !preservedPreviewUrls.has(attachment.previewUrl)) {
          URL.revokeObjectURL(previewEntry[1]);
          attachmentPreviewUrlsRef.current.delete(previewEntry[0]);
        }
      }
    });
    composerAttachmentMapRef.current.clear();
    composerCapabilityMapRef.current.clear();
    setAttachments([]);
    setComposerText("");
    setShowCapabilityPicker(false);
    setSlashQuery("");
    if (editor) {
      editor.innerHTML = "";
      composerSelectionRef.current = null;
    }
  }

  return { addFiles, addFolderAttachments, applyComposerDrop, clearComposer, createPastedBadge, handleComposerInput, handleComposerKeyDown, handleDragEnter, handleDragLeave, handleDrop, handlePaste, handleSubmit, insertPastedMarkup, parsedBody, removeAttachment, removeBadgeNode };
}
