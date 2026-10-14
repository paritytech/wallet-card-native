// Automatic material detection, copied from Material Detector.dc.html (MATS, rgb2lab, rgb2hsv,
// classify, analyze). It is the state the detector shows right after "Upload PNG", before anyone
// touches the wand, brush or sliders, plus refine() at the end (see below). Only the 520-px downscale differs: the browser's drawImage
// is replaced by a premultiplied box filter, so borderline clusters can occasionally land differently.

export const MATS = {
  leather: { name: 'Leather', h: 19, hw: 10, s: .58, sw: .26, v: .36, vw: .24, metal: 0, rough: .55, relief: .9, sheen: .1, coat: .22 },
  brass: { name: 'Brass', h: 40, hw: 10, s: .48, sw: .2, v: .55, vw: .26, metal: 1, rough: .34, relief: .45, sheen: 0, coat: 0 },
  gold: { name: 'Gold', h: 44, hw: 8, s: .76, sw: .15, v: .82, vw: .15, metal: 1, rough: .18, relief: .3, sheen: 0, coat: 0 },
  steel: { name: 'Steel', h: -1, hw: 0, s: .06, sw: .09, v: .62, vw: .28, metal: 1, rough: .24, relief: .35, sheen: 0, coat: 0 },
  copper: { name: 'Copper', h: 19, hw: 7, s: .66, sw: .14, v: .72, vw: .14, metal: 1, rough: .3, relief: .4, sheen: 0, coat: 0, smooth: true },
  thread: { name: 'Cotton thread', h: 32, hw: 15, s: .32, sw: .18, v: .84, vw: .13, small: true, metal: 0, rough: .88, relief: .7, sheen: .5, coat: 0 },
  fabric: { name: 'Fabric', h: -1, hw: 0, s: .2, sw: .2, v: .68, vw: .25, large: true, metal: 0, rough: .93, relief: .6, sheen: .6, coat: 0 },
  rubber: { name: 'Rubber', h: -1, hw: 0, s: .1, sw: .2, v: .1, vw: .08, metal: 0, rough: .85, relief: .4, sheen: 0, coat: 0 },
  plastic: { name: 'Plastic', auto: false, metal: 0, rough: .28, relief: .2, sheen: 0, coat: .6 },
  wood: { name: 'Wood', auto: false, metal: 0, rough: .6, relief: .8, sheen: 0, coat: .3 },
  glass: { name: 'Glass', auto: false, metal: 0, rough: .05, relief: .1, sheen: 0, coat: 1 },
  paint: { name: 'Paint', auto: false, metal: 0, rough: .4, relief: .3, sheen: 0, coat: .4 },
};

function rgb2lab(r, g, b) {
  const f = x => (x /= 255) <= .04045 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4);
  r = f(r); g = f(g); b = f(b);
  let X = (r * .4124 + g * .3576 + b * .1805) / .95047, Y = r * .2126 + g * .7152 + b * .0722, Z = (r * .0193 + g * .1192 + b * .9505) / 1.08883;
  const h = t => t > .008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  X = h(X); Y = h(Y); Z = h(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, mx ? d / mx : 0, mx];
}
function classify(hsv, area, tex) {
  let best = null, bs = 0, sum = 0;
  for (const k in MATS) {
    const m = MATS[k];
    if (m.auto === false) continue;
    let s = Math.exp(-(((hsv[1] - m.s) / m.sw) ** 2)) * Math.exp(-(((hsv[2] - m.v) / m.vw) ** 2));
    if (m.h >= 0) { let dh = Math.abs(hsv[0] - m.h); dh = Math.min(dh, 360 - dh); s *= Math.exp(-((dh / m.hw) ** 2)); }
    if (m.small) s *= area < .1 ? 1 : .15;
    if (m.large) s *= area > .15 ? 1 : .3;
    if (m.smooth) s *= tex < .04 ? 1 : .4;
    sum += s; if (s > bs) { bs = s; best = k; }
  }
  return { mat: best || 'leather', conf: sum > 0 ? bs / sum : 0 };
}

// Stand-in for drawImage(img, 0, 0, W, H) + getImageData: premultiplied box filter, straight RGBA out.
function downscale(img, W, H) {
  const D = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const x0 = Math.floor(x * img.width / W), x1 = Math.max(x0 + 1, Math.floor((x + 1) * img.width / W));
    const y0 = Math.floor(y * img.height / H), y1 = Math.max(y0 + 1, Math.floor((y + 1) * img.height / H));
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const i = (yy * img.width + xx) * 4, al = img.data[i + 3];
      r += img.data[i] * al; g += img.data[i + 1] * al; b += img.data[i + 2] * al; a += al; n++;
    }
    const o = (y * W + x) * 4;
    if (a > 0) { D[o] = r / a; D[o + 1] = g / a; D[o + 2] = b / a; }
    D[o + 3] = a / n;
  }
  return D;
}

// img = { width, height, data: straight RGBA }. Returns the region map (0 = none, 1…6) at the
// detector's analysis size, and up to six regions in map order with their detected material.
export function analyze(img) {
  const M = 520, asp = img.width / img.height;
  const W = asp >= 1 ? M : Math.round(M * asp), H = asp >= 1 ? Math.round(M / asp) : M;
  const D = downscale(img, W, H), N = W * H;
  const lab = new Float32Array(N * 3), Lm = new Float32Array(N), op = new Uint8Array(N);
  for (let i = 0; i < N; i++) { op[i] = D[i * 4 + 3] > 140 ? 1 : 0; const l = rgb2lab(D[i * 4], D[i * 4 + 1], D[i * 4 + 2]); lab[i * 3] = l[0] * .5; lab[i * 3 + 1] = l[1] * 1.6; lab[i * 3 + 2] = l[2]; Lm[i] = l[0] / 100; }
  const tex = new Float32Array(N);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; tex[i] = Math.abs(Lm[i] - (Lm[i - 1] + Lm[i + 1] + Lm[i - W] + Lm[i + W]) / 4); }
  const idx = []; for (let i = 0; i < N; i++) if (op[i]) idx.push(i);
  if (!idx.length) throw new Error('the image has no opaque pixels (alpha > 140)');
  const step = Math.max(1, Math.floor(idx.length / 16000)), S = []; for (let i = 0; i < idx.length; i += step) S.push(idx[i]);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const K = 10, C = []; const d2 = (i, c) => { const a = lab[i * 3] - c[0], b = lab[i * 3 + 1] - c[1], d = lab[i * 3 + 2] - c[2]; return a * a + b * b + d * d; };
  { const i = S[Math.floor(rnd() * S.length)]; C.push([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]]); }
  while (C.length < K) { let tot = 0; const ds = S.map(i => { let m = 1e9; for (const c of C) m = Math.min(m, d2(i, c)); tot += m; return m; }); let r = rnd() * tot, j = 0; for (; j < ds.length - 1 && (r -= ds[j]) > 0; j++); const i = S[j]; C.push([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]]); }
  const near = i => { let b = 0, bm = 1e9; for (let k = 0; k < C.length; k++) { const m = d2(i, C[k]); if (m < bm) { bm = m; b = k; } } return b; };
  for (let it = 0; it < 14; it++) {
    const acc = C.map(() => [0, 0, 0, 0]);
    for (const i of S) { const k = near(i), a = acc[k]; a[0] += lab[i * 3]; a[1] += lab[i * 3 + 1]; a[2] += lab[i * 3 + 2]; a[3]++; }
    acc.forEach((a, k) => { if (a[3]) C[k] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  const asg = new Int8Array(N).fill(-1), st = C.map(() => ({ r: 0, g: 0, b: 0, t: 0, n: 0 }));
  for (const i of idx) { const k = near(i); asg[i] = k; const s = st[k]; s.r += D[i * 4]; s.g += D[i * 4 + 1]; s.b += D[i * 4 + 2]; s.t += tex[i]; s.n++; }
  const tot = idx.length || 1; const byMat = {};
  st.forEach((s, k) => {
    if (s.n < tot * .003) return;
    const r = s.r / s.n, g = s.g / s.n, b = s.b / s.n; const c = classify(rgb2hsv(r, g, b), s.n / tot, s.t / s.n);
    const m = byMat[c.mat] || (byMat[c.mat] = { mat: c.mat, ks: [], n: 0, r: 0, g: 0, b: 0, conf: 0 });
    m.ks.push(k); m.n += s.n; m.r += s.r; m.g += s.g; m.b += s.b; m.conf += c.conf * s.n;
  });
  const regs = Object.values(byMat).sort((a, b) => b.n - a.n).slice(0, 6);
  const kToR = new Int8Array(K).fill(-1); regs.forEach((r, ri) => r.ks.forEach(k => { kToR[k] = ri; }));
  for (let k = 0; k < K; k++) if (kToR[k] < 0) { let b = 0, bm = 1e9; regs.forEach((r, ri) => r.ks.forEach(k2 => { const a = C[k], c = C[k2]; const m = (a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2 + (a[2] - c[2]) ** 2; if (m < bm) { bm = m; b = ri; } })); kToR[k] = b; }
  const map = new Uint8Array(N); for (let i = 0; i < N; i++) map[i] = asg[i] < 0 ? 0 : kToR[asg[i]] + 1;
  const sm = new Uint8Array(map);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x; if (!map[i]) continue;
    const cnt = [0, 0, 0, 0, 0, 0, 0];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cnt[map[i + dy * W + dx]]++;
    let b = map[i]; for (let v = 1; v < 7; v++) if (cnt[v] > cnt[b]) b = v; sm[i] = b;
  }
  refine(sm, W, H, regs);
  const regions = regs.map(r => {
    const m = MATS[r.mat];
    return { mat: r.mat, conf: r.conf / r.n, area: r.n / tot, p: { rough: m.rough, metal: m.metal, relief: m.relief } };
  });
  return { W, H, map: sm, regions };
}

// ---- Not in the detector: shape-aware clean-up of the automatic map ----
// The detector classifies by colour alone, so the lit side of a metal button (pale, yellowish) reads as
// cotton thread, and a few thread pixels read as brass. Metal parts are solid objects, so:
//   1. metal specks smaller than SPECK px go to their most common neighbour;
//   2. a non-metal, non-dominant patch sharing ≥ TOUCH of its border with one metal part joins it;
//   3. a compact metal part (area ≥ SOLID of its convex hull) takes every pixel inside that hull.
// Frames, zips and other thin or ring-shaped metal fail the SOLID test and are left as detected.
const SPECK = 12, TOUCH = 0.25, SOLID = 0.6;

function components(map, W, H) {
  const comp = new Int32Array(W * H).fill(-1), list = [];
  for (let s = 0; s < W * H; s++) {
    if (!map[s] || comp[s] >= 0) continue;
    const v = map[s], px = [], q = [s];
    comp[s] = list.length;
    while (q.length) {
      const i = q.pop(); px.push(i);
      const x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
        if (j < 0 || j >= W * H || comp[j] >= 0 || map[j] !== v) continue;
        comp[j] = list.length; q.push(j);
      }
    }
    list.push({ v, px });
  }
  return { comp, list };
}

// border contacts of one component: neighbouring component id → shared edge count
function contacts(c, comp, map, W, H, self) {
  const touch = new Map(); let edges = 0;
  for (const i of c.px) {
    const x = i % W;
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i + W < W * H ? i + W : -1]) {
      if (j < 0 || comp[j] === self) continue;
      edges++;
      if (map[j]) touch.set(comp[j], (touch.get(comp[j]) || 0) + 1);
    }
  }
  return { touch, edges };
}

