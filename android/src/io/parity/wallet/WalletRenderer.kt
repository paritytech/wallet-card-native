// OpenGL ES 3.0 renderer for the card: one shadow quad, one card quad, premultiplied "over".
// Uses shaders/wallet.vert, wallet.frag and shadow.frag unchanged (the web reference runs the same
// files through WebGL2 and matches the detector's own shader; see reference/compare.html).
// Call every method on the GL thread with a current ES 3 context.
package io.parity.wallet

import android.content.res.AssetManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ColorSpace
import android.opengl.GLES30.*
import android.opengl.GLUtils
import org.json.JSONObject
import java.nio.ByteBuffer
import kotlin.math.min

class CardDescription(json: JSONObject) {
    class Material(val metal: Float, val rough: Float, val relief: Float, val sheen: Float, val coat: Float)
    val imageFile: String = json.getJSONObject("image").getString("file")
    val imageWidth = json.getJSONObject("image").getInt("width")
    val imageHeight = json.getJSONObject("image").getInt("height")
    val regionsFile: String = json.getJSONObject("regions").getString("file")
    val materials: List<Material> = json.getJSONArray("materials").let { a ->
        List(a.length()) { i ->
            val m = a.getJSONObject(i)
            Material(m.f("metal"), m.f("rough"), m.f("relief"), m.f("sheen"), m.f("coat"))
        }
    }
    val shadowFile: String = json.getJSONObject("shadow").getString("file")
    val shadowPad = json.getJSONObject("shadow").f("pad")
    val shadowOffsetY = json.getJSONObject("shadow").f("offsetY")
    val shadowOpacity = json.getJSONObject("shadow").f("opacity")
    /** Pressed-in relief (a logo), or null. */
    val heightFile: String? = json.optJSONObject("height")?.getString("file")
    val heightScale = json.optJSONObject("height")?.f("scale") ?: 0f
}

class WalletParams(json: JSONObject) {
    private val layout = json.getJSONObject("layout")
    private val tilt = json.getJSONObject("tilt")
    private val render = json.getJSONObject("render")
    /** Most frames per second the card is drawn at, whatever the display rate. */
    val maxFps = render.getDouble("maxFps")
    /** Light movement (shader tilt units) below which a frame is not redrawn. */
    val idle = render.f("idle")
    val widthFraction = layout.f("widthFraction")
    val maxWidth = layout.f("maxWidth")
    val creases = json.getJSONObject("relief").f("creases")
    val guard = json.getJSONObject("light").f("guard")
    val occlusion = json.getJSONObject("light").f("occlusion")
    val rest = tilt.getJSONArray("rest").let { doubleArrayOf(it.getDouble(0), it.getDouble(1)) }
    val amplitude = tilt.getDouble("amplitude")
    val softDeg = tilt.getDouble("softDeg")
    val neutralTau = tilt.getDouble("neutralTau")
    val smoothing = tilt.getDouble("smoothing")
}

private fun JSONObject.f(key: String) = getDouble(key).toFloat()

/** Reads the asset folder (assets/ of this package, copied into the app's assets under [folder]). */
class WalletAssets(private val assets: AssetManager, private val folder: String = "wallet") {
    fun text(name: String) = assets.open("$folder/$name").bufferedReader().use { it.readText() }
    fun bitmap(name: String, premultiplied: Boolean): Bitmap = assets.open("$folder/$name").use {
        BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inPremultiplied = premultiplied
            inScaled = false
            inPreferredColorSpace = ColorSpace.get(ColorSpace.Named.SRGB)   // no colour conversion
        }) ?: error("cannot decode $folder/$name")
    }
    val card by lazy { CardDescription(JSONObject(text("card.json"))) }
    val params by lazy { WalletParams(JSONObject(text("params.json"))) }

    /** Width ÷ height of a view that holds exactly the card and its shadow; see WalletSurface. */
    val fittedAspect: Float by lazy {
        val c = card
        (1 + 2 * c.shadowPad) / (c.imageHeight.toFloat() / c.imageWidth + 2 * c.shadowPad + c.shadowOffsetY)
    }
}

