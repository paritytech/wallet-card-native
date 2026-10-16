// Shared by the reference pages: asset loading, the original detector shader (golden) and the
// GLSL ES 3.00 port (= what Android runs), each drawing the wallet into a WebGL context.
const ROOT = new URL('../', import.meta.url);
const url = p => new URL(p, ROOT).href;

export async function loadAssets() {
  const json = p => fetch(url(p)).then(r => { if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); });
  const text = p => fetch(url(p)).then(r => r.text());
  const image = p => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error(p)); i.src = url(p); });
  const desc = await json('assets/card.json');
  const [params, img, reg, shadow, vert, frag, shadowFrag, height] = await Promise.all([
    json('assets/params.json'), image('assets/' + desc.image.file), image('assets/' + desc.regions.file),
    image('assets/' + desc.shadow.file), text('shaders/wallet.vert'), text('shaders/wallet.frag'), text('shaders/shadow.frag'),
    desc.height ? image('assets/' + desc.height.file) : null,
  ]);
  // regions.png as raw bytes: the detector kept this map in memory, never as an image
  const c = document.createElement('canvas');
  c.width = reg.width; c.height = reg.height;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(reg, 0, 0);
  const rgba = cx.getImageData(0, 0, reg.width, reg.height).data, regBytes = new Uint8Array(reg.width * reg.height);
  for (let i = 0; i < regBytes.length; i++) regBytes[i] = rgba[i * 4];
  return { desc, params, img, regBytes, shadow, height, src: { vert, frag, shadowFrag } };
}

// Per-region uniform arrays, zero-filled to 6 exactly as the detector's arr() did.
export function regionArrays(materials) {
  const arr = f => { const a = new Float32Array(6); materials.forEach((m, i) => { a[i] = f(m); }); return a; };
  return { uMetal: arr(m => m.metal), uRough: arr(m => m.rough), uRelief: arr(m => m.relief), uSheen: arr(m => m.sheen), uCoat: arr(m => m.coat) };
}

