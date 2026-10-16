// Turns the card image into the assets the renderers load. Run after replacing the card:
//
//   node tools/bake.mjs
//
// in:  card/card.png          the card, any size and aspect, transparent outside its shape
//      card/regions.json      optional: regions saved from Material Detector (hand-tuned). Delete it when
//                             you replace card.png, and the materials are detected automatically.
//      card/logo.json         optional: a logo pressed into the card (logo.svg or logo.png next to it);
//                             it is blended into image.png, written as height.png and gets its own material
//                             region, so its pressed edge catches the moving light.
// out: assets/image.png       the card, sized for phones (≤ MAX_SIDE px), metadata stripped, recompressed
//      assets/regions.png     region id × 40 per pixel (0 = no region), 8-bit grey
//      assets/shadow.png      blurred alpha for the drop shadow, 8-bit grey
//      assets/height.png      extra relief (8-bit grey, 0 = flat, 255 = fully pressed in), only with a logo
//      assets/card.json       sizes, materials (≤ 6), shadow geometry, height map
// (assets/params.json is hand-edited and not touched.)
import { readFileSync, writeFileSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPNG, writeGreyPNG, writeRGBAPNG, downscaleRGBA } from './png.mjs';
import { analyze, MATS } from './analyze.mjs';

const root = new URL('..', import.meta.url).pathname;
const IN = root + 'card/', OUT = root + 'assets/';

// CSS `drop-shadow(0 30px 40px rgba(0,0,0,.22))`, relative to the card's on-screen width.
// The detector shows the card at 78 % of the stage; on a phone that is ≈ 300 pt, the reference here.
// Phone budget: the card is drawn ≤ 78 % of a 430 pt screen at 3× ≈ 1010 px wide, so more pixels than
// this are never seen; they only cost memory (w × h × 4 bytes on the GPU) and load time.
const MAX_SIDE = 1024;
// Material settings tuned by hand in Material Detector for the wallet (the detector's own defaults give
// leather relief 0.9, which turns every pore of the photo into a sharp glint). Applied to every card
// whose materials are detected automatically; a saved regions.json keeps its own values.
const TUNED = {
  leather: { rough: 0.57, metal: 0.16, relief: 0.45 },
};
const SHADOW_REF_WIDTH = 300, SHADOW_OFFSET = 30, SHADOW_SIGMA = 20, SHADOW_OPACITY = 0.22, SHADOW_PX = 320;

// Region map and materials: the detector's saved state if there is one, else automatic detection.
function regionsFor(img) {
  const saved = IN + 'regions.json';
  if (!existsSync(saved)) {
    const a = analyze(img);
    a.regions.forEach(r => { if (TUNED[r.mat]) r.p = { ...r.p, ...TUNED[r.mat] }; });
    return { ...a, source: 'auto' };
  }
  const d = JSON.parse(readFileSync(saved));
  const map = new Uint8Array(d.W * d.H);
  let k = 0;
  for (const run of d.rle.split(',')) { const [v, n] = run.split(':').map(Number); map.fill(v, k, k + n); k += n; }
  if (k !== d.W * d.H) throw new Error(`RLE covers ${k} pixels, expected ${d.W * d.H}`);
  if (Math.abs(img.width / img.height / (d.W / d.H) - 1) > 0.01) throw new Error(`card.png is ${img.width}×${img.height} and regions.json is ${d.W}×${d.H}: different aspect. Delete regions.json to detect materials automatically`);
  return { W: d.W, H: d.H, map, regions: d.regions, source: 'saved' };
}

