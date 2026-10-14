// Metal reference renderer (macOS command line). Uses ios/WalletRenderer.swift and shaders/wallet.metal
// unchanged, renders offscreen and writes PNGs for reference/compare.html.
//
//   reference/metal/run.sh
//
// Writes, into reference/results/:
//   metal_<x>_<y>.png   the wallet alone at the image's own size, over the stage colour, one per tilt
//   scene_<x>_<y>.png   a 390 × 844 pt phone screen at 3×, card + shadow, one per tilt
import Foundation
import Metal
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let assets = root.appendingPathComponent("assets")
let out = root.appendingPathComponent("reference/results")
// optional: tilts as "x,y;x,y;…" in argv[2] (card-only renders, no phone screens)
let custom: [SIMD2<Float>]? = CommandLine.arguments.count > 2
    ? CommandLine.arguments[2].split(separator: ";").map { p in let v = p.split(separator: ",").map { Float($0)! }; return SIMD2(v[0], v[1]) }
    : nil
let tilts: [SIMD2<Float>] = custom ?? [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.6, -0.4]]

let device = MTLCreateSystemDefaultDevice()!
let source = try String(contentsOf: root.appendingPathComponent("shaders/wallet.metal"), encoding: .utf8)
let library = try device.makeLibrary(source: source, options: nil)
let renderer = try WalletRenderer(device: device, library: library, assets: assets)
let queue = device.makeCommandQueue()!

func background() -> MTLClearColor {
    let hex = renderer.params.layout.background.dropFirst()
    let v = Int(hex, radix: 16)!
    return MTLClearColor(red: Double((v >> 16) & 255) / 255, green: Double((v >> 8) & 255) / 255, blue: Double(v & 255) / 255, alpha: 1)
}

func render(width: Int, height: Int, to name: String, draw: (MTLRenderCommandEncoder) -> Void) throws {
    let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
    d.usage = [.renderTarget, .shaderRead]
    d.storageMode = .shared
    let target = device.makeTexture(descriptor: d)!
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = target
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].clearColor = background()
    pass.colorAttachments[0].storeAction = .store
    let cmd = queue.makeCommandBuffer()!
    let enc = cmd.makeRenderCommandEncoder(descriptor: pass)!
    enc.setViewport(MTLViewport(originX: 0, originY: 0, width: Double(width), height: Double(height), znear: 0, zfar: 1))
    draw(enc)
    enc.endEncoding()
    cmd.commit()
    cmd.waitUntilCompleted()

    var px = [UInt8](repeating: 0, count: width * height * 4)
    target.getBytes(&px, bytesPerRow: width * 4, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)
    let ctx = CGContext(data: &px, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    let url = out.appendingPathComponent(name)
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(url.path)") }
    print("wrote", url.lastPathComponent)
}

let w = renderer.description.image.width, h = renderer.description.image.height
let full = SIMD4<Float>(-1, 1, 1, -1)
func label(_ v: Float) -> String { String(format: "%g", v) }
for t in tilts {
    try render(width: w, height: h, to: "metal_\(label(t.x))_\(label(t.y)).png") { renderer.encodeWallet($0, clipRect: full, tilt: t) }
}
let scene = CGSize(width: 390, height: 844)
for t in custom == nil ? tilts : [] {
    try render(width: 390 * 3, height: 844 * 3, to: "scene_\(label(t.x))_\(label(t.y)).png") { renderer.encode($0, size: scene, tilt: t) }
}
