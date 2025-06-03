import { Vector2, Vector3 } from "@math.gl/core";

export class TextureArray {
  imageSources: string[]
  gl: WebGL2RenderingContext
  texture: WebGLTexture | null
  textureUnit: number
  textureSize: Vector2
  textureWrap: number
  minFilter: number
  
  constructor(gl: WebGL2RenderingContext, imageSources: string[], textureSize: Vector2, textureUnit: number, textureWrap: number, minFilter: number) {
    this.imageSources = imageSources;
    this.gl = gl;
    this.textureUnit = textureUnit;
    this.textureSize = textureSize;
    this.textureWrap = textureWrap;
    this.minFilter = minFilter;

    this.texture = gl.createTexture()

    gl.activeTexture(gl.TEXTURE0 + this.textureUnit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);

    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 8, gl.RGBA8, textureSize.x, textureSize.y, imageSources.length);
  }

  load(cb: (idx: number)=>void) {
    let neededToLoad = this.imageSources.length;

    for (var i = 0; i < this.imageSources.length; i++) {
      const idx = i;
      const image = new Image();
      image.src = this.imageSources[idx];
  
      const gl = this.gl;
      const $this = this;
      image.addEventListener('load', function() {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, $this.texture);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, idx, $this.textureSize.x, $this.textureSize.y, 1, gl.RGBA, gl.UNSIGNED_BYTE, image);

        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, $this.textureWrap);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, $this.textureWrap);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, $this.minFilter);

        gl.generateMipmap(gl.TEXTURE_2D_ARRAY);

        cb(idx)
        if (--neededToLoad == 0) {
          cb(-1)
        }
      });
    }
  }
}