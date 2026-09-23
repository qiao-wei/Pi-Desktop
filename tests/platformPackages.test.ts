// 平台专属依赖的裁剪（scripts/lib/platformPackages.mjs）。
//
// 背景：pi 自带的 npm-shrinkwrap.json 让 `npm install` 把 esbuild 的 26 个平台包全装进来
// （284M），只有一个是本机用得上的。这里锁的是决策规则本身：什么算"平台专属"、什么算"匹配"、
// 走多深、什么时候必须什么都不删。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  findPrunablePlatformPackages,
  formatBytes,
  platformMatches,
  prunePlatformPackages,
  resolveTargetPlatform,
} from "../scripts/lib/platformPackages.mjs";

const darwinArm = { os: "darwin", cpu: "arm64" };

function tempDir() {
  return mkdtempSync(join(tmpdir(), "pi-platform-prune-"));
}

/** 造一个包：`pkg(root, "@esbuild/win32-x64", {os:["win32"],cpu:["x64"]})`。 */
function pkg(root, name, manifest, files = 1) {
  const dir = join(root, "node_modules", ...name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }, null, 2));
  for (let index = 0; index < files; index += 1) {
    writeFileSync(join(dir, `blob-${index}.bin`), "x".repeat(2048));
  }
  return dir;
}

test("rust target triple 认得出来（交叉构建靠它）", () => {
  assert.deepEqual(resolveTargetPlatform({ triple: "aarch64-apple-darwin" }), { os: "darwin", cpu: "arm64" });
  assert.deepEqual(resolveTargetPlatform({ triple: "x86_64-apple-darwin" }), { os: "darwin", cpu: "x64" });
  assert.deepEqual(resolveTargetPlatform({ triple: "x86_64-pc-windows-msvc" }), { os: "win32", cpu: "x64" });
  assert.deepEqual(resolveTargetPlatform({ triple: "aarch64-pc-windows-msvc" }), { os: "win32", cpu: "arm64" });
  assert.deepEqual(resolveTargetPlatform({ triple: "aarch64-unknown-linux-gnu" }), { os: "linux", cpu: "arm64" });
  assert.deepEqual(resolveTargetPlatform({ triple: "armv7-unknown-linux-gnueabihf" }), { os: "linux", cpu: "arm" });
  assert.deepEqual(resolveTargetPlatform({ triple: "riscv64gc-unknown-linux-gnu" }), { os: "linux", cpu: "riscv64" });
});

test("没有 triple 时用构建机自己的平台", () => {
  assert.deepEqual(resolveTargetPlatform({ platform: "darwin", arch: "arm64" }), { os: "darwin", cpu: "arm64" });
  assert.deepEqual(resolveTargetPlatform({ platform: "win32", arch: "x64" }), { os: "win32", cpu: "x64" });
  // win32 的 defaultTargetTriple 是空串（Windows 没有 launcher），不能因此把平台判成未知。
  assert.deepEqual(resolveTargetPlatform({ triple: "", platform: "win32", arch: "x64" }), { os: "win32", cpu: "x64" });
});

test("匹配规则就是 npm 那套：缺失=通吃、any、否定、os 与 cpu 都要过", () => {
  assert.equal(platformMatches({}, darwinArm), true, "没声明 os/cpu 的包永远保留");
  assert.equal(platformMatches({ os: [], cpu: [] }, darwinArm), true);
  assert.equal(platformMatches({ os: ["any"], cpu: ["any"] }, darwinArm), true);
  assert.equal(platformMatches({ os: ["darwin"], cpu: ["arm64"] }, darwinArm), true);
  assert.equal(platformMatches({ os: ["darwin"], cpu: ["x64"] }, darwinArm), false, "同 os 不同 cpu 也要删");
  assert.equal(platformMatches({ os: ["win32"], cpu: ["x64"] }, darwinArm), false);
  assert.equal(platformMatches({ os: ["!win32"] }, darwinArm), true, "否定式：非 win32 就留");
  assert.equal(platformMatches({ os: ["!darwin"] }, darwinArm), false, "否定式命中就要删");
  assert.equal(platformMatches({ cpu: ["arm64"] }, darwinArm), true, "只声明 cpu 时只看 cpu");
});

