// The "Material" view of Material Detector.dc.html, in Metal Shading Language.
// Line-for-line the same math as wallet.vert / wallet.frag / shadow.frag (GLSL ES 3.00).
#include <metal_stdlib>
using namespace metal;

struct QuadOut {
  float4 position [[position]];
  float2 uv;                       // (0,0) = the texture's top-left, row 0 of the file
};

// One quad, no vertex buffers: draw 4 vertices as a triangle strip.
// rect = (left, top, right, bottom) in clip space.
vertex QuadOut quad_vertex(uint vid [[vertex_id]], constant float4 &rect [[buffer(0)]]) {
  float2 c = float2(float(vid & 1), float(vid >> 1));
  QuadOut o;
  o.uv = c;
  o.position = float4(mix(rect.x, rect.z, c.x), mix(rect.y, rect.w, c.y), 0., 1.);
  return o;
}

// Matches WalletRenderer.swift: 36 floats, 144 bytes.
struct Region { float metal, rough, relief, sheen, coat; };
struct WalletUniforms {
  float2 tex;                      // image.png size in pixels
  float2 tilt;                     // smoothed tilt, x right, y up, each -1..1
  Region regions[6];
  float crease;                    // params.json relief.creases
  float guard;                     // params.json light.guard
};

constexpr sampler linearClamp(filter::linear, address::clamp_to_edge);
constexpr sampler nearestClamp(filter::nearest, address::clamp_to_edge);

static float ss(float e0, float e1, float x) { float t = clamp((x - e0) / (e1 - e0), 0., 1.); return t * t * (3. - 2. * t); }
static float lum(texture2d<float> img, float2 p) { float4 c = img.sample(linearClamp, p); return dot(c.rgb, float3(.3, .59, .11)) * c.a; }
static float alp(texture2d<float> img, float2 p) { return img.sample(linearClamp, p).a; }

static float3 envC(float3 d, float r) {
  float3 c = mix(float3(.16, .15, .14), float3(1., .97, .92), ss(-.5, .8, d.y));
  float w = .12 + r * .35;
  c += ss(w, 0., abs(d.x - .3)) * ss(.1, .5, d.y) * mix(1.8, .35, r);
  c += ss(w * 1.4, 0., abs(d.x + .55)) * ss(-.2, .3, d.y) * mix(.7, .15, r) * float3(.85, .9, 1.);
  return c;
}

fragment float4 wallet_fragment(QuadOut in [[stage_in]],
                                texture2d<float> img [[texture(0)]],     // premultiplied RGBA
                                texture2d<float> reg [[texture(1)]],     // R8 region ids × 40
                                constant WalletUniforms &u [[buffer(0)]]) {
  float2 uv = in.uv;
  float4 c = img.sample(linearClamp, uv);
  if (c.a < .01) return float4(0.);
  float3 base = c.rgb / max(c.a, .001);

  float id = floor(reg.sample(nearestClamp, uv).r * 255. / 40. + .5) - 1.;
  float me = 0., ro = .6, re = .5, sh = 0., co = 0.;
  int i = int(id);
  if (i >= 0 && i < 6) { Region g = u.regions[i]; me = g.metal; ro = g.rough; re = g.relief; sh = g.sheen; co = g.coat; }

  float2 e = 1. / u.tex;
  float hx = lum(img, uv + float2(e.x, 0.)) - lum(img, uv - float2(e.x, 0.));
  float hy = lum(img, uv + float2(0., e.y)) - lum(img, uv - float2(0., e.y));
  if (u.crease > 0.) {
    float2 ex = float2(e.x * 3., 0.), ey = float2(0., e.y * 3.), sx = float2(e.x, 0.), sy = float2(0., e.y);
    float cx = (lum(img, uv + ex) - lum(img, uv - ex) + lum(img, uv + ex + sy) - lum(img, uv - ex + sy) + lum(img, uv + ex - sy) - lum(img, uv - ex - sy)) / 3.;
    float cy = (lum(img, uv + ey) - lum(img, uv - ey) + lum(img, uv + ey + sx) - lum(img, uv - ey + sx) + lum(img, uv + ey - sx) - lum(img, uv - ey - sx)) / 3.;
    hx = mix(hx, cx, u.crease);
    hy = mix(hy, cy, u.crease);
  }
  float2 e3 = e * 4.;
  float ax = alp(img, uv + float2(e3.x, 0.)) - alp(img, uv - float2(e3.x, 0.));
  float ay = alp(img, uv + float2(0., e3.y)) - alp(img, uv - float2(0., e3.y));
  float3 N = normalize(float3(-hx * re * 7. - ax * 1.4, hy * re * 7. + ay * 1.4, 1.));

  float2 t = u.tilt;
  float3 V = float3(0., 0., 1.);
  float ly = .6 + t.y * (t.y < 0. ? mix(1.5, .3, u.guard) : 1.5);   // light.guard: never head-on
  float3 L = normalize(float3(.35 - t.x * 1.5, ly, .85));
  float3 H = normalize(L + V);
  float ndl = max(dot(N, L), 0.), ndh = max(dot(N, H), 0.);
  float3 R = reflect(-V, N); R.xy += float2(-t.x, t.y) * 1.1; R = normalize(R);

  float shin = mix(500., 10., ro);
  float spec = precise::pow(ndh, shin) * (1. - ro) * (1. - ro) * 2.2;
  float3 dif = base * (.78 + .34 * ndl);
  float3 env = envC(R, ro);
  float3 metalC = base * .32 * (.7 + .3 * ndl) + env * base * 1.05 + spec * base * 1.8;
  float3 col = mix(dif + float3(spec) * .35 * (1. - me), metalC, me * .7);
  col += sh * precise::pow(ndh, 5.) * .18 * (base + .4);
  col += co * (precise::pow(ndh, 320.) * 1.1
             + envC(reflect(-V, normalize(float3(N.xy * .3, 1.))) + float3(-t.x, t.y, 0.), .05).r * .05);

  return float4(col * c.a, c.a);
}

fragment float4 shadow_fragment(QuadOut in [[stage_in]],
                                texture2d<float> mask [[texture(0)]],    // shadow.png, R8
                                constant float &opacity [[buffer(0)]]) {
  return float4(0., 0., 0., mask.sample(linearClamp, in.uv).r * opacity);
}
