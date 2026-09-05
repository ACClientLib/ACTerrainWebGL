export const ScenePresentFragSource = `#version 300 es
precision highp float;

uniform sampler2D sceneTexture;
in vec2 uv;
out vec4 color;

void main() {
  vec4 scene = texture(sceneTexture, uv);
  color = scene;
}
`;