function shadowFor(img) {
  // alpha, box-downscaled to SHADOW_PX wide, padded by 3σ on every side, then Gaussian-blurred
  const aspect = img.width / img.height;
  const iw = SHADOW_PX, ih = Math.round(iw / aspect), sigma = SHADOW_SIGMA / SHADOW_REF_WIDTH * iw, pad = Math.ceil(sigma * 3);
  const sw = iw + pad * 2, sh = ih + pad * 2;
  let a = new Float32Array(sw * sh);
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
    const x0 = Math.floor(x * img.width / iw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * img.width / iw));
    const y0 = Math.floor(y * img.height / ih), y1 = Math.max(y0 + 1, Math.floor((y + 1) * img.height / ih));
    let s = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += img.data[(yy * img.width + xx) * 4 + 3];
    a[(y + pad) * sw + x + pad] = s / ((x1 - x0) * (y1 - y0) * 255);
  }
  const r = Math.ceil(sigma * 3), kern = Array.from({ length: r * 2 + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const ks = kern.reduce((p, q) => p + q);
  const blur = (src, dx, dy) => {
    const dst = new Float32Array(src.length);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i * dx, yy = y + i * dy;
        if (xx >= 0 && yy >= 0 && xx < sw && yy < sh) s += src[yy * sw + xx] * kern[i + r];
      }
      dst[y * sw + x] = s / ks;
    }
    return dst;
  };
  a = blur(blur(a, 1, 0), 0, 1);
  return {
    png: writeGreyPNG(sw, sh, Uint8Array.from(a, v => Math.round(Math.min(1, v) * 255))),
    meta: { file: 'shadow.png', pad: pad / iw, offsetY: SHADOW_OFFSET / SHADOW_REF_WIDTH, opacity: SHADOW_OPACITY },   // fractions of the drawn width
  };
}

