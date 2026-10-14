// Compose view: the card, lit by the phone's motion. Drop-in:
//
//   WalletSurface(Modifier.fillMaxSize().background(Color(0xFFECECEF)))
//
// Assets: copy this package's assets/ folder and the three shaders/*.vert|frag files into the app's
// assets under "wallet/" (the sample's Gradle task does it). The surface is transparent outside the
// card and its shadow, and is composited like a normal view (TextureView-backed), so UI can sit on top.
// Without any motion sensor (some emulators) a drag moves the light instead.
package io.parity.wallet

import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.os.Handler
import android.os.HandlerThread
import android.view.Choreographer
import android.view.Surface
import androidx.compose.foundation.AndroidEmbeddedExternalSurface
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import java.util.concurrent.CountDownLatch

@Composable
fun WalletSurface(modifier: Modifier = Modifier, assetsFolder: String = "wallet") {
    val context = LocalContext.current
    val density = LocalDensity.current.density
    val assets = remember(assetsFolder) { WalletAssets(context.assets, assetsFolder) }
    val tilt = remember(assets) { TiltSource(context, assets.params) }
    DisposableEffect(tilt) { tilt.start(); onDispose { tilt.stop() } }

    val drag = if (tilt.hasMotion) Modifier else Modifier.pointerInput(Unit) {
        detectDragGestures(onDragEnd = { tilt.filter.point(0.0, 0.0) }, onDragCancel = { tilt.filter.point(0.0, 0.0) }) { change, _ ->
            tilt.filter.point((change.position.x / size.width - 0.5) * 2.0, (change.position.y / size.height - 0.5) * -2.0)
        }
    }
    AndroidEmbeddedExternalSurface(modifier.then(drag), isOpaque = false) {
        onSurface { surface, width, height ->
            val loop = RenderLoop(surface, WalletRenderer(assets), tilt.filter, density)
            loop.start(width, height)
            surface.onChanged { w, h -> loop.resize(w, h) }
            surface.onDestroyed { loop.stop() }
        }
    }
}

/** EGL + a dedicated render thread, driven by Choreographer at the display's frame rate. */
private class RenderLoop(
    private val surface: Surface,
    private val renderer: WalletRenderer,
    private val tilt: TiltFilter,
    private val density: Float,
) : Choreographer.FrameCallback {
    private val thread = HandlerThread("wallet-gl").apply { start() }
    private val handler = Handler(thread.looper)
    private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var context: EGLContext = EGL14.EGL_NO_CONTEXT
    private var eglSurface: EGLSurface = EGL14.EGL_NO_SURFACE
    private var width = 0
    private var height = 0
    private var lastNanos = 0L
    private var running = false

    fun start(w: Int, h: Int) = handler.post {
        width = w; height = h
        setUpEgl()
        renderer.init()
        running = true
        Choreographer.getInstance().postFrameCallback(this)
    }

    fun resize(w: Int, h: Int) = handler.post { width = w; height = h }

    /** Blocks until GL is torn down, so the Surface is never used after it is destroyed. */
    fun stop() {
        val done = CountDownLatch(1)
        handler.post {
            running = false
            Choreographer.getInstance().removeFrameCallback(this)
            if (context != EGL14.EGL_NO_CONTEXT) {
                renderer.release()
                EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
                EGL14.eglDestroySurface(display, eglSurface)
                EGL14.eglDestroyContext(display, context)
                EGL14.eglTerminate(display)
            }
            done.countDown()
        }
        done.await()
        thread.quitSafely()
    }

    override fun doFrame(frameTimeNanos: Long) {
        if (!running) return
        val dt = if (lastNanos == 0L) 0.0 else ((frameTimeNanos - lastNanos) / 1e9).coerceIn(0.0, 0.1)
        lastNanos = frameTimeNanos
        val t = tilt.step(dt)
        renderer.draw(width, height, density, t[0], t[1])
        EGL14.eglSwapBuffers(display, eglSurface)
        Choreographer.getInstance().postFrameCallback(this)
    }

    private fun setUpEgl() {
        display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        val version = IntArray(2)
        check(EGL14.eglInitialize(display, version, 0, version, 1)) { "eglInitialize failed" }
        val attribs = intArrayOf(
            EGL14.EGL_RENDERABLE_TYPE, EGLExt.EGL_OPENGL_ES3_BIT_KHR,
            EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_NONE)
        val configs = arrayOfNulls<EGLConfig>(1)
        val count = IntArray(1)
        check(EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, count, 0) && count[0] > 0) { "no RGBA8 ES3 config" }
        context = EGL14.eglCreateContext(display, configs[0], EGL14.EGL_NO_CONTEXT,
            intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE), 0)
        // default (non-sRGB) colour space: the shader's values are already sRGB
        eglSurface = EGL14.eglCreateWindowSurface(display, configs[0], surface, intArrayOf(EGL14.EGL_NONE), 0)
        check(EGL14.eglMakeCurrent(display, eglSurface, eglSurface, context)) { "eglMakeCurrent failed" }
    }
}