function program(gl, vs, fs) {
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
function texture(gl, unit, filter) {
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
const uniforms = (gl, p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));

// ---- golden: Material Detector's own FRAG (WebGL 1), "Material" view, copied verbatim ----
const GOLDEN_VERT = `attribute vec2 a;varying vec2 vUv;void main(){vUv=a*.5+.5;gl_Position=vec4(a,0.,1.);}`;
const GOLDEN_FRAG = `precision highp float;
varying vec2 vUv;
uniform sampler2D uImg,uReg;
uniform vec2 uTex,uTilt;
uniform float uHi,uMask,uT;
uniform float uMetal[6],uRough[6],uRelief[6],uSheen[6],uCoat[6];
uniform vec3 uMaskC[6];
float lum(vec2 p){vec4 c=texture2D(uImg,p);return dot(c.rgb,vec3(.3,.59,.11))*c.a;}
float alp(vec2 p){return texture2D(uImg,p).a;}
vec3 envC(vec3 d,float r){
  vec3 c=mix(vec3(.16,.15,.14),vec3(1.,.97,.92),smoothstep(-.5,.8,d.y));
  float w=.12+r*.35;
  c+=smoothstep(w,0.,abs(d.x-.3))*smoothstep(.1,.5,d.y)*mix(1.8,.35,r);
  c+=smoothstep(w*1.4,0.,abs(d.x+.55))*smoothstep(-.2,.3,d.y)*mix(.7,.15,r)*vec3(.85,.9,1.);
  return c;
}
void main(){
  vec2 uv=vec2(vUv.x,1.-vUv.y);
  vec4 c=texture2D(uImg,uv);
  if(c.a<.01){gl_FragColor=vec4(0.);return;}
  vec3 base=c.rgb/max(c.a,.001);
  float id=floor(texture2D(uReg,uv).r*255./40.+.5)-1.;
  float me=0.,ro=.6,re=.5,sh=0.,co=0.;vec3 mc=vec3(.5);
  for(int i=0;i<6;i++){if(abs(float(i)-id)<.5){me=uMetal[i];ro=uRough[i];re=uRelief[i];sh=uSheen[i];co=uCoat[i];mc=uMaskC[i];}}
  vec2 e=1./uTex;
  float hx=lum(uv+vec2(e.x,0.))-lum(uv-vec2(e.x,0.));
  float hy=lum(uv+vec2(0.,e.y))-lum(uv-vec2(0.,e.y));
  vec2 e3=e*4.;
  float ax=alp(uv+vec2(e3.x,0.))-alp(uv-vec2(e3.x,0.));
  float ay=alp(uv+vec2(0.,e3.y))-alp(uv-vec2(0.,e3.y));
  vec3 N=normalize(vec3(-hx*re*7.-ax*1.4, hy*re*7.+ay*1.4, 1.));
  vec3 V=vec3(0.,0.,1.);
  vec3 L=normalize(vec3(.35-uTilt.x*1.5,.6+uTilt.y*1.5,.85));
  vec3 H=normalize(L+V);
  float ndl=max(dot(N,L),0.),ndh=max(dot(N,H),0.);
  vec3 R=reflect(-V,N);R.xy+=vec2(-uTilt.x,uTilt.y)*1.1;R=normalize(R);
  float shin=mix(500.,10.,ro);
  float spec=pow(ndh,shin)*(1.-ro)*(1.-ro)*2.2;
  vec3 dif=base*(.78+.34*ndl);
  vec3 env=envC(R,ro);
  vec3 metalC=base*.32*(.7+.3*ndl)+env*base*1.05+spec*base*1.8;
  vec3 col=mix(dif+vec3(spec)*.35*(1.-me),metalC,me*.7);
  col+=sh*pow(ndh,5.)*.18*(base+.4);
  vec3 Rf=normalize(vec3(-uTilt.x,uTilt.y,1.)+vec3(0.,0.,0.));
  col+=co*(pow(ndh,320.)*1.1+envC(reflect(-V,normalize(vec3(N.xy*.3,1.)))+vec3(-uTilt.x,uTilt.y,0.),.05).r*.05);
  float l=dot(base,vec3(.3,.59,.11));
  if(uMask>.5) col=mc*(.45+.7*l);
  if(uHi>-.5){
    if(abs(id-uHi)>.5) col=mix(col,vec3(l*.45+.42),.72);
    else col+=vec3(.06)*(.5+.5*sin(uT*5.));
  }
  gl_FragColor=vec4(col*c.a,c.a);
}`;

// The detector's upload and draw, minus the CSS rotation. Fills the whole canvas.
export function goldenRenderer(gl, a) {
  const p = program(gl, GOLDEN_VERT, GOLDEN_FRAG);
  gl.useProgram(p);
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(p, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = uniforms(gl, p, ['uImg', 'uReg', 'uTex', 'uTilt', 'uHi', 'uMask', 'uT', 'uMetal', 'uRough', 'uRelief', 'uSheen', 'uCoat']);
  const img = texture(gl, 0, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, a.img); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  texture(gl, 1, gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, a.desc.regions.width, a.desc.regions.height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, a.regBytes);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  const R = regionArrays(a.desc.materials);
  return tilt => {
    gl.useProgram(p);
    gl.uniform1i(U.uImg, 0); gl.uniform1i(U.uReg, 1);
    gl.uniform2f(U.uTex, a.img.naturalWidth, a.img.naturalHeight); gl.uniform2f(U.uTilt, tilt[0], tilt[1]);
    gl.uniform1f(U.uHi, -1); gl.uniform1f(U.uMask, 0); gl.uniform1f(U.uT, 0);
    for (const k in R) gl.uniform1fv(U[k], R[k]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
}

// ---- the port (WebGL 2 = OpenGL ES 3.0, the same calls Android makes through GLES30) ----
export function portRenderer(gl, a) {
  const wallet = program(gl, a.src.vert, a.src.frag), shadow = program(gl, a.src.vert, a.src.shadowFrag);
  const UW = uniforms(gl, wallet, ['uRect', 'uImg', 'uReg', 'uTex', 'uTilt', 'uCrease', 'uGuard', 'uHeight', 'uHeightScale', 'uMetal', 'uRough', 'uRelief', 'uSheen', 'uCoat']);
  const US = uniforms(gl, shadow, ['uRect', 'uShadow', 'uOpacity']);
  gl.bindVertexArray(gl.createVertexArray());            // no attributes: the quad comes from gl_VertexID
  const img = texture(gl, 0, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, a.img); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  const reg = texture(gl, 1, gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, a.desc.regions.width, a.desc.regions.height, 0, gl.RED, gl.UNSIGNED_BYTE, a.regBytes);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  const sh = texture(gl, 2, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, a.shadow);
  texture(gl, 3, gl.LINEAR);
  if (a.height) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, a.height);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(1));
  const R = regionArrays(a.desc.materials);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // premultiplied over
  return {
    // rect = [left, top, right, bottom] in clip space
    shadow(rect) {
      gl.useProgram(shadow);
      gl.uniform4f(US.uRect, ...rect); gl.uniform1i(US.uShadow, 2); gl.uniform1f(US.uOpacity, a.desc.shadow.opacity);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    // crease, guard, height: params.json relief.creases, light.guard, card.json height.scale;
    // pass 0, 0, 0 to reproduce the detector exactly
    wallet(rect, tilt, crease = a.params.relief.creases, guard = a.params.light.guard, height = a.desc.height ? a.desc.height.scale : 0) {
      gl.useProgram(wallet);
      gl.uniform4f(UW.uRect, ...rect); gl.uniform1i(UW.uImg, 0); gl.uniform1i(UW.uReg, 1);
      gl.uniform2f(UW.uTex, a.desc.image.width, a.desc.image.height); gl.uniform2f(UW.uTilt, tilt[0], tilt[1]); gl.uniform1f(UW.uCrease, crease); gl.uniform1f(UW.uGuard, guard); gl.uniform1i(UW.uHeight, 3); gl.uniform1f(UW.uHeightScale, height);
      for (const k in R) gl.uniform1fv(UW[k], R[k]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}

// Same layout as WalletRenderer.walletRect / WalletRenderer.kt: sizes in CSS px (= points / dp).
export function walletRect(a, w, h) {
  const aspect = a.desc.image.width / a.desc.image.height, s = a.desc.shadow, L = a.params.layout;
  const fitHeight = h / (1 / aspect + 2 * s.pad + s.offsetY);
  const ww = Math.min(w * L.widthFraction, L.maxWidth, fitHeight), wh = ww / aspect;
  return { x: (w - ww) / 2, y: (h - wh) / 2, w: ww, h: wh };
}
export function clipRect(r, w, h) { return [r.x / w * 2 - 1, 1 - r.y / h * 2, (r.x + r.w) / w * 2 - 1, 1 - (r.y + r.h) / h * 2]; }
export function shadowRect(a, r) {
  const p = a.desc.shadow.pad * r.w;
  return { x: r.x - p, y: r.y - p + a.desc.shadow.offsetY * r.w, w: r.w + 2 * p, h: r.h + 2 * p };
}
export function hexColor(hex) { const v = parseInt(hex.slice(1), 16); return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255]; }
