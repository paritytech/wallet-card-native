// Minimal PNG reader/writer for the bake step: 8-bit, non-interlaced, no dependencies.
import { inflateSync, deflateSync } from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

// Returns { width, height, data: Uint8Array RGBA, straight (not premultiplied) alpha }.
export function readPNG(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let p = 8, width, height, depth, type, interlace;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString('ascii', p + 4, p + 8), body = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    p += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !channels || interlace) throw new Error(`unsupported PNG (depth ${depth}, colour type ${type}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels, px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[o + x - channels] : 0, b = y ? px[o - stride + x] : 0, c = x >= channels && y ? px[o - stride + x - channels] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[o + x] = v;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = px.subarray(i * channels, i * channels + channels);
    if (channels <= 2) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = s[0]; data[i * 4 + 3] = channels === 2 ? s[1] : 255; }
    else { data[i * 4] = s[0]; data[i * 4 + 1] = s[1]; data[i * 4 + 2] = s[2]; data[i * 4 + 3] = channels === 4 ? s[3] : 255; }
  }
  return { width, height, data };
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// 8-bit greyscale PNG with no colour chunks, so every platform decodes the bytes unchanged.
export function writeGreyPNG(width, height, grey) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) grey.subarray(y * width, (y + 1) * width).forEach((v, x) => { raw[y * (width + 1) + 1 + x] = v; });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// 8-bit RGBA PNG (straight alpha), no metadata chunks. Tries every row filter, keeps the smallest per row.
export function writeRGBAPNG(width, height, rgba) {
  const stride = width * 4, raw = Buffer.alloc((stride + 1) * height), cand = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride), up = y ? rgba.subarray((y - 1) * stride, y * stride) : null;
    let best = -1, bestCost = Infinity;
    for (let f = 0; f < 5; f++) {
      let cost = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? row[x - 4] : 0, b = up ? up[x] : 0, c = x >= 4 && up ? up[x - 4] : 0;
        let p = 0;
        if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
        else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        const v = (row[x] - p) & 255;
        cand[x] = v;
        cost += v < 128 ? v : 256 - v;
      }
      if (cost < bestCost) { bestCost = cost; best = f; cand.copy(raw, y * (stride + 1) + 1); }
    }
    raw[y * (stride + 1)] = best;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9, memLevel: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Area-average downscale in premultiplied space (no dark fringes at the edges), straight RGBA out.
export function downscaleRGBA(img, width, height) {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const fy0 = y * img.height / height, fy1 = (y + 1) * img.height / height;
    for (let x = 0; x < width; x++) {
      const fx0 = x * img.width / width, fx1 = (x + 1) * img.width / width;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = Math.floor(fy0); sy < Math.ceil(fy1); sy++) {
        const wy = Math.min(fy1, sy + 1) - Math.max(fy0, sy);
        for (let sx = Math.floor(fx0); sx < Math.ceil(fx1); sx++) {
          const w = wy * (Math.min(fx1, sx + 1) - Math.max(fx0, sx)), i = (sy * img.width + sx) * 4, al = img.data[i + 3] * w;
          r += img.data[i] * al; g += img.data[i + 1] * al; b += img.data[i + 2] * al; a += al; wsum += w;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(a / wsum);
    }
  }
  return { width, height, data: out };
}
