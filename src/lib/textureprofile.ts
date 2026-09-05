import { TEXTURE_PROFILE, type TextureProfile } from "./formatcontract";
import { data } from "../settings";

export interface TextureExtensions {
  s3tc: WEBGL_compressed_texture_s3tc | null;
  etc: WEBGL_compressed_texture_etc | null;
}

export interface TextureCapabilities {
  profile: TextureProfile;
  extensions: TextureExtensions;
}

const capabilities = new WeakMap<WebGL2RenderingContext, TextureCapabilities>();

export function selectTextureProfile(
  gl: WebGL2RenderingContext,
): TextureCapabilities {
  const existing = capabilities.get(gl);
  if (existing) return existing;
  const s3tc = gl.getExtension("WEBGL_compressed_texture_s3tc");
  const etc = gl.getExtension("WEBGL_compressed_texture_etc");
  const automaticProfile = s3tc
    ? TEXTURE_PROFILE.bc
    : etc
      ? TEXTURE_PROFILE.etc2
      : TEXTURE_PROFILE.rgba8;
  const profile = data.textureProfile === "auto"
    ? automaticProfile
    : data.textureProfile;
  const result = {
    profile,
    extensions: { s3tc, etc },
  } satisfies TextureCapabilities;
  capabilities.set(gl, result);
  return result;
}