class WalletRenderer(private val src: WalletAssets) {
    private val card = src.card
    private val params = src.params
    private var walletProgram = 0
    private var shadowProgram = 0
    private var vao = 0
    private val textures = IntArray(4)       // image, regions, shadow, height
    private val regionArrays = Array(5) { FloatArray(6) }   // metal, rough, relief, sheen, coat; zero-filled to 6
    private val loc = HashMap<String, Int>()                // uniform locations, looked up once per program
    private fun u(program: Int, name: String) = loc.getOrPut("$program/$name") { glGetUniformLocation(program, name) }

    fun init() {
        val vert = src.text("wallet.vert")
        walletProgram = program(vert, src.text("wallet.frag"))
        shadowProgram = program(vert, src.text("shadow.frag"))
        vao = IntArray(1).also { glGenVertexArrays(1, it, 0) }[0]   // no attributes: the quad comes from gl_VertexID
        glGenTextures(4, textures, 0)

        // image.png: premultiplied (as the web uploads it), row 0 first, no mipmaps
        val img = src.bitmap(card.imageFile, premultiplied = true)
        bindTexture(0, GL_LINEAR)
        GLUtils.texImage2D(GL_TEXTURE_2D, 0, img, 0)
        img.recycle()
        greyTexture(1, card.regionsFile, GL_NEAREST)
        greyTexture(2, card.shadowFile, GL_LINEAR)
        card.heightFile?.let { greyTexture(3, it, GL_LINEAR) } ?: run {
            bindTexture(3, GL_LINEAR)                          // 1 × 1 zero: no pressed-in relief
            glPixelStorei(GL_UNPACK_ALIGNMENT, 1)
            glTexImage2D(GL_TEXTURE_2D, 0, GL_R8, 1, 1, 0, GL_RED, GL_UNSIGNED_BYTE, ByteBuffer.allocateDirect(1))
            glPixelStorei(GL_UNPACK_ALIGNMENT, 4)
        }

        card.materials.take(6).forEachIndexed { i, m ->
            regionArrays[0][i] = m.metal; regionArrays[1][i] = m.rough; regionArrays[2][i] = m.relief
            regionArrays[3][i] = m.sheen; regionArrays[4][i] = m.coat
        }
    }

    /** Draws into the current surface. Sizes in pixels; [density] = pixels per dp; [tilt] = smoothed (x, y), −1…1. */
    fun draw(widthPx: Int, heightPx: Int, density: Float, tiltX: Float, tiltY: Float) {
        glViewport(0, 0, widthPx, heightPx)
        glClearColor(0f, 0f, 0f, 0f)
        glClear(GL_COLOR_BUFFER_BIT)
        glEnable(GL_BLEND)
        glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA)          // premultiplied over
        glBindVertexArray(vao)

        val w = widthPx / density
        val h = heightPx / density
        val r = cardRect(w, h)
        val pad = card.shadowPad * r[2]
        val shadow = floatArrayOf(r[0] - pad, r[1] - pad + card.shadowOffsetY * r[2], r[2] + 2 * pad, r[3] + 2 * pad)

        glUseProgram(shadowProgram)
        uniformRect(shadowProgram, shadow, w, h)
        texUnit(shadowProgram, "uShadow", 2)
        glUniform1f(u(shadowProgram, "uOpacity"), card.shadowOpacity)
        glDrawArrays(GL_TRIANGLE_STRIP, 0, 4)

        val p = walletProgram
        glUseProgram(p)
        uniformRect(p, r, w, h)
        texUnit(p, "uImg", 0)
        texUnit(p, "uReg", 1)
        texUnit(p, "uHeight", 3)
        glUniform1f(u(p, "uHeightScale"), card.heightScale)
        glUniform2f(u(p, "uTex"), card.imageWidth.toFloat(), card.imageHeight.toFloat())
        glUniform2f(u(p, "uTilt"), tiltX, tiltY)
        glUniform1f(u(p, "uCrease"), params.creases)
        glUniform1f(u(p, "uGuard"), params.guard)
        glUniform1f(u(p, "uOcclusion"), params.occlusion)
        listOf("uMetal", "uRough", "uRelief", "uSheen", "uCoat").forEachIndexed { i, n ->
            glUniform1fv(u(p, n), 6, regionArrays[i], 0)
        }
        glDrawArrays(GL_TRIANGLE_STRIP, 0, 4)
    }

    /** Where the card sits in a view of w × h dp: (x, y, width, height). Same as WalletRenderer.swift / common.js. */
    fun cardRect(w: Float, h: Float): FloatArray {
        val aspect = card.imageWidth.toFloat() / card.imageHeight
        val fitHeight = h / (1 / aspect + 2 * card.shadowPad + card.shadowOffsetY)
        val cw = min(min(w * params.widthFraction, params.maxWidth), fitHeight)
        val ch = cw / aspect
        return floatArrayOf((w - cw) / 2, (h - ch) / 2, cw, ch)
    }

    fun release() {
        loc.clear()
        glDeleteTextures(4, textures, 0)
        glDeleteVertexArrays(1, intArrayOf(vao), 0)
        glDeleteProgram(walletProgram)
        glDeleteProgram(shadowProgram)
    }

    private fun uniformRect(program: Int, r: FloatArray, w: Float, h: Float) {
        // (left, top, right, bottom) in clip space
        glUniform4f(u(program, "uRect"),
            r[0] / w * 2 - 1, 1 - r[1] / h * 2, (r[0] + r[2]) / w * 2 - 1, 1 - (r[1] + r[3]) / h * 2)
    }

    private fun texUnit(program: Int, name: String, unit: Int) {
        glActiveTexture(GL_TEXTURE0 + unit)
        glBindTexture(GL_TEXTURE_2D, textures[unit])
        glUniform1i(u(program, name), unit)
    }

    private fun bindTexture(unit: Int, filter: Int) {
        glActiveTexture(GL_TEXTURE0 + unit)
        glBindTexture(GL_TEXTURE_2D, textures[unit])
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, filter)
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, filter)
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE)
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE)
    }

    /** 8-bit grey PNG → R8: the decoded bytes as data, not colour. */
    private fun greyTexture(unit: Int, file: String, filter: Int) {
        val bmp = src.bitmap(file, premultiplied = false)
        val rgba = ByteBuffer.allocateDirect(bmp.byteCount)
        bmp.copyPixelsToBuffer(rgba)                           // R, G, B, A bytes
        val r = ByteBuffer.allocateDirect(bmp.width * bmp.height)
        for (i in 0 until bmp.width * bmp.height) r.put(rgba.get(i * 4))
        r.position(0)
        bindTexture(unit, filter)
        glPixelStorei(GL_UNPACK_ALIGNMENT, 1)
        glTexImage2D(GL_TEXTURE_2D, 0, GL_R8, bmp.width, bmp.height, 0, GL_RED, GL_UNSIGNED_BYTE, r)
        glPixelStorei(GL_UNPACK_ALIGNMENT, 4)
        bmp.recycle()
    }

    private fun program(vs: String, fs: String): Int {
        fun shader(type: Int, source: String) = glCreateShader(type).also {
            glShaderSource(it, source)
            glCompileShader(it)
            val ok = IntArray(1); glGetShaderiv(it, GL_COMPILE_STATUS, ok, 0)
            check(ok[0] != 0) { glGetShaderInfoLog(it) }
        }
        return glCreateProgram().also {
            glAttachShader(it, shader(GL_VERTEX_SHADER, vs))
            glAttachShader(it, shader(GL_FRAGMENT_SHADER, fs))
            glLinkProgram(it)
            val ok = IntArray(1); glGetProgramiv(it, GL_LINK_STATUS, ok, 0)
            check(ok[0] != 0) { glGetProgramInfoLog(it) }
        }
    }
}
