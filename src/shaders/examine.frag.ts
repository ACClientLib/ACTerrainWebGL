export const ExamineFragmentShader = `#version 300 es
precision highp float;
uniform sampler2D materialTexture;
uniform float opacity;
uniform float luminosity;
uniform float diffuse;
uniform float alphaCutoff;
uniform int alphaMode;
in vec2 vUv;
out vec4 color;
void main() {
  vec4 sampled = texture(materialTexture, vUv);
  vec3 rgb = sampled.rgb;
  float alpha = sampled.a * opacity;
  if (alphaMode == 1 && alpha < alphaCutoff) discard;
  color = vec4(rgb, alpha);
}`;
