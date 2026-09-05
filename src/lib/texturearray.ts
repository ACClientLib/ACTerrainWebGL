import { Vector2 } from "@math.gl/core";

export class TextureArray {
  layerCount: number;
  gl: WebGL2RenderingContext;
  texture: WebGLTexture | null;
  textureUnit: number;
  textureSize: Vector2;
  textureWrap: number;
  minFilter: number;

  constructor(
    gl: WebGL2RenderingContext,
    layerCount: number,
    textureSize: Vector2,
    textureUnit: number,
    textureWrap: number,
    minFilter: number,
  ) {
    this.layerCount = layerCount;
    this.gl = gl;
    this.textureUnit = textureUnit;
    this.textureSize = textureSize;
    this.textureWrap = textureWrap;
    this.minFilter = minFilter;

    this.texture = gl.createTexture();

    gl.activeTexture(gl.TEXTURE0 + this.textureUnit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);

    const mipLevels =
      Math.floor(Math.log2(Math.max(textureSize.x, textureSize.y))) + 1;
    gl.texStorage3D(
      gl.TEXTURE_2D_ARRAY,
      mipLevels,
      gl.RGBA8,
      textureSize.x,
      textureSize.y,
      layerCount,
    );
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, this.textureWrap);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, this.textureWrap);
    gl.texParameteri(
      gl.TEXTURE_2D_ARRAY,
      gl.TEXTURE_MIN_FILTER,
      this.minFilter,
    );
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  load(textures: WebGLTexture[], cb: (idx: number) => void) {
    if (textures.length !== this.layerCount)
      throw new Error("Texture array layer count mismatch");
    const gl = this.gl;
    const vertex = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(
      vertex,
      "#version 300 es\nconst vec2 p[3]=vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3)); out vec2 uv; void main(){gl_Position=vec4(p[gl_VertexID],0,1);uv=p[gl_VertexID]*.5+.5;}",
    );
    gl.compileShader(vertex);
    const fragment = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(
      fragment,
      "#version 300 es\nprecision highp float; uniform sampler2D source; in vec2 uv; out vec4 color; void main(){color=texture(source,uv);}",
    );
    gl.compileShader(fragment);
    const program = gl.createProgram()!;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(
        gl.getProgramInfoLog(program) || "Texture array copy shader failed",
      );
    const framebuffer = gl.createFramebuffer();
    const vao = gl.createVertexArray();
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "source"), 0);
    gl.bindVertexArray(vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, this.textureSize.x, this.textureSize.y);
    for (let index = 0; index < textures.length; index++) {
      const texture = textures[index];
      gl.framebufferTextureLayer(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        this.texture,
        0,
        index,
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error("Unable to populate texture array");
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      cb(index);
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    cb(-1);
  }
}
