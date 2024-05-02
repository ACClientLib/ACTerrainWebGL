import { Vector3 } from "@math.gl/core";

export class TextureArray {
  constructor(gl: WebGL2RenderingContext, imageSources: string[], cb: (idx: number)=>undefined) {
    const texture = gl.createTexture();

    gl.activeTexture(gl.TEXTURE0 + 1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);

    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 8, gl.RGBA8, 512, 512, imageSources.length);

    let neededToLoad = imageSources.length;

    for (var i = 0; i < imageSources.length; i++) {
      const idx = i;
      const image = new Image();
      image.src = imageSources[idx];
  
      image.addEventListener('load', function() {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, idx, 512, 512, 1, gl.RGBA, gl.UNSIGNED_BYTE, image);

        gl.generateMipmap(gl.TEXTURE_2D_ARRAY);

        cb(idx)
        if (--neededToLoad) {
          cb(-1)
        }
      });
    }
  }
}