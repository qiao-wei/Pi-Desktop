/**
 * 「双击改动的文件 → 用宿主机的 IDE 打开它的 diff（HEAD ↔ 工作区）」。
 *
 * 为什么需要一层服务端逻辑，而不是渲染层直接 `shell.openPath`：
 * - 渲染层手里只有 git 给的**相对**路径，cwd 只有服务端有；
 * - `open <file>` 打开的是文件本身，里面没有 `+`/`−`。要看 diff 必须走 IDE 自己的 diff
 *   命令（`code --diff a b` / `zed --diff a b` / `idea diff a b`），而 diff 需要**两个文件**：
 *   左侧是 HEAD 里的旧内容（临时文件），右侧是工作区里的真实文件。
 * 所以这里做三件事：找 IDE、准备左右两侧、detached 启动。
 *
 * 「默认 IDE」没有系统级约定 —— macOS 的 LaunchServices 只回答"用哪个应用打开这个文件"，
 * 回答不了"用哪个应用看 diff"。所以按 `ideDiffLaunchers` 那张表探测（PATH 上的启动器 +
 * macOS 应用包里的 CLI），表里没有的 IDE 用 `PI_DESKTOP_DIFF_IDE` 指定。
 *
 * 不用 `git difftool`：它会等编辑器退出，并在编辑器退出后删掉临时文件；如果用户的
 * `difftool.<tool>.cmd` 里没有 `--wait`（例如 `code --diff $LOCAL $REMOTE`），git 启动完
 * 立刻退出就把临时文件删了，IDE 还没读完 —— 不可靠。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, posix as posixPath, win32 as win32Path } from "node:path";

import { fileStatusKind, readChangedEntries, readHeadFileText } from "./gitInfo.mjs";

/** 临时文件都放这里：`<tmpdir>/pi-desktop-diff/<每个文件一个稳定目录>/`。 */
export const DIFF_TEMP_ROOT = "pi-desktop-diff";
/** 超过这个年龄的旧临时目录在下次打开时被清掉（三天），临时目录不会无上限长大。 */
export const DIFF_TEMP_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** 已知的 diff 调用形态；`PI_DESKTOP_DIFF_IDE_KIND` 也只认这几个。 */
export const DIFF_ARG_KINDS = new Set(["vscode", "zed", "sublime", "jetbrains"]);

/** JetBrains 系：启动器名 + macOS 应用包名（同一条命令，`diff <a> <b>` 是子命令）。 */
const JETBRAINS_IDES = [
  { id: "idea", label: "IntelliJ IDEA", launcher: "idea", apps: ["IntelliJ IDEA", "IntelliJ IDEA Ultimate", "IntelliJ IDEA CE", "IntelliJ IDEA Community Edition"] },
  { id: "webstorm", label: "WebStorm", launcher: "webstorm", apps: ["WebStorm"] },
  { id: "pycharm", label: "PyCharm", launcher: "pycharm", apps: ["PyCharm", "PyCharm CE", "PyCharm Professional"] },
  { id: "phpstorm", label: "PhpStorm", launcher: "phpstorm", apps: ["PhpStorm"] },
  { id: "goland", label: "GoLand", launcher: "goland", apps: ["GoLand"] },
  { id: "clion", label: "CLion", launcher: "clion", apps: ["CLion"] },
  { id: "rubymine", label: "RubyMine", launcher: "rubymine", apps: ["RubyMine"] },
  { id: "rider", label: "Rider", launcher: "rider", apps: ["Rider"] },
  { id: "datagrip", label: "DataGrip", launcher: "datagrip", apps: ["DataGrip"] },
];

/**
 * IDE 的 diff 参数。都是"两个文件路径"的形态，唯一分歧是要不要 `--diff`：
 * VS Code 家族 / Zed / Sublime 是 flag，JetBrains 系是 `diff` 子命令。
 *
 * @param {"vscode"|"zed"|"sublime"|"jetbrains"} kind
 */
export function diffArgs(kind, left, right) {
  return kind === "jetbrains" ? ["diff", left, right] : ["--diff", left, right];
}

