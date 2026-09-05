import { MAP_SIZE } from "../lib/worldgeometry";

export const ParticleVertSource = `#version 300 es
precision highp float;
layout(location=0) in vec2 quad;
layout(location=1) in vec3 center;
layout(location=2) in vec4 scaleOpacity;
layout(location=3) in vec3 dimensions;
layout(location=4) in vec4 planeOrientation;
layout(location=5) in vec4 rotation;
layout(location=6) in float billboard;
uniform mat4 xWorld;
uniform vec3 cameraRight;
uniform vec3 cameraUp;
uniform vec3 cameraPosition;
out vec2 uv;
out float opacity;
out vec3 fragmentWorldPosition;
vec3 qrot(vec3 v, vec4 q) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
vec3 constrainedBillboardOffset(vec3 local, vec4 orientation, int pinnedAxis, vec3 cameraToParticle) {
  float lengthSq = dot(cameraToParticle, cameraToParticle);
  if (lengthSq < 0.00000004) return qrot(local, orientation);
  vec3 heading = cameraToParticle / sqrt(lengthSq);
  vec3 axis = pinnedAxis == 0 ? vec3(1.0, 0.0, 0.0) : pinnedAxis == 1 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  vec3 pinned = qrot(axis, orientation);
  vec3 normal = heading - pinned * dot(pinned, heading);
  float normalSq = dot(normal, normal);
  if (normalSq < 0.00000004) return qrot(local, orientation);
  normal /= sqrt(normalSq);
  vec3 other = cross(normal, pinned);
  vec3 x = pinnedAxis == 0 ? pinned : pinnedAxis == 1 ? normal : other;
  vec3 y = pinnedAxis == 0 ? other : pinnedAxis == 1 ? pinned : normal;
  vec3 z = pinnedAxis == 0 ? normal : pinnedAxis == 1 ? other : pinned;
  return local.x * x + local.y * y + local.z * z;
}
void main() {
  uv = quad * 0.5 + 0.5; opacity = scaleOpacity.y;
  // The uploaded quad vertices span [-1, 1]. Dimensions are full extents,
  // so halve them here to match the authored GfxObj bounds.
  vec3 local = vec3(quad.x * dimensions.x, 0.0, quad.y * dimensions.z) * (0.5 * scaleOpacity.x);
  vec3 orientedLocal = qrot(local, planeOrientation);
  vec3 offset;
  if (billboard == 1.0) offset = cameraRight * local.x + cameraUp * local.z;
  else if (billboard >= 2.5) offset = constrainedBillboardOffset(orientedLocal, rotation, int(billboard) - 3, center - cameraPosition);
  else offset = qrot(orientedLocal, rotation);
  vec3 p = center + offset;
  fragmentWorldPosition = vec3(p.x, ${MAP_SIZE.toFixed(1)} - p.y, p.z);
  gl_Position = xWorld * vec4(fragmentWorldPosition, 1.0);
}`;
