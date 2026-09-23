// electron-builder `afterPack` 钩子（只在 macOS 上做事）：给「跳过签名」的产物补一个 ad-hoc 签名。
//
// 背景（2026-09-20 实测）：本机没有 Developer ID / Apple Development 证书时，electron-builder 会
// 「skipped macOS application code signing」，产物 `.app` 保留 Electron 自带的 linker 签名
// （`codesign -dv` → `Identifier=Electron`、`Sealed Resources=none`）。这种包能正常启动、功能正常，
// 但 macOS 会拒绝它的一切通知（`UNErrorDomain error 1`，且不弹权限框）——也就是设置里的
// 「任务完成后系统提醒」在打包版里静默失效。
//
// 复现/验证：把同一个 .app 重新做一次 ad-hoc 签名、identifier 与 Info.plist 的 CFBundleIdentifier
// 对齐后，通知立刻恢复（`defaults read com.apple.ncprefs` 里出现该 app 的记录，`auth = 7`）。
// 也就是说 ad-hoc 足够，缺的只是「包签名与 bundle id 自洽」。
//
// 有真实证书时不插手（让 electron-builder 自己签，那里还需要 hardened runtime / 公证）。
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

const readSignature = (appPath) => {
  const { stdout, stderr } = spawnSync("codesign", ["-dv", "--verbose=2", appPath], { encoding: "utf8" });
  return `${stdout ?? ""}${stderr ?? ""}`;
};

const hasCodeSigningIdentity = () => {
  const { stdout } = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  const count = Number((stdout ?? "").match(/(\d+)\s+valid identities found/)?.[1] ?? 0);
  return count > 0;
};

export default async function signAdhocAfterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const bundleId = context.packager.appInfo.id;
  if (hasCodeSigningIdentity()) {
    console.log(`[adhoc-sign] 有可用证书，交给 electron-builder 签名：${appPath}`);
    return;
  }
  const before = readSignature(appPath);
  const currentId = before.match(/^Identifier=(.+)$/m)?.[1]?.trim();
  if (currentId === bundleId) {
    console.log(`[adhoc-sign] 已有自洽的 ad-hoc 签名（identifier=${bundleId}），跳过`);
    return;
  }
  console.log(`[adhoc-sign] 没有可用证书 → 补 ad-hoc 签名（identifier: ${currentId ?? "unknown"} → ${bundleId}）`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--identifier", bundleId, appPath], { stdio: "inherit" });
  const after = readSignature(appPath);
  console.log(`[adhoc-sign] ${after.split("\n").filter((line) => /^(Identifier|Signature|Sealed|TeamIdentifier)/.test(line)).join(" | ")}`);
}