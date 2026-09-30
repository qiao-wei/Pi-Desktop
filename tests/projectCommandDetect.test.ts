/**
 * 项目启动命令的自动探测（`server/projectCommandDetect.mjs`）。
 *
 * 探测规则全部走 `probe` 文件接口，所以这里用假 probe 覆盖各种项目类型 —— 不需要真的建
 * 目录树，也不会碰真实文件系统。重点钉子：
 * - 「越显式越靠前」的排序（Procfile / Makefile 在 package.json 之前）；
 * - 同一条命令只出现一次（跨规则去重）；
 * - monorepo 的 workspace 命令带相对 cwd；
 * - 什么规则都没命中时才给静态服务器兜底。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createProjectProbe, detectPackageManager, detectProjectCommands, pyprojectScriptNames } from "../server/projectCommandDetect.mjs";

/**
 * 假文件系统。`entries` 里以 `/` 结尾的是目录；父目录自动成为目录。
 * `contents` 按相对路径给文件正文。
 */
function fakeProbe(entries: string[], contents: Record<string, string> = {}) {
  const dirs = new Set<string>([""]);
  for (const entry of entries) {
    const clean = entry.replace(/\/$/, "");
    const parts = clean.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      dirs.add(parts.slice(0, index).join("/"));
    }
  }

  return {
    has(relative: string) {
      const clean = relative.replace(/\/$/, "");
      return clean in contents || dirs.has(clean);
    },
    isDir(relative = "") {
      return dirs.has(relative.replace(/\/$/, ""));
    },
    list(relative = "") {
      const clean = relative.replace(/\/$/, "");
      const prefix = clean ? `${clean}/` : "";
      const names = new Set<string>();
      for (const entry of dirs) {
        if (!entry || entry === clean || !entry.startsWith(prefix)) {
          continue;
        }
        names.add(entry.slice(prefix.length).split("/")[0]);
      }
      for (const entry of Object.keys(contents)) {
        if (!entry.startsWith(prefix)) {
          continue;
        }
        names.add(entry.slice(prefix.length).split("/")[0]);
      }
      return [...names].sort();
    },
    readText(relative: string) {
      return contents[relative] ?? "";
    },
  };
}

const packageJson = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "demo", scripts, ...extra });

function commandsOf(entries: string[], contents: Record<string, string> = {}) {
  return detectProjectCommands(fakeProbe(entries, contents));
}

test("package.json 的脚本全部列出（按偏好排序），lockfile 决定包管理器", () => {
  const files = {
    "package.json": packageJson({ build: "tsc", start: "node .", dev: "vite", serve: "serve ." }),
  };

  const npm = commandsOf(["package.json"], files);
  assert.deepEqual(
    npm.map((command) => command.command),
    ["npm run dev", "npm run start", "npm run serve", "npm run build"],
    "不能只给前 3 条：真实项目的主命令往往排在后面",
  );

  for (const [lockfile, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
  ] as const) {
    const detected = commandsOf(["package.json", lockfile], files);
    assert.equal(detected[0]?.command, `${manager} run dev`, `lockfile ${lockfile} 应选 ${manager}`);
  }

  assert.equal(detectPackageManager(fakeProbe(["pnpm-workspace.yaml"])), "pnpm");
  assert.equal(detectPackageManager(fakeProbe([])), "npm");
});

test("显式运行声明排在包管理器脚本之前", () => {
  const detected = commandsOf(
    ["Procfile", "Makefile", "package.json"],
    {
      Procfile: "worker: node worker.js\nweb: node server.js\n",
      Makefile: "build:\n\techo build\n\ndev:\n\tnpm run dev\n",
      "package.json": packageJson({ dev: "vite" }),
    },
  );

  assert.equal(detected[0]?.command, "node server.js", "Procfile 的 web 进程最靠前");
  assert.equal(detected[0]?.label, "Procfile · web");
  assert.ok(detected.some((command) => command.command === "make dev"));
  assert.ok(detected.some((command) => command.command === "npm run dev"));
});

