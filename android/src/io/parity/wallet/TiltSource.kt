// Phone motion → light. The same filter as reference/tilt.js and TiltSource.swift; keep the three in step.
//
// The light follows the phone turning, from TYPE_GYROSCOPE (device frame: x right, y up the screen,
// z out of the screen, right-hand rule, rad/s; the same axes as iOS):
//   x = turn about the device's y axis (right edge away from you = +)
//   y = turn about the device's x axis (top edge toward you = +)
// The turn is integrated with a leak (`neutralTau`), so any holding angle becomes "level" and only
// movement moves the light. Level is `rest` (where the creases catch the light best), and a turn moves the
// light by amplitude · tanh(turn / softDeg), so ordinary hand sway already plays the highlights across the
// creases. The card is never rotated on screen.
// Without a gyroscope it falls back to gravity angles (blind to turns of an upright phone about vertical).
// Axes are the device's natural (portrait) ones: lock the activity to portrait, or remap for rotation.
package io.parity.wallet

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.exp
import kotlin.math.sqrt
import kotlin.math.tanh

class TiltFilter(
    private val rest: DoubleArray, private val amplitude: Double, private val softDeg: Double,
    private val neutralTau: Double, private val smoothing: Double,
) {
    private var turnX = 0.0; private var turnY = 0.0        // degrees about device x, y
    private var baseBeta = Double.NaN; private var baseGamma = 0.0
    @Volatile private var targetX = rest[0]
    @Volatile private var targetY = rest[1]
    private var valueX = rest[0]; private var valueY = rest[1]

    /** Gyroscope rate about device x and y, degrees per second. */
    fun rotate(rateX: Double, rateY: Double, dt: Double) {
        val leak = exp(-dt / neutralTau)
        turnX = (turnX + rateX * dt) * leak
        turnY = (turnY + rateY * dt) * leak
        aim(turnY, turnX)
    }

    /** Fallback: absolute beta (about x) and gamma (about y), degrees. */
    fun angles(beta: Double, gamma: Double, dt: Double) {
        if (baseBeta.isNaN()) { baseBeta = beta; baseGamma = gamma }
        val k = 1 - exp(-dt / neutralTau)
        baseBeta += (beta - baseBeta) * k
        baseGamma += (gamma - baseGamma) * k
        aim(gamma - baseGamma, beta - baseBeta)
    }

    /** Touch fallback: position −1…1, y up; null = back to rest. */
    fun point(p: DoubleArray?) {
        targetX = rest[0] + (p?.get(0) ?: 0.0) * amplitude
        targetY = rest[1] + (p?.get(1) ?: 0.0) * amplitude
    }

    private fun aim(aboutY: Double, aboutX: Double) {
        targetX = rest[0] + amplitude * tanh(aboutY / softDeg)
        targetY = rest[1] + amplitude * tanh(aboutX / softDeg)
    }

    /** Called once per frame on the render thread; returns the smoothed (x, y). */
    fun step(dt: Double): FloatArray {
        val k = 1 - exp(-dt * smoothing)
        valueX += (targetX - valueX) * k
        valueY += (targetY - valueY) * k
        return floatArrayOf(valueX.toFloat(), valueY.toFloat())
    }
}

class TiltSource(context: Context, params: WalletParams) : SensorEventListener {
    val filter = TiltFilter(params.rest, params.amplitude, params.softDeg, params.neutralTau, params.smoothing)
    private val sensors = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val gyro: Sensor? = sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    private val gravity: Sensor? = sensors.getDefaultSensor(Sensor.TYPE_GRAVITY) ?: sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    private var lastNanos = 0L

    val hasMotion get() = gyro != null || gravity != null

    fun start() {
        lastNanos = 0L
        (gyro ?: gravity)?.let { sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
    }

    fun stop() = sensors.unregisterListener(this)

    override fun onSensorChanged(e: SensorEvent) {
        val dt = if (lastNanos == 0L) 0.0 else ((e.timestamp - lastNanos) / 1e9).coerceIn(0.0, 0.1)
        lastNanos = e.timestamp
        val deg = 180 / Math.PI
        if (e.sensor.type == Sensor.TYPE_GYROSCOPE) {
            filter.rotate(e.values[0] * deg, e.values[1] * deg, dt)
        } else {
            // the reported vector points up (reaction to gravity): flat face-up = (0, 0, +g)
            val (x, y, z) = Triple(e.values[0].toDouble(), e.values[1].toDouble(), e.values[2].toDouble())
            val g = sqrt(x * x + y * y + z * z).takeIf { it > 1e-3 } ?: return
            filter.angles(atan2(y, z) * deg, asin((-x / g).coerceIn(-1.0, 1.0)) * deg, dt)
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
}
