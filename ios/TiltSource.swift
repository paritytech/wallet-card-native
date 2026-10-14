// Phone motion → light. The same filter as reference/tilt.js and TiltSource.kt; keep the three in step.
//
// The light follows the phone turning, from CMDeviceMotion.rotationRate (gyroscope, bias-corrected by
// Core Motion, in the device frame: x right, y up the screen, z out of the screen, right-hand rule):
//   x = turn about the device's y axis (right edge away from you = +)
//   y = turn about the device's x axis (top edge toward you = +)
// The turn is integrated with a leak (`neutralTau`), so any holding angle becomes "level" and only
// movement moves the light. The wallet is never rotated on screen.
import Foundation
import CoreMotion
import simd

public struct TiltFilter {
    public let rangeDeg, neutralTau, smoothing: Double
    private var turn = SIMD2<Double>(0, 0)          // degrees about device x, y
    public private(set) var target = SIMD2<Double>(0, 0)
    public private(set) var value = SIMD2<Double>(0, 0)

    public init(_ p: WalletParams.Tilt) { rangeDeg = p.rangeDeg; neutralTau = p.neutralTau; smoothing = p.smoothing }

    /// Gyroscope rate about device x and y, degrees per second.
    public mutating func rotate(rateX: Double, rateY: Double, dt: Double) {
        let leak = exp(-dt / neutralTau)
        turn = (turn + SIMD2(rateX, rateY) * dt) * leak
        target = simd_clamp(SIMD2(turn.y, turn.x) / rangeDeg, SIMD2(repeating: -1), SIMD2(repeating: 1))
    }

    /// Direct target, −1…1, y up (touch fallback where there is no gyroscope, e.g. the Simulator).
    public mutating func point(_ p: SIMD2<Double>) { target = p }

    public mutating func step(dt: Double) -> SIMD2<Float> {
        value += (target - value) * (1 - exp(-dt * smoothing))
        return SIMD2<Float>(value)
    }
}

/// Polls Core Motion once per frame (Apple's recommendation for render loops; no update queue).
public final class TiltSource {
    public var filter: TiltFilter
    private let motion = CMMotionManager()
    private var lastSample: TimeInterval = 0

    public init(_ params: WalletParams.Tilt) { filter = TiltFilter(params) }

    public var hasGyro: Bool { motion.isDeviceMotionAvailable }

    public func start() {
        guard motion.isDeviceMotionAvailable, !motion.isDeviceMotionActive else { return }
        motion.deviceMotionUpdateInterval = 1.0 / 60
        motion.startDeviceMotionUpdates()
        lastSample = 0
    }

    public func stop() { motion.stopDeviceMotionUpdates() }

    /// Call once per frame with the frame's dt. Returns the smoothed tilt for the shader.
    public func update(dt: Double) -> SIMD2<Float> {
        if let m = motion.deviceMotion, m.timestamp != lastSample {
            let sampleDt = lastSample == 0 ? 0 : min(0.1, m.timestamp - lastSample)
            lastSample = m.timestamp
            let deg = 180 / Double.pi
            filter.rotate(rateX: m.rotationRate.x * deg, rateY: m.rotationRate.y * deg, dt: sampleDt)
        }
        return filter.step(dt: dt)
    }
}