test("只挑出跑不了的包，路径全在树内", () => {
  const root = tempDir();
  try {
    pkg(root, "plain-package", {});
    pkg(root, "@esbuild/darwin-arm64", { os: ["darwin"], cpu: ["arm64"] });
    pkg(root, "@esbuild/win32-x64", { os: ["win32"], cpu: ["x64"] });
    pkg(root, "@esbuild/linux-x64", { os: ["linux"], cpu: ["x64"] });

    const found = findPrunablePlatformPackages({ root, target: darwinArm });
    assert.deepEqual(found.map((entry) => entry.name).sort(), ["@esbuild/linux-x64", "@esbuild/win32-x64"]);
    for (const entry of found) {
      assert.ok(entry.dir.startsWith(root), `${entry.dir} 必须在树内`);
    }
    assert.ok(!found.some((entry) => entry.name === "plain-package"), "没声明 os/cpu 的包不能被删");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("嵌套树（npm 把依赖的依赖放在它自己的 node_modules 里）也要走到", () => {
  const root = tempDir();
  try {
    // 复刻真实形状：pi-coding-agent/node_modules/@esbuild/*
    const pi = pkg(root, "@earendil-works/pi-coding-agent", {});
    writeFileSync(join(pi, "index.js"), "module.exports = 1;\n");
    pkg(pi, "esbuild", {});
    pkg(pi, "@esbuild/darwin-arm64", { os: ["darwin"], cpu: ["arm64"] });
    pkg(pi, "@esbuild/openharmony-arm64", { os: ["openharmony"], cpu: ["arm64"] });
    pkg(pi, "fsevents", { os: ["darwin"] });
    // 更深一层
    const deep = pkg(pi, "@aws-sdk/credential-provider-sso", {});
    pkg(deep, "win32-only-helper", { os: ["win32"] });

    const found = findPrunablePlatformPackages({ root, target: darwinArm });
    assert.deepEqual(
      found.map((entry) => entry.name).sort(),
      ["@esbuild/openharmony-arm64", "win32-only-helper"],
    );
    assert.ok(!found.some((entry) => entry.name === "fsevents"), "os 里只有 darwin 的要留");
    assert.ok(!found.some((entry) => entry.name === "esbuild"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("裁剪真的删了文件、报了大米数、而且幂等", () => {
  const root = tempDir();
  try {
    const keep = pkg(root, "@esbuild/darwin-arm64", { os: ["darwin"], cpu: ["arm64"] });
    pkg(root, "@esbuild/win32-x64", { os: ["win32"], cpu: ["x64"] }, 4);

    const first = prunePlatformPackages({ root, target: darwinArm });
    assert.deepEqual(first.removed.map((entry) => entry.name), ["@esbuild/win32-x64"]);
    assert.ok(first.bytes > 4 * 2048, `应报出被删的字节数，实际 ${first.bytes}`);
    assert.ok(existsSync(keep));
    assert.equal(existsSync(join(root, "node_modules/@esbuild/win32-x64")), false, "该删的必须删掉");
    assert.deepEqual(readdirSync(join(root, "node_modules/@esbuild")), ["darwin-arm64"]);

    const second = prunePlatformPackages({ root, target: darwinArm });
    assert.deepEqual(second.removed, [], "第二次应该没事可做");
    assert.equal(second.bytes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dryRun 只看不删", () => {
  const root = tempDir();
  try {
    pkg(root, "@esbuild/win32-x64", { os: ["win32"] });
    const result = prunePlatformPackages({ root, target: darwinArm, dryRun: true });
    assert.equal(result.removed.length, 1);
    assert.ok(existsSync(join(root, "node_modules/@esbuild/win32-x64")), "dryRun 不能删东西");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("删不掉的包不能把构建搞崩", () => {
  const root = tempDir();
  try {
    pkg(root, "@esbuild/win32-x64", { os: ["win32"] });
    const result = prunePlatformPackages({
      root,
      target: darwinArm,
      fs: {
        existsSync,
        readdirSync,
        readFileSync,
        statSync,
        rmSync: () => {
          throw new Error("EACCES");
        },
      },
    });
    assert.deepEqual(result.removed, []);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /EACCES/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("不跟符号链接走（npm 的 .bin 是指向别处的链接）", { skip: process.platform === "win32" }, () => {
  const root = tempDir();
  const outside = tempDir();
  try {
    pkg(outside, "outside-win32", { os: ["win32"] });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(outside, join(root, "node_modules", "linked-package"));
    const found = findPrunablePlatformPackages({ root, target: darwinArm });
    assert.deepEqual(found, [], "链接指向的树不在这次安装里，不能删");
    assert.ok(existsSync(join(outside, "node_modules/outside-win32")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("没安装过的树（没有 node_modules）不报错", () => {
  const root = tempDir();
  try {
    assert.deepEqual(findPrunablePlatformPackages({ root, target: darwinArm }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("坏掉的 package.json 不能让扫描崩掉", () => {
  const root = tempDir();
  try {
    const broken = join(root, "node_modules", "broken-package");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "package.json"), "{ not json");
    pkg(root, "@esbuild/win32-x64", { os: ["win32"] });
    const found = findPrunablePlatformPackages({ root, target: darwinArm });
    assert.deepEqual(found.map((entry) => entry.name), ["@esbuild/win32-x64"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("formatBytes 只为了日志可读", () => {
  assert.equal(formatBytes(0), "0");
  assert.equal(formatBytes(1024 * 1024 * 267), "267M");
  assert.equal(formatBytes(512 * 1024), "512K");
  assert.equal(formatBytes(1024 * 1024 * 1024 * 1.5), "1.5G");
});