import { Vector2 } from "@math.gl/core";

export class Texture {
  imageSource: string
  gl: WebGL2RenderingContext
  texture: WebGLTexture | null
  textureUnit: number
  textureSize: Vector2
  image: HTMLImageElement
  
  constructor(gl: WebGL2RenderingContext, imageSource: string, textureSize: Vector2, textureUnit: number) {
    this.imageSource = imageSource;
    this.gl = gl;
    this.textureUnit = textureUnit;
    this.textureSize = textureSize;
    
    this.texture = gl.createTexture()

    gl.activeTexture(gl.TEXTURE0 + this.textureUnit);
    gl.bindTexture(this.gl.TEXTURE_2D, this.texture);

    this.image = new Image(this.textureSize.x, this.textureSize.y);
    this.image.src = this.imageSource;
  }

  load(cb: ()=>void) {
    const gl = this.gl;
    const $this = this;
    this.image.addEventListener('load', function() {
      gl.bindTexture(gl.TEXTURE_2D, $this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA,gl.UNSIGNED_BYTE, $this.image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      cb();
    });
  }
}
