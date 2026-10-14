// Metal renderer for the wallet: one shadow quad, one wallet quad, both premultiplied "over".
// Platform-neutral (Metal + ImageIO only), so the same file drives the iOS view and the macOS
// reference renderer in reference/metal/.
import Foundation
import Metal
import CoreGraphics
import ImageIO
import simd

public struct WalletMaterial: Decodable {
    public let mat: String
    public let metal, rough, relief, sheen, coat: Float
}

public struct WalletDescription: Decodable {
    public struct Image: Decodable { public let file: String; public let width, height: Int }
    public struct Regions: Decodable { public let file: String; public let width, height: Int }
    public struct Shadow: Decodable { public let file: String; public let pad, offsetY, opacity: Float }
    public let image: Image
    public let regions: Regions
    public let materials: [WalletMaterial]
    public let shadow: Shadow
}

public struct WalletParams: Decodable {
    public struct Layout: Decodable { public let widthFraction, maxWidth: Float; public let background: String }
    public struct Render: Decodable { public let maxScale, supersample: Float }
    public struct Tilt: Decodable { public let rest: [Double]; public let amplitude, softDeg, neutralTau, smoothing: Double }
    public struct Relief: Decodable { public let creases: Float }
    public struct Light: Decodable { public let `guard`: Float }
    public let layout: Layout
    public let render: Render
    public let tilt: Tilt
    public let relief: Relief
    public let light: Light
}

public enum WalletError: Error { case missing(String), badImage(String), noFunction(String) }

public final class WalletRenderer {
    public let description: WalletDescription
    public let params: WalletParams
    private let walletPipeline, shadowPipeline: MTLRenderPipelineState
    private let image, regions, shadow: MTLTexture

    /// - assets: the `assets/` folder (image.png, regions.png, shadow.png, card.json, params.json).
    /// - library: a library containing wallet.metal (the app's default library on iOS).
    public init(device: MTLDevice, library: MTLLibrary, assets: URL,
                colorPixelFormat: MTLPixelFormat = .bgra8Unorm, sampleCount: Int = 1) throws {
        func data(_ name: String) throws -> Data {
            do { return try Data(contentsOf: assets.appendingPathComponent(name)) } catch { throw WalletError.missing(name) }
        }
        description = try JSONDecoder().decode(WalletDescription.self, from: data("card.json"))
        params = try JSONDecoder().decode(WalletParams.self, from: data("params.json"))
        image = try Self.premultipliedTexture(device, data(description.image.file), name: description.image.file)
        regions = try Self.greyTexture(device, data(description.regions.file), name: description.regions.file)
        shadow = try Self.greyTexture(device, data(description.shadow.file), name: description.shadow.file)

        func pipeline(_ fragment: String) throws -> MTLRenderPipelineState {
            guard let v = library.makeFunction(name: "quad_vertex") else { throw WalletError.noFunction("quad_vertex") }
            guard let f = library.makeFunction(name: fragment) else { throw WalletError.noFunction(fragment) }
            let d = MTLRenderPipelineDescriptor()
            d.vertexFunction = v
            d.fragmentFunction = f
            d.rasterSampleCount = sampleCount
            let c = d.colorAttachments[0]!
            c.pixelFormat = colorPixelFormat          // not an _srgb format: the values are already sRGB
            c.isBlendingEnabled = true                // premultiplied over
            c.sourceRGBBlendFactor = .one
            c.sourceAlphaBlendFactor = .one
            c.destinationRGBBlendFactor = .oneMinusSourceAlpha
            c.destinationAlphaBlendFactor = .oneMinusSourceAlpha
            return try device.makeRenderPipelineState(descriptor: d)
        }
        walletPipeline = try pipeline("wallet_fragment")
        shadowPipeline = try pipeline("shadow_fragment")
    }

    /// Width ÷ height of a view that holds exactly the card and its shadow. Size the view with this
    /// (instead of full screen) and the card fills it; a larger view only costs drawable memory.
    public var fittedAspect: CGFloat {
        let s = description.shadow, aspect = CGFloat(description.image.width) / CGFloat(description.image.height)
        return (1 + 2 * CGFloat(s.pad)) / (1 / aspect + 2 * CGFloat(s.pad) + CGFloat(s.offsetY))
    }

    /// `fittedAspect` without a renderer, read from an assets folder's card.json.
    public static func fittedAspect(assets: URL) -> CGFloat? {
        guard let data = try? Data(contentsOf: assets.appendingPathComponent("card.json")),
              let d = try? JSONDecoder().decode(WalletDescription.self, from: data) else { return nil }
        let s = d.shadow, aspect = CGFloat(d.image.width) / CGFloat(d.image.height)
        return (1 + 2 * CGFloat(s.pad)) / (1 / aspect + 2 * CGFloat(s.pad) + CGFloat(s.offsetY))
    }

    /// Where the wallet sits in a view of `size` points: centred, `widthFraction` of the width,
    /// at most `maxWidth`, and small enough that it and its shadow fit the height.
    public func walletRect(in size: CGSize) -> CGRect {
        let aspect = CGFloat(description.image.width) / CGFloat(description.image.height)
        let s = description.shadow, f = CGFloat(params.layout.widthFraction)
        let fitHeight = size.height / (1 / aspect + 2 * CGFloat(s.pad) + CGFloat(s.offsetY))
        let w = min(size.width * f, CGFloat(params.layout.maxWidth), fitHeight)
        return CGRect(x: (size.width - w) / 2, y: (size.height - w / aspect) / 2, width: w, height: w / aspect)
    }

    /// Encodes the shadow and the wallet. `size` is the view in points; `tilt` the smoothed tilt (−1…1).
    public func encode(_ enc: MTLRenderCommandEncoder, size: CGSize, tilt: SIMD2<Float>) {
        guard size.width > 1, size.height > 1 else { return }
        let r = walletRect(in: size), s = description.shadow
        let pad = CGFloat(s.pad) * r.width
        let shadowRect = r.insetBy(dx: -pad, dy: -pad).offsetBy(dx: 0, dy: CGFloat(s.offsetY) * r.width)
        func clip(_ q: CGRect) -> SIMD4<Float> {
            SIMD4(Float(q.minX / size.width * 2 - 1), Float(1 - q.minY / size.height * 2),
                  Float(q.maxX / size.width * 2 - 1), Float(1 - q.maxY / size.height * 2))
        }

        encodeShadow(enc, clipRect: clip(shadowRect))
        encodeWallet(enc, clipRect: clip(r), tilt: tilt)
    }

    /// The shadow quad alone. `clipRect` = (left, top, right, bottom) in clip space.
    public func encodeShadow(_ enc: MTLRenderCommandEncoder, clipRect: SIMD4<Float>) {
        var rect = clipRect, opacity = description.shadow.opacity
        enc.setRenderPipelineState(shadowPipeline)
        enc.setVertexBytes(&rect, length: MemoryLayout<SIMD4<Float>>.size, index: 0)
        enc.setFragmentTexture(shadow, index: 0)
        enc.setFragmentBytes(&opacity, length: MemoryLayout<Float>.size, index: 0)
        enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
    }

    /// The wallet quad alone. `clipRect` = (left, top, right, bottom) in clip space.
    public func encodeWallet(_ enc: MTLRenderCommandEncoder, clipRect: SIMD4<Float>, tilt: SIMD2<Float>) {
        // WalletUniforms in wallet.metal: tex.xy, tilt.xy, 6 × (metal, rough, relief, sheen, coat), crease, guard
        var u: [Float] = [Float(description.image.width), Float(description.image.height), tilt.x, tilt.y]
        for i in 0..<6 {
            if i < description.materials.count {
                let m = description.materials[i]
                u += [m.metal, m.rough, m.relief, m.sheen, m.coat]
            } else {
                u += [0, 0, 0, 0, 0]
            }
        }
        u.append(params.relief.creases)
        u.append(params.light.guard)
        var rect = clipRect
        enc.setRenderPipelineState(walletPipeline)
        enc.setVertexBytes(&rect, length: MemoryLayout<SIMD4<Float>>.size, index: 0)
        enc.setFragmentTexture(image, index: 0)
        enc.setFragmentTexture(regions, index: 1)
        enc.setFragmentBytes(u, length: u.count * MemoryLayout<Float>.size, index: 0)
        enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
    }

    /// The pixel density to render at, as on the web: min(screen scale, 2) × 1.5.
    public func renderScale(screenScale: CGFloat) -> CGFloat {
        min(screenScale, CGFloat(params.render.maxScale)) * CGFloat(params.render.supersample)
    }

    // MARK: textures

    private static func cgImage(_ data: Data, name: String) throws -> CGImage {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { throw WalletError.badImage(name) }
        return img
    }

    /// RGBA8, premultiplied (what the web uploads with UNPACK_PREMULTIPLY_ALPHA_WEBGL), row 0 first.
    private static func premultipliedTexture(_ device: MTLDevice, _ data: Data, name: String) throws -> MTLTexture {
        let img = try cgImage(data, name: name)
        let w = img.width, h = img.height
        var px = [UInt8](repeating: 0, count: w * h * 4)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw WalletError.badImage(name) }
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))   // CGContext rows are already top-down in memory
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: w, height: h, mipmapped: false)
        d.usage = .shaderRead
        guard let t = device.makeTexture(descriptor: d) else { throw WalletError.badImage(name) }
        t.replace(region: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0, withBytes: px, bytesPerRow: w * 4)
        return t
    }

    /// R8 from an 8-bit grey PNG: the decoder's raw bytes, no colour conversion (these are data, not colour).
    private static func greyTexture(_ device: MTLDevice, _ data: Data, name: String) throws -> MTLTexture {
        let img = try cgImage(data, name: name)
        guard img.bitsPerComponent == 8, let raw = img.dataProvider?.data as Data? else { throw WalletError.badImage(name) }
        let w = img.width, h = img.height, bpp = img.bitsPerPixel / 8, stride = img.bytesPerRow
        var px = [UInt8](repeating: 0, count: w * h)
        raw.withUnsafeBytes { (b: UnsafeRawBufferPointer) in
            for y in 0..<h { for x in 0..<w { px[y * w + x] = b[y * stride + x * bpp] } }
        }
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r8Unorm, width: w, height: h, mipmapped: false)
        d.usage = .shaderRead
        guard let t = device.makeTexture(descriptor: d) else { throw WalletError.badImage(name) }
        t.replace(region: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0, withBytes: px, bytesPerRow: w)
        return t
    }
}
