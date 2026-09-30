/**
 * `server/toolSettings.mjs`：桌面端「工具开关」的读写。
 *
 * 这里最重要的一组测试是 **pi 对照**（parity）：我的 `mergeToolLayers` + `resolveToolNames`
 * 是 pi `mergeDefaultTools` + `resolveDefaultTools` 的手抄版，必须逐例对上真
 * `SettingsManager.getDefaultTools()`。抄错的话 UI 会显示一个和内核不一致的状态。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_TOOL_NAMES,
  applyToolToggle,
  mergeToolLayers,
  readToolSettingsSnapshot,
  readToolToggle,
  resolveToolNames,
  stripToolToggle,
  toolSettingsPath,
  writeToolSettingsFile,
} from "../server/toolSettings.mjs";

/* -------------------------------- 路径 ---------------------------------- */

test("全局落在 agent 目录，项目落在 <project>/.pi", () => {
  assert.equal(
    toolSettingsPath({ agentDir: "/home/u/.pi/agent", projectCwd: "/work/app", scope: "user" }),
    "/home/u/.pi/agent/settings.json",
  );
  assert.equal(
    toolSettingsPath({ agentDir: "/home/u/.pi/agent", projectCwd: "/work/app", scope: "project" }),
    "/work/app/.pi/settings.json",
  );
});

/* ------------------------------- resolve -------------------------------- */

test("resolveToolNames：没写过 = 内建四件套，空数组 = 一个都不要", () => {
  // 这两者不是一回事，混淆了会把用户的会话变成"没有任何工具"。
  assert.deepEqual(resolveToolNames(undefined), DEFAULT_TOOL_NAMES);
  assert.deepEqual(resolveToolNames([]), []);
  assert.deepEqual(DEFAULT_TOOL_NAMES, ["read", "bash", "edit", "write"]);
});

test("resolveToolNames：纯名字替换内建清单", () => {
  assert.deepEqual(resolveToolNames(["read"]), ["read"]);
  assert.deepEqual(resolveToolNames(["read", "bash"]), ["read", "bash"]);
});

test("resolveToolNames：只含 +/- 时是改内建清单，按顺序应用", () => {
  assert.deepEqual(resolveToolNames(["+codemode"]), [...DEFAULT_TOOL_NAMES, "codemode"]);
  assert.deepEqual(resolveToolNames(["-bash"]), ["read", "edit", "write"]);
  // 先删再加，会落到末尾——顺序上也和 pi 一样（不是原位置）。
  assert.deepEqual(resolveToolNames(["-bash", "+bash"]), ["read", "edit", "write", "bash"]);
  assert.deepEqual(resolveToolNames(["+bash"]), DEFAULT_TOOL_NAMES);
  assert.deepEqual(resolveToolNames(["+a", "-a", "+a"]), [...DEFAULT_TOOL_NAMES, "a"]);
});

test("resolveToolNames：非字符串项被丢掉，非数组当空", () => {
  assert.deepEqual(resolveToolNames(["read", 42, null]), ["read"]);
  assert.deepEqual(resolveToolNames("read"), []);
});

/* -------------------------------- 层叠加 --------------------------------- */

test("mergeToolLayers：项目没设就是全局", () => {
  assert.deepEqual(mergeToolLayers(["+codemode"], undefined), ["+codemode"]);
  assert.equal(mergeToolLayers(undefined, undefined), undefined);
});

test("mergeToolLayers：项目只写 +/- 时是改，写纯名字时是整体替换", () => {
  assert.deepEqual(mergeToolLayers(["+grep"], ["+codemode"]), ["+grep", "+codemode"]);
  assert.deepEqual(mergeToolLayers(["+grep"], ["read"]), ["read"]);
  assert.deepEqual(mergeToolLayers(["+grep"], ["read", "+codemode"]), ["read", "+codemode"]);
  // 全局没设时，项目那串修饰符自己成立（pi 的 `base` 不是数组就返回 overrides）。
  assert.deepEqual(mergeToolLayers(undefined, ["-bash"]), ["-bash"]);
});

/* ------------------------------ 读某一层状态 ------------------------------ */

test("readToolToggle：三种写法都能认出来，没设过算继承", () => {
  assert.equal(readToolToggle(["+codemode"]), "on");
  assert.equal(readToolToggle(["read", "codemode"]), "on");
  assert.equal(readToolToggle(["-codemode"]), "off");
  assert.equal(readToolToggle(["-bash"]), "inherit");
  assert.equal(readToolToggle(undefined), "inherit");
  assert.equal(readToolToggle([]), "inherit");
  // 减号优先：同时出现时按"关"算，和 pi 的顺序语义一致。
  assert.equal(readToolToggle(["+codemode", "-codemode"]), "off");
});

test("stripToolToggle：三种写法一起摘掉，别的工具原样保留", () => {
  assert.deepEqual(stripToolToggle(["read", "+codemode", "-codemode", "+grep"]), ["read", "+grep"]);
  assert.deepEqual(stripToolToggle(["read", "bash"]), ["read", "bash"]);
  assert.deepEqual(stripToolToggle(undefined), []);
});

/* -------------------------------- 写 ------------------------------------ */

test("全局「开」：追加 +codemode，不动别的工具", () => {
  assert.deepEqual(applyToolToggle(undefined, "on", { scope: "user" }), ["+codemode"]);
  assert.deepEqual(applyToolToggle(["+grep"], "on", { scope: "user" }), ["+grep", "+codemode"]);
  assert.deepEqual(applyToolToggle(["read", "bash"], "on", { scope: "user" }), ["read", "bash", "+codemode"]);
});

test("全局「关」：摘掉 codemode 项就够了，摘空之后要删键（不能写 []）", () => {
  assert.equal(applyToolToggle(["+codemode"], "off", { scope: "user" }), undefined);
  assert.equal(applyToolToggle(undefined, "off", { scope: "user" }), undefined);
  // 还有别的工具就留着，只是不再有 codemode。
  assert.deepEqual(applyToolToggle(["+grep", "+codemode"], "off", { scope: "user" }), ["+grep"]);
  // 用户的替换式清单不该被顺手清掉。
  assert.deepEqual(applyToolToggle(["read", "bash"], "off", { scope: "user" }), ["read", "bash"]);
});

test("全局「继承」等同「关」（全局层没有可继承的东西）", () => {
  assert.equal(applyToolToggle(["+codemode"], "inherit", { scope: "user" }), undefined);
});

test("项目「开」：只写 +codemode，好让 pi 叠在全局之上", () => {
  assert.deepEqual(applyToolToggle(undefined, "on", { scope: "project" }), ["+codemode"]);
  assert.deepEqual(applyToolToggle(["+grep"], "on", { scope: "project" }), ["+grep", "+codemode"]);
});

test("项目「关」：必须写显式的 -codemode，否则会继承全局的开", () => {
  assert.deepEqual(applyToolToggle(undefined, "off", { scope: "project" }), ["-codemode"]);
  assert.deepEqual(applyToolToggle(["+codemode"], "off", { scope: "project" }), ["-codemode"]);
  assert.deepEqual(applyToolToggle(["+grep", "+codemode"], "off", { scope: "project" }), ["+grep", "-codemode"]);
});

test("项目「继承」：摘掉自己写的那项；别的都留，空了就把键删掉", () => {
  assert.equal(applyToolToggle(["+codemode"], "inherit", { scope: "project" }), undefined);
  assert.equal(applyToolToggle(["-codemode"], "inherit", { scope: "project" }), undefined);
  assert.deepEqual(applyToolToggle(["+grep", "+codemode"], "inherit", { scope: "project" }), ["+grep"]);
  // 替换式清单不是我们写的，不能因为"继承"就删掉。
  assert.deepEqual(applyToolToggle(["read", "bash"], "inherit", { scope: "project" }), ["read", "bash"]);
});

test("非法状态直接抛，别把坏值写进文件", () => {
  assert.throws(() => applyToolToggle([], "maybe", { scope: "user" }), /invalid tool toggle state/);
});

/* ----------------------------- 真文件往返 -------------------------------- */

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "pi-desktop-tools-"));
  const agentDir = join(dir, "agent");
  const projectCwd = join(dir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectCwd, { recursive: true });
  return { dir, agentDir, projectCwd };
}

test("写回文件只动 defaultTools，其它键和顺序都保留", () => {
  const { agentDir, projectCwd } = tempProject();
  const path = toolSettingsPath({ agentDir, projectCwd, scope: "user" });
  writeFileSync(path, JSON.stringify({ theme: "dark", packages: ["x"], defaultTools: ["+codemode"] }), "utf8");

  const settings = { theme: "dark", packages: ["x"], defaultTools: ["+codemode"] };
  settings.defaultTools = applyToolToggle(settings.defaultTools, "off", { scope: "user" }) as string[];
  writeToolSettingsFile(path, settings);

  const written = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(written, { theme: "dark", packages: ["x"] });
  assert.equal(readFileSync(path, "utf8").endsWith("\n"), true, "文件应以换行结尾");
});

test("snapshot：默认关，全局开就开，项目关能压回全局的开", () => {
  const { agentDir, projectCwd } = tempProject();
  const base = { agentDir, projectCwd, projectTrusted: true };

  assert.deepEqual(
    { global: readToolSettingsSnapshot(base).global, project: readToolSettingsSnapshot(base).project, effective: readToolSettingsSnapshot(base).effective },
    { global: false, project: "inherit", effective: false },
  );

  const globalPath = toolSettingsPath({ agentDir, projectCwd, scope: "user" });
  writeFileSync(globalPath, JSON.stringify({ defaultTools: ["+codemode"] }), "utf8");
  const on = readToolSettingsSnapshot(base);
  assert.equal(on.global, true);
  assert.equal(on.effective, true);
  assert.deepEqual(on.tools, [...DEFAULT_TOOL_NAMES, "codemode"]);

  const projectPath = toolSettingsPath({ agentDir, projectCwd, scope: "project" });
  mkdirSync(join(projectCwd, ".pi"), { recursive: true });
  writeFileSync(projectPath, JSON.stringify({ defaultTools: ["-codemode"] }), "utf8");
  const off = readToolSettingsSnapshot(base);
  assert.equal(off.project, "off");
  assert.equal(off.effective, false);
});

test("snapshot：未信任的项目不读它的 settings.json", () => {
  const { agentDir, projectCwd } = tempProject();
  const projectPath = toolSettingsPath({ agentDir, projectCwd, scope: "project" });
  mkdirSync(join(projectCwd, ".pi"), { recursive: true });
  writeFileSync(projectPath, JSON.stringify({ defaultTools: ["+codemode"] }), "utf8");

  const trusted = readToolSettingsSnapshot({ agentDir, projectCwd, projectTrusted: true });
  const untrusted = readToolSettingsSnapshot({ agentDir, projectCwd, projectTrusted: false });

  assert.equal(trusted.project, "on");
  assert.equal(trusted.effective, true);
  assert.equal(untrusted.project, "inherit");
  assert.equal(untrusted.effective, false);
  assert.equal(untrusted.projectTrusted, false);
});

/* ------------------------------- pi 对照 --------------------------------- */

/** 用真的 SettingsManager 解析一对 (global, project) 的 defaultTools。 */
function resolveWithPi(globalDefaultTools: unknown, projectDefaultTools: unknown): string[] {
  const { agentDir, projectCwd } = tempProject();
  const globalSettings: Record<string, unknown> = {};
  if (globalDefaultTools !== undefined) {
    globalSettings.defaultTools = globalDefaultTools;
  }
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(globalSettings), "utf8");
  if (projectDefaultTools !== undefined) {
    mkdirSync(join(projectCwd, ".pi"), { recursive: true });
    writeFileSync(join(projectCwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: projectDefaultTools }), "utf8");
  }
  const manager = SettingsManager.create(projectCwd, agentDir, { projectTrusted: true });
  return manager.getDefaultTools() ?? DEFAULT_TOOL_NAMES;
}

test("和 pi 逐例对照：合并 + 解析的结果必须一模一样", () => {
  const cases: [unknown, unknown][] = [
    [undefined, undefined],
    [[], undefined],
    [[], ["+codemode"]],
    [["+codemode"], undefined],
    [["+codemode"], ["+grep"]],
    [["+codemode"], ["-codemode"]],
    [["+codemode"], ["read"]],
    [["+codemode"], ["read", "+codemode"]],
    [["read", "bash"], ["-bash"]],
    [["read", "bash"], []],
    [["+grep", "+codemode"], ["-codemode"]],
    [[-["-bash"]], undefined],
    [["-bash"], ["+bash"]],
    [undefined, ["-bash"]],
    [["+a", "-a", "+a"], undefined],
    [["codemode"], undefined],
    [["codemode"], ["-codemode"]],
  ];

  for (const [global, project] of cases) {
    assert.deepEqual(
      resolveToolNames(mergeToolLayers(global, project)),
      resolveWithPi(global, project),
      `global=${JSON.stringify(global)} project=${JSON.stringify(project)}`,
    );
  }
});

test("和 pi 对照：全局开 + 项目关，pi 也认为 codemode 不在", () => {
  assert.equal(resolveWithPi(["+codemode"], ["-codemode"]).includes("codemode"), false);
  assert.equal(resolveWithPi(["+codemode"], undefined).includes("codemode"), true);
  assert.equal(resolveWithPi(undefined, ["+codemode"]).includes("codemode"), true);
  // 写盘后再读一遍，确认 applyToolToggle 的产物真的能被 pi 认出来。
  assert.equal(resolveWithPi(applyToolToggle(undefined, "on", { scope: "user" }), applyToolToggle(undefined, "off", { scope: "project" })).includes("codemode"), false);
});
test("摘干净之后删文件，别留一个 {} 让项目从此必须被信任", () => {
  const { agentDir, projectCwd } = tempProject();
  const path = toolSettingsPath({ agentDir, projectCwd, scope: "project" });
  mkdirSync(join(projectCwd, ".pi"), { recursive: true });
  writeFileSync(path, JSON.stringify({ defaultTools: ["+codemode"] }), "utf8");
  writeToolSettingsFile(path, {});
  assert.equal(existsSync(path), false);

  // 还有别的键时只摘 defaultTools，文件得留着。
  writeFileSync(path, JSON.stringify({ defaultTools: ["+codemode"], theme: "dark" }), "utf8");
  writeToolSettingsFile(path, { theme: "dark" });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { theme: "dark" });
});
