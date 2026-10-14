# Wallet card: native port for iOS and Android

This package rebuilds the **Material** view of `Material Detector.dc.html` natively: a card image lit as leather, thread and metal, with relief and highlights that move as the phone moves. The light follows the phone's gyroscope. The card itself never rotates on screen.

- **iOS:** Metal, a SwiftUI view.
- **Android:** OpenGL ES 3.0, a Compose view.

Both renderers use the same shader math and the same baked assets. The structure follows `coinage-viz/native`: hand-written shaders, exported assets, reference renderers, and a pixel comparison against the original.

| Renderer | Where | Compared with | Mean difference | Pixels off by > 8/255 |
|---|---|---|---|---|
| GLES 3.00 (Android's shaders, run through WebGL 2) | `shaders/*.vert, *.frag` | the detector's own WebGL 1 shader (`creases = 0`) | < 0.0001 / 255 | 0 % |
| Metal | `shaders/wallet.metal` | the GLES port, with the shipped `params.json` | < 0.0001 / 255 (max 1 / 255) | 0 % |

Both rows were measured on the current card at six tilts (`reference/compare.html`).

---

## Contents

1. [Quick start](#1-quick-start)
2. [Files](#2-files)
3. [Replacing the card](#3-replacing-the-card)
4. [Assets](#4-assets)
5. [The shader](#5-the-shader)
6. [Motion → light](#6-motion--light)
7. [Layout, shadow and compositing](#7-layout-shadow-and-compositing)
8. [iOS integration](#8-ios-integration)
9. [Android integration](#9-android-integration)
10. [Verifying a change](#10-verifying-a-change)
11. [Performance](#11-performance)
12. [Pitfalls checklist](#12-pitfalls-checklist)

---

## 1. Quick start

```sh
node tools/bake.mjs                 # card/card.png → assets/ (Node 18+, no dependencies)
ios/Sample/build-sim.sh             # iOS demo in the Simulator (no Xcode project needed)
cd android/sample && ./gradlew installDebug   # Android demo on a device or emulator
```

To view the reference pages, serve the package root with any static server (for example `python3 -m http.server`) and open:
- `reference/webgl2/`: the port as a web app. On a phone it uses the gyroscope; on desktop, the pointer. `?tilt=x,y` freezes the light.
- `reference/compare.html`: the pixel comparison.

## 2. Files

```
card/
  card.png                the card (input). Transparent outside its shape.
  regions.json            optional: hand-made regions saved from Material Detector
assets/                   everything a renderer loads (output of the bake + params.json)
  image.png               the card, sized for phones, metadata stripped
  regions.png             material region per pixel
  shadow.png              blurred alpha for the drop shadow
  card.json               sizes, the material table, shadow geometry
  params.json             hand-edited runtime constants (layout, relief, motion)
shaders/
  wallet.vert             GLSL ES 3.00: one quad from gl_VertexID, no vertex buffers
  wallet.frag             GLSL ES 3.00: the card
  shadow.frag             GLSL ES 3.00: the shadow
  wallet.metal            Metal: the same three stages, line for line
tools/
  bake.mjs                card/ → assets/
  analyze.mjs             automatic material detection (the detector's code) + shape clean-up
  png.mjs                 PNG read/write, area downscale
ios/
  WalletRenderer.swift    Metal renderer (platform-neutral: also used by the macOS reference)
  TiltSource.swift        Core Motion → tilt
  WalletView.swift        SwiftUI view (MTKView)
  Sample/                 demo app + build-sim.sh
android/
  src/io/parity/wallet/   WalletRenderer.kt (GLES30), TiltSource.kt (SensorManager), WalletSurface.kt (Compose)
  sample/                 Gradle demo app that compiles ../src and packages assets/ + shaders/
reference/
  common.js               the detector's shader verbatim (golden) + the GLES port, in WebGL
  tilt.js                 the motion filter (same as TiltSource.swift / .kt)
  webgl2/                 the port as a running web app
  compare.html            golden vs GLES vs Metal
  metal/                  macOS command-line Metal renderer (run.sh) → results/
  results/                metal_*.png (compare input), scene_*.png (phone screens), lighting.png
```

## 3. Replacing the card

1. Put the new image at `card/card.png`. Any size and aspect works; it needs a transparent background.
2. If `card/regions.json` exists and belongs to the old card, delete it.
3. Run `node tools/bake.mjs`. It prints what it did:
   ```
   card.png 1110×696 1411 KB → image.png 1024×642 1109 KB, GPU 2.5 MB
   auto regions: leather 98%, thread 1%, brass 1%
   ```
4. Rebuild the apps. The Android sample copies `assets/` at build time; the iOS sample copies it in `build-sim.sh`.

The native code reads everything from `assets/`, so a new card needs no code changes. The following adapt by themselves: aspect, size, the number of materials (up to 6), and the shadow.

### What the bake does

- **Size for phones.** The card is drawn at most 78 % of a 430 pt screen at 3×, about 1010 px. The image is therefore area-downscaled to at most 1024 px on its long side (`MAX_SIDE`), in premultiplied space so the edges get no dark fringe.
  - Metadata is dropped: C2PA blocks from image generators can be hundreds of KB.
  - The file is recompressed losslessly.
  - A smaller source is not upscaled. It works, but it will look slightly soft on large phones.
- **Materials.** Exactly the detector's automatic pass, as shown right after "Upload PNG": k-means in Lab, then a classifier over `MATS`. The only difference is the 520-px downscale, a box filter instead of the browser's `drawImage`, so a borderline cluster can occasionally land differently. Two additions sit on top:
  - **`refine()`** (`tools/analyze.mjs`): the detector classifies by colour alone, so it gets the lit side of a metal button wrong (pale yellow reads as thread). `refine()` adds a shape-aware clean-up:
    1. Metal specks under 12 px go to their neighbour.
    2. A patch sharing ≥ 25 % of its border with a metal part joins it.
    3. A compact metal part (≥ 60 % of its convex hull) takes everything inside the hull.

    Rings, frames and zips fail the compactness test and stay as detected.
  - **`TUNED`** (`tools/bake.mjs`): per-material settings tuned by hand, applied to auto-detected regions. Currently leather uses rough 0.57, metal 0.16, relief 0.45. The detector's default leather relief of 0.9 turns every pore of a photo into a sharp glint.
- **Hand-made regions.** If `card/regions.json` exists, it is used instead of the automatic pass. This is the detector's saved format `{W, H, regions:[{mat, p:{rough, metal, relief}}], rle}`. Use it when the automatic pass gets a card wrong.
- **Shadow.** The image's alpha is downscaled to 320 px, padded, and Gaussian-blurred (§7).

## 4. Assets

All of these are data, not colour. Decode them without colour management and upload row 0 first (texture coordinate (0, 0) = top-left).

| File | Format | Upload |
|---|---|---|
| `image.png` | RGBA8, straight alpha | **premultiplied** RGBA8 (as WebGL's `UNPACK_PREMULTIPLY_ALPHA_WEBGL`), LINEAR, clamp, no mipmaps |
| `regions.png` | 8-bit grey, value = region id × 40, 0 = none | R8, NEAREST, clamp. Decode as raw bytes |
| `shadow.png` | 8-bit grey, blurred alpha | R8, LINEAR, clamp |

**`card.json`:**
```jsonc
{
  "image":   { "file": "image.png", "width": 1024, "height": 642 },   // width/height → uTex
  "regions": { "file": "regions.png", "width": 520, "height": 326, "source": "auto" | "saved" },
  "materials": [                                                       // region id 1 → index 0; ≤ 6
    { "mat": "leather", "metal": 0.16, "rough": 0.57, "relief": 0.45, "sheen": 0.1, "coat": 0.22 }, …
  ],
  "shadow": { "file": "shadow.png", "pad": 0.2, "offsetY": 0.1, "opacity": 0.22 }  // fractions of drawn width
}
```

**`params.json`** (edit freely; nothing here is baked):

| Key | Default | Effect |
|---|---|---|
| `layout.widthFraction` | 0.78 | card width as a fraction of the view (the detector's 78 %) |
| `layout.maxWidth` | 820 | cap in points / dp |
| `layout.background` | `#ececef` | the detector's stage colour (the views are transparent; this is for the demos and references) |
| `render.maxScale`, `supersample` | 2, 1.5 | iOS render density = min(screen scale, 2) × 1.5, as the detector's canvas |
| `relief.creases` | 1 | 0 = the detector's 1-texel relief exactly; 1 = crease-scale relief (§5) |
| `light.guard` | 1 | 0 = the detector's light path; 1 = the light never lines up with the view, so the whole card can't flood with highlight (§5) |
| `tilt.rest` | [0.2, −0.4] | where the light sits while the phone is held still (shader tilt units); chosen where the creases catch the light best |
| `tilt.amplitude` | 0.55 | how far a turn can move the light from `rest` |
| `tilt.softDeg` | 8 | degrees of turn for most of that travel: 3° moves the light 0.2, 6° moves it 0.35, then it saturates |
| `tilt.neutralTau` | 4.2 | seconds for a new holding angle to become "level" |
| `tilt.smoothing` | 5.0 | easing rate of the light (1/s); the detector's 0.08 per-frame lerp at 60 fps |

## 5. The shader

`wallet.frag` / `wallet_fragment` is the detector's `FRAG`, "Material" view only. Per pixel:

1. **Material.** Look up the region id from `regions.png`. Pixels outside every region keep the detector's defaults (metal 0, rough 0.6, relief 0.5).
2. **Normal.** It comes from the image itself:
   - the luminance gradient gives the relief, scaled by `relief × 7`;
   - the alpha gradient over ±4 texels makes the silhouette roll off.
3. **Light.** A point light `L = (0.35 − 1.5·tilt.x, 0.6 + 1.5·tilt.y, 0.85)` and a small procedural studio `envC()`: a graded room, a key strip right of centre, a cool fill on the left. The reflection vector is shifted by tilt too.
4. **Shading.** Each term blends by material:
   - diffuse;
   - Blinn specular with shininess `mix(500, 10, rough)`;
   - metal = environment × base colour;
   - sheen (thread, fabric);
   - clear coat (leather, plastic, glass).
5. **Output** is premultiplied: `(col × a, a)`.

**Deliberate differences from the detector:**
- **Spelled-out smoothstep.** `smoothstep()` is written out as `ss()`. `envC()` calls it with edge0 > edge1, which is undefined in GLSL ES and MSL; `ss()` is the formula WebGL drivers evaluate.
- **Indexed uniforms.** Uniform arrays are indexed directly (ES 3.00 / MSL) instead of the ES 1.00 loop.
- **Removed.** The region highlight (`uHi`), mask view (`uMask`) and pulse (`uT`) are gone, and so is the CSS `rotateY/rotateX`. The card no longer turns on screen; the phone turning replaces it.
- **Crease-scale relief** (`uCrease`, `params.relief.creases`). The detector measures the slope between neighbouring texels, which treats a pore and a crease alike. With `creases = 1`, the slope is measured across ±3 texels and three rows. Creases and folds then tilt the normal and catch the light, while single-pixel pores average out. This costs 12 extra texture reads. Set it to 0 to match the detector exactly; `compare.html` checks the port in that mode.
- **Head-on guard** (`uGuard`, `params.light.guard`). In the detector, at a tilt of about (0.23, −0.4) the light sits straight behind the viewer. The narrow leather highlight then lines up with every flat pixel at once, and the pores turn the whole card into a bright grain. With `guard = 1`, tipping the top away lowers the light only to 0.3 (`L.y = 0.6 + y·0.3` for y < 0), about 19° off the view axis, so highlights stay on creases, stitches and metal. Tilting toward you and sideways is unchanged.

## 6. Motion → light

The same filter is implemented three times. Keep them in step: `reference/tilt.js`, `ios/TiltSource.swift`, `android/.../TiltSource.kt`.

- **Input.** The gyroscope rate in the phone's own frame (x right, y up the screen, z out of the screen, right-hand rule). Both platforms use the same axes.
  - iOS: `CMDeviceMotion.rotationRate`, bias-corrected by Core Motion.
  - Android: `TYPE_GYROSCOPE`.
  - Web: `devicemotion.rotationRate`, where browsers report alpha about x and beta about y (checked in Android WebView).

  The Android direction is verified on the emulator's virtual gyroscope, and it matches the reference renders. The iOS direction follows Core Motion's documented right-hand convention but has not yet been checked on a real iPhone; the Simulator has no gyroscope. Check it once on a device: tipping the top edge toward you should brighten the button.
- **Mapping.** This is exactly the motion the detector imitated with CSS `rotateY` / `rotateX`.
  - `x` = turn about the device's y axis (right edge away from you = +)
  - `y` = turn about the device's x axis (top edge toward you = +)
- **Leaky integration.** `turn = (turn + rate·dt) · exp(−dt / neutralTau)`. Whatever angle the phone is held at becomes "level" within a few seconds, so only movement moves the light. It also cancels gyro drift. It is the same as a neutral pose that slowly drifts toward the current one.
- **Target.** `target = rest + amplitude · tanh(turn / softDeg)`, per axis. Level is not the shader's (0, 0) but `rest`, measured as the light position where the creases glint most without the leather flooding (`creases` metric over a 9 × 9 tilt grid). The tanh makes the first few degrees of ordinary hand sway do most of the work, and keeps big turns away from the flooded corner.
- **Easing.** Once per frame: `value += (target − value) · (1 − exp(−dt · smoothing))`. This is the shader's `uTilt`.
- **Why not the accelerometer.** The accelerometer only sees gravity: it is blind to turning an upright phone about the vertical axis, and it is noisy. Without a gyroscope, Android falls back to gravity angles (`TYPE_GRAVITY`, else `TYPE_ACCELEROMETER`). Without any sensor (the iOS Simulator, some emulators), dragging a finger moves the light, like the detector's pointer.
- **Orientation.** Axes are the device's natural portrait ones. Lock the screen to portrait, or swap and negate x/y for landscape.

## 7. Layout, shadow and compositing

- **Card rectangle.** Centred, `widthFraction` of the view width, at most `maxWidth`, and small enough that the card and its shadow fit the height. The same function exists in `WalletRenderer.walletRect` (Swift), `cardRect` (Kotlin) and `walletRect` (common.js).
- **Shadow.** This is the detector's CSS `drop-shadow(0 30px 40px rgba(0,0,0,.22))`, taken relative to a card drawn 300 pt wide:
  - blur σ = 20/300 of the width, offset 30/300;
  - the baked mask is drawn as premultiplied black × `opacity`, in a quad = card rect grown by `pad · width` on each side and moved down by `offsetY · width`;
  - to change it, edit the `SHADOW_*` constants in `tools/bake.mjs`.
- **Blending.** Both quads use premultiplied "over": `src·1 + dst·(1 − srcAlpha)`. Clear to (0, 0, 0, 0).
- **Render target.** It must be **non-sRGB** (`.bgra8Unorm`, the default EGL surface). The shader's values are already sRGB, as on the web.
- **Transparency.** Outside the card and shadow the views are transparent:
  - iOS: `isOpaque = false`;
  - Android: `AndroidEmbeddedExternalSurface(isOpaque = false)`, TextureView-backed, so it composites like a normal view and UI can sit on top.

## 8. iOS integration

Add these to the app target:
- `ios/WalletRenderer.swift`, `ios/TiltSource.swift`, `ios/WalletView.swift`;
- `shaders/wallet.metal` (compiled into the default library);
- `assets/` as a **folder reference** named `WalletAssets`.

Then:
```swift
WalletView()                                    // or WalletView(assetsFolder: "MyFolder")
    .background(Color(red: 0xEC / 255, green: 0xEC / 255, blue: 0xEF / 255))
```

- **Requirements.** Metal and Core Motion only; the APIs exist since iOS 14. Tested on the iOS 17+ Simulator (the sample targets 17.0). Device motion needs no permission prompt or usage string.
- **Shader fallback.** If `wallet.metal` is not in the default library, the view compiles `WalletAssets/wallet.metal` at launch. `build-sim.sh` uses this when the Metal Toolchain isn't installed (`xcodebuild -downloadComponent MetalToolchain`).
- **Frame loop.** The view renders at 60 fps via `MTKView` and polls Core Motion once per frame (no update queue). Motion stops when the view is dismantled.

## 9. Android integration

Copy `android/src/io/parity/wallet/*.kt` into the app, or add the folder as a source dir as the sample does. Then package `assets/*` plus `shaders/*.vert, *.frag` into the APK's `assets/wallet/`; the sample's `copyWalletAssets` Gradle task does this.

```kotlin
WalletSurface(Modifier.fillMaxSize().background(Color(0xFFECECEF)))   // or assetsFolder = "…"
```

- **Requirements.** minSdk 26, OpenGL ES 3.0 (`<uses-feature android:glEsVersion="0x00030000"/>`), Compose foundation 1.7+.
- **Threading.** EGL lives on its own render thread, paced by `Choreographer`. Sensors register while the composable is on screen. GL is torn down before the surface is released.
- **Render density.** Android renders at the screen's native density, not with the iOS / web × 1.5 supersample. On ≥ 2.6× screens the difference is negligible.

The sample builds with Gradle 8.14.3, AGP 8.13, Kotlin 2.2.10 and Compose BOM 2026.05.00:
```sh
cd android/sample && ./gradlew assembleDebug    # → app/build/outputs/apk/debug/app-debug.apk
```

## 10. Verifying a change

1. `node tools/bake.mjs`
2. `reference/metal/run.sh`: renders `reference/results/metal_<x>_<y>.png` (card alone, six tilts) and `scene_<x>_<y>.png` (390 × 844 pt phone screens at 3×).
3. Open `reference/compare.html`. It checks:
   - **GLES vs detector** at `creases = 0`, `guard = 0`: proves the shader port;
   - **Metal vs GLES** at the shipped params: proves iOS = Android.

   Targets: mean ≤ 1/255 and ≤ 0.1 % of pixels off by more than 8/255. Both currently pass at < 0.0001 / 255.
4. Run the demos:
   - `ios/Sample/build-sim.sh`;
   - `android/sample: ./gradlew installDebug`. On the Android emulator, drive the gyroscope with `adb emu sensor set gyroscope 0.3:0:0` (rad/s about x; back to `0:0:0`).

**If you change the shader,** edit `wallet.frag` and `wallet.metal` together; the section comments match. Then re-run steps 2–3.

### What has been run

| Check | Where | Result |
|---|---|---|
| Shader port vs detector, Metal vs GLES | `reference/compare.html` (Chrome), `reference/metal/run.sh` (Apple Silicon Mac) | < 0.0001 / 255 |
| iOS demo | iPhone 18 Pro Simulator, iOS 27 | renders; drag fallback moves the light |
| Android demo | Pixel 8 emulator (API 37) | renders; virtual gyroscope moves the light the right way; survives home / relaunch / force-stop |
| Web demo | `reference/webgl2/?tilt=…` | renders, no console errors |
| Not yet | real iPhone and Android phone | gyroscope direction on iOS, frame rate on low-end GPUs |

## 11. Performance

| Item | Cost |
|---|---|
| Draws | 2 per frame (shadow, card), no vertex buffers |
| Per pixel of card | 1 + 4 + 4 texture reads (colour, luminance gradient, alpha gradient) + 12 for creases, + 1 region read |
| Textures | image 1024 × 642 RGBA8 = 2.5 MB, regions 520 × 326 R8 = 0.17 MB, shadow ≈ 0.15 MB |
| APK / bundle | ≈ 1.2 MB of assets |
| Frame | one full-screen quad of simple math; the shadow quad is trivial |

Rendering runs continuously while the view is visible, because the gyroscope is always slightly moving. To save power when the light has settled, skip frames while `|target − value|` is below ~0.001.

## 12. Pitfalls checklist

- [ ] `image.png` uploaded **premultiplied**; regions and shadow as raw bytes (no colour conversion, no premultiply).
- [ ] Row 0 first, no vertical flip; uv (0, 0) = top-left.
- [ ] `regions.png` NEAREST (it is an id map); image LINEAR, no mipmaps.
- [ ] `uTex` = `card.json image.width/height` (the shipped image's size, not the source's).
- [ ] Uniform arrays zero-filled to 6.
- [ ] Non-sRGB target; premultiplied blending; clear alpha 0.
- [ ] Tilt from the gyroscope (rate, device frame), not from the accelerometer; portrait axes.
- [ ] Smoothing and leak are dt-based, not per-frame constants.
- [ ] After replacing `card.png`, delete a stale `card/regions.json` and re-run the bake.
