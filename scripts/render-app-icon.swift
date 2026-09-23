// 把任意图标源（ico/png/svg 由 ImageIO 决定，可用 sips -g format 先确认）渲染成
// 应用图标：正方形画布 + macOS 图标网格留白 + 圆角裁剪（macOS 不会自动给 app 图标加圆角，
// 圆角必须画进像素里；Windows 用同一张图，行为一致）。
//
// 用法:
//   swiftc -O scripts/render-app-icon.swift -o /tmp/render-app-icon
//   /tmp/render-app-icon <src> <dst.png> [canvas=1024] [insetRatio=0.0977] [radiusRatio=0.2247] [curveLimit=6] [interp=smooth|nearest]
//
// 默认值来自 Apple HIG 的 macOS 图标网格：1024 画布上内容 824x824 居中（inset 100），
// 圆角半径 185 ⇒ insetRatio=100/1024, radiusRatio=185/824。
// curveLimit 是超椭圆指数：2 = 普通圆弧，6 ≈ Apple 的连续曲率 squircle。
// 不用 CGPath 的 cornerCurveLimit（本机 SDK 没有该重载），自己采样成折线，
// 1024 边长下 4x64 段 + 抗锯齿肉眼已无法与解析曲线区分。
import CoreGraphics
import Foundation
import ImageIO

// 超椭圆 |x|^n + |y|^n = 1 的第一象限采样，拼成四角连续的圆角矩形。
func squirclePath(rect: CGRect, radius r: CGFloat, exponent n: CGFloat, samples: Int = 64) -> CGMutablePath {
    let path = CGMutablePath()
    let rr = min(max(r, 0), min(rect.width, rect.height) / 2)
    if rr <= 0 {
        path.addRect(rect)
        return path
    }
    let exp = max(n, 2)
    var points: [CGPoint] = []
    // 逆时针绕一圈（CGContext 是 y 轴向上），每段 90°，段与段之间自然是直线边。
    let corners: [(center: CGPoint, from: CGFloat, to: CGFloat)] = [
        (CGPoint(x: rect.maxX - rr, y: rect.minY + rr), -.pi / 2, 0),      // 右下
        (CGPoint(x: rect.maxX - rr, y: rect.maxY - rr), 0, .pi / 2),       // 右上
        (CGPoint(x: rect.minX + rr, y: rect.maxY - rr), .pi / 2, .pi),     // 左上
        (CGPoint(x: rect.minX + rr, y: rect.minY + rr), .pi, 3 * .pi / 2),  // 左下
    ]
    for corner in corners {
        for i in 0...samples {
            let t = corner.from + (corner.to - corner.from) * CGFloat(i) / CGFloat(samples)
            // 参数化超椭圆（n=2 时退化为真圆弧）
            let x = pow(abs(cos(t)), 2 / exp) * rr * (cos(t) < 0 ? -1 : 1)
            let y = pow(abs(sin(t)), 2 / exp) * rr * (sin(t) < 0 ? -1 : 1)
            points.append(CGPoint(x: corner.center.x + x, y: corner.center.y + y))
        }
    }
    path.addLines(between: points)
    path.closeSubpath()
    return path
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    fputs("用法: \(args[0]) <src> <dst.png> [canvas] [insetRatio] [radiusRatio]\n", stderr)
    exit(2)
}
let srcPath = args[1]
let dstPath = args[2]
let canvas = args.count > 3 ? Int(args[3]) ?? 1024 : 1024
let insetRatio = args.count > 4 ? Double(args[4]) ?? 100.0 / 1024.0 : 100.0 / 1024.0
let radiusRatio = args.count > 5 ? Double(args[5]) ?? 185.0 / 824.0 : 185.0 / 824.0
let curveLimit = args.count > 6 ? Double(args[6]) ?? 6.0 : 6.0
// 像素风 logo 必须 nearest，否则 8x 放大被双线性糊成一团；照片/矢量感用 smooth。
let nearest = (args.count > 7 ? args[7] : "smooth") == "nearest"

guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: srcPath) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
    fputs("读不到图标源: \(srcPath)\n", stderr)
    exit(1)
}

let side = CGFloat(canvas)
let inset = side * CGFloat(insetRatio)
let content = CGRect(x: inset, y: inset, width: side - inset * 2, height: side - inset * 2)
let radius = content.width * CGFloat(radiusRatio)

guard let ctx = CGContext(
    data: nil, width: canvas, height: canvas, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fputs("无法创建位图上下文\n", stderr)
    exit(1)
}

ctx.setAllowsAntialiasing(true)
ctx.interpolationQuality = nearest ? .none : .high
ctx.addPath(squirclePath(rect: content, radius: radius, exponent: CGFloat(curveLimit)))
ctx.clip()
ctx.draw(image, in: content)

guard let out = ctx.makeImage() else {
    fputs("渲染失败\n", stderr)
    exit(1)
}
guard let dst = CGImageDestinationCreateWithURL(
    URL(fileURLWithPath: dstPath) as CFURL, "public.png" as CFString, 1, nil
) else {
    fputs("无法写 \(dstPath)\n", stderr)
    exit(1)
}
CGImageDestinationAddImage(dst, out, nil)
guard CGImageDestinationFinalize(dst) else {
    fputs("PNG 落盘失败\n", stderr)
    exit(1)
}
print("\(dstPath): \(canvas)x\(canvas) inset=\(Int(inset)) radius=\(Int(radius)) curve=\(curveLimit) interp=\(nearest ? "nearest" : "smooth")")
