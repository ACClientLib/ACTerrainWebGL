export const PaletteFragSource = `#version 300 es
precision highp float;
precision highp usampler2D;
uniform usampler2D indexPlane;
uniform sampler2D palette;
out vec4 color;
void main() {
  uint index = texelFetch(indexPlane, ivec2(gl_FragCoord.xy), 0).r;
  color = texelFetch(palette, ivec2(int(index), 0), 0);
}`;
