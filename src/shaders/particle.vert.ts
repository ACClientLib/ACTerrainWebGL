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
out vec2 uv;
out float opacity;
vec3 qrot(vec3 v, vec4 q) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() {
  uv = quad * 0.5 + 0.5; opacity = scaleOpacity.y;
  vec3 local = vec3(quad.x * dimensions.x, 0.0, quad.y * dimensions.z) * scaleOpacity.x;
  vec3 offset = billboard > 0.5 ? cameraRight * local.x + cameraUp * local.z : qrot(qrot(local, planeOrientation), rotation);
  vec3 p = center + offset;
  gl_Position = xWorld * vec4(p.x, ${MAP_SIZE.toFixed(1)} - p.y, p.z, 1.0);
}`;