const source = readPNG(readFileSync(IN + 'card.png'));
const fit = Math.min(1, MAX_SIDE / Math.max(source.width, source.height));
const img = fit < 1 ? downscaleRGBA(source, Math.round(source.width * fit), Math.round(source.height * fit)) : source;
const opaqueAlpha = img.data.every((v, i) => i % 4 !== 3 || v === 255);
if (opaqueAlpha) console.warn('card.png has no transparency: the whole rectangle is the card (no rounded corners, shadow is a box)');
const reg = regionsFor(img);
let heightMap = null;
// Logo: blended over the card like a flat fill (colour at opacity, times the logo's own alpha), and its pixels
// become a region of their own whose relief makes the pressed edges catch the light.
if (existsSync(IN + 'logo.json')) {
  const L = JSON.parse(readFileSync(IN + 'logo.json'));
  const lw = Math.max(8, Math.round(L.width * img.width));
  let logo;
  if (L.file.toLowerCase().endsWith('.svg')) {
    const tmp = mkdtempSync(join(tmpdir(), 'logo-'));
    execFileSync('swift', [root + 'tools/svg2png.swift', IN + L.file, join(tmp, 'logo.png'), String(lw * 2)]);
    logo = readPNG(readFileSync(join(tmp, 'logo.png')));
    rmSync(tmp, { recursive: true, force: true });
  } else logo = readPNG(readFileSync(IN + L.file));
  const lh = Math.round(lw * logo.height / logo.width);
  const box = downscaleRGBA(logo, lw, lh);
  // coverage 0..1: the logo's alpha relative to its most opaque pixel (the SVG's own fill-opacity is not a hole)
  let amax = 0; for (let i = 3; i < box.data.length; i += 4) amax = Math.max(amax, box.data[i]);
  const cover = new Float32Array(lw * lh).map((_, i) => box.data[i * 4 + 3] / (amax || 255));
  const x0 = Math.round(L.center[0] * img.width - lw / 2), y0 = Math.round(L.center[1] * img.height - lh / 2);
  const col = [1, 3, 5].map(i => parseInt(L.color.slice(i, i + 2), 16));
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
    const X = x0 + x, Y = y0 + y;
    if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) continue;
    const a = cover[y * lw + x] * L.opacity, i = (Y * img.width + X) * 4;
    if (!a || !img.data[i + 3]) continue;
    for (let k = 0; k < 3; k++) img.data[i + k] = Math.round(img.data[i + k] * (1 - a) + col[k] * a);
  }
  if (reg.regions.length >= 6) throw new Error('logo needs a 7th region; the shader has 6');
  reg.regions.push(L.material);
  const id = reg.regions.length;
  for (let y = 0; y < reg.H; y++) for (let x = 0; x < reg.W; x++) {
    const lx = Math.floor((x + 0.5) / reg.W * img.width) - x0, ly = Math.floor((y + 0.5) / reg.H * img.height) - y0;
    if (lx < 0 || ly < 0 || lx >= lw || ly >= lh) continue;
    if (cover[ly * lw + lx] > 0.25 && reg.map[y * reg.W + x]) reg.map[y * reg.W + x] = id;
  }
  // height: the coverage at image resolution, Gaussian-blurred by bevelPx so the pressed edge has a slope
  const hm = new Float32Array(img.width * img.height);
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
    const X = x0 + x, Y = y0 + y;
    if (X >= 0 && Y >= 0 && X < img.width && Y < img.height) hm[Y * img.width + X] = cover[y * lw + x];
  }
  const sg = L.bevelPx, r = Math.ceil(sg * 3), kern = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sg * sg)));
  const ks = kern.reduce((p, q) => p + q);
  const pass = (src, dx, dy) => {
    const dst = new Float32Array(src.length);
    for (let y = Math.max(0, y0 - 2 * r); y < Math.min(img.height, y0 + lh + 2 * r); y++)
      for (let x = Math.max(0, x0 - 2 * r); x < Math.min(img.width, x0 + lw + 2 * r); x++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) { const xx = x + k * dx, yy = y + k * dy; if (xx >= 0 && yy >= 0 && xx < img.width && yy < img.height) acc += src[yy * img.width + xx] * kern[k + r]; }
        dst[y * img.width + x] = acc / ks;
      }
    return dst;
  };
  heightMap = { data: pass(pass(hm, 1, 0), 0, 1), depth: L.depth };
  console.log(`logo ${L.file} ${lw}×${lh} px at ${L.center.join(', ')}, region ${id}`);
}
const maxId = reg.map.reduce((m, v) => Math.max(m, v), 0);
if (maxId > reg.regions.length || reg.regions.length > 6) throw new Error(`region map uses ${maxId}, ${reg.regions.length} regions defined (max 6)`);
// materials in shader order (region id 1 → index 0); the detector edits rough/metal/relief, sheen and coat come from MATS
const materials = reg.regions.map(r => {
  const m = MATS[r.mat];
  if (!m) throw new Error(`unknown material ${r.mat}`);
  return { mat: r.mat, metal: r.p.metal, rough: r.p.rough, relief: r.p.relief, sheen: m.sheen, coat: m.coat };
});
const shadow = shadowFor(img);
writeFileSync(OUT + 'image.png', writeRGBAPNG(img.width, img.height, img.data));
writeFileSync(OUT + 'regions.png', writeGreyPNG(reg.W, reg.H, reg.map.map(v => v * 40)));
writeFileSync(OUT + 'shadow.png', shadow.png);
if (heightMap) writeFileSync(OUT + 'height.png', writeGreyPNG(img.width, img.height, Uint8Array.from(heightMap.data, v => Math.round(Math.min(1, v) * 255))));
else rmSync(OUT + 'height.png', { force: true });
writeFileSync(OUT + 'card.json', JSON.stringify({
  image: { file: 'image.png', width: img.width, height: img.height },
  regions: { file: 'regions.png', width: reg.W, height: reg.H, source: reg.source, encoding: 'id = round(r * 255 / 40) - 1; -1 = outside every region' },
  materials,
  shadow: shadow.meta,
  // pressed-in relief added to the normal: N.xy += (dh/dx, −dh/dy) · scale, h from height.png (0 … 1)
  height: heightMap ? { file: 'height.png', scale: heightMap.depth } : null,
}, null, 2) + '\n');
const opaque = reg.map.reduce((n, v) => n + (v > 0), 0) || 1;
const share = id => Math.round(reg.map.reduce((n, v) => n + (v === id), 0) / opaque * 100);
const kb = f => Math.round(statSync(f).size / 1024);
console.log(`card.png ${source.width}×${source.height} ${kb(IN + 'card.png')} KB → image.png ${img.width}×${img.height} ${kb(OUT + 'image.png')} KB, GPU ${(img.width * img.height * 4 / 1048576).toFixed(1)} MB`);
console.log(`${reg.source} regions: ` + materials.map((m, i) => `${m.mat} ${share(i + 1)}%`).join(', '));
