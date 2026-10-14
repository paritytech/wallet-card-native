#version 300 es
// Drop shadow: the baked, blurred wallet alpha, as premultiplied black.
precision mediump float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uShadow;   // shadow.png, R8, LINEAR
uniform float uOpacity;      // card.json shadow.opacity
void main() {
  fragColor = vec4(0., 0., 0., texture(uShadow, vUv).r * uOpacity);
}
