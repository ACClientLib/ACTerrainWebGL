export const ParticleFragSource = `#version 300 es
precision highp float;
uniform sampler2D particleTexture;
uniform int alphaMode;
uniform float alphaCutoff;
uniform int renderPass;
uniform float materialOpacity;
uniform vec3 cameraPosition; uniform vec3 fogColor; uniform float fogStart; uniform float fogEnd; uniform int fogEnabled;
in vec2 uv; in float opacity; in vec3 fragmentWorldPosition;
layout(location = 0) out vec4 outColor;
layout(location = 1) out float outRevealage;
void main() { vec4 color = texture(particleTexture, uv); color.a *= opacity * materialOpacity; if (alphaMode == 1 ? color.a < alphaCutoff : color.a <= 0.0) discard; if (fogEnabled != 0) { float fogFactor = clamp((length(fragmentWorldPosition - cameraPosition) - fogStart) / max(fogEnd - fogStart, 0.0001), 0.0, 1.0); color.rgb = mix(color.rgb, fogColor, fogFactor); } if (renderPass == 2) { outColor = vec4(color.a); outRevealage = color.a; return; } if (renderPass == 1) { outColor = vec4(color.rgb * color.a, color.a); outRevealage = 1.0; return; } if (alphaMode == 2 && renderPass == 0) { float weight = clamp(pow(max(color.a, 0.0001), 0.5) * 8.0, 0.01, 8.0); outColor = vec4(color.rgb * color.a * weight, color.a * weight); outRevealage = color.a; } else { outColor = color; outRevealage = 1.0; } }`;
