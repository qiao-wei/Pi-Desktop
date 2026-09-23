// 生成打包用应用图标：assets/app-icon-source.ico -> src-tauri/icons/icon.png + icon.ico
//
// 三件事必须在这里固化，而不是靠人记得：
// 1) 圆角要画进像素里 —— macOS 不会自动给 app 图标加圆角，Windows 也不会；
// 2) 像素风源图（favicon 只有 128x128）必须整数倍 + 最近邻放大，否则 8x 双线性会糊成一团；
// 3) Windows 那一侧只认 .ico（tauri-build 的资源编译和 NSIS 都找不到 png），所以它和 png 一起
//    生成、一起核验 —— 否则重画了图标之后 .ico 还是旧的。
// 生成完立刻用 pngBasic 复核像素，不通过就非零退出，避免"配置改了但图没变"。
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cornerReport, readPngInfo } from "./lib/pngBasic.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_REL = "assets/app-icon-source.ico";
const SOURCE = path.join(repoRoot, SOURCE_REL);
const RENDERER = path.join(repoRoot, "scripts", "render-app-icon.swift");
const OUTPUT = path.join(repoRoot, "src-tauri", "icons", "icon.png");
const ICO_OUTPUT = path.join(repoRoot, "src-tauri", "icons", "icon.ico");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function tauriIconCli() {
  const bin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
  if (!fs.existsSync(bin)) {
    throw new Error("[icon] 找不到 @tauri-apps/cli，先 npm install");
  }
  return bin;
}

// Windows 的 .ico 交给官方 CLI 生成：自己拼 ICO 容器（BMP/AND mask、PNG entry、256 帧）容易在
// rc.exe 那边翻车，而这份产物正是所有 Tauri Windows 应用在用的格式，同一输入下字节也稳定。
// 只取 icon.ico，其余尺寸 PNG / icns / 移动端目录都丢在临时目录里。
function buildIco(stagePng) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-ico-"));
  try {
    // tauri icon 的进度日志走 stderr，一次几十行：成功时只留我们自己的汇总，失败时把原文带出来。
    const result = spawnSync(tauriIconCli(), ["icon", stagePng, "-o", outDir], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`[icon] tauri icon 失败（${result.status}）：\n${result.stdout ?? ""}${result.stderr ?? ""}`);
    }
    const ico = path.join(outDir, "icon.ico");
    if (!fs.existsSync(ico)) {
      throw new Error("[icon] tauri icon 没有产出 icon.ico");
    }
    const buf = fs.readFileSync(ico);
    const count = buf.readUInt16LE(4);
    const sizes = [];
    for (let i = 0; i < count; i += 1) {
      const offset = buf.readUInt32LE(6 + i * 16 + 12);
      if (buf.subarray(offset, offset + 8).toString("hex") !== "89504e470d0a1a0a") {
        throw new Error("[icon] ICO 里有非 PNG 的 entry，rc.exe 能不能吃没保证");
      }
      sizes.push(buf[6 + i * 16] || 256);
    }
    if (!sizes.includes(16) || !sizes.includes(256)) {
      throw new Error(`[icon] ICO 尺寸不全：${sizes.join("/")}`);
    }
    return { bytes: buf, sizes };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

const CANVAS = 1024;
const INSET = 64; // 内容 896 = 128 的整数 7 倍，最近邻下每块像素等大
const RADIUS = 184; // 视觉圆角，约画布的 18%
const CURVE_LIMIT = "6"; // 超椭圆指数，6 ≈ Apple 连续曲率
const INTERP = "nearest";

function rendererBinary() {
  const bin = path.join(os.tmpdir(), "pi-desktop-render-app-icon");
  const stale = fs.existsSync(bin) && fs.statSync(bin).mtimeMs < fs.statSync(RENDERER).mtimeMs;
  if (!fs.existsSync(bin) || stale) {
    execFileSync("xcrun", ["swiftc", "-O", RENDERER, "-o", bin], { stdio: "inherit" });
  }
  return bin;
}

