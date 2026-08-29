export const BuildingsVertSource = `#version 300 es

precision highp float;

uniform mat4 xWorld;
layout(location = 0) in vec2 position;

void main() {
  gl_Position = xWorld * vec4(position, 0.0, 1.0);
}
`;
