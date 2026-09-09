export const TextureArrayVertSource = `#version 300 es
const vec2 p[3] = vec2[3](vec2(-1, -1), vec2(3, -1), vec2(-1, 3));
out vec2 uv;
void main() {
  gl_Position = vec4(p[gl_VertexID], 0, 1);
  uv = p[gl_VertexID] * 0.5 + 0.5;
}`;
