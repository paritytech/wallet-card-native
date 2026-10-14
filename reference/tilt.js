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
// at becomes "level" within a few seconds, so only movement moves the light (this also cancels gyro drift).
// Level is not the shader's (0, 0) but `rest`, the light position where the creases catch the light best,
// and a turn moves the light by amplitude · tanh(turn / softDeg): a few degrees of ordinary hand sway
// already sweep the highlights across the creases, and big turns saturate before the light floods the card.
// The renderer then eases toward the target with rate `smoothing` (the detector's 0.08 lerp at 60 fps).
//
// Without a gyroscope, `angles()` takes beta/gamma from gravity instead (blind to turns of an
// upright phone about the vertical, so a fallback only).
export class TiltFilter {
  constructor({ rest, amplitude, softDeg, neutralTau, smoothing }) {
    Object.assign(this, { rest, amplitude, softDeg, neutralTau, smoothing });
    this.turn = [0, 0];           // degrees about device x, y, relative to the drifting neutral
    this.base = null;             // fallback only: neutral beta/gamma
    this.target = rest.slice();
    this.value = rest.slice();
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
  // pointer (desktop): position over the stage, -1..1, y up; null = back to rest
  point(p) { this.target = p ? [this.rest[0] + p[0] * this.amplitude, this.rest[1] + p[1] * this.amplitude] : this.rest.slice(); }
  aim(aboutY, aboutX) {
    const k = this.amplitude, s = this.softDeg;
    this.target = [this.rest[0] + k * Math.tanh(aboutY / s), this.rest[1] + k * Math.tanh(aboutX / s)];
  }
  step(dt) {
    const k = 1 - Math.exp(-dt * this.smoothing);
    this.value[0] += (this.target[0] - this.value[0]) * k;
    this.value[1] += (this.target[1] - this.value[1]) * k;
    return this.value;
  }
}
