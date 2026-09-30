/**
 * 「给一个项目目录，猜出能怎么跑起来」。
 *
 * 规则表住在这里（不进 `server/index.mjs`），每条规则**只读文件、不执行任何东西** ——
 * 探测本身是纯读操作，真正的执行在 `runProjectCommand.mjs`，且只在用户点「运行」时才发生。
 *
 * 优先级沿用「越显式越靠前」：
 *   显式运行声明（Procfile / docker compose / justfile / Taskfile / Makefile）
 *   > 包管理器脚本（package.json / pyproject 的 scripts）—— 根**全部**脚本 + 子包脚本，
 *     「像启动命令的」（dev / start:dev / serve…）在前，「其余脚本」在后
 *   > 语言入口约定（go.mod / Cargo.toml / manage.py / mix.exs / pom.xml …）
 *   > 兜底（静态站）。
 * 同一条「命令 + 工作目录」只留一条。
 *
 * 所有文件访问都走 `probe` 这个小小的文件接口，测试里塞假 probe 即可覆盖各种项目类型，
 * 不需要真的建目录树。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { PROJECT_COMMAND_LIMIT, projectCommandId } from "../src/shared/projectCommands.ts";

/** 真实文件系统上的探测接口。 */
export function createProjectProbe(cwd) {
  const root = String(cwd ?? "");
  return {
    has(relative) {
      return existsSync(join(root, relative));
    },
    isDir(relative = "") {
      try {
        return statSync(join(root, relative)).isDirectory();
      } catch {
        return false;
      }
    },
    list(relative = "") {
      try {
        return readdirSync(join(root, relative));
      } catch {
        return [];
      }
    },
    readText(relative) {
      try {
        return readFileSync(join(root, relative), "utf8");
      } catch {
        return "";
      }
    },
  };
}

/** 脚本名偏好：越靠前越像"开发服务器"。 */
const SCRIPT_PREFERENCE = ["dev", "develop", "start", "serve", "watch", "preview"];
/** 以这些词开头的脚本（`start:dev` / `dev:renderer`）同样是启动命令。 */
const SCRIPT_HEADS = ["dev", "develop", "start", "serve", "watch", "preview", "run"];
/** 「其余脚本」的起始分值：`build` / `test` / `lint` / `vendor:…` 这类摆在前者后面。 */
const SCRIPT_RANK_OTHER = 30;
/** 像启动命令的脚本从这里起排；子包依次 +1（根 > 已声明 workspace > 顺带发现的子包）。 */
const NODE_SCRIPT_BASE = 30;
/** 「其余脚本」从这里起排，按 根 / 声明子包 / 发现子包 每档 +10。 */
const NODE_SCRIPT_OTHER = 100;

const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const JUST_FILES = ["justfile", "Justfile", ".justfile"];
const TASK_FILES = ["Taskfile.yml", "Taskfile.yaml", "taskfile.yml", "taskfile.yaml", "Taskfile.dist.yml"];
const MAKE_FILES = ["Makefile", "makefile", "GNUmakefile"];

/** 有这些文件之一就说明这是个“有构建/依赖体系”的项目，不是纯静态站。 */
const PROJECT_MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "mix.exs",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "pubspec.yaml",
];

/** 把候选名按偏好排序（偏好表里没有的排后面，保持原有顺序 —— `sort` 是稳定的）。 */
function rankNames(names, preference) {
  return [...names].sort((a, b) => rank(a, preference) - rank(b, preference));
}

function rank(name, preference) {
  const index = preference.indexOf(name);
  return index < 0 ? preference.length + 1 : index;
}

/**
 * 脚本名 → 「像不像启动命令」的分值（越小越靠前）。
 *
 * 不能只做精确匹配：真实项目里的开发命令大量是带前缀/后缀的（NextClaw 的主命令就是
 * `npm run start:dev`，还有 `dev:renderer` / `dev:electron:standalone` / `start:vite`）。
 */
function scriptRank(name) {
  const lower = String(name ?? "").toLowerCase();
  const exact = SCRIPT_PREFERENCE.indexOf(lower);
  if (exact >= 0) {
    return exact;
  }
  const segments = lower.split(/[^a-z0-9]+/).filter(Boolean);
  if (SCRIPT_HEADS.includes(segments[0])) {
    return 10 + Math.min(segments.length, 5);
  }
  if (segments.some((s) => s === "dev" || s === "develop")) {
    return 20;
  }
  if (segments.some((s) => s === "serve" || s === "start")) {
    return 21;
  }
  if (segments.some((s) => s === "watch" || s === "preview")) {
    return 22;
  }
  return SCRIPT_RANK_OTHER;
}

/**
 * JS 脚本的排序分值。`location`：0 = 根 package.json，1 = 声明的 workspace，2 = 顺带发现的子包。
 */
function nodeScriptPriority(rank, location) {
  if (rank < SCRIPT_RANK_OTHER) {
    return NODE_SCRIPT_BASE + rank * 2 + location;
  }
  return NODE_SCRIPT_OTHER + location * 10 + (rank - SCRIPT_RANK_OTHER);
}

/**
 * 探测一个项目里能跑的命令。
 *
 * @param {ReturnType<typeof createProjectProbe>} probe
 * @returns {Array<{ id: string, label: string, command: string, cwd: string, source: string }>}
 */
export function detectProjectCommands(probe) {
  /** @type {Array<{ priority: number, source: string, label: string, command: string, cwd: string }>} */
  const found = [];
  const seen = new Set();

  const add = (priority, source, label, command, cwd = "") => {
    const text = String(command ?? "").trim();
    if (!text) {
      return;
    }
    const dir = String(cwd ?? "").trim();
    const key = `${dir}\u0000${text}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    found.push({ priority, source, label: String(label ?? "").trim() || text, command: text, cwd: dir });
  };

  detectProcfile(probe, add);
  detectCompose(probe, add);
  detectJustfile(probe, add);
  detectTaskfile(probe, add);
  detectMakefile(probe, add);
  detectNode(probe, add);
  detectPython(probe, add);
  detectGo(probe, add);
  detectRust(probe, add);
  detectRuby(probe, add);
  detectPhp(probe, add);
  detectElixir(probe, add);
  detectJvm(probe, add);
  detectDotnet(probe, add);
  detectStaticFallback(probe, add, found.length === 0 && !PROJECT_MANIFESTS.some((file) => probe.has(file)));

  // 稳定排序：同优先级保持规则内的插入顺序（第一个探测到的命令最像"启动命令"）。
  found.sort((a, b) => a.priority - b.priority);
  return found.slice(0, PROJECT_COMMAND_LIMIT).map(({ label, command, cwd, source }) => ({
    id: projectCommandId(source, command, cwd),
    label,
    command,
    cwd,
    source,
  }));
}

/* ------------------------------------------------------------------ 显式声明 */

function detectProcfile(probe, add) {
  const text = probe.readText("Procfile");
  if (!text) {
    return;
  }
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_][A-Za-z0-9_-]*)\s*:\s*(.+)$/.exec(line.trim());
    if (match) {
      entries.push({ name: match[1], command: match[2].trim() });
    }
  }
  if (!entries.length) {
    return;
  }
  const ordered = rankNames(entries.map((entry) => entry.name), ["web", "dev", "run", "start", "serve"]).map(
    (name) => entries.find((entry) => entry.name === name),
  );
  for (const entry of ordered.slice(0, 3)) {
    add(10, "Procfile", `Procfile · ${entry.name}`, entry.command);
  }
}

function detectCompose(probe, add) {
  if (COMPOSE_FILES.some((file) => probe.has(file))) {
    add(15, "Docker Compose", "Docker Compose · up", "docker compose up");
  }
}

function detectJustfile(probe, add) {
  const file = JUST_FILES.find((candidate) => probe.has(candidate));
  if (!file) {
    return;
  }
  const names = [];
  for (const line of probe.readText(file).split(/\r?\n/)) {
    if (/^(set|alias|export|import|mod|unexport|assert|evaluate|shell)\b/.test(line)) {
      continue;
    }
    const match = /^([A-Za-z0-9_][A-Za-z0-9_-]*)(?:[ \t][^:\n]*)?:(?!=)/.exec(line);
    if (match) {
      names.push(match[1]);
    }
  }
  for (const name of rankNames(names, ["dev", "run", "start", "serve", "default", "up"]).slice(0, 2)) {
    add(20, "justfile", `just · ${name}`, `just ${name}`);
  }
}

function detectTaskfile(probe, add) {
  const file = TASK_FILES.find((candidate) => probe.has(candidate));
  if (!file) {
    return;
  }
  const names = [];
  for (const line of probe.readText(file).split(/\r?\n/)) {
    const match = /^ {2}([A-Za-z0-9_][A-Za-z0-9_-]*)\s*:\s*$/.exec(line);
    if (match) {
      names.push(match[1]);
    }
  }
  for (const name of rankNames(names, ["dev", "run", "start", "serve", "default", "up"]).slice(0, 2)) {
    add(22, "Taskfile", `task · ${name}`, `task ${name}`);
  }
}

function detectMakefile(probe, add) {
  const file = MAKE_FILES.find((candidate) => probe.has(candidate));
  if (!file) {
    return;
  }
  const names = [];
  for (const line of probe.readText(file).split(/\r?\n/)) {
    if (/^\t/.test(line) || /^\.(PHONY|SUFFIXES|DEFAULT|PRECIOUS|INTERMEDIATE|SECONDARY|DELETE_ON_ERROR|IGNORE|SILENT|EXPORT_ALL_VARIABLES|NOTPARALLEL|ONESHELL|POSIX)\b/.test(line)) {
      continue;
    }
    const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(line);
    if (match) {
      names.push(match[1]);
    }
  }
  for (const name of rankNames(names, ["dev", "run", "start", "serve", "up", "all"]).slice(0, 2)) {
    add(25, "Makefile", `make · ${name}`, `make ${name}`);
  }
}

/* ------------------------------------------------------------------ 包管理器脚本 */

/** lockfile → 包管理器；决定 `npm run dev` 还是 `pnpm run dev`。 */
export function detectPackageManager(probe) {
  if (probe.has("pnpm-lock.yaml") || probe.has("pnpm-workspace.yaml")) {
    return "pnpm";
  }
  if (probe.has("yarn.lock")) {
    return "yarn";
  }
  if (probe.has("bun.lock") || probe.has("bun.lockb")) {
    return "bun";
  }
  return "npm";
}

function detectNode(probe, add) {
  const text = probe.readText("package.json");
  if (!text) {
    return;
  }
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return;
  }
  const manager = detectPackageManager(probe);
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};

  // 根 package.json 的**全部**脚本都摆出来（用户自己挑），只按「像不像启动命令」排序。
  // 以前只取前 3 条，导致 `start:dev` 这种真实入口根本没机会出现。
  for (const name of Object.keys(scripts)) {
    add(nodeScriptPriority(scriptRank(name), 0), "package.json", `${manager} run ${name}`, `${manager} run ${name}`);
  }

  for (const { dir, declared } of childPackageDirs(probe, pkg)) {
    let child;
    try {
      child = JSON.parse(probe.readText(`${dir}/package.json`));
    } catch {
      continue;
    }
    const childScripts = child && typeof child.scripts === "object" && child.scripts ? child.scripts : {};
    const location = declared ? 1 : 2;
    for (const name of Object.keys(childScripts)) {
      add(
        nodeScriptPriority(scriptRank(name), location),
        declared ? "workspace" : "package",
        `${dir} · ${manager} run ${name}`,
        `${manager} run ${name}`,
        dir,
      );
    }
  }
}

/**
 * 子包目录（monorepo 的 `packages/*` / `apps/*`，以及顶层自带 package.json 的目录）。
 *
 * 声明了 workspaces 或 `pnpm-workspace.yaml` 的按声明来（`declared: true`）；
 * **没声明但布局就是常见 monorepo 样子**的也认（`packages/foo/package.json` 存在），只是排在声明项
 * 后面 —— 现实里很多仓库（NextClaw）有 `packages/` 却根本没写 workspaces 字段。
 */
const MONOREPO_ROOTS = ["packages", "apps", "services", "libs", "modules", "plugins", "extensions"];
/** 这些目录不是子应用，别把它们里的 package.json 当命令来源。 */
const CHILD_PACKAGE_DENY = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "output",
  "outputs",
  "coverage",
  "vendor",
  "tmp",
  "temp",
  "patches",
  "__pycache__",
]);
const CHILD_PACKAGE_LIMIT = 20;

