import * as glhelpers from './glhelpers'
import { Matrix4, Vector3, Vector2 } from '@math.gl/core'

import { TextureArray } from './texturearray'
import { TerrainVertSource } from '../shaders/terrain.vert'
import { TerrainFragSource } from '../shaders/terrain.frag'

import { terrainColors } from '../data/terraincolors'
import { terrainTextures } from '../data/terraintextures'
import { camera2d } from './cameras/camera2d'
import { updateFrameRate } from '../tools/fpscounter'

export class TerrainRenderer {
  canvas: HTMLCanvasElement
  overlay: Element
  loader: Element
  gl: WebGL2RenderingContext
  quality: number

  vertexShader: WebGLShader | null = null
  fragmentShader: WebGLShader | null = null
  program: WebGLProgram | null = null

  #fps = 0

  #viewProjection: Matrix4 = new Matrix4()
  #world: Matrix4 = Matrix4.IDENTITY.clone()

  // uniform locations
  #xWorldLoc : WebGLUniformLocation | null = null;
  #scaleLoc : WebGLUniformLocation | null = null;
  #renderViewLoc : WebGLUniformLocation | null = null;
  #terrainDataLoc: WebGLUniformLocation | null = null;
  #terrainAtlasLoc: WebGLUniformLocation | null = null;

  #terrainTextureArray: TextureArray;
  hasTerrainTexture: number[] = []

  // ac data
  heightTable: number[] = []

  camera: camera2d
  mousePos = new Vector2()

  constructor(canvas: HTMLCanvasElement, overlay: Element, loader: Element, quality: number) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.loader = loader;
    this.gl = canvas.getContext("webgl2")!;
    this.quality = quality;
    this.camera = new camera2d(this.canvas)

    glhelpers.resizeCanvasToDisplaySize(canvas);

    if (!this.gl) {
      this.throwError("No Canvas / webgl2?");
    }

    this.setupGL()
    this.setupInputs()

    this.#makeDataTexture()
    this.#terrainTextureArray = new TextureArray(this.gl, terrainTextures, (idx) => {
      if (idx >= 0) {
        this.hasTerrainTexture[idx] = 1;
      }
    })

    if (canvas.height > canvas.width) {
      this.camera.Zoom = canvas.height / this.camera.MapSize.y
    }
    else {
      this.camera.Zoom = canvas.width / this.camera.MapSize.x
    }
    this.camera.CenterOnVec(this.camera.MapSize.clone().divide(new Vector3(2, 2, 1)))
  }

  setupInputs() {
    this.mousePos = new Vector2(0, 0);

    addEventListener("resize", () => {
      glhelpers.resizeCanvasToDisplaySize(this.canvas)
    })

    addEventListener("mousemove", (event) => {
      this.mousePos.x = event.clientX
      this.mousePos.y = event.clientY
    })
  }

  setupGL() {
    if (!this.#createShaders()) {
      this.throwError("Unable to create shaders!")
      return false;
    }
    
    if (!this.#createProgram()) {
      this.throwError("Unable to program!")
      return false;
    }

    this.#buildData();
    
    // Tell WebGL how to convert from clip space to pixels
    this.gl.viewport(0, 0, this.gl.canvas.width, this.gl.canvas.height);

    // Clear the canvas
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    // Tell it to use our program (pair of shaders)
    this.gl.useProgram(this.program);

    this.#xWorldLoc = this.gl.getUniformLocation(this.program!, 'xWorld');
    this.#scaleLoc = this.gl.getUniformLocation(this.program!, 'scale');
    this.#renderViewLoc = this.gl.getUniformLocation(this.program!, 'renderView');
    this.#terrainDataLoc = this.gl.getUniformLocation(this.program!, "terrainData");
    this.#terrainAtlasLoc = this.gl.getUniformLocation(this.program!, "terrainAtlas");
  }

  #makeDataTexture() {
    // Create a texture.
    var texture = this.gl.createTexture();

    // use texture unit 0
    this.gl.activeTexture(this.gl.TEXTURE0 + 0);

    // bind to the TEXTURE_2D bind point of texture unit 0
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);

    // Asynchronously load an image
    var image = new Image();
    image.src = "textures/terrain.png";

    const gl = this.gl;
    const $this = this;
    image.addEventListener('load', function() {
      // Now that the image has loaded make copy it to the texture.
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA,gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);

      $this.#onready()
    });
  }

  #onready() {
    document.body.classList.add('loaded')
  }

  #buildData() {
    for (var i = 0; i < 255; i++) {
      this.heightTable[i] = i * 2;
    }
    for (var i = 0; i < 32; i++) {
      this.hasTerrainTexture[i] = 0
    }
  }

  #createShaders() {
    this.vertexShader = glhelpers.createShader(this.gl, this.gl.VERTEX_SHADER, TerrainVertSource);
    this.fragmentShader = glhelpers.createShader(this.gl, this.gl.FRAGMENT_SHADER, TerrainFragSource);

    return (this.vertexShader && this.fragmentShader);
  }

  #createProgram() {
    this.program = glhelpers.createProgram(this.gl, this.vertexShader!, this.fragmentShader!);
    return !!this.program;
  }

  update(dt: number) {
    this.#fps = updateFrameRate()
    this.camera.ViewportSize.x = this.canvas.width;
    this.camera.ViewportSize.y = this.canvas.height;

    this.camera.update(dt);

    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    this.gl.uniform1i(this.#terrainDataLoc, 0);
    this.gl.uniform1i(this.#terrainAtlasLoc, 1);

    this.gl.uniform1f(this.#scaleLoc!, this.camera.Zoom);
    this.gl.uniformMatrix4fv(this.#xWorldLoc!, false, this.camera.Transform);
    this.gl.uniform4f(this.#renderViewLoc!, 0, 0, 255, 255);
    
    // TODO: put this in a 1d texture array?
    for (var i = 0; i < this.heightTable.length; i++) {
      const heightTableLoc = this.gl.getUniformLocation(this.program!, `heightTable[${i}]`);
      this.gl.uniform1f(heightTableLoc, this.heightTable[i]);
    }
    for (var i = 0; i < terrainColors.length; i++) {
      const terrainColorLoc = this.gl.getUniformLocation(this.program!, `terrainColors[${i}]`);
      this.gl.uniform3f(terrainColorLoc, terrainColors[i].x, terrainColors[i].y, terrainColors[i].z);
    }
    for (var i = 0; i < this.hasTerrainTexture.length; i++) {
      const hasTerrainTextureLoc = this.gl.getUniformLocation(this.program!, `hasTerrainTexture[${i}]`);
      this.gl.uniform1f(hasTerrainTextureLoc, this.hasTerrainTexture[i]);
    }

    this.overlay.innerHTML = `
    Coords: ${this.camera.ScreenToCoords(new Vector3(window.innerWidth / 2.0, window.innerHeight / 2.0, 0))}<br />
    FPS: ${this.#fps}<br />
    `;
  }

  draw(dt: number) {
    const numVerts = 8 * 8 * 2 * 3; // 8 cells per lb, 2 tris per cell
    const numInstances = 255 * 255; // one for each landblock

    this.gl.drawArraysInstanced(this.gl.TRIANGLES, 0, numVerts, numInstances);
  }

  throwError(message: string) {
    console.error(`Error: ${message}\n\nCheck console output for more details`);
  }
}