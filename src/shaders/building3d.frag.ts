export const Building3DFragSource = `#version 300 es
precision highp float;

uniform sampler2D buildingTexture;
uniform float diffuseAmount;
uniform float luminosity;
uniform float opacity;

in vec2 uv;
in vec3 normal;
out vec4 outColor;

void main() {
  vec4 color = texture(buildingTexture, uv);
  color.a *= opacity;
  if (color.a < 0.08) discard;
  vec3 lightDirection = normalize(vec3(0.35, 0.75, 0.55));
  float lighting = max(luminosity, 0.35 + max(dot(normalize(normal), lightDirection), 0.0) * max(diffuseAmount, 0.65));
  outColor = vec4(color.rgb, color.a);
}
`
