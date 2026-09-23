/**
 * 打包图标门禁。
 *
 * 两个踩过的坑：把 ~/Downloads 里的 favicon 直接指进配置（换台机器就构建不出来）；
 * 以及"以为有圆角"—— macOS 和 Windows 都不会自动给 app 图标加圆角，圆角必须是像素本身透明。
 * 所以这里既查接线（唯一图标源、两端共用、生成器可复现），也查产物像素（四角真的透明），
 * 并且给解码器留了正/负对照：否则"cornerReport 永远返回透明"也能让整套断言假绿。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import zlib from "node:zlib";

import { cornerReport, decodeRgba8Png, readPngInfo } from "../scripts/lib/pngBasic.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const ICON_REL = "src-tauri/icons/icon.png";
const ICON = resolve(ROOT, ICON_REL);
const BUILDER = resolve(ROOT, "scripts/build-app-icon.mjs");
const SOURCE_REL = "assets/app-icon-source.ico";

// 与 scripts/build-app-icon.mjs 保持一致：1024 画布、内容内缩 64、圆角半径 184。
const CANVAS = 1024;
const INSET = 64;
const RADIUS = 184;

function pngFromRgba(width, height, rgba) {
  const info = Buffer.alloc(13);
  info.writeUInt32BE(width, 0);
  info.writeUInt32BE(height, 4);
  info[8] = 8; // bit depth
  info[9] = 6; // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) =>
    // 这个最小读取器不校验 CRC，测试里就不重复造 crc32 了。
    Buffer.concat([
      (() => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length, 0);
        return len;
      })(),
      Buffer.from(type, "ascii"),
      data,
      Buffer.alloc(4),
    ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", info),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function swatch(size, isHole) {
  const px = Buffer.alloc(size * size * 4, 0);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      px[i] = 10;
      px[i + 1] = 20;
      px[i + 2] = 30;
      px[i + 3] = isHole(x, y) ? 0 : 255;
    }
  }
  return { size, px };
}

// 测试自己建模一个 squircle（|dx|^n + |dy|^n > r^n 即圆弧之外），
// 不复用渲染器的采样代码，两边不一致时断言会响。
function squircleHoles(size, inset, radius, exponent) {
  return (x, y) => {
    const centers = [
      [inset + radius, inset + radius],
      [size - inset - radius - 1, inset + radius],
      [inset + radius, size - inset - radius - 1],
      [size - inset - radius - 1, size - inset - radius - 1],
    ];
    const inCornerBox = centers.some(([cx, cy]) => {
      const nearX = Math.abs(x - cx) <= radius && Math.abs(y - cy) <= radius;
      if (!nearX) return false;
      const dx = Math.abs(x - cx);
      const dy = Math.abs(y - cy);
      const outside = dx > radius || dy > radius;
      if (outside) return false;
      return (dx / radius) ** exponent + (dy / radius) ** exponent > 1;
    });
    const outsideContent = x < inset || y < inset || x >= size - inset || y >= size - inset;
    return inCornerBox || outsideContent;
  };
}

function tempPng(buffer) {
  const dir = mkdtempSync("/tmp/pi-desktop-icon-test-");
  const file = resolve(dir, "x.png");
  writeFileSync(file, buffer);
  return file;
}

test("解码器正对照：能读出透明角与不透明中心", () => {
  const { size, px } = swatch(8, (x, y) => ["0,0", "1,0", "0,1"].includes(`${x},${y}`));
  const img = decodeRgba8Png(pngFromRgba(size, size, px));
  assert.equal(img.width, 8);
  assert.equal(img.height, 8);
  assert.equal(img.hasAlpha, true);
  assert.equal(img.pixel(0, 0).a, 0);
  assert.equal(img.pixel(4, 4).a, 255);
  assert.deepEqual([img.pixel(4, 4).r, img.pixel(4, 4).g, img.pixel(4, 4).b], [10, 20, 30]);
});

test("解码器负对照：直角填充图必须报四角不透明", () => {
  const { size, px } = swatch(64, () => false);
  const report = cornerReport(tempPng(pngFromRgba(size, size, px)), 0, 0);
  assert.deepEqual(report.corners, { topLeft: 255, topRight: 255, bottomLeft: 255, bottomRight: 255 });
});

test("cornerReport 判圆角：削掉的角透明、越过半径不透明", () => {
  const size = 64;
  const inset = 4;
  const radius = 20;
  const { px } = swatch(size, squircleHoles(size, inset, radius, 6));
  const report = cornerReport(tempPng(pngFromRgba(size, size, px)), inset, radius);
  assert.deepEqual(report.corners, { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 });
  assert.equal(report.insideCorner, 0, "内容方角顶点应落在圆弧之外");
  assert.equal(report.pastCorner, 255, "越过圆角半径之后应不透明");
  assert.equal(report.center, 255);
});

test("坏输入必须抛，而不是静默通过", () => {
  const file = tempPng(Buffer.from("not a png at all"));
  assert.throws(() => readPngInfo(readFileSync(file)), /不是 PNG/);
  assert.throws(() => cornerReport(file, 0, 0), /不是 PNG/);
});

test("打包图标只有一个源文件，mac/win 共用", () => {
  const config = JSON.parse(readFileSync(resolve(ROOT, "src-electron/electron-builder.json"), "utf8"));
  assert.equal(config.mac.icon, ICON_REL);
  assert.equal(config.win.icon, ICON_REL);
  const paths = readFileSync(resolve(ROOT, "src-electron/paths.js"), "utf8");
  assert.ok(
    paths.includes('"icons"') && paths.includes('"icon.png"'),
    "dev 的 Dock 图标要和打包图标指向同一个文件",
  );
});

test("打包图标产物：1024 RGBA 且圆角真的在像素里", () => {
  assert.ok(existsSync(ICON), `缺少 ${ICON_REL}，先跑 npm run icon:build`);
  const info = readPngInfo(readFileSync(ICON));
  assert.equal(info.width, CANVAS);
  assert.equal(info.height, CANVAS);
  assert.equal(info.bitDepth, 8);
  assert.equal(info.colorType, 6, "图标必须带 alpha，否则表达不了圆角");
  assert.equal(info.interlace, 0);
  const report = cornerReport(ICON, INSET, RADIUS);
  for (const [corner, alpha] of Object.entries(report.corners)) {
    assert.ok(alpha <= 8, `${corner} alpha=${alpha}：四角必须透明（系统不会自动加圆角）`);
  }
  assert.ok(report.insideCorner <= 40, `内容角 alpha=${report.insideCorner}：圆角半径不够`);
  assert.ok(report.pastCorner >= 200, `圆角内侧 alpha=${report.pastCorner}：圆角过头或图被裁穿`);
  assert.ok(report.center >= 200, `中心 alpha=${report.center}：源图没画满画布`);
});

test("Windows 侧有可用的 icon.ico：多尺寸、圆角在像素里、配置里有它", () => {
  const config = JSON.parse(readFileSync(resolve(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
  assert.ok(
    config.bundle.icon.includes("icons/icon.ico"),
    "Windows 的 rc 资源和 NSIS 只认 .ico，bundle.icon 里必须有它",
  );
  assert.ok(config.bundle.icon.includes("icons/icon.png"), "mac/linux 侧仍然用 png");

  const ico = resolve(ROOT, "src-tauri/icons/icon.ico");
  assert.ok(existsSync(ico), "缺少 src-tauri/icons/icon.ico，先跑 npm run icon:build");
  const buffer = readFileSync(ico);
  assert.equal(buffer.readUInt16LE(0), 0, "ICONDIR.reserved 必须是 0");
  assert.equal(buffer.readUInt16LE(2), 1, "ICONDIR.type 必须是 1（图标）");
  const count = buffer.readUInt16LE(4);
  assert.ok(count >= 4, `ICO 只有 ${count} 帧，系统缩放时会糊`);

  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    const size = buffer.readUInt32LE(entry + 8);
    const offset = buffer.readUInt32LE(entry + 12);
    const image = buffer.subarray(offset, offset + size);
    // 每帧都得是 PNG：自制 BMP/AND mask 那一套在本机没法验证 rc.exe 吃不吐得下，就别放行。
    assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `第 ${i} 帧不是 PNG`);
    const width = buffer[entry] || 256;
    assert.equal(buffer[entry + 1] || 256, width, "ICO 帧必须是正方形");
    sizes.push(width);
  }
  for (const needed of [16, 32, 256]) {
    assert.ok(sizes.includes(needed), `ICO 缺少 ${needed}px 帧：${sizes.join("/")}`);
  }

  // 圆角是画在像素里的：拿最大那帧解码，四角必须透明 —— 否则说明 .ico 用的是方形源图，
  // 没走圆角渲染（Windows 不会自己给图标加圆角）。
  const largest = 6 + sizes.indexOf(Math.max(...sizes)) * 16;
  const largestSize = buffer.readUInt32LE(largest + 8);
  const largestOffset = buffer.readUInt32LE(largest + 12);
  const img = decodeRgba8Png(buffer.subarray(largestOffset, largestOffset + largestSize));
  assert.equal(img.width, Math.max(...sizes));
  for (const [x, y] of [
    [0, 0],
    [img.width - 1, 0],
    [0, img.height - 1],
    [img.width - 1, img.height - 1],
  ]) {
    assert.ok(img.pixel(x, y).a <= 8, `(${x},${y}) alpha=${img.pixel(x, y).a}：ICO 四角必须透明`);
  }
  assert.ok(img.pixel(img.width >> 1, img.height >> 1).a >= 200, "ICO 中心必须不透明");
});

test("图标生成器可复现：源图入库、不引用个人目录、像素风用最近邻", () => {
  assert.ok(existsSync(resolve(ROOT, SOURCE_REL)), `源图必须入库（${SOURCE_REL}）`);
  const builder = readFileSync(BUILDER, "utf8");
  assert.ok(builder.includes("app-icon-source.ico"), "生成脚本要读仓库里的源图");
  assert.ok(!/Downloads|\/Users\/|homedir\(\)/.test(builder), "生成脚本不能引用个人目录");
  assert.ok(builder.includes("nearest"), "像素风源图必须最近邻放大，否则整数倍也会糊");
  assert.ok(builder.includes("icon.ico"), "生成脚本要同时产出 Windows 的 .ico，否则重画图标后它是旧的");
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["icon:build"], "node scripts/build-app-icon.mjs");
  const renderer = readFileSync(resolve(ROOT, "scripts/render-app-icon.swift"), "utf8");
  assert.ok(renderer.includes("clip()"), "渲染器必须真的做圆角裁剪");
});