test("同一条命令跨规则只出现一次，先出现的来源胜出", () => {
  const detected = commandsOf(["Procfile", "package.json"], {
    Procfile: "web: npm run dev\n",
    "package.json": packageJson({ dev: "vite" }),
  });

  const matches = detected.filter((command) => command.command === "npm run dev");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.source, "Procfile");
});

test("Makefile 忽略 .PHONY 和片段，优先 dev/run/start/serve", () => {
  const detected = commandsOf(["Makefile"], {
    Makefile: ".PHONY: all dev\nCFLAGS = -O2\nall: build\n\t@echo all\n\ndev:\n\tnpm run dev\n",
  });

  assert.deepEqual(
    detected.map((command) => command.command),
    ["make dev", "make all"],
  );
  assert.ok(!detected.some((command) => command.command === "make .PHONY"));
});

test("docker compose / justfile / Taskfile 各出一条候选", () => {
  assert.equal(commandsOf(["compose.yaml"])[0]?.command, "docker compose up");

  const just = commandsOf(["justfile"], { justfile: "set shell := [\"sh\"]\n\ndefault:\n  echo hi\ndev:\n  npm run dev\n" });
  assert.deepEqual(just.map((command) => command.command), ["just dev", "just default"]);

  const task = commandsOf(["Taskfile.yml"], { "Taskfile.yml": "version: '3'\ntasks:\n  default:\n    cmds:\n      - echo hi\n  serve:\n    cmds:\n      - npm start\n" });
  assert.deepEqual(task.map((command) => command.command), ["task serve", "task default"]);
});

test("带前缀/后缀的启动命令（start:dev / dev:renderer）排在普通脚本前面", () => {
  const detected = commandsOf(["package.json"], {
    "package.json": packageJson({
      "vendor:pandoc": "node v.js",
      build: "vite build",
      "dev:browser": "node url.js",
      start: "node .",
      "start:dev": "node dev.js",
    }),
  });

  // `start:dev` / `dev:browser` 同分（都是「前缀是启动词 + 两段」），同分保持 package.json
  // 里的原始顺序 —— 作者放前面的更可能是主命令。
  assert.deepEqual(
    detected.map((command) => command.command),
    ["npm run start", "npm run dev:browser", "npm run start:dev", "npm run vendor:pandoc", "npm run build"],
  );
});

test("monorepo：声明过的子包带相对 cwd；没声明但布局常见也认，排在声明项后面", () => {
  const detected = commandsOf(
    ["package.json", "packages/", "packages/web/", "packages/web/package.json", "apps/", "apps/api/", "apps/api/package.json"],
    {
      "package.json": packageJson({}, { workspaces: ["packages/*"] }),
      "packages/web/package.json": packageJson({ dev: "vite" }),
      "apps/api/package.json": packageJson({ start: "node ." }),
    },
  );

  const web = detected.find((command) => command.cwd === "packages/web");
  assert.equal(web?.command, "npm run dev");
  assert.equal(web?.source, "workspace");

  const api = detected.find((command) => command.cwd === "apps/api");
  assert.equal(api?.command, "npm run start");
  assert.equal(api?.source, "package", "没声明 workspaces 也认（NextClaw 就是有 packages/ 却根本没写 workspaces）");
  assert.ok(detected.indexOf(web!) < detected.indexOf(api!), "声明过的排在顺带发现的前面");
});

test("没声明 workspaces 时也扫 packages/*，且不扫 node_modules / dist", () => {
  const detected = commandsOf(
    [
      "package.json",
      "packages/",
      "packages/plugin-sdk/",
      "packages/plugin-sdk/package.json",
      "node_modules/",
      "node_modules/evil/",
      "node_modules/evil/package.json",
      "dist/",
      "dist/old/",
      "dist/old/package.json",
      "frontend/",
      "frontend/package.json",
    ],
    {
      "package.json": packageJson({ start: "node .", "start:dev": "node dev.js", "vendor:pandoc": "node v.js" }),
      "packages/plugin-sdk/package.json": packageJson({ build: "tsc -p tsconfig.json" }),
      "node_modules/evil/package.json": packageJson({ dev: "curl evil.example" }),
      "dist/old/package.json": packageJson({ dev: "curl evil.example" }),
      "frontend/package.json": packageJson({ dev: "vite" }),
    },
  );

  assert.deepEqual(
    detected.map((command) => `${command.cwd}:${command.command}`),
    [
      "frontend:npm run dev",
      ":npm run start",
      ":npm run start:dev",
      ":npm run vendor:pandoc",
      "packages/plugin-sdk:npm run build",
    ],
  );
  assert.ok(!detected.some((command) => command.command.includes("evil")), "node_modules / dist 不能进候选");
});