function childPackageDirs(probe, pkg) {
  /** @type {Map<string, boolean>} 目录 → 是否声明过 */
  const dirs = new Map();
  const addDir = (dir, declared) => {
    const clean = String(dir ?? "").trim().replace(/\/+$/, "");
    if (!clean || clean.includes("*")) {
      return;
    }
    const previous = dirs.get(clean);
    if (previous === true) {
      return;
    }
    dirs.set(clean, Boolean(previous || declared));
  };

  // 1) 声明的 workspaces（package.json 的 workspaces / pnpm-workspace.yaml 的一层 glob）。
  for (const pattern of workspacePatterns(probe, pkg)) {
    const clean = String(pattern).trim().replace(/^\.\//, "").replace(/\/\*\*?$/, "");
    if (!clean || clean.includes("*")) {
      continue;
    }
    if (probe.has(`${clean}/package.json`)) {
      addDir(clean, true);
      continue;
    }
    if (!probe.isDir(clean)) {
      continue;
    }
    for (const name of probe.list(clean).sort()) {
      if (probe.has(`${clean}/${name}/package.json`)) {
        addDir(`${clean}/${name}`, true);
      }
    }
  }

  // 2) 常见 monorepo 根目录下的直接子目录（没声明也算）。
  for (const root of MONOREPO_ROOTS) {
    if (!probe.isDir(root)) {
      continue;
    }
    for (const name of probe.list(root).sort()) {
      if (probe.has(`${root}/${name}/package.json`)) {
        addDir(`${root}/${name}`, false);
      }
    }
  }

  // 3) 顶层自带 package.json 的目录（frontend/、remotion/、docs/ …）。
  for (const name of probe.list("").sort()) {
    if (CHILD_PACKAGE_DENY.has(name) || name.startsWith(".")) {
      continue;
    }
    if (probe.has(`${name}/package.json`)) {
      addDir(name, false);
    }
  }

  return [...dirs.entries()]
    .slice(0, CHILD_PACKAGE_LIMIT)
    .map(([dir, declared]) => ({ dir, declared }));
}

/** workspace 声明的原始 patterns（不展开目录）。 */
function workspacePatterns(probe, pkg) {
  const patterns = [];
  const workspaces = pkg?.workspaces;
  if (Array.isArray(workspaces)) {
    patterns.push(...workspaces);
  } else if (workspaces && Array.isArray(workspaces.packages)) {
    patterns.push(...workspaces.packages);
  }
  const pnpmWorkspace = probe.readText("pnpm-workspace.yaml");
  if (pnpmWorkspace) {
    for (const match of pnpmWorkspace.matchAll(/^\s*-\s*([^\s#]+)\s*$/gm)) {
      patterns.push(match[1].replace(/^['"]|['"]$/g, ""));
    }
  }
  return patterns;
}

/* ------------------------------------------------------------------ Python */

/** 读 `[project.scripts]` / `[tool.poetry.scripts]` 里的入口名。 */
export function pyprojectScriptNames(text) {
  const names = [];
  for (const heading of ["[project.scripts]", "[tool.poetry.scripts]"]) {
    const start = text.indexOf(heading);
    if (start < 0) {
      continue;
    }
    for (const line of text.slice(start + heading.length).split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) {
        break;
      }
      const match = /^\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*=/.exec(line);
      if (match) {
        names.push(match[1]);
      }
    }
  }
  return [...new Set(names)];
}

function detectPython(probe, add) {
  const pyproject = probe.readText("pyproject.toml");
  const dependencies = `${probe.readText("requirements.txt")}\n${pyproject}\n${probe.readText("Pipfile")}`;

  if (probe.has("manage.py")) {
    add(200, "Django", "Django · runserver", "python manage.py runserver");
  }

  // 有 uv / poetry 时 `[project.scripts]` 的入口可以直接跑（`uv run <name>` / `poetry run <name>`）；
  // 都没有时那个名字只是个未安装的 console script，跑不起来，宁可不出现在列表里。
  const runner = probe.has("uv.lock") ? "uv run " : probe.has("poetry.lock") || /\[tool\.poetry\]/.test(pyproject) ? "poetry run " : "";
  if (runner) {
    for (const name of pyprojectScriptNames(pyproject).slice(0, 3)) {
      add(202, "pyproject.toml", `pyproject · ${name}`, `${runner}${name}`);
    }
  }

  if (/fastapi|uvicorn/i.test(dependencies)) {
    const module = probe.has("app.py") ? "app" : probe.has("main.py") ? "main" : "";
    if (module) {
      add(204, "FastAPI", `uvicorn ${module}:app`, `uvicorn ${module}:app --reload`);
    }
  }

  if (/\bflask\b/i.test(dependencies) && !probe.has("manage.py")) {
    add(206, "Flask", "flask run", "python -m flask run");
  }

  for (const file of ["main.py", "app.py"]) {
    if (!probe.has(file)) {
      continue;
    }
    if (/__name__\s*==\s*["']__main__["']/.test(probe.readText(file))) {
      add(208, file, `python ${file}`, `python ${file}`);
    }
  }
}

/* ------------------------------------------------------------------ 语言入口约定 */

function detectGo(probe, add) {
  if (!probe.has("go.mod")) {
    return;
  }
  const cmdDirs = probe.isDir("cmd")
    ? probe.list("cmd").filter((name) => probe.has(`cmd/${name}/main.go`)).sort()
    : [];
  if (cmdDirs.length) {
    for (const name of cmdDirs.slice(0, 3)) {
      add(215, "go.mod", `cmd/${name} · go run`, `go run ./cmd/${name}`);
    }
    return;
  }
  if (probe.has("main.go")) {
    add(215, "go.mod", "go run .", "go run .");
  }
}

function detectRust(probe, add) {
  if (!probe.has("Cargo.toml")) {
    return;
  }
  if (probe.has("Trunk.toml")) {
    add(216, "Trunk.toml", "trunk serve", "trunk serve");
    return;
  }
  const cargo = probe.readText("Cargo.toml");
  const hasBinary = probe.has("src/main.rs") || /\[\[bin\]\]/.test(cargo);
  if (!hasBinary) {
    return;
  }
  add(216, "Cargo.toml", "cargo run", "cargo run");
}

function detectRuby(probe, add) {
  if (probe.has("bin/rails") || probe.has("config/application.rb")) {
    add(217, "Rails", "Rails · server", probe.has("bin/rails") ? "bin/rails server" : "bundle exec rails server");
  }
  if (probe.has("config.ru")) {
    add(218, "config.ru", "rackup", "bundle exec rackup");
  }
}

function detectPhp(probe, add) {
  if (probe.has("artisan")) {
    add(220, "Laravel", "php artisan serve", "php artisan serve");
  }
  const composerText = probe.readText("composer.json");
  if (composerText) {
    let composer;
    try {
      composer = JSON.parse(composerText);
    } catch {
      composer = null;
    }
    const scripts = composer && typeof composer.scripts === "object" && composer.scripts ? composer.scripts : {};
    for (const name of rankNames(Object.keys(scripts), ["dev", "start", "serve"]).slice(0, 2)) {
      add(221, "composer.json", `composer run ${name}`, `composer run ${name}`);
    }
  }
  if (probe.has("index.php") && !probe.has("artisan")) {
    add(222, "index.php", "php -S localhost:8000", "php -S localhost:8000");
  }
}

function detectElixir(probe, add) {
  if (!probe.has("mix.exs")) {
    return;
  }
  if (/phoenix/i.test(probe.readText("mix.exs"))) {
    add(223, "mix.exs", "mix phx.server", "mix phx.server");
  } else {
    add(223, "mix.exs", "iex -S mix", "iex -S mix");
  }
}

function detectJvm(probe, add) {
  if (probe.has("pom.xml") && /spring-boot/i.test(probe.readText("pom.xml"))) {
    add(224, "Maven", "mvn spring-boot:run", probe.has("mvnw") ? "./mvnw spring-boot:run" : "mvn spring-boot:run");
  }

  const gradleFile = ["build.gradle", "build.gradle.kts"].find((file) => probe.has(file));
  if (gradleFile) {
    const text = probe.readText(gradleFile);
    const wrapper = probe.has("gradlew") ? "./gradlew" : "gradle";
    if (/org\.springframework\.boot|bootRun/.test(text)) {
      add(225, "Gradle", `${wrapper} bootRun`, `${wrapper} bootRun`);
    } else if (/(id\s*\(?\s*['"]application['"]|application\s*\{)/.test(text)) {
      add(225, "Gradle", `${wrapper} run`, `${wrapper} run`);
    }
  }
}

function detectDotnet(probe, add) {
  const files = probe.list("").filter((name) => name.endsWith(".sln") || name.endsWith(".csproj")).sort();
  const projects = files.filter((name) => name.endsWith(".csproj"));
  if (!files.length) {
    return;
  }
  const project = projects.length === 1 ? ` --project ${projects[0]}` : "";
  add(226, ".NET", `dotnet run${project}`, `dotnet run${project}`);
}

/** 什么规则都没命中、也没有任何构建清单、但根目录有 `index.html` 时，给一个静态服务器当兜底。 */
function detectStaticFallback(probe, add, nothingFound) {
  if (nothingFound && probe.has("index.html")) {
    add(300, "index.html", "静态服务器 · http.server", "python3 -m http.server 8000");
  }
}