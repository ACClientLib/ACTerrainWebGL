import { MAP_SIZE } from "../lib/worldgeometry";

export const TerrainOverviewVertSource = `#version 300 es

precision highp float;
precision highp int;

uniform mat4 xWorld;

out vec2 texturePosition;

void main() {
  int vertex = gl_VertexID % 6;
  texturePosition = vec2(0.0);
  if (vertex == 1 || vertex == 2 || vertex == 4)
    texturePosition.x = 1.0;
  if (vertex == 2 || vertex == 4 || vertex == 5)
    texturePosition.y = 1.0;

  gl_Position = xWorld * vec4(texturePosition * ${MAP_SIZE.toFixed(1)}, 0.0, 1.0);
}
`;
