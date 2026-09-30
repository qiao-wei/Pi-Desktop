/**
 * macOS 签名档位。
 *
 * 这块以前是隐式的：钥匙串里恰好有一张自签证书 → electron-builder 走"非 Apple 证书"兜底分支 →
 * 240 个文件逐个真签名、每个都联网取一次 Apple 时间戳（实测 0.76s/文件，不带则 0.05s）≈ 4 分钟，
 * 而没人声明过产物到底是什么档位。所以这里锁三件事：
 *
 *  1. 档位表只有一处（`scripts/lib/macSigning.cjs`），electron-builder 的配置与出包计划念的是同一份；
 *  2. 两个档位的实际取值（证书、时间戳、hardened runtime、公证）不会各自漂移；
 *  3. release 档缺公证凭证时**在动手之前**报错 —— electron-builder 只会 warn 一句"skipped macOS
 *     notarization"然后照常出包，那种"签了但没公证"的包 codesign 检查全过、Gatekeeper 照样拦。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_RELEASE_IDENTITY,
  ELECTRON_LANGUAGES,
  SIGN_TIERS,
  notarizationCredentials,
  resolveMacSigning,
  resolveSignTier,
} from "../scripts/lib/macSigning.cjs";
import { PackPlanError, buildPackPlan, parsePackArgs } from "../scripts/lib/packPlan.mjs";

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, "..");
const readJson = (relative) => JSON.parse(readFileSync(resolve(ROOT, relative), "utf8"));

const SIGN_ENV_KEYS = ["PI_DESKTOP_SIGN", "PI_DESKTOP_SIGN_IDENTITY", "PI_DESKTOP_RUNTIME_MODE"];

/** 以指定的 env 重新加载 electron-builder 包装配置（它 require 时就定档，所以要清缓存并还原 env）。 */
function electronConfig(env) {
  const path = resolve(ROOT, "src-electron/electron-builder.config.cjs");
  const saved = Object.fromEntries(SIGN_ENV_KEYS.map((key) => [key, process.env[key]]));
  delete require.cache[path];
  for (const key of SIGN_ENV_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    return require(path);
  } finally {
    for (const key of SIGN_ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    delete require.cache[path];
  }
}

/** assert.throws 不把错误交回来，而这些用例标题就是错误本身。 */
function planError(run) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof PackPlanError, `期望 PackPlanError，收到 ${error}`);
    return error;
  }
  assert.fail("应当拒绝这个组合，但它通过了");
}

const planFor = (args, env = {}, context = {}) =>
  buildPackPlan(parsePackArgs(args), { platform: "darwin", arch: "arm64", env, ...context });

/**
 * electron-builder 的语言裁剪规则（抄自 app-builder-lib/out/electron/ElectronFramework.js 的
 * `removeUnusedLanguagesIfNeeded`）：语言名 = 文件名去掉后缀后小写，保留条件是
 * `wanted === language` 或 `wanted` 以 `<language>-` / `<language>_` 开头。
 * 抄在这里是为了在**没有 electron 源码可读**时也能验证白名单，不是为了复述实现。
 */
const keepsLocale = (languages, fileName, ext) => {
  const language = fileName.replace(new RegExp(`\\${ext}$`), "").toLowerCase();
  return languages.some(
    (wanted) => wanted.toLowerCase() === language || wanted.startsWith(`${language}-`) || wanted.startsWith(`${language}_`),
  );
};

const electronFrameworkResources = () => {
  for (const version of ["Current", "A"]) {
    const dir = resolve(
      ROOT,
      `node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/${version}/Resources`,
    );
    if (existsSync(dir)) {
      return dir;
    }
  }
  return undefined;
};
const FRAMEWORK_RESOURCES = electronFrameworkResources();

test("local 是默认档：不需要任何 env，出的是 ad-hoc 签名且不联网", () => {
  const signing = resolveMacSigning({});
  assert.equal(signing.tier, "local");
  assert.equal(signing.identity, "-", "local 档必须显式 ad-hoc：不给证书限定词就会又变成「看钥匙串里有什么」");
  assert.equal(signing.timestamp, "none", "本地档从不联网取时间戳");
  assert.equal(signing.hardenedRuntime, false, "ad-hoc + hardened runtime 会启用 library validation");
  assert.equal(signing.notarize, false, "本地档不公证，显式关掉少一条 skip 警告");
  assert.deepEqual(signing.electronLanguages, ELECTRON_LANGUAGES);

  for (const env of [{}, { PI_DESKTOP_SIGN: "" }, { PI_DESKTOP_SIGN: "  LOCAL  " }]) {
    assert.equal(resolveSignTier(env), "local", `空档位/大小写/空白都算 local：${JSON.stringify(env)}`);
  }
});

