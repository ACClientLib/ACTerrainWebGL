export const SceneCompositeFragSource = `#version 300 es
precision highp float;
uniform sampler2D opaqueTexture;
uniform sampler2D accumulationTexture;
uniform sampler2D revealageTexture;
in vec2 uv;
out vec4 color;
void main() {
  vec4 opaque = texture(opaqueTexture, uv);
  vec4 accumulation = texture(accumulationTexture, uv);
  float alpha = clamp(1.0 - texture(revealageTexture, uv).r, 0.0, 1.0);
  vec3 source = accumulation.rgb / max(accumulation.a, 0.0001);
  color = vec4(mix(opaque.rgb, source, alpha), 1.0);
}
`;
