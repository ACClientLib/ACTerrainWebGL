export const TextureArrayFragSource = `#version 300 es
precision highp float;
uniform sampler2D source;
in vec2 uv;
out vec4 color;
void main() {
  color = texture(source, uv);
}`;
