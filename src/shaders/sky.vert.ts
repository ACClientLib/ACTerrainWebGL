export const SkyVertSource = `#version 300 es
precision highp float;
layout(location=0) in vec3 localPosition;
layout(location=1) in vec3 localNormal;
layout(location=2) in vec2 textureUv;
uniform mat4 xWorld;
uniform vec3 skyOrigin;
uniform vec4 skyRotation;
uniform vec2 uvOffset;
out vec2 uv;
out vec3 normal;
out vec3 fragmentWorldPosition;
vec3 rotate(vec3 value) {
  return value + 2.0 * cross(skyRotation.xyz, cross(skyRotation.xyz, value) + skyRotation.w * value);
}
void main() {
  // AC places sky objects on a 500-unit camera-relative sphere before
  // applying the object's sky rotation.
  vec3 p = rotate(localPosition + vec3(0.0, 0.0, 0.0)) + skyOrigin;
  normal = normalize(rotate(localNormal));
  p.y = -p.y;
  normal.y = -normal.y;
  uv = textureUv + uvOffset;
  fragmentWorldPosition = p;
  // Sky geometry is rendered without depth testing and must not be clipped by
  // the world camera's far plane. Keep its projected X/Y, but place it at the
  // clip far plane so changing world render distance cannot move the skybox
  // horizon.
  vec4 clip = xWorld * vec4(p, 1.0);
  gl_Position = vec4(clip.xy, clip.w, clip.w);
}`;
