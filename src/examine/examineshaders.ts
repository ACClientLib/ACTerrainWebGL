export const ExamineVertexShader = `#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
layout(location=2) in vec2 uv;
uniform mat4 projection;
uniform mat4 view;
uniform mat4 model;
out vec3 vNormal;
out vec2 vUv;
void main() {
  vNormal = mat3(model) * normal;
  vUv = uv;
  gl_Position = projection * view * model * vec4(position, 1.0);
}`;

export const ExamineFragmentShader = `#version 300 es
precision highp float;
uniform sampler2D materialTexture;
uniform float opacity;
uniform float luminosity;
uniform float diffuse;
uniform float alphaCutoff;
uniform int alphaMode;
in vec3 vNormal;
in vec2 vUv;
out vec4 color;
void main() {
  vec4 sampled = texture(materialTexture, vUv);
  float lighting = max(dot(normalize(vNormal), normalize(vec3(-0.35, 0.8, 0.55))), 0.0);
  vec3 rgb = sampled.rgb * (luminosity + diffuse * lighting);
  float alpha = sampled.a * opacity;
  if (alphaMode == 1 && alpha < alphaCutoff) discard;
  color = vec4(rgb, alpha);
}`;