function main() {
  const verify = process.argv.includes("--verify");
  if (process.platform !== "darwin") {
    console.error(`[icon] 渲染器依赖 macOS 的 CoreGraphics/ImageIO，当前平台 ${process.platform} 无法生成图标。`);
    process.exit(1);
  }
  for (const file of [SOURCE, RENDERER]) {
    if (!fs.existsSync(file)) {
      console.error(`[icon] 缺少 ${path.relative(repoRoot, file)}`);
      process.exit(1);
    }
  }
  // 渲染到临时文件再校验/落盘：--verify 不改工作区，也能发现"图标源改了但产物没跟上"。
  const stage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-icon-")), "icon.png");
  const ratioOfContent = CANVAS - INSET * 2;
  execFileSync(rendererBinary(), [
    SOURCE,
    stage,
    String(CANVAS),
    String(INSET / CANVAS),
    String(RADIUS / ratioOfContent),
    CURVE_LIMIT,
    INTERP,
  ]);

  const info = readPngInfo(fs.readFileSync(stage));
  const report = cornerReport(stage, INSET, RADIUS);
  const problems = [];
  if (info.width !== CANVAS || info.height !== CANVAS) problems.push(`尺寸 ${info.width}x${info.height}，应为 ${CANVAS}x${CANVAS}`);
  if (info.colorType !== 6) problems.push(`colorType=${info.colorType}，应为 6（RGBA）`);
  for (const [name, alpha] of Object.entries(report.corners)) {
    if (alpha > 8) problems.push(`${name} 不透明（alpha=${alpha}）⇒ 圆角没画进图里`);
  }
  if (report.insideCorner > 40) problems.push(`内容左上顶点仍不透明（alpha=${report.insideCorner}）⇒ 圆角半径太小`);
  if (report.pastCorner < 200) problems.push(`越过圆角后仍透明（alpha=${report.pastCorner}）⇒ 圆角半径太大或图被裁穿`);
  if (report.center < 200) problems.push(`中心透明（alpha=${report.center}）⇒ 源图没画满`);
  if (problems.length) {
    console.error(`[icon] 生成结果不合格：\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
  const bytes = fs.statSync(stage).size;
  const summary =
    `${CANVAS}x${CANVAS} 圆角半径 ${RADIUS}（连续曲率 ${CURVE_LIMIT}）` +
    ` 内容 ${ratioOfContent}px = 源图 7 倍最近邻，${(bytes / 1024).toFixed(0)}KB，四角透明 ✓`;
  // .ico 在 --verify 里也重算一遍：Windows 用的是它，圆角/尺寸漂了同样要拦住。
  const stagedIco = buildIco(stage);
  const icoSummary = `${stagedIco.sizes.length} 帧 PNG（${stagedIco.sizes.join("、")}），${(stagedIco.bytes.length / 1024).toFixed(0)}KB`;
  try {
    if (verify) {
      const stale = [
        [OUTPUT, sha256(fs.readFileSync(stage))],
        [ICO_OUTPUT, sha256(stagedIco.bytes)],
      ].filter(([file, fresh]) => !fs.existsSync(file) || sha256(fs.readFileSync(file)) !== fresh);
      if (stale.length) {
        console.error(
          `[icon] 与源图不同步：${stale.map(([file]) => path.relative(repoRoot, file)).join("、")}，跑 npm run icon:build`,
        );
        process.exit(1);
      }
      console.log(
        `[icon] --verify 通过：${path.relative(repoRoot, OUTPUT)} 与 ${path.relative(repoRoot, ICO_OUTPUT)}` +
          ` 都和 ${SOURCE_REL} 同步（${summary}；ICO ${icoSummary}）`,
      );
      return;
    }
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.copyFileSync(stage, OUTPUT);
    fs.writeFileSync(ICO_OUTPUT, stagedIco.bytes);
    console.log(`[icon] ${path.relative(repoRoot, OUTPUT)}: ${summary}`);
    console.log(`[icon] ${path.relative(repoRoot, ICO_OUTPUT)}: ${icoSummary}`);
  } finally {
    fs.rmSync(path.dirname(stage), { recursive: true, force: true });
  }
}

main();
