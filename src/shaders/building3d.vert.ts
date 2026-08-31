import { MAP_SIZE } from '../lib/worldgeometry'

export const Building3DVertSource = `#version 300 es
precision highp float;

layout(location = 0) in vec3 localPosition;
layout(location = 1) in vec3 localNormal;
layout(location = 2) in vec2 textureUv;
layout(location = 3) in vec3 instanceOrigin;
layout(location = 4) in vec4 instanceRotation;
layout(location = 5) in vec3 instanceScale;

uniform mat4 xWorld;

out vec2 uv;
out vec3 normal;

vec3 rotateByQuaternion(vec3 value, vec4 rotation) {
  return value + 2.0 * cross(rotation.xyz, cross(rotation.xyz, value) + rotation.w * value);
}

void main() {
  vec3 acPosition = instanceOrigin + rotateByQuaternion(localPosition * instanceScale, instanceRotation);
  vec3 worldPosition = vec3(acPosition.x, ${MAP_SIZE.toFixed(1)} - acPosition.y, acPosition.z);
  vec3 normalScale = vec3(
    abs(instanceScale.x) < 0.000001 ? 1.0 : instanceScale.x,
    abs(instanceScale.y) < 0.000001 ? 1.0 : instanceScale.y,
    abs(instanceScale.z) < 0.000001 ? 1.0 : instanceScale.z);
  vec3 acNormal = normalize(rotateByQuaternion(localNormal / normalScale, instanceRotation));
  normal = vec3(acNormal.x, -acNormal.y, acNormal.z);
  uv = textureUv;
  gl_Position = xWorld * vec4(worldPosition, 1.0);
}
`