test("语言入口约定：Go / Rust / Python / PHP / Elixir / JVM / .NET", () => {
  assert.deepEqual(
    commandsOf(["go.mod", "cmd/", "cmd/api/", "cmd/api/main.go"]).map((command) => command.command),
    ["go run ./cmd/api"],
  );
  assert.deepEqual(commandsOf(["go.mod", "main.go"]).map((command) => command.command), ["go run ."]);
  assert.deepEqual(commandsOf(["Cargo.toml", "src/", "src/main.rs"]).map((command) => command.command), ["cargo run"]);
  assert.equal(commandsOf(["Trunk.toml", "Cargo.toml", "src/main.rs"])[0]?.command, "trunk serve");
  assert.equal(commandsOf(["manage.py"])[0]?.command, "python manage.py runserver");
  assert.equal(commandsOf(["artisan"])[0]?.command, "php artisan serve");
  assert.equal(commandsOf(["mix.exs"], { "mix.exs": 'defp deps, do: [{:phoenix, "~> 1.7"}]' })[0]?.command, "mix phx.server");
  assert.equal(commandsOf(["pom.xml"], { "pom.xml": "<artifactId>spring-boot-starter-web</artifactId>" })[0]?.command, "mvn spring-boot:run");
  assert.equal(commandsOf(["app.csproj"]).map((command) => command.command)[0], "dotnet run --project app.csproj");
});

test("Python：FastAPI / uv / poetry 的探测", () => {
  const fastapi = commandsOf(["app.py", "requirements.txt"], {
    "app.py": "from fastapi import FastAPI\napp = FastAPI()\n",
    "requirements.txt": "fastapi\nuvicorn\n",
  });
  assert.equal(fastapi[0]?.command, "uvicorn app:app --reload");

  const uv = commandsOf(["pyproject.toml", "uv.lock"], {
    "pyproject.toml": "[project.scripts]\nserve = \"demo.__main__:main\"\n",
  });
  assert.equal(uv[0]?.command, "uv run serve");

  const plain = commandsOf(["main.py"], { "main.py": 'if __name__ == "__main__":\n    print("hi")\n' });
  assert.equal(plain[0]?.command, "python main.py");

  assert.deepEqual(pyprojectScriptNames("[project.scripts]\na = \"x:y\"\n\n[tool.other]\nb = 1\n"), ["a"]);
});

test("一条规则都没命中、根目录有 index.html 时兜底静态服务器", () => {
  assert.deepEqual(commandsOf(["index.html"]).map((command) => command.command), ["python3 -m http.server 8000"]);
  // 有 package.json（哪怕没脚本）就不算静态站
  assert.deepEqual(commandsOf(["index.html", "package.json"], { "package.json": packageJson({}) }), []);
});

test("package.json 里脚本很多时也全给出来（候选上限很高）", () => {
  const scripts: Record<string, string> = {};
  for (let i = 0; i < 60; i += 1) {
    scripts[`task:${i}`] = `node task-${i}.js`;
  }
  const detected = commandsOf(["package.json"], { "package.json": packageJson(scripts) });
  assert.equal(detected.length, 60);
  assert.equal(detected.at(-1)?.command, "npm run task:59", "包管理器脚本保持 package.json 里的原始顺序");
});

test("真实文件系统探针能读到文件（冒烟）", () => {
  const probe = createProjectProbe(new URL("..", import.meta.url).pathname);
  assert.equal(probe.has("package.json"), true);
  assert.equal(probe.readText("package.json").includes("\"name\": \"pi-desktop\""), true);
  assert.equal(probe.isDir("src"), true);
  assert.equal(probe.isDir("does-not-exist"), false);
});