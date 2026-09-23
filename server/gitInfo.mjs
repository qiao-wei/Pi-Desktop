/**
 * 当前项目的 Git 信息（会话头部右侧那枚 git 徽标的数据源）。
 *
 * 方案 A：spawn 宿主机自己的 `git`。不打包 git、不重写 git —— 徽标显示的必须和用户在
 * 自己终端里看到的一致，而 `status` / `diff` / `for-each-ref` 恰好就是 UI 要问的那几个
 * 问题。渲染层永不执行 git，它通过 `GET /api/git` 读这个模块，于是 Electron、Tauri 和
 * 浏览器 dev 宿主拿到的是同一个进程（也就是唯一拥有真实 cwd 的那个）给出的同一份答案。
 *
 * 本模块守两条规矩：
 * - 所有 argv 都在这里拼。`READ_ONLY_SUBCOMMANDS` 是 `runReadOnlyGit` 执行的只读白名单，
 *   以后有人想在读路径里夹带 `commit`/`checkout`/`push` 会被直接拒绝。
 * - `git init`（`initGitRepo`）、`git switch`（`switchGitBranch`）、`git switch -c`
 *   （`createGitBranch`）、`git branch -m`（`renameGitBranch`）和 `git commit`
 *   （`commitGitChanges`）是本功能仅有的五个写操作：都不走
 *   只读 helper，只在用户点按钮/点分支/改名/写提交信息后触发。切分支前先拿 `for-each-ref` 对一遍
 *   本地分支名，提交前先拿 `status` 对一遍改动文件路径 —— 目标必须是 git 刚刚报出来的东西。
 *   新建分支是唯一一处用户输入要进 argv 正题的地方（分支名本来就是要新建的东西，没有现成
 *   清单可对），所以它过 `isSafeBranchName`，再用 `for-each-ref` 确认不重名。
 *
 * 不需要子进程就能判断的部分全部是下面导出的纯解析函数，`node --test` 直接对 porcelain
 * 文本做用例，不依赖机器上装没装 git。
 */
import { execFile } from "node:child_process";
import { openSync, closeSync, readSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 单条 git 命令的超时（毫秒）。大仓库 `git status` 可能到秒级，给足余量但不无限等。 */
export const GIT_TIMEOUT_MS = 5000;

/**
 * 只读子命令白名单。故意不含 `init`：写操作走 `initGitRepo` 的独立通道。
 * `show` 只用来读 `HEAD:<path>` 的旧内容（双击改动文件打开 IDE diff 时的左侧），不改任何东西。
 */
export const READ_ONLY_SUBCOMMANDS = new Set(["rev-parse", "status", "diff", "for-each-ref", "log", "show"]);

/**
 * 会碰磁盘或执行外部程序的参数。本模块的 argv 都是自己拼的，这层是纵深防御：
 * 万一以后有人把参数接到输入上，`diff --output=x` 也进不来。
 */
const WRITE_FLAGS = [/^--output/, /^--ext-diff$/, /^--no-index$/];

export function isReadOnlyGitArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return false;
  }

  const [subcommand, ...rest] = args;
  if (typeof subcommand !== "string" || !READ_ONLY_SUBCOMMANDS.has(subcommand)) {
    return false;
  }

  return rest.every(
    (arg) =>
      typeof arg === "string" &&
      arg.length > 0 &&
      !arg.includes("\0") &&
      !WRITE_FLAGS.some((pattern) => pattern.test(arg)),
  );
}

/** `execFile` 的 promise 包装：spawn 失败和非零退出都变成数据，不 reject。 */
function execFileResult(command, args, options, execImpl) {
  return new Promise((resolve) => {
    execImpl(command, args, options, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        // 非零退出时是退出码；spawn 失败（ENOENT 等）时是字符串。
        code: error?.code,
        killed: Boolean(error?.killed),
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

/** 环境：不抢用户的 index.lock，也不让 git 交互式等输入。 */
function gitEnv() {
  return { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
}

/**
 * 绑定好 exec 实现的 `git` 调用器。
 *
 * 存在的唯一理由是避坑：`execFileResult` 有 4 个参数，`execImpl` 是最后一个，直接调很容易
 * 漏传（漏了就是 undefined 被当函数调）。这里建一次、后面只传 argv，漏不掉；测试注入的
 * 假 execFile 也只会通过这一个口子生效。
 */
function gitRunner({ execImpl = execFile, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return (args, options = {}) =>
    execFileResult(
      "git",
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: gitEnv(),
        ...options,
      },
      execImpl,
    );
}

/**
 * 跑一条只读 git 命令。cwd 通过 spawn 的 `cwd` 选项传，不拼进 argv（路径里的空格、
 * 引号、`-` 开头都不会变成参数）。
 */
export async function runReadOnlyGit(cwd, args, options = {}) {
  if (!isReadOnlyGitArgs(args)) {
    throw new Error(`refusing to run non read-only git command: git ${args.join(" ")}`);
  }

  return gitRunner(options)(args, { cwd });
}

/** 空载荷：没装 git，或项目不是仓库。UI 靠 `gitInstalled` / `isRepo` 决定显示什么。 */
export function emptyGitInfo({ gitInstalled = true, gitVersion = "", isRepo = false } = {}) {
  return {
    gitInstalled,
    gitVersion,
    isRepo,
    branch: "",
    oid: "",
    detached: false,
    unborn: false,
    upstream: "",
    ahead: 0,
    behind: 0,
    files: [],
    added: 0,
    removed: 0,
    branches: [],
  };
}

/**
 * `status --porcelain=v2 --branch -z` 里以 `# ` 开头的头信息。
 * 注意 `-z` 下头信息也是用 NUL 分隔的，所以调用方先按 "\0" 切开再逐块解析。
 */
export function parseBranchHeader(chunks) {
  const info = { branch: "", oid: "", detached: false, unborn: false, upstream: "", ahead: 0, behind: 0 };

  for (const chunk of chunks) {
    if (chunk.startsWith("# branch.oid ")) {
      const oid = chunk.slice("# branch.oid ".length).trim();
      info.unborn = oid === "(initial)";
      if (!info.unborn) {
        info.oid = oid;
      }
    } else if (chunk.startsWith("# branch.head ")) {
      const head = chunk.slice("# branch.head ".length).trim();
      if (head === "(detached)") {
        info.detached = true;
      } else {
        info.branch = head;
      }
    } else if (chunk.startsWith("# branch.upstream ")) {
      info.upstream = chunk.slice("# branch.upstream ".length).trim();
    } else if (chunk.startsWith("# branch.ab ")) {
      const match = /\+(\d+)\s+-(\d+)/.exec(chunk);
      if (match) {
        info.ahead = Number(match[1]);
        info.behind = Number(match[2]);
      }
    }
  }

  return info;
}

/**
 * `status --porcelain=v2 -z` 的变更条目 → `{ path, indexStatus, worktreeStatus, ... }`。
 * 记录格式（`-z` 下每条以 NUL 结尾；`2` 的重命名原路径单独占一个 NUL 块）：
 * - `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
 * - `2 <XY> <sub> ... <X><score> <path>` + 紧随其后的 `<origPath>`
 * - `u <XY> <sub> <m1..mW> <h1..h3> <path>`
 * - `? <path>`
 */
export function parsePorcelainV2(chunks) {
  const files = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk || chunk.startsWith("# ")) {
      continue;
    }

    if (chunk.startsWith("? ")) {
      files.push({ path: chunk.slice(2), origPath: "", indexStatus: "?", worktreeStatus: "?", untracked: true, conflicted: false });
      continue;
    }

    const unmerged = /^u ([^\s]{2}) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(chunk);
    if (unmerged) {
      files.push({
        path: unmerged[2],
        origPath: "",
        indexStatus: unmerged[1][0],
        worktreeStatus: unmerged[1][1],
        untracked: false,
        conflicted: true,
      });
      continue;
    }

    const renamed = /^2 ([^\s]{2}) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(chunk);
    if (renamed) {
      // 重命名条目的原路径是下一个 NUL 块，消费掉它再继续。
      const origPath = chunks[index + 1] ?? "";
      index += 1;
      files.push({
        path: renamed[2],
        origPath,
        indexStatus: renamed[1][0],
        worktreeStatus: renamed[1][1],
        untracked: false,
        conflicted: false,
      });
      continue;
    }

    const ordinary = /^1 ([^\s]{2}) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(chunk);
    if (ordinary) {
      files.push({
        path: ordinary[2],
        origPath: "",
        indexStatus: ordinary[1][0],
        worktreeStatus: ordinary[1][1],
        untracked: false,
        conflicted: false,
      });
    }
  }

  return files;
}

/** 一个条目在 UI 里归成哪一类。 */
export function fileStatusKind(entry) {
  if (entry.untracked) {
    return "untracked";
  }
  if (entry.conflicted) {
    return "conflicted";
  }

  const code = `${entry.indexStatus}${entry.worktreeStatus}`;
  if (code.includes("R") || code.includes("C")) {
    return "renamed";
  }
  if (code.includes("D")) {
    return "deleted";
  }
  if (code.includes("A")) {
    return "added";
  }
  if (code.includes("U")) {
    return "conflicted";
  }
  return "modified";
}

/** 是否已进入暂存区（index 侧不算未修改/未跟踪；冲突条目不计，它的 index 位是冲突段不是一次暂存）。 */
export function isStaged(entry) {
  if (entry.untracked || entry.conflicted) {
    return false;
  }

  return entry.indexStatus !== "." && entry.indexStatus !== "?";
}

/** `diff --numstat -z` → `path -> { added, removed }`（二进制文件是 0/0）。
 *
 * 重命名记录形如 `<added>\t<removed>\t\0<旧路径>\0<新路径>`（路径字段为空，两个路径各占一个
 * NUL 块），计数归到**新**路径，这样它和 `status` 里的重命名条目对得上，总数也和
 * `git diff --shortstat` 一致（纯重命名算 0 增 0 删）。
 */
export function parseNumstat(text) {
  const chunks = String(text ?? "").split("\0");
  const counts = new Map();

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk) {
      continue;
    }

    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(chunk);
    if (!match) {
      continue;
    }

    const added = match[1] === "-" ? 0 : Number(match[1]);
    const removed = match[2] === "-" ? 0 : Number(match[2]);
    if (match[3]) {
      counts.set(match[3], { added, removed });
      continue;
    }

    const renamedPath = chunks[index + 2] ?? "";
    index += 2;
    if (renamedPath) {
      counts.set(renamedPath, { added, removed });
    }
  }

  return counts;
}

/** 把状态条目和行数合成 UI 用的列表，并算总增删。 */
export function summarizeChanges(entries, counts = new Map()) {
  const files = entries.map((entry) => {
    const lines = counts.get(entry.path) ?? { added: 0, removed: 0 };
    return {
      path: entry.path,
      origPath: entry.origPath ?? "",
      status: fileStatusKind(entry),
      staged: isStaged(entry),
      untracked: Boolean(entry.untracked),
      conflicted: Boolean(entry.conflicted),
      added: lines.added,
      removed: lines.removed,
    };
  });

  files.sort((left, right) => left.path.localeCompare(right.path));

  return {
    files,
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
  };
}

/** `%(upstream:track)` → `{ ahead, behind, gone }`。输出形如 `[ahead 1, behind 2]` / `[gone]`。 */
export function parseUpstreamTrack(track) {
  const text = String(track ?? "");
  const ahead = /ahead (\d+)/.exec(text);
  const behind = /behind (\d+)/.exec(text);

  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: text.includes("gone"),
  };
}

/** `for-each-ref --format=%(HEAD)\t%(refname:short)\t%(upstream:short)\t%(upstream:track) refs/heads` */
export function parseBranches(text) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [head = "", name = "", upstream = "", track = ""] = line.split("\t");
      const { ahead, behind, gone } = parseUpstreamTrack(track);
      return { name: name.trim(), current: head.trim() === "*", upstream: upstream.trim(), ahead, behind, gone };
    })
    .filter((branch) => branch.name.length > 0);
}

const BRANCH_FORMAT = "%(HEAD)%09%(refname:short)%09%(upstream:short)%09%(upstream:track)";

/** 提交信息的长度上限（git 自己能存更长，但 UI 上没理由接受无限的文本）。 */
export const MAX_COMMIT_MESSAGE_CHARS = 8192;

/** 一次提交最多允许选中的路径数（含重命名的旧路径）。 */
export const MAX_COMMIT_PATHS = 1000;

/** 给模型看的 diff 上限（字符）。超了就截断并在 prompt 里注明。 */
export const MAX_COMMIT_PATCH_CHARS = 24000;

/** 未跟踪文件在内文里最多展示多少字符 / 多少字节的文件才读 / 最多读几个。 */
export const MAX_NEW_FILE_CHARS = 4000;
export const MAX_NEW_FILE_BYTES = 64000;
export const MAX_NEW_FILES = 20;

/** 提交信息校验：非空、无 NUL、不超长。 */
export function normalizeCommitMessage(message) {
  const text = String(message ?? "").trim();
  if (!text) {
    throw new Error("Commit message is required");
  }
  if (text.includes("\u0000")) {
    throw new Error("Commit message cannot contain NUL");
  }
  if (text.length > MAX_COMMIT_MESSAGE_CHARS) {
    throw new Error(`Commit message is too long (max ${MAX_COMMIT_MESSAGE_CHARS} characters)`);
  }

  return text;
}

/**
 * 可以用 `status` 输出校验提交路径的“允许集合”。
 *
 * 重命名的**旧路径**也要放进去：只提交新路径会得到一个“新文件”，旧文件还留在树里。
 * 冲突条目一律排除 —— 对冲突路径 `git add` 等于宣告冲突已解决，这是最危险的一步，绝不能
 * 由"勾选一个框"隐式发生。
 */
export function commitablePaths(entries) {
  const paths = new Set();
  const conflicted = new Set();
  for (const entry of entries) {
    if (entry.conflicted) {
      conflicted.add(entry.path);
      continue;
    }
    paths.add(entry.path);
    if (entry.origPath) {
      paths.add(entry.origPath);
    }
  }

  return { paths, conflicted };
}

/** 未知子命令时的 stderr（老 git 没 `switch`，要退回 `checkout`）。 */
export function isUnknownGitSubcommand(stderr) {
  return /is not a git command/.test(String(stderr ?? ""));
}

/**
 * 分支名安全校验：不接受空、前导 `-`（会被 git 当成选项）、控制字符/NUL。
 * 真正的"这分支存在吗"由 `switchGitBranch` 用本地分支列表回答。
 */
export function isSafeBranchName(name) {
  const value = String(name ?? "");
  if (!value || value.startsWith("-") || value.includes("\u0000")) {
    return false;
  }

  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(value);
}

function gitFailureReason(result) {
  return (result.stderr || result.stdout).trim() || (result.killed ? "git timed out" : `git failed (${result.code})`);
}

/** `git version 2.39.5 (Apple Git-154)` → `2.39.5`（拿不到就返回空串）。 */
export function parseGitVersion(text) {
  const match = /git version (\S+)/.exec(String(text ?? ""));
  return match ? match[1] : "";
}

/**
 * 项目文件夹的完整 git 信息。
 *
 * 两步探测，因为 `execFile` 的 ENOENT 同时代表"没有 git"和"cwd 不存在"：
 * 1. `git --version`（在 tmpdir 里跑，不依赖项目路径）→ 宿主机装没装 git；
 * 2. `git -C <项目> rev-parse --is-inside-work-tree` → 项目是不是仓库。
 */