/**
 * 探测顺序 = 下面的数组顺序：VS Code 家族（最常见）→ Zed → Sublime → JetBrains。
 *
 * 每条 launcher 的 `commands` 是候选启动器（裸名字走 PATH，绝对路径直接检查），
 * 按顺序取第一个存在的；同一个 IDE 的 PATH 启动器排在应用包之前（PATH 上的那个是用户
 * 自己装/链过去的，更贴近"他的默认"）。
 *
 * `appName` 只在 macOS 用：后台进程启动的窗口不一定到前台，打开后用 AppleScript 抬一下。
 */
export function ideDiffLaunchers({ platform = process.platform, homeDir = homedir(), env = process.env } = {}) {
  const appRoots = platform === "darwin" ? ["/Applications", posixPath.join(homeDir, "Applications")] : [];
  // 应用包路径是 macOS 的，Linux 的绝对路径只在 Linux 上有意义 —— 别把宿主平台的路径
  // 混进别的平台的候选里，否的话"探测"就变成了碰运气。
  const linuxOnly = (paths) => (platform === "linux" ? paths : []);
  const inApp = (app, relative) => appRoots.map((root) => posixPath.join(root, `${app}.app`, relative));
  const vscodeBin = (app, cli) => inApp(app, posixPath.join("Contents", "Resources", "app", "bin", cli));
  const appExec = (app, exe) => inApp(app, posixPath.join("Contents", "MacOS", exe));
  const winBin = (program) =>
    platform === "win32"
      ? [win32Path.join(String(env.LOCALAPPDATA ?? win32Path.join(homeDir, "AppData", "Local")), "Programs", program, "bin", "code.cmd")]
      : [];
  const toolbox = posixPath.join(homeDir, "Library", "Application Support", "JetBrains", "Toolbox", "scripts");

  const vscodeFamily = [
    { id: "vscode", label: "Visual Studio Code", kind: "vscode", appName: "Visual Studio Code", commands: ["code", ...vscodeBin("Visual Studio Code", "code"), ...winBin("Microsoft VS Code"), ...linuxOnly(["/usr/share/code/code", "/snap/bin/code"])] },
    { id: "codebuddy", label: "CodeBuddy", kind: "vscode", appName: "CodeBuddy", commands: ["codebuddy", ...vscodeBin("CodeBuddy", "code")] },
    { id: "cursor", label: "Cursor", kind: "vscode", appName: "Cursor", commands: ["cursor", ...vscodeBin("Cursor", "cursor"), ...winBin("cursor")] },
    { id: "windsurf", label: "Windsurf", kind: "vscode", appName: "Windsurf", commands: ["windsurf", ...vscodeBin("Windsurf", "code")] },
    { id: "vscodium", label: "VSCodium", kind: "vscode", appName: "VSCodium", commands: ["codium", "vscodium", ...vscodeBin("VSCodium", "codium"), ...linuxOnly(["/usr/share/codium/codium", "/snap/bin/codium"])] },
  ];

  const others = [
    { id: "zed", label: "Zed", kind: "zed", appName: "Zed", commands: ["zed", ...appExec("Zed", "cli"), ...linuxOnly([posixPath.join(homeDir, ".local", "bin", "zed")])] },
    { id: "sublime", label: "Sublime Text", kind: "sublime", appName: "Sublime Text", commands: ["subl", ...inApp("Sublime Text", posixPath.join("Contents", "SharedSupport", "bin", "subl")), ...linuxOnly(["/usr/bin/subl", "/opt/sublime_text/sublime_text"])] },
  ];

  const jetbrains = JETBRAINS_IDES.map((ide) => ({
    id: ide.id,
    label: ide.label,
    kind: "jetbrains",
    appName: ide.apps[0],
    commands: [ide.launcher, posixPath.join(toolbox, ide.launcher), ...ide.apps.flatMap((app) => appExec(app, ide.launcher))],
  }));

  return [...vscodeFamily, ...others, ...jetbrains];
}

/**
 * PATH 查找。裸名字（如 `code`）才走 PATH；带分隔符的按绝对/相对路径直接用。
 * win32 上按 `;` 切分并按 `PATHEXT` 试扩展名 —— 两处都显式判断平台，测试才能在任意
 * 宿主机上验证 Windows 分支。
 */
export function findOnPath(command, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const name = String(command ?? "").trim();
  if (!name) {
    return null;
  }
  if (name.includes("/") || name.includes("\\")) {
    return exists(name) ? name : null;
  }

  const separator = platform === "win32" ? ";" : ":";
  const pathImpl = platform === "win32" ? win32Path : posixPath;
  const extensions =
    platform === "win32" ? String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];

  for (const directory of String(env.PATH ?? "").split(separator)) {
    if (!directory) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = pathImpl.join(directory, `${name}${extension}`);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * 找出这次要用哪个 IDE 的 diff 命令。
 *
 * `PI_DESKTOP_DIFF_IDE` 一旦设了就只认它（找不到就返回 null，不偷偷退回探测别的 ——
 * 明确指定却静默用别的 IDE 更让人困惑）；`PI_DESKTOP_DIFF_IDE_KIND` 决定参数形态。
 */
export function resolveDiffIde({ platform = process.platform, homeDir = homedir(), env = process.env, exists = existsSync } = {}) {
  const override = String(env.PI_DESKTOP_DIFF_IDE ?? "").trim();
  if (override) {
    const command = findOnPath(override, { env, platform, exists });
    if (!command) {
      return null;
    }
    const requested = String(env.PI_DESKTOP_DIFF_IDE_KIND ?? "").trim();
    return {
      id: "custom",
      label: override,
      kind: DIFF_ARG_KINDS.has(requested) ? requested : "vscode",
      appName: "",
      commands: [command],
      command,
    };
  }

  for (const launcher of ideDiffLaunchers({ platform, homeDir, env })) {
    for (const candidate of launcher.commands) {
      const command = findOnPath(candidate, { env, platform, exists });
      if (command) {
        return { ...launcher, command };
      }
    }
  }
  return null;
}

/**
 * 同一 (项目, 文件) 总是映射到同一个临时目录：重复双击在 IDE 里是同一个 diff 标签，
 * 不会每点一次多开一个；左侧临时文件也是原地覆盖（IDE 按 mtime 重新读）。
 */
export function diffTempDirectory(cwd, filePath, baseDir = tmpdir()) {
  const key = createHash("sha1").update(`${cwd}\u0000${filePath}`).digest("hex").slice(0, 12);
  return join(baseDir, DIFF_TEMP_ROOT, key);
}

/**
 * `a.ts` + `HEAD` → `a (HEAD).ts`：扩展名留在最后，IDE 才会按类型高亮；括号里的标签让
 * diff 的两侧在标签页/标题里一眼可辨（`a (HEAD).ts ↔ a.ts`）。
 * 没有扩展名（`.env`、`Makefile`）就是 `.env (HEAD)`。
 */
export function sideFileName(filePath, label) {
  const name = basename(String(filePath ?? ""));
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem} (${label})${extension}`;
}

/**
 * 该删的旧临时目录（纯函数：mtime 由调用方查好，方便测）。
 * `mtimeMs` 不是数字（stat 失败）的一律不动 —— 宁可留着也不敢删正在用的。
 */
export function staleDiffDirectories(entries, { now = Date.now(), maxAgeMs = DIFF_TEMP_MAX_AGE_MS } = {}) {
  return entries
    .filter((entry) => typeof entry?.mtimeMs === "number" && now - entry.mtimeMs > maxAgeMs)
    .map((entry) => entry.name);
}

/** 清掉过旧的临时目录。清不掉不算失败：这只是打扫，不影响本次打开。 */
export function sweepDiffTemps({ baseDir = tmpdir(), now = Date.now(), maxAgeMs = DIFF_TEMP_MAX_AGE_MS, readdir = readdirSync, stat = statSync, remove = rmSync } = {}) {
  const root = join(baseDir, DIFF_TEMP_ROOT);
  let names;
  try {
    names = readdir(root);
  } catch {
    return [];
  }

  const entries = names.map((name) => {
    try {
      return { name, mtimeMs: stat(join(root, name)).mtimeMs };
    } catch {
      return { name, mtimeMs: null };
    }
  });

  const stale = staleDiffDirectories(entries, { now, maxAgeMs });
  for (const name of stale) {
    try {
      remove(join(root, name), { recursive: true, force: true });
    } catch {
      // 打扫失败无所谓。
    }
  }
  return stale;
}

/**
 * detached 启动，等到 `spawn` 事件就返回：只证明进程起来了，不等它退出。
 * GUI 编辑器常常"把请求转交给已运行的实例后立刻退出"，等退出等于把 HTTP 请求卡住。
 */
export function launchDetached(command, args, { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, { detached: true, stdio: "ignore" });
    } catch (error) {
      reject(error);
      return;
    }

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref?.();
      resolve();
    });
  });
}

/**
 * 后台进程启动的 IDE 不一定到前台；macOS 上补一次 AppleScript 把它抬起来（失败无所谓）。
 * 和 `revealFolder` 对 Finder 的处理同一个理由。
 */
function activateApp(appName, spawnImpl) {
  if (!/^[\w .+-]+$/.test(appName)) {
    return;
  }
  try {
    const child = spawnImpl("osascript", ["-e", `tell application "${appName}" to activate`], { detached: true, stdio: "ignore" });
    child.on?.("error", () => {});
    child.unref?.();
  } catch {
    // 抬不起来不影响 diff 已经打开。
  }
}

/**
 * 打开某个改动文件的 diff，返回 `{ ide, left, right }`（路径给日志和测试用）。
 *
 * 只读：只跑 `status` / `show`，只往 tmpdir 写，不碰工作区、index 和 HEAD。
 * 两侧的来源：
 * - 左侧 = `HEAD:<path>`（重命名取旧路径）。HEAD 里没有这个路径（未跟踪 / 新暂存 / 空仓库）
 *   就是一个空文件，IDE 里于是显示为"整篇都是新增"。
 * - 右侧 = 工作区里的真实文件；已删除时是一个空文件，于是显示为"整篇都是删除"。
 */
export async function openGitFileDiff(
  cwd,
  filePath,
  {
    execImpl,
    timeoutMs,
    platform = process.platform,
    homeDir = homedir(),
    env = process.env,
    exists = existsSync,
    baseDir = tmpdir(),
    now = Date.now(),
    spawnImpl = spawn,
  } = {},
) {
  const project = String(cwd ?? "").trim();
  const relativePath = String(filePath ?? "").trim();
  if (!project || !relativePath) {
    throw new Error("Cannot open a diff without a project folder and a file path");
  }
  if (relativePath.endsWith("/")) {
    throw new Error(`Not a file: ${relativePath}`);
  }

  // 路径必须是 git 刚刚报出来的改动之一（和 commit 同一套校验）：这样拼进 argv / 拼到 cwd
  // 上的路径一定是仓库内的相对路径，客户端传不了别的东西。
  const { header, entries } = await readChangedEntries(project, { execImpl, timeoutMs });
  const entry = entries.find((candidate) => candidate.path === relativePath);
  if (!entry) {
    throw new Error(`Not a changed file: ${relativePath}`);
  }

  const launcher = resolveDiffIde({ platform, homeDir, env, exists });
  if (!launcher) {
    throw new Error(
      "No IDE found to open a diff in. Install VS Code, CodeBuddy, Cursor, Windsurf, VSCodium, Zed, Sublime Text or a JetBrains IDE, or point PI_DESKTOP_DIFF_IDE at one.",
    );
  }

  sweepDiffTemps({ baseDir, now });

  const headText = header.unborn ? null : await readHeadFileText(project, entry.origPath || entry.path, { execImpl, timeoutMs });

  const directory = diffTempDirectory(project, relativePath, baseDir);
  mkdirSync(directory, { recursive: true });

  const left = join(directory, sideFileName(relativePath, headText === null ? "empty" : "HEAD"));
  writeFileSync(left, headText ?? "");

  const working = join(project, relativePath);
  const workingIsFile = (() => {
    try {
      return statSync(working).isFile();
    } catch {
      return false;
    }
  })();

  const status = fileStatusKind(entry);
  const right = workingIsFile
    ? working
    : join(directory, sideFileName(relativePath, status === "deleted" ? "deleted" : "missing"));
  if (!workingIsFile) {
    writeFileSync(right, "");
  }

  await launchDetached(launcher.command, diffArgs(launcher.kind, left, right), { spawnImpl });
  if (platform === "darwin" && launcher.appName) {
    activateApp(launcher.appName, spawnImpl);
  }

  return { ide: launcher.id, label: launcher.label, left, right };
}