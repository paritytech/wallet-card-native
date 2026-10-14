// SwiftUI view: the wallet, lit by the phone's motion. Drop-in:
//
//   WalletView()                                    // assets from the "WalletAssets" folder in the app bundle
//       .background(Color(red: 0xEC / 255, green: 0xEC / 255, blue: 0xEF / 255))
//
// The view is transparent outside the wallet and its shadow; put any background behind it.
// Size it to the card rather than full screen (the drawable is width × height × scale² × 4 bytes, ×3):
//
//   WalletView().aspectRatio(WalletView.fittedAspect(), contentMode: .fit)
//
// It draws only when the light moved visibly or the size changed, so a phone held still costs almost nothing.
// Without a gyroscope (the Simulator) a drag moves the light instead, like the pointer on the web.
import SwiftUI
import MetalKit
import QuartzCore

public struct WalletView: UIViewRepresentable {
    public var assetsFolder = "WalletAssets"
    public init(assetsFolder: String = "WalletAssets") { self.assetsFolder = assetsFolder }

    /// Width ÷ height of the card with its shadow, for `.aspectRatio(_, contentMode: .fit)`.
    public static func fittedAspect(assetsFolder: String = "WalletAssets") -> CGFloat {
        Bundle.main.url(forResource: assetsFolder, withExtension: nil).flatMap(WalletRenderer.fittedAspect(assets:)) ?? 1.6
    }

    public func makeCoordinator() -> Coordinator { Coordinator() }

    public func makeUIView(context: Context) -> MTKView {
        let view = MTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())
        view.colorPixelFormat = .bgra8Unorm               // not _srgb: the shader's values are already sRGB
        view.isOpaque = false
        view.layer.isOpaque = false
        view.backgroundColor = .clear
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        view.preferredFramesPerSecond = 60
        view.delegate = context.coordinator
        context.coordinator.setUp(view, folder: assetsFolder)
        view.addGestureRecognizer(UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.pan(_:))))
        return view
    }

    public func updateUIView(_ view: MTKView, context: Context) {}

    public static func dismantleUIView(_ view: MTKView, coordinator: Coordinator) { coordinator.tilt?.stop() }

    public final class Coordinator: NSObject, MTKViewDelegate {
        var renderer: WalletRenderer?
        var tilt: TiltSource?
        private var queue: MTLCommandQueue?
        private var lastFrame: CFTimeInterval = 0
        // what the last presented frame showed; frames that would look the same are skipped
        private var drawnTilt = SIMD2<Float>(.nan, .nan)
        private var drawnSize = CGSize.zero
        private var idle: Float = 0.002                 // params.render.idle

        func setUp(_ view: MTKView, folder: String) {
            guard let device = view.device, let assets = Bundle.main.url(forResource: folder, withExtension: nil) else {
                assertionFailure("WalletView: no Metal device, or the \(folder) folder is missing"); return
            }
            do {
                // wallet.metal compiled into the app target; else its source shipped next to the assets
                var library = device.makeDefaultLibrary()
                if library?.makeFunction(name: "wallet_fragment") == nil {
                    let source = try String(contentsOf: assets.appendingPathComponent("wallet.metal"), encoding: .utf8)
                    library = try device.makeLibrary(source: source, options: nil)
                }
                guard let library else { return }
                let r = try WalletRenderer(device: device, library: library, assets: assets, colorPixelFormat: view.colorPixelFormat)
                renderer = r
                queue = device.makeCommandQueue()
                // render density as on the web: min(screen scale, 2) × 1.5 (= 3 on every current iPhone)
                view.contentScaleFactor = r.renderScale(screenScale: UIScreen.main.scale)
                // at most maxFps (60): on a 120 Hz ProMotion screen more frames only double the cost
                view.preferredFramesPerSecond = r.params.render.maxFps
                idle = r.params.render.idle
                tilt = TiltSource(r.params.tilt)
                tilt?.start()
            } catch {
                assertionFailure("WalletView: \(error)")
            }
        }

        @objc func pan(_ g: UIPanGestureRecognizer) {
            guard let tilt, !tilt.hasGyro, let v = g.view else { return }
            if g.state == .ended || g.state == .cancelled { tilt.filter.point(nil); return }
            let p = g.location(in: v)
            tilt.filter.point([Double(p.x / v.bounds.width - 0.5) * 2, Double(p.y / v.bounds.height - 0.5) * -2])
        }

        public func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

        public func draw(in view: MTKView) {
            guard let renderer, let queue else { return }
            let now = CACurrentMediaTime()
            let dt = lastFrame == 0 ? 0 : min(0.1, now - lastFrame)
            lastFrame = now
            let t = tilt?.update(dt: dt) ?? .zero
            // Skip the frame (no drawable, no GPU work) when it would look the same as the last one.
            let size = view.drawableSize
            if size == drawnSize, abs(t.x - drawnTilt.x) <= idle, abs(t.y - drawnTilt.y) <= idle { return }
            guard let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
                  let cmd = queue.makeCommandBuffer(), let enc = cmd.makeRenderCommandEncoder(descriptor: pass) else { return }
            renderer.encode(enc, size: view.bounds.size, tilt: t)
            enc.endEncoding()
            cmd.present(drawable)
            cmd.commit()
            drawnTilt = t
            drawnSize = size
        }
    }
}