test("release 档：Developer ID + 时间戳默认开 + 公证默认开", () => {
  const signing = resolveMacSigning({ PI_DESKTOP_SIGN: "release" });
  assert.equal(signing.tier, "release");
  assert.equal(signing.identity, DEFAULT_RELEASE_IDENTITY);
  assert.equal(signing.timestamp, undefined, "undefined = 不写这个键，用 electron-builder 的默认值（开）");
  assert.equal(signing.notarize, undefined, "undefined = 让 electron-builder 按 env 自动判定");
  assert.equal(signing.hardenedRuntime, true);

  // 这个限定词是子串匹配 `security find-identity` 的输出行用的；带冒号会被 macCodeSign.js 的
  // checkPrefix 直接拒绝。
  assert.ok(!signing.identity.startsWith("Developer ID Application:"), signing.identity);

  // 只有 release 允许换证书名。
  assert.equal(resolveMacSigning({ PI_DESKTOP_SIGN: "release", PI_DESKTOP_SIGN_IDENTITY: "Foo (TEAMID)" }).identity, "Foo (TEAMID)");
  assert.equal(resolveMacSigning({ PI_DESKTOP_SIGN: "local", PI_DESKTOP_SIGN_IDENTITY: "Foo (TEAMID)" }).identity, "-");
});

test("拼错的档位直接报错，不静默退回 local", () => {
  assert.throws(() => resolveSignTier({ PI_DESKTOP_SIGN: "internal" }), /不是有效档位/);
  assert.deepEqual(SIGN_TIERS, ["local", "release"]);

  const error = planError(() =>
    buildPackPlan(parsePackArgs(["--host", "electron", "--target", "mac", "--arch", "arm64", "--sign", "internal"]), {
      platform: "darwin",
      arch: "arm64",
    }),
  );
  assert.match(error.message, /--sign 只能是 local \/ release/);
});

test("electron-builder 的配置就是档位表念出来的，两种模式都不漂移", () => {
  const local = electronConfig({});
  assert.equal(local.mac.identity, "-");
  assert.equal(local.mac.timestamp, "none");
  assert.equal(local.mac.hardenedRuntime, false);
  assert.equal(local.mac.notarize, false);
  assert.deepEqual(local.mac.electronLanguages, ELECTRON_LANGUAGES, "语言裁剪要跟随档位一起下发给 mac 段");
  assert.equal(local.electronLanguages, undefined, "Windows 的 locales/*.pak 用另一套命名，那边验证过再打开");

  const release = electronConfig({ PI_DESKTOP_SIGN: "release" });
  assert.equal(release.mac.identity, DEFAULT_RELEASE_IDENTITY);
  assert.equal(release.mac.hardenedRuntime, true);
  assert.ok(!("timestamp" in release.mac), "release 档要把时间戳留给默认值（开），不能变成显式的 none");
  assert.ok(!("notarize" in release.mac), "release 档的公证由 env 自动判定");

  // 精简模式只是摘掉两个 runtime 目录，不能顺手把档位丢掉。
  const slim = electronConfig({ PI_DESKTOP_SIGN: "release", PI_DESKTOP_RUNTIME_MODE: "system" });
  assert.equal(slim.mac.identity, DEFAULT_RELEASE_IDENTITY);
  assert.equal(slim.mac.hardenedRuntime, true);
  assert.deepEqual(slim.mac.extraResources.map((entry) => entry.to), ["pi-desktop-server"]);
});

test("旧钩子已退休：没有 afterPack，也不再有第二个签名入口", () => {
  // 钩子当初存在的理由是「electron-builder 没签时补 identifier」；现在 local 档显式 identity "-"
  // 走 electron-builder 自己的签名路径（codesign 从 Info.plist 取 CFBundleIdentifier）。两条路并存
  // 只会互相覆盖（afterPack 跑在 electron-builder 签名之前），所以钩子必须消失，而不是留着兜底。
  assert.equal(readJson("src-electron/electron-builder.json").afterPack, undefined);
  assert.equal(electronConfig({}).afterPack, undefined);
  assert.ok(!existsSync(resolve(ROOT, "scripts/electron-sign-adhoc.mjs")), "钩子脚本应当已删除");
});