function hull(points) {
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of points) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let k = points.length - 1; k >= 0; k--) { const p = points[k]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));   // counter-clockwise in (x, y-down) = clockwise on screen
}

export function refine(map, W, H, regions) {
  const isMetal = v => v > 0 && MATS[regions[v - 1].mat].metal > 0.5;
  const counts = new Array(regions.length + 1).fill(0);
  for (const v of map) counts[v]++;
  const dominant = counts.indexOf(Math.max(...counts.slice(1)), 1);

  // 1. metal specks
  let { comp, list } = components(map, W, H);
  list.forEach((c, k) => {
    if (!isMetal(c.v) || c.px.length >= SPECK) return;
    const votes = new Map();
    for (const [n, e] of contacts(c, comp, map, W, H, k).touch) votes.set(list[n].v, (votes.get(list[n].v) || 0) + e);
    const best = [...votes].sort((a, b) => b[1] - a[1])[0];
    if (best) for (const i of c.px) map[i] = best[0];
  });

  // 2. patches hugging a metal part
  ({ comp, list } = components(map, W, H));
  list.forEach((c, k) => {
    if (isMetal(c.v) || c.v === dominant) return;
    const { touch, edges } = contacts(c, comp, map, W, H, k);
    for (const [n, e] of touch) if (isMetal(list[n].v) && e >= TOUCH * edges) { for (const i of c.px) map[i] = list[n].v; break; }
  });

  // 3. fill compact metal parts to their convex hull
  ({ comp, list } = components(map, W, H));
  for (const c of list) {
    if (!isMetal(c.v) || c.px.length < SPECK) continue;
    const pts = [];
    for (const i of c.px) { const x = i % W, y = (i - x) / W; pts.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]); }
    const h = hull(pts);
    let area = 0;
    for (let k = 0; k < h.length; k++) { const a = h[k], b = h[(k + 1) % h.length]; area += a[0] * b[1] - b[0] * a[1]; }
    area = Math.abs(area) / 2;
    if (c.px.length < SOLID * area) continue;
    const sign = Math.sign(h.length > 2 ? (h[1][0] - h[0][0]) * (h[2][1] - h[0][1]) - (h[1][1] - h[0][1]) * (h[2][0] - h[0][0]) : 1);
    const xs = h.map(p => p[0]), ys = h.map(p => p[1]);
    for (let y = Math.min(...ys); y < Math.max(...ys); y++) for (let x = Math.min(...xs); x < Math.max(...xs); x++) {
      const i = y * W + x, cx = x + .5, cy = y + .5;
      if (!map[i]) continue;
      let inside = true;
      for (let k = 0; k < h.length && inside; k++) { const a = h[k], b = h[(k + 1) % h.length]; if (sign * ((b[0] - a[0]) * (cy - a[1]) - (b[1] - a[1]) * (cx - a[0])) < 0) inside = false; }
      if (inside) map[i] = c.v;
    }
  }
  return map;
}
