export const TerrainOverviewFragSource = `#version 300 es

precision highp float;
precision highp int;

uniform sampler2D terrainOverview;
in vec2 texturePosition;
out vec4 FragColor;

void main() {
  FragColor = texture(terrainOverview, texturePosition);
}
`;
