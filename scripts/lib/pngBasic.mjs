// 零依赖的最小 PNG 读取：只支持打包图标这一类文件（8bit、非隔行、RGBA/RGB）。
// 之所以自己写：门禁要能证明"圆角真的画进像素里"，而这不需要图像库。
import fs from "node:fs";
import zlib from "node:zlib";

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function readPngInfo(buffer) {
  if (buffer.toString("ascii", 12, 16) !== "IHDR") throw new Error("不是 PNG（缺 IHDR）");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    interlace: buffer[28],
  };
}

// 反滤波后返回 RGBA 像素访问器。灰度/无 alpha 的图会补 alpha=255。
export function decodeRgba8Png(buffer, info = readPngInfo(buffer)) {
  const { width, height, bitDepth, colorType, interlace } = info;
  if (bitDepth !== 8) throw new Error(`只支持 8bit，实际 ${bitDepth}`);
  if (interlace !== 0) throw new Error("不支持隔行 PNG");
  const srcChannels = CHANNELS[colorType];
  if (!srcChannels) throw new Error(`不支持的 colorType ${colorType}`);
  const stride = width * 4;
  const idat = [];
  let off = 8;
  while (off + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(off);
    const type = buffer.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(buffer.subarray(off + 8, off + 8 + len));
    if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(height * stride);
  const srcStride = width * srcChannels;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (srcStride + 1)];
    const line = raw.subarray(y * (srcStride + 1) + 1, y * (srcStride + 1) + 1 + srcStride);
    const dst = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    // 反滤波在源字节空间做，但邻居像素要按 RGBA 输出空间的步长取（每像素固定 4 字节）。
    for (let x = 0; x < width; x += 1) {
      for (let ch = 0; ch < srcChannels; ch += 1) {
        const j = x * 4 + ch;
        const a = x > 0 ? dst[j - 4] : 0;
        const b = prev[j];
        const c = x > 0 ? prev[j - 4] : 0;
        let value = line[x * srcChannels + ch];
        if (filter === 1) value += a;
        else if (filter === 2) value += b;
        else if (filter === 3) value += (a + b) >> 1;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        dst[j] = value & 255;
      }
      if (srcChannels === 3) dst[x * 4 + 3] = 255;
      else if (srcChannels === 1) {
        const gray = dst[x * 4];
        dst[x * 4 + 1] = gray;
        dst[x * 4 + 2] = gray;
        dst[x * 4 + 3] = 255;
      } else if (srcChannels === 2) {
        const gray = dst[x * 4];
        dst[x * 4 + 1] = gray;
        dst[x * 4 + 2] = gray;
      }
    }
  }
  return {
    width,
    height,
    hasAlpha: colorType === 6 || colorType === 4,
    pixel(x, y) {
      const i = y * stride + x * 4;
      return { r: out[i], g: out[i + 1], b: out[i + 2], a: out[i + 3] };
    },
  };
}

export function readPngFile(path) {
  return decodeRgba8Png(fs.readFileSync(path));
}

// 圆角的机器可验证定义：四角透明，且"内容方角的顶点"落在圆弧之外（透明），
// 而同一条边上越过半径足够多的位置不透明。偏移按半径比例取，小图（测试用）也能成立。
export function cornerReport(path, inset, radius) {
  const img = readPngFile(path);
  const { width, height } = img;
  const at = (x, y) => (x < width && y < height ? img.pixel(x, y).a : undefined);
  const step = Math.max(2, Math.round(radius * 0.2));
  return {
    width,
    height,
    corners: {
      topLeft: at(0, 0),
      topRight: at(width - 1, 0),
      bottomLeft: at(0, height - 1),
      bottomRight: at(width - 1, height - 1),
    },
    insideCorner: at(inset + 2, inset + 2),
    pastCorner: at(inset + radius + step, inset + 2),
    center: at(Math.floor(width / 2), Math.floor(height / 2)),
  };
}
