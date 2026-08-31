export const ParticleFragSource = `#version 300 es
precision highp float;
uniform sampler2D particleTexture;
uniform float materialOpacity;
in vec2 uv; in float opacity; out vec4 outColor;
void main() { vec4 color = texture(particleTexture, uv); color.a *= opacity * materialOpacity; if (color.a < 0.005) discard; outColor = color; }`
