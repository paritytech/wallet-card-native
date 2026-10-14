// The port as a running app: the same shaders, layout and tilt filter the native views use.
// Open it on a phone to feel the motion. ?tilt=x,y freezes the light (for screenshots).
import { loadAssets, portRenderer, walletRect, shadowRect, clipRect } from '../common.js';
import { TiltFilter } from '../tilt.js';

const canvas = document.getElementById('c'), read = document.getElementById('read'), motionBtn = document.getElementById('motion');
try {
  const a = await loadAssets();
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false, alpha: true });
  if (!gl) throw new Error('WebGL2 is not available');
  const r = portRenderer(gl, a);
  const tilt = new TiltFilter(a.params.tilt);
  const frozen = new URLSearchParams(location.search).get('tilt')?.split(',').map(Number);
  let source = 'pointer', lastSample = 0;

  addEventListener('pointermove', e => {
    if (source !== 'pointer' || e.pointerType === 'touch') return;
    tilt.point((e.clientX / innerWidth - 0.5) * 2, (e.clientY / innerHeight - 0.5) * -2);
  });
  document.addEventListener('pointerleave', () => { if (source === 'pointer') tilt.point(0, 0); });
  // DeviceMotionEvent.rotationRate is in the device frame, degrees per second: beta about x, gamma about y
  const onMotion = e => {
    const r = e.rotationRate;
    if (!r || r.beta == null || r.gamma == null) return;
    const now = performance.now() / 1000, dt = lastSample ? Math.min(0.1, now - lastSample) : 0;
    lastSample = now;
    source = 'motion';
    tilt.rotate(r.beta, r.gamma, dt);
  };
  const D = window.DeviceMotionEvent;
  if (D && typeof D.requestPermission === 'function') {          // iOS Safari: permission from a tap
    motionBtn.hidden = false;
    motionBtn.onclick = () => D.requestPermission().then(s => { if (s === 'granted') { addEventListener('devicemotion', onMotion); motionBtn.hidden = true; } }).catch(() => {});
  } else addEventListener('devicemotion', onMotion);

  let last = 0;
  const frame = t => {
    requestAnimationFrame(frame);
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
    last = t;
    const scale = Math.min(devicePixelRatio || 1, a.params.render.maxScale) * a.params.render.supersample;
    const w = innerWidth, h = innerHeight, pw = Math.round(w * scale), ph = Math.round(h * scale);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const v = frozen || tilt.step(dt);
    gl.viewport(0, 0, pw, ph);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const rect = walletRect(a, w, h);
    r.shadow(clipRect(shadowRect(a, rect), w, h));
    r.wallet(clipRect(rect, w, h), v);
    read.textContent = `${frozen ? 'frozen' : source}  x ${v[0].toFixed(2)}  y ${v[1].toFixed(2)}`;
  };
  requestAnimationFrame(frame);
} catch (e) {
  document.body.insertAdjacentHTML('beforeend', `<div class="err"></div>`);
  document.querySelector('.err').textContent = String(e.stack || e);
}
