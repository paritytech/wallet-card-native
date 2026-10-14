// Turns the card image into the assets the renderers load. Run after replacing the card:
//
//   node tools/bake.mjs
//
// in:  card/card.png          the card, any size and aspect, transparent outside its shape
//      card/regions.json      optional: regions saved from Material Detector (hand-tuned). Delete it when
//                             you replace card.png, and the materials are detected automatically.
// out: assets/image.png       the card, sized for phones (≤ MAX_SIDE px), metadata stripped, recompressed
//      assets/regions.png     region id × 40 per pixel (0 = no region), 8-bit grey
//      assets/shadow.png      blurred alpha for the drop shadow, 8-bit grey
//      assets/card.json       sizes, materials (≤ 6), shadow geometry
// (assets/params.json is hand-edited and not touched.)
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
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
writeFileSync(OUT + 'card.json', JSON.stringify({
  image: { file: 'image.png', width: img.width, height: img.height },
  regions: { file: 'regions.png', width: reg.W, height: reg.H, source: reg.source, encoding: 'id = round(r * 255 / 40) - 1; -1 = outside every region' },
  materials,
  shadow: shadow.meta,
}, null, 2) + '\n');
const opaque = reg.map.reduce((n, v) => n + (v > 0), 0) || 1;
const share = id => Math.round(reg.map.reduce((n, v) => n + (v === id), 0) / opaque * 100);
const kb = f => Math.round(statSync(f).size / 1024);
console.log(`card.png ${source.width}×${source.height} ${kb(IN + 'card.png')} KB → image.png ${img.width}×${img.height} ${kb(OUT + 'image.png')} KB, GPU ${(img.width * img.height * 4 / 1048576).toFixed(1)} MB`);
console.log(`${reg.source} regions: ` + materials.map((m, i) => `${m.mat} ${share(i + 1)}%`).join(', '));