export async function readGitInfo(cwd, { execImpl = execFile, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  // `--version` 不是子命令，走 gitRunner 直接调；其余全部经过只读白名单。
  const git = gitRunner({ execImpl, timeoutMs });
  const options = { execImpl, timeoutMs };

  // 真正的"没装"只有 spawn 失败（ENOENT / EACCES）这一种；`git --version` 退出码非零
  // 也当成没装（那是坏掉的/被拦截的 git）。
  const gitVersion = await readGitVersion(git);
  if (gitVersion === null) {
    return emptyGitInfo({ gitInstalled: false });
  }

  const project = String(cwd ?? "").trim();
  if (!project) {
    return emptyGitInfo({ gitVersion });
  }

  const repo = await runReadOnlyGit(project, ["rev-parse", "--is-inside-work-tree"], options);
  if (!repo.ok || repo.stdout.trim() !== "true") {
    return emptyGitInfo({ gitVersion });
  }

  const status = await runReadOnlyGit(
    project,
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"],
    options,
  );
  const chunks = status.stdout.split("\0");
  const header = parseBranchHeader(chunks);
  const counts = await readLineCounts(project, options);
  const { files, added, removed } = summarizeChanges(parsePorcelainV2(chunks), counts);

  const branches = await runReadOnlyGit(project, ["for-each-ref", `--format=${BRANCH_FORMAT}`, "refs/heads"], options);

  return {
    gitInstalled: true,
    gitVersion,
    isRepo: true,
    branch: header.branch,
    oid: header.oid,
    detached: header.detached,
    unborn: header.unborn,
    upstream: header.upstream,
    ahead: header.ahead,
    behind: header.behind,
    files,
    added,
    removed,
    branches: branches.ok ? parseBranches(branches.stdout) : [],
  };
}

/** `git --version`；返回版本号，没装 git 时返回 null。 */
async function readGitVersion(git) {
  const version = await git(["--version"], { cwd: tmpdir() });

  if (!version.ok) {
    return null;
  }

  return parseGitVersion(version.stdout);
}

/**
 * 相对 HEAD 的逐文件增删。
 *
 * 空仓库（还没有第一个 commit）里 `diff HEAD` 会以 "ambiguous argument 'HEAD'" 失败，
 * 这时退回"工作区 vs 索引"+"索引 vs 空树"，语义仍然是"这个项目当前改了多少行"。
 */
async function readLineCounts(cwd, options) {
  const args = ["diff", "HEAD", "--numstat", "-z"];
  const head = await runReadOnlyGit(cwd, args, options);
  if (head.ok) {
    return parseNumstat(head.stdout);
  }

  const [worktree, staged] = await Promise.all([
    runReadOnlyGit(cwd, ["diff", "--numstat", "-z"], options),
    runReadOnlyGit(cwd, ["diff", "--cached", "--numstat", "-z"], options),
  ]);

  const counts = parseNumstat(staged.ok ? staged.stdout : "");
  for (const [path, lines] of parseNumstat(worktree.ok ? worktree.stdout : "")) {
    counts.set(path, lines);
  }
  return counts;
}

/**
 * `git init` —— 本功能唯一的写操作，只在用户点按钮时调用。
 *
 * 不传 `-b`：分支名交给用户自己的 `init.defaultBranch`（没配就是 git 的默认值），
 * 和他在终端里敲 `git init` 得到的结果一致。
 */
export async function initGitRepo(cwd, { execImpl = execFile, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const project = String(cwd ?? "").trim();
  if (!project) {
    throw new Error("Cannot initialize git without a project folder");
  }

  const result = await gitRunner({ execImpl, timeoutMs })(["init"], { cwd: project });

  if (!result.ok) {
    const reason = result.stderr.trim() || (result.killed ? "git init timed out" : `git init failed (${result.code})`);
    throw new Error(reason);
  }

  return result.stdout.trim();
}

/**
 * 切换分支（`git switch <branch>`，老 git 退回 `git checkout <branch>`）。
 *
 * 两道门：
 * 1. 分支名必须通过 `isSafeBranchName`；
 * 2. 必须出现在本地分支列表里 —— 目标不是用户随便传的字符串。
 *
 * 脏工作区不在这里拦：git 自己会在"切换会覆盖本地改动"时拒绝，把它的原文当错误抛出
 * （保留了 git 的建议，也不存在"我们以为会丢改动"的误判）。UI 那边脏树时会先弹确认。
 */
export async function switchGitBranch(cwd, branch, { execImpl = execFile, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const project = String(cwd ?? "").trim();
  if (!project) {
    throw new Error("Cannot switch branches without a project folder");
  }

  const target = String(branch ?? "").trim();
  if (!isSafeBranchName(target)) {
    throw new Error(`Invalid branch name: ${target || "(empty)"}`);
  }

  const options = { execImpl, timeoutMs };
  const git = gitRunner(options);

  const listed = await runReadOnlyGit(project, ["for-each-ref", `--format=${BRANCH_FORMAT}`, "refs/heads"], options);
  const branches = parseBranches(listed.ok ? listed.stdout : "");
  if (!branches.some((candidate) => candidate.name === target)) {
    throw new Error(`Unknown branch: ${target}`);
  }
  if (branches.some((candidate) => candidate.current && candidate.name === target)) {
    return;
  }

  const switched = await git(["switch", target], { cwd: project });
  if (switched.ok) {
    return;
  }
  if (!isUnknownGitSubcommand(switched.stderr)) {
    throw new Error(gitFailureReason(switched));
  }

  const checkedOut = await git(["checkout", target], { cwd: project });
  if (!checkedOut.ok) {
    throw new Error(gitFailureReason(checkedOut));
  }
}

/**
 * 从当前 HEAD 新建分支并切过去（`git switch -c <name>`，老 git 退回 `git checkout -b <name>`）。
 *
 * 基线固定是**当前分支**：接口只收一个新名字，起点不是参数，用户也就无从指定别处。
 * 两道校验：名字必须过 `isSafeBranchName`（防前导 `-` 被当成选项）、不能和已有本地分支重名
 * （比 git 自己的 "a branch named X already exists" 更好懂，也让「不小心覆盖已有分支」不可能）。
 * 新分支指向当前 commit，工作区内容不变，所以脏树不需要确认框 —— git 也不会丢任何改动。
 */
export async function createGitBranch(cwd, name, { execImpl = execFile, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const project = String(cwd ?? "").trim();
  if (!project) {
    throw new Error("Cannot create a branch without a project folder");
  }

  const target = String(name ?? "").trim();
  if (!isSafeBranchName(target)) {
    throw new Error(`Invalid branch name: ${target || "(empty)"}`);
  }

  const options = { execImpl, timeoutMs };
  const git = gitRunner(options);

  const listed = await runReadOnlyGit(project, ["for-each-ref", `--format=${BRANCH_FORMAT}`, "refs/heads"], options);
  const branches = parseBranches(listed.ok ? listed.stdout : "");
  if (branches.some((candidate) => candidate.name === target)) {
    throw new Error(`Branch already exists: ${target}`);
  }

  const created = await git(["switch", "-c", target], { cwd: project });
  if (created.ok) {
    return created.stdout.trim() || created.stderr.trim();
  }
  if (!isUnknownGitSubcommand(created.stderr)) {
    throw new Error(gitFailureReason(created));
  }

  const checkedOut = await git(["checkout", "-b", target], { cwd: project });
  if (!checkedOut.ok) {
    throw new Error(gitFailureReason(checkedOut));
  }

  return checkedOut.stdout.trim() || checkedOut.stderr.trim();
}

/**
 * 给**当前分支**改名（`git branch -m <newName>`）。
 *
 * 只改当前分支：交互入口是徽标标题上那一个分支名（也就是 HEAD 所在的分支），接口里没有
 * 旧名字这个参数，用户也就无从改到别的分支上。两道校验：名字过 `isSafeBranchName`
 * （防前导 `-` 被当成选项）、不和已有本地分支重名（比 git 自己的 "a branch named X
 * already exists" 更好懂）。同名直接当成功 —— git 自己也是成功的空操作。
 *
 * 游离 HEAD 时 git 会拒绝（"cannot rename the current branch while not on any"），
 * 原文照抛；空仓库（unborn）里 git 支持给未出生的分支改名，照常放行。
 */
export async function renameGitBranch(cwd, name, { execImpl = execFile, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const project = String(cwd ?? "").trim();
  if (!project) {
    throw new Error("Cannot rename a branch without a project folder");
  }

  const target = String(name ?? "").trim();
  if (!isSafeBranchName(target)) {
    throw new Error(`Invalid branch name: ${target || "(empty)"}`);
  }

  const options = { execImpl, timeoutMs };
  const git = gitRunner(options);

  const listed = await runReadOnlyGit(project, ["for-each-ref", `--format=${BRANCH_FORMAT}`, "refs/heads"], options);
  const branches = parseBranches(listed.ok ? listed.stdout : "");
  const current = branches.find((branch) => branch.current);
  if (current && current.name === target) {
    return "";
  }
  if (branches.some((branch) => !branch.current && branch.name === target)) {
    throw new Error(`Branch already exists: ${target}`);
  }

  const renamed = await git(["branch", "-m", target], { cwd: project });
  if (!renamed.ok) {
    throw new Error(gitFailureReason(renamed));
  }

  return renamed.stdout.trim();
}

/**
 * 提交选中的改动。
 *
 * 语义是"把这几个文件按磁盘上的样子提交"（和弹层里显示的行数一致）：
 * 1. `git commit -m <msg> -- <paths>` 本身就是部分提交：被列出的路径取**工作区**内容，
 *    因此修改/删除/重命名不需要先 `add`（实测：对已暂存的重命名/删除再 `git add` 反而会以
 *    "pathspec did not match" fatal）；
 * 2. 只有**未跟踪**的文件必须先 `git add` —— 否则 `commit -- <未跟踪路径>` 报
 *    "pathspec did not match any file(s) known to git"；
 * 3. 没被选中的文件一律不受影响：别人在终端里暂存的其它文件不会被卷进来。
 *
 * 路径必须来自刚刚的 `status` 输出，且冲突文件直接拒绝（见 `commitablePaths`）。
 */
export async function commitGitChanges(cwd, { message, paths } = {}, { execImpl = execFile, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const project = String(cwd ?? "").trim();
  if (!project) {
    throw new Error("Cannot commit without a project folder");
  }

  const text = normalizeCommitMessage(message);
  const requested = Array.isArray(paths) ? paths.map((path) => String(path)) : [];
  if (requested.length === 0) {
    throw new Error("Select at least one file to commit");
  }
  if (requested.length > MAX_COMMIT_PATHS) {
    throw new Error(`Too many paths to commit (max ${MAX_COMMIT_PATHS})`);
  }

  const options = { execImpl, timeoutMs };
  const git = gitRunner(options);

  const status = await runReadOnlyGit(
    project,
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"],
    options,
  );
  if (!status.ok) {
    throw new Error(gitFailureReason(status));
  }

  const entries = parsePorcelainV2(status.stdout.split("\u0000"));
  const { paths: allowed, conflicted } = commitablePaths(entries);
  const requestedPaths = [...new Set(requested)];
  for (const path of requestedPaths) {
    if (conflicted.has(path)) {
      throw new Error(`Resolve conflicts before committing: ${path}`);
    }
    if (!allowed.has(path)) {
      throw new Error(`Not a changed file: ${path}`);
    }
  }

  // 重命名由服务端自己补齐旧路径（只提交新路径会留下半个重命名），最后排一次序：
  // argv 稳定，和用户勾选顺序无关。
  const renames = new Map(entries.filter((entry) => entry.origPath).map((entry) => [entry.path, entry.origPath]));
  const chosen = [...new Set(requestedPaths.flatMap((path) => [path, renames.get(path)].filter(Boolean)))].sort();

  const untracked = [...new Set(requestedPaths)].filter((path) => entries.some((entry) => entry.path === path && entry.untracked)).sort();
  if (untracked.length > 0) {
    const added = await git(["add", "--", ...untracked], { cwd: project });
    if (!added.ok) {
      throw new Error(gitFailureReason(added));
    }
  }

  const committed = await git(["commit", "-m", text, "--", ...chosen], { cwd: project });
  if (!committed.ok) {
    throw new Error(gitFailureReason(committed));
  }

  return committed.stdout.trim() || committed.stderr.trim();
}
/**
 * 一步拿到 `status --porcelain=v2 --branch -z` 的头信息与改动条目。
 *
 * 和写操作（`commitGitChanges`）用的是同一份 status 输出，所以"这个路径是当前改动"这层校验
 * 在读写两条路上是同一条事实。
 */
export async function readChangedEntries(cwd, { execImpl = execFile, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const project = String(cwd ?? "").trim();
  if (!project) {
    throw new Error("Cannot read git status without a project folder");
  }

  const status = await runReadOnlyGit(
    project,
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"],
    { execImpl, timeoutMs },
  );
  if (!status.ok) {
    throw new Error(gitFailureReason(status));
  }

  const chunks = status.stdout.split("\u0000");
  return { header: parseBranchHeader(chunks), entries: parsePorcelainV2(chunks) };
}

/**
 * 读 `HEAD:<path>` 的旧内容（双击改动文件打开 IDE diff 时的左侧）。
 *
 * 返回 `null` 表示这个路径在 HEAD 里没有 —— 未跟踪文件、刚 `add` 的新文件、还没有任何提交的
 * 空仓库都会走到这里；那种情况下左侧就该是一个空文件（IDE 里显示为"整篇都是新增"）。
 * 文件大到 `maxBuffer` 装不下时抛错，而不是安静地当成"HEAD 里没有"——否则一份大文件会被
 * 显示成整篇新增，是在骗人。
 */
export async function readHeadFileText(cwd, path, { execImpl = execFile, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const project = String(cwd ?? "").trim();
  const target = String(path ?? "").trim();
  if (!project || !target) {
    throw new Error("Cannot read a file from HEAD without a project folder and a path");
  }

  const result = await runReadOnlyGit(project, ["show", `HEAD:${target}`], { execImpl, timeoutMs });
  if (result.ok) {
    return result.stdout;
  }
  if (result.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    throw new Error(`File is too large to diff: ${target}`);
  }
  return null;
}

/**
 * 给"智能生成提交信息"用的上下文：改动清单 + 补丁 + 新文件内容摘录。
 *
 * 为什么单独一个函数而不是直接用 `readGitInfo`：
 * - 补丁只需要**选中要提交的那几个路径**（没勾的文件不该影响提交信息）；
 * - 未跟踪文件不在 `git diff HEAD` 里，得单独读一小段内容 —— 新功能文件恰恰是最需要被
 *   描述的东西；
 * - 全部有上限（补丁 24k 字符、单文件 4k 字符、最多 20 个新文件），大仓库不能把整个 diff
 *   塞进模型。
 */
export async function readCommitDiff(cwd, paths, { execImpl = execFile, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const project = String(cwd ?? "").trim();
  if (!project) {
    throw new Error("Cannot read a diff without a project folder");
  }

  const options = { execImpl, timeoutMs };
  const status = await runReadOnlyGit(
    project,
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"],
    options,
  );
  if (!status.ok) {
    throw new Error(gitFailureReason(status));
  }

  const chunks = status.stdout.split("\u0000");
  const header = parseBranchHeader(chunks);
  const entries = parsePorcelainV2(chunks);
  const counts = await readLineCounts(project, options);
  const { files } = summarizeChanges(entries, counts);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));

  const requested = Array.isArray(paths) && paths.length > 0 ? [...new Set(paths.map((path) => String(path)))] : null;
  const conflictedForRequest = requested ? requested.filter((path) => byPath.get(path)?.conflicted) : [];
  if (conflictedForRequest.length > 0) {
    throw new Error(`Resolve conflicts before describing the commit: ${conflictedForRequest.join(", ")}`);
  }

  const selected = requested
    ? files.filter((file) => requested.includes(file.path))
    : files.filter((file) => !file.conflicted);
  const unknown = requested?.filter((path) => !byPath.has(path)) ?? [];
  if (selected.length === 0) {
    throw new Error(unknown.length > 0 ? `Not a changed file: ${unknown[0]}` : "Nothing to describe");
  }

  const tracked = selected.filter((file) => !file.untracked).map((file) => file.path);
  const renamed = selected.flatMap((file) => (file.origPath ? [file.origPath] : []));

  let patch = "";
  if (tracked.length > 0 || renamed.length > 0) {
    const diff = await runReadOnlyGit(project, ["diff", "HEAD", "--", ...tracked, ...renamed], options);
    if (!diff.ok && !isUnknownGitSubcommand(diff.stderr) && !/ambiguous argument 'HEAD'/.test(diff.stderr)) {
      throw new Error(gitFailureReason(diff));
    }
    patch = diff.stdout;
  }

  const patchTruncated = patch.length > MAX_COMMIT_PATCH_CHARS;
  if (patchTruncated) {
    patch = `${patch.slice(0, MAX_COMMIT_PATCH_CHARS)}\n…（补丁已截断）`;
  }

  return {
    branch: header.branch,
    detached: header.detached,
    unborn: header.unborn,
    files: selected.map((file) => ({
      path: file.path,
      origPath: file.origPath,
      status: file.status,
      staged: file.staged,
      added: file.added,
      removed: file.removed,
    })),
    skippedUntrackedDirs: selected.filter((file) => file.untracked && file.path.endsWith("/")).map((file) => file.path),
    newFiles: readNewFileExcerpts(project, selected.filter((file) => file.untracked && !file.path.endsWith("/"))),
    patch,
    patchTruncated,
  };
}

/** 未跟踪文件的内容摘录：只读前几 KB，二进制（含 NUL）直接跳过。 */
function readNewFileExcerpts(project, files) {
  return files.slice(0, MAX_NEW_FILES).map((file) => {
    const absolute = join(project, file.path);
    try {
      if (!statSync(absolute).isFile() || statSync(absolute).size > MAX_NEW_FILE_BYTES) {
        return { path: file.path, text: "", truncated: true };
      }
      const buffer = Buffer.alloc(MAX_NEW_FILE_BYTES);
      const handle = openSync(absolute, "r");
      let bytes = 0;
      try {
        bytes = readSync(handle, buffer, 0, buffer.length, 0);
      } finally {
        closeSync(handle);
      }
      const sample = buffer.subarray(0, bytes);
      if (sample.includes(0)) {
        return { path: file.path, text: "", truncated: true };
      }
      const text = sample.toString("utf8");
      const truncated = text.length > MAX_NEW_FILE_CHARS;
      return { path: file.path, text: truncated ? text.slice(0, MAX_NEW_FILE_CHARS) : text, truncated };
    } catch {
      return { path: file.path, text: "", truncated: true };
    }
  });
}
