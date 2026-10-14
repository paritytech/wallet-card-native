// Tilt input → light. The same filter as TiltSource.swift / TiltSource.kt; keep the three in step.
//
// The light follows the phone turning, measured by the gyroscope in the phone's own frame
// (x right, y up the screen, z out of the screen; right-hand rule):
//   x = turn about the device's y axis (right edge away from you = +)
//   y = turn about the device's x axis (top edge toward you = +)
// That is exactly the motion the detector faked with CSS rotateY/rotateX. Here the wallet is never
// turned on screen; only the light (uTilt) moves.
//
// The turn is integrated with a leak of time constant `neutralTau`: whatever angle the phone is held
// at becomes "level" within a few seconds, so only movement moves the light. (This is the same as the
// drifting neutral pose in Purse/src/tilt.js, and it also cancels gyro drift.) ±rangeDeg → ±1.
// The renderer then eases toward the target with rate `smoothing` (the detector's 0.08 lerp at 60 fps).
//
// Without a gyroscope, `angles()` takes beta/gamma from gravity instead (blind to turns of an
// upright phone about the vertical, so a fallback only).
export class TiltFilter {
  constructor({ rangeDeg, neutralTau, smoothing }) {
    Object.assign(this, { rangeDeg, neutralTau, smoothing });
    this.turn = [0, 0];           // degrees about device x, y, relative to the drifting neutral
    this.base = null;             // fallback only: neutral beta/gamma
    this.target = [0, 0];
    this.value = [0, 0];
  }
  // gyroscope: rotation rate about device x and y in degrees per second
  // (from DeviceMotionEvent.rotationRate: alpha is about x, beta about y)
  rotate(rateX, rateY, dt) {
    const leak = Math.exp(-dt / this.neutralTau);
    this.turn[0] = (this.turn[0] + rateX * dt) * leak;
    this.turn[1] = (this.turn[1] + rateY * dt) * leak;
    this.aim(this.turn[1], this.turn[0]);
  }
  // fallback: absolute beta (about x) and gamma (about y) in degrees
  angles(beta, gamma, dt) {
    if (!this.base) this.base = [beta, gamma];
    const k = 1 - Math.exp(-dt / this.neutralTau);
    this.base[0] += (beta - this.base[0]) * k;
    this.base[1] += (gamma - this.base[1]) * k;
    this.aim(gamma - this.base[1], beta - this.base[0]);
  }
  // pointer (desktop), as in the detector: position over the stage, -1..1, y up
  point(x, y) { this.target = [x, y]; }
  aim(aboutY, aboutX) {
    const c = v => Math.max(-1, Math.min(1, v));
    this.target = [c(aboutY / this.rangeDeg), c(aboutX / this.rangeDeg)];
  }
  step(dt) {
    const k = 1 - Math.exp(-dt * this.smoothing);
    this.value[0] += (this.target[0] - this.value[0]) * k;
    this.value[1] += (this.target[1] - this.value[1]) * k;
    return this.value;
  }
}