test("语言白名单：只列真实语言名，mac 的命名规则下能留住 en / zh，伪本地化全删", () => {
  for (const language of ELECTRON_LANGUAGES) {
    assert.match(language, /^[a-z]{2}(_[A-Z]{2})?$/, `${language} 不像一个 mac 的 .lproj 语言名`);
    assert.doesNotMatch(language, /_(FEMININE|MASCULINE|NEUTER)$/i, "伪本地化不该进白名单");
  }
  assert.ok(ELECTRON_LANGUAGES.includes("en"), "en.lproj 是 Chromium 的 fallback，缺了整包会退化成没有界面文案");
  assert.ok(ELECTRON_LANGUAGES.includes("zh_CN") && ELECTRON_LANGUAGES.includes("zh_TW"), "应用自己的文案只有 en/zh");

  for (const kept of ["en", "zh_CN", "zh_TW"]) {
    assert.ok(keepsLocale(ELECTRON_LANGUAGES, kept, ".lproj"), `${kept}.lproj 应当保留`);
  }
  for (const dropped of ["en_FEMININE", "zh_CN_NEUTER", "zh_CN_FEMININE", "de", "fr", "ja", "en_GB", "es_419"]) {
    assert.ok(!keepsLocale(ELECTRON_LANGUAGES, dropped, ".lproj"), `${dropped}.lproj 应当被裁掉`);
  }
});

test("对真实的 Electron 目录跑一遍：220 个 locale → 3 个，白的留下、伪本地化清掉", { skip: !FRAMEWORK_RESOURCES }, () => {
  const present = readdirSync(FRAMEWORK_RESOURCES)
    .filter((name) => name.endsWith(".lproj"))
    .map((name) => name.replace(/\.lproj$/, ""));
  assert.ok(present.length > 100, `没找到预期的 locale 目录，布局变了？${FRAMEWORK_RESOURCES}`);

  const kept = present.filter((language) => keepsLocale(ELECTRON_LANGUAGES, language, ".lproj")).sort();
  assert.deepEqual(kept, ["en", "zh_CN", "zh_TW"]);
  // 这一条就是签名时间的大头：每个剩下的 locale.pak 都会被单独 codesign 一次并联网取时间戳。
  assert.ok(kept.length * 10 < present.length, `${present.length} 个 locale 只该留下个位数，实际留了 ${kept.length}`);
});

test("公证凭证：两种方式任选其一，Apple ID 的密码认两种外壳的变量名", () => {
  assert.equal(notarizationCredentials({}).ready, false);
  assert.equal(notarizationCredentials({}).mode, null);

  const appleId = { APPLE_ID: "dev@example.com", APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh", APPLE_TEAM_ID: "ABCDE12345" };
  assert.deepEqual(notarizationCredentials(appleId), { ready: true, mode: "apple-id", missing: [] });
  // Tauri 认 APPLE_PASSWORD，electron-builder 认 APPLE_APP_SPECIFIC_PASSWORD：同一个值导两遍即可。
  assert.equal(notarizationCredentials({ ...appleId, APPLE_APP_SPECIFIC_PASSWORD: undefined, APPLE_PASSWORD: "abcd-efgh" }).ready, true);

  const apiKey = { APPLE_API_KEY: "/tmp/key.p8", APPLE_API_KEY_ID: "ABC123", APPLE_API_ISSUER: "issuer-uuid" };
  assert.deepEqual(notarizationCredentials(apiKey), { ready: true, mode: "api-key", missing: [] });
  const partial = notarizationCredentials({ APPLE_API_KEY: "/tmp/key.p8", APPLE_API_ISSUER: "issuer-uuid" });
  assert.equal(partial.ready, false);
  assert.deepEqual(partial.missing, ["APPLE_API_KEY_ID"], "electron-builder 三个都要，缺的那个要报出来");

  // 都没齐时挑缺得最少的那套报，别两套各报一半。
  const nothingUseful = notarizationCredentials({ APPLE_ID: "dev@example.com" });
  assert.equal(nothingUseful.tried, "apple-id");
  assert.deepEqual(nothingUseful.missing, ["APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]);
});

test("release 档缺凭证：在动手之前报错，并说清缺哪个变量", () => {
  const error = planError(() =>
    planFor(["--host", "electron", "--target", "mac", "--arch", "arm64", "--sign", "release"], {}),
  );
  assert.match(error.message, /缺 Apple 公证凭证/);
  assert.match(error.message, /APPLE_ID/);
  assert.ok(error.hints.some((hint) => hint.includes("APPLE_APP_SPECIFIC_PASSWORD")), error.hints.join("\n"));
  assert.ok(error.hints.some((hint) => hint.includes("APPLE_API_KEY_ID")), "API key 那条路也要给出来");
  assert.ok(error.hints.some((hint) => hint.includes("--sign release")), "要提示「不加 --sign 就是本地档」");

  // 部分凭证同样拦住（只给 APPLE_ID 是最容易犯的错）。
  const partial = planError(() => planFor(["--host", "tauri", "--target", "mac", "--arch", "arm64", "--sign", "release"], { APPLE_ID: "dev@example.com" }));
  assert.match(partial.message, /APPLE_APP_SPECIFIC_PASSWORD/);
});

test("release 档凭证齐备：放行，并把档位与证书一起下发给两条外壳", () => {
  const env = { APPLE_ID: "dev@example.com", APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh", APPLE_TEAM_ID: "ABCDE12345" };
  for (const host of ["electron", "tauri"]) {
    const plan = planFor(["--host", host, "--target", "mac", "--arch", "arm64", "--sign", "release"], env);
    assert.equal(plan.env.PI_DESKTOP_SIGN, "release");
    assert.equal(plan.env.APPLE_SIGNING_IDENTITY, DEFAULT_RELEASE_IDENTITY, `${host} 要从同一个决定点拿到证书`);
    assert.equal(plan.signing.tier, "release");
    assert.match(plan.signing.description, /公证/);
    assert.match(plan.signing.description, /凭证 OK/);
  }

  const local = planFor(["--host", "electron", "--target", "mac", "--arch", "arm64"], env);
  assert.equal(local.env.PI_DESKTOP_SIGN, "local");
  assert.equal(local.env.APPLE_SIGNING_IDENTITY, "-");
  assert.match(local.signing.description, /ad-hoc/);
});

test("档位只认命令行：shell 里导过的 PI_DESKTOP_SIGN 不能改变一条命令的含义", () => {
  // 否则同一条 `npm run pack:electron:mac:arm64` 在不同人的机器上会出不同档位的东西。
  const plan = planFor(["--host", "electron", "--target", "mac", "--arch", "arm64"], { PI_DESKTOP_SIGN: "release" });
  assert.equal(plan.env.PI_DESKTOP_SIGN, "local");
  assert.equal(plan.signing.tier, "local");
});

test("Windows 目标不进档位表：不下发 APPLE_*，也不被公证凭证挡住", () => {
  const plan = buildPackPlan(parsePackArgs(["--host", "electron", "--target", "windows", "--mode", "slim", "--cross"]), {
    platform: "darwin",
    arch: "arm64",
    env: {},
    commandExists: () => false,
  });
  assert.equal(plan.signing, undefined);
  assert.ok(!("APPLE_SIGNING_IDENTITY" in plan.env), plan.env);
  assert.ok(!("PI_DESKTOP_SIGN" in plan.env), plan.env);
});

test("通知验收脚本在，且文档指得到它", () => {
  // 签名改动最典型的失败就是通知静默失效（这笔改动之前踩过两次），验收手段不能只存在脑子里。
  assert.ok(existsSync(resolve(ROOT, "scripts/verify-mac-notification.mjs")));
  assert.equal(readJson("package.json").scripts["notification:verify"], "node scripts/verify-mac-notification.mjs");
  for (const file of ["README.md", "README.zh-CN.md", "src-electron/README.md"]) {
    assert.match(readFileSync(resolve(ROOT, file), "utf8"), /notification:verify/, `${file} 要写清怎么验收`);
  }
});

test("文档里的档位与代码一致：README 提到两种档位，且不再推荐 CSC_IDENTITY_AUTO_DISCOVERY", () => {
  // 那条建议现在是陷阱：electron-builder 尊重它跳过签名，而档位表里 local 是"显式 ad-hoc，
  // 必须签" —— 两边一通操作会把包变成 linker-signed，通知静默失效。
  for (const file of ["README.md", "README.zh-CN.md", "src-electron/README.md"]) {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    assert.match(text, /--sign release/, `${file} 要写清生产档怎么出包`);
    assert.ok(!text.includes("CSC_IDENTITY_AUTO_DISCOVERY"), `${file} 不该再推荐 CSC_IDENTITY_AUTO_DISCOVERY`);
    assert.ok(!text.includes("electron-sign-adhoc"), `${file} 不该再提已删除的钩子`);
  }
});