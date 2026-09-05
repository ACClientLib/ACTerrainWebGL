export const Building3DFragSource = `#version 300 es
precision highp float;

uniform sampler2D buildingTexture;
uniform float diffuseAmount;
uniform float luminosity;
uniform float opacity;
uniform float alphaCutoff;
uniform int alphaMode;
uniform int renderPass;
uniform vec3 cameraPosition;
uniform vec3 fogColor;
uniform float fogStart;
uniform float fogEnd;
uniform int fogEnabled;
uniform vec3 lightDirection;
uniform vec3 sunlightColor;
uniform vec3 ambientColor;

in vec2 uv;
in vec3 normal;
in vec3 fragmentWorldPosition;
layout(location = 0) out vec4 outColor;
layout(location = 1) out float outRevealage;

void main() {
  vec4 color = texture(buildingTexture, uv);
  color.a *= opacity;
  if (renderPass == 4) {
    // Match the client's alpha-tested foliage behavior: opaque texels write
    // depth, while the antialiased edge remains in the translucent pass.
    if (alphaMode != 2 || color.a < 0.95) discard;
    color.a = 1.0;
  }
  // SourceOver is accumulated into the shared WBOIT targets. Masked content
  // remains a depth-writing discard pass.
  if (renderPass == 0 || renderPass == 3 || renderPass == 4) {
    if (alphaMode == 3) discard;
    if (renderPass == 0 && alphaMode == 2 && color.a >= 0.95) discard;
    if (alphaMode == 1 && color.a < alphaCutoff) discard;
    if (alphaMode == 2 && color.a <= 0.0) discard;
  } else if (renderPass == 2) {
    if (alphaMode != 2 || color.a <= 0.0 || color.a >= 0.95) discard;
  } else {
    if (alphaMode != 3) discard;
    if (color.a <= 0.0) discard;
  }
  // lightDirection describes the direction light travels. Lighting is
  // evaluated against the direction from the surface toward the light.
  float lighting = max(luminosity, dot(normalize(normal), -normalize(lightDirection)) * diffuseAmount + 0.35);
  vec3 rgb = color.rgb * (ambientColor + sunlightColor * lighting);
  if (fogEnabled != 0) {
    float fogFactor = clamp((length(fragmentWorldPosition - cameraPosition) - fogStart) /
      max(fogEnd - fogStart, 0.0001), 0.0, 1.0);
    rgb = mix(rgb, fogColor, fogFactor);
  }
  vec4 premultiplied = vec4(rgb * color.a, color.a);
  if (renderPass == 2) {
    outColor = vec4(color.a);
    outRevealage = color.a;
    return;
  }
  if (alphaMode == 2 && renderPass == 0) {
    float weight = clamp(pow(max(color.a, 0.0001), 0.5) * 8.0, 0.01, 8.0);
    outColor = vec4(premultiplied.rgb * weight, color.a * weight);
    outRevealage = color.a;
  } else {
    outColor = vec4(rgb, color.a);
    outRevealage = 1.0;
  }
}
`;
