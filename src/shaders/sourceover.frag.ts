export const SourceOverFragSource = `#version 300 es
precision highp float;

uniform sampler2D sceneTexture;
uniform sampler2D revealageTexture;
in vec2 uv;
out vec4 color;

void main() {
  vec4 accumulation = texture(sceneTexture, uv);
  float revealage = texture(revealageTexture, uv).r;
  float alpha = clamp(1.0 - revealage, 0.0, 1.0);
  color = vec4(accumulation.rgb / max(accumulation.a, 0.0001), alpha);
}
`;
