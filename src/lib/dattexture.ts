import type { ProcessedResourceTexture } from "./datprocessorprotocol";

export const BUILDING_TEXTURE_UNIT = 3;

export function uploadResourceTexture(
  gl: WebGL2RenderingContext,
  surface: ProcessedResourceTexture,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) {
    surface.bitmap?.close();
    throw new Error("Unable to create object texture");
  }

  const previousActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  gl.activeTexture(gl.TEXTURE0 + BUILDING_TEXTURE_UNIT);
  const previousTexture = gl.getParameter(
    gl.TEXTURE_BINDING_2D,
  ) as WebGLTexture | null;
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (surface.bitmap) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        surface.bitmap,
      );
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        surface.width,
        surface.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        surface.pixels ?? null,
      );
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
  } catch (error) {
    gl.deleteTexture(texture);
    throw error;
  } finally {
    surface.bitmap?.close();
    gl.bindTexture(gl.TEXTURE_2D, previousTexture);
    gl.activeTexture(previousActiveTexture);
  }
  return texture;
}
