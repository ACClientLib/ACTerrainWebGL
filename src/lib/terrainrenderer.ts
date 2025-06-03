import * as glhelpers from './glhelpers'
import { Matrix4, Vector3, Vector2 } from '@math.gl/core'

import { TextureArray } from './texturearray'
import { TerrainVertSource } from '../shaders/terrain.vert'
import { TerrainFragSource } from '../shaders/terrain.frag'

import * as settings from '../settings'
import { terrainTextures, alphaTextures, terrainColors } from '../data/terrain'
import { CameraMode } from './cameras/cameramode'
import { Camera2D } from './cameras/camera2d'
import { BaseCamera } from './cameras/basecamera'
import { CameraFlying } from './cameras/cameryflying'
import gui from './gui'
import { updateFrameRate } from '../tools/fpscounter'
import * as codes from '../tools/codes'
import { Texture } from './texture'

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

  // uniform locations
  #xWorldLoc : WebGLUniformLocation | null = null
  #scaleLoc : WebGLUniformLocation | null = null
  #renderViewLoc : WebGLUniformLocation | null = null
  #terrainDataLoc: WebGLUniformLocation | null = null
  #terrainAtlasLoc: WebGLUniformLocation | null = null
  #alphaAtlasLoc: WebGLUniformLocation | null = null
  #minZoomForTexturesLoc: WebGLUniformLocation | null = null
  #showLandcellLinesLoc: WebGLUniformLocation | null = null
  #showLandblockLinesLoc: WebGLUniformLocation | null = null
  #pixelSizeLoc: WebGLUniformLocation | null = null
  #cameraMode: WebGLUniformLocation | null = null
  #renderView: WebGLUniformLocation | null = null

  #dataTexture!: Texture
  #terrainTextureArray!: TextureArray
  #alphaTextureArray!: TextureArray

  hasTerrainTexture: number[] = []

  // ac data
  heightTable: number[] = []

  // Camera system
  camera2D: Camera2D
  flyingCamera: CameraFlying
  currentCamera: BaseCamera
  currentCameraMode: CameraMode = CameraMode.Camera2D
  
  mousePos = new Vector2()

  constructor(canvas: HTMLCanvasElement, overlay: Element, loader: Element, quality: number) {
    this.canvas = canvas
    this.overlay = overlay
    this.loader = loader
    this.gl = canvas.getContext("webgl2")!
    this.quality = quality
    
    // Initialize both cameras
    this.camera2D = new Camera2D(this.canvas, this)
    this.flyingCamera = new CameraFlying(this.canvas, this)
    this.currentCamera = this.camera2D

    this.#handleResize()

    if (!this.gl) {
      this.throwError("No Canvas / webgl2?")
    }

    this.#addSettings()
    this.#setupGL()
    this.#setupInputs()

    this.#makeTextures()

    this.#setConstantUniforms()

    // Initialize 2D camera setup
    this.#initialize2DCamera()
    
    // Initialize flying camera setup
    this.#initializeFlyingCamera()
  }

  #initialize2DCamera() {
    // resize map to fit
    if (this.canvas.height > this.canvas.width) {
      this.camera2D.Zoom = this.canvas.height / this.camera2D.MapSize.y
    }
    else {
      this.camera2D.Zoom = this.canvas.width / this.camera2D.MapSize.x
    }

    // center map
    this.camera2D.CenterOnVec(this.camera2D.MapSize.clone().divide(new Vector3(2, 2, 1)))
  }

  #initializeFlyingCamera() {
    // Position flying camera above the center of the map at a reasonable height
    const mapCenter = this.camera2D.MapSize.clone().divide(new Vector3(2, 2, 1))
    this.flyingCamera.Position = new Vector3(mapCenter.x, mapCenter.y, 500) // Y is up in 3D
    
    // Look down at the map initially
    this.flyingCamera.SetRotation(0, -Math.PI / 4, 0) // Look down at 45 degrees
    
    // Set reasonable movement speed based on map size
    this.flyingCamera.MoveSpeed = Math.max(this.camera2D.MapSize.x, this.camera2D.MapSize.y) * 0.01
  }

  #addSettings() {
    gui.add(settings.data, settings.labels.renderQuality, settings.data.minRenderQuality, settings.data.maxRenderQuality, 1)
      .onChange(() => {
        this.#handleResize()
      })
    gui.add(settings.data, settings.labels.badWireframe)
    gui.add(settings.data, settings.labels.showLandblockLines)
    gui.add(settings.data, settings.labels.showLandcellLines)
    gui.add(settings.data, settings.labels.minZoomForTextures, 0.0001, 5, 0.005)
    
    // Add camera switching control
    const cameraController = {
      cameraMode: CameraMode.Camera2D,
      switchTo2D: () => this.switchCamera(CameraMode.Camera2D),
      switchToFlying: () => this.switchCamera(CameraMode.Flying),
      resetFlyingCamera: () => this.#initializeFlyingCamera()
    }
    
    gui.add(cameraController, 'switchTo2D').name('Switch to 2D')
    gui.add(cameraController, 'switchToFlying').name('Switch to Flying')
    gui.add(cameraController, 'resetFlyingCamera').name('Reset Flying Cam')
    
    // Flying camera specific controls
    const flyingControls = gui.addFolder('Flying Camera')
    flyingControls.add(this.flyingCamera, 'MoveSpeed', 1, 1000).name('Move Speed')
    flyingControls.add(this.flyingCamera, 'FOV', 30, 120).name('Field of View')
  }

  switchCamera(mode: CameraMode) {
    if (mode === this.currentCameraMode) return

    const oldMode = this.currentCameraMode
    this.currentCameraMode = mode

    if (mode === CameraMode.Camera2D) {
      // Switching to 2D camera
      this.currentCamera = this.camera2D
      
      // Try to preserve some context - position the 2D camera based on flying camera position
      if (oldMode === CameraMode.Flying) {
        const flyingPos = this.flyingCamera.Position
        // Convert 3D position to 2D position (Y becomes Z, ignore original Z)
        const pos2D = new Vector3(flyingPos.x, flyingPos.z, 1)
        this.camera2D.CenterOnVec(pos2D)
        
        // Set zoom based on height - higher = more zoomed out
        const heightFactor = Math.max(0.01, Math.min(2, flyingPos.y / 1000))
        this.camera2D.Zoom = this.camera2D.Zoom / heightFactor
      }
      
      console.log('Switched to 2D Camera')
    } 
    else if (mode === CameraMode.Flying) {
      // Switching to flying camera
      this.currentCamera = this.flyingCamera
      
      // Try to preserve context - position flying camera based on 2D camera
      if (oldMode === CameraMode.Camera2D) {
        const pos2D = this.camera2D.Position
        // Convert 2D position to 3D (Z becomes Y, add reasonable height)
        const height = Math.max(100, 1000 / this.camera2D.Zoom) // Higher when zoomed out
        this.flyingCamera.Position = new Vector3(pos2D.x, height, pos2D.y)
        
        // Look down towards the terrain
        this.flyingCamera.SetRotation(0, -Math.PI / 6, 0)
      }
      
      console.log('Switched to Flying Camera')
      console.log('Controls: WASD to move, Mouse to look, Space/Shift for up/down, Q/E to roll')
    }

    // Update viewport size for new camera
    this.currentCamera.ViewportSize.x = this.canvas.width
    this.currentCamera.ViewportSize.y = this.canvas.height
  }

  #setupInputs() {
    this.mousePos = new Vector2(0, 0);

    addEventListener("resize", () => {
      this.#handleResize()
    })

    addEventListener("mousemove", (event) => {
      this.mousePos.x = event.clientX
      this.mousePos.y = event.clientY
    })

    // Add keyboard shortcut for quick camera switching
    addEventListener("keydown", (event) => {
      if (event.key === 'c' || event.key === 'C') {
        const newMode = this.currentCameraMode === CameraMode.Camera2D ? 
          CameraMode.Flying : CameraMode.Camera2D
        this.switchCamera(newMode)
      }
    })

    codes.setupCodes()
    codes.addCode('idkfa', () => {
      console.log('idkfa')
    });
    
    // Add camera-related cheat codes
    codes.addCode('cam2d', () => {
      this.switchCamera(CameraMode.Camera2D)
    })
    
    codes.addCode('cam3d', () => {
      this.switchCamera(CameraMode.Flying)
    })
    
    codes.addCode('fly', () => {
      this.switchCamera(CameraMode.Flying)
    })
  }

  #setupGL() {
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

    // Tell it to use our program (pair of shaders)
    this.gl.useProgram(this.program);

    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);

    this.#xWorldLoc = this.gl.getUniformLocation(this.program!, 'xWorld');
    this.#scaleLoc = this.gl.getUniformLocation(this.program!, 'scale');
    this.#renderViewLoc = this.gl.getUniformLocation(this.program!, 'renderView');
    this.#terrainDataLoc = this.gl.getUniformLocation(this.program!, "terrainData");
    this.#terrainAtlasLoc = this.gl.getUniformLocation(this.program!, "terrainAtlas");
    this.#alphaAtlasLoc = this.gl.getUniformLocation(this.program!, "alphaAtlas");
    this.#minZoomForTexturesLoc = this.gl.getUniformLocation(this.program!, 'minZoomForTextures');
    this.#showLandcellLinesLoc = this.gl.getUniformLocation(this.program!, 'showLandcellLines');
    this.#showLandblockLinesLoc = this.gl.getUniformLocation(this.program!, 'showLandblockLines');
    this.#pixelSizeLoc = this.gl.getUniformLocation(this.program!, 'pixelSize');
    this.#cameraMode = this.gl.getUniformLocation(this.program!, 'cameraMode');
    this.#renderView = this.gl.getUniformLocation(this.program!, 'renderView');
  }

  #setConstantUniforms() {
    for (var i = 0; i < this.heightTable.length; i++) {
      const heightTableLoc = this.gl.getUniformLocation(this.program!, `heightTable[${i}]`);
      this.gl.uniform1f(heightTableLoc, this.heightTable[i]);
    }
    for (var i = 0; i < terrainColors.length; i++) {
      const terrainColorLoc = this.gl.getUniformLocation(this.program!, `terrainColors[${i}]`);
      this.gl.uniform3f(terrainColorLoc, terrainColors[i].x, terrainColors[i].y, terrainColors[i].z);
    }

    this.gl.uniform1i(this.#terrainDataLoc, this.#dataTexture.textureUnit);
    this.gl.uniform1i(this.#terrainAtlasLoc, this.#terrainTextureArray.textureUnit);
    this.gl.uniform1i(this.#alphaAtlasLoc, this.#alphaTextureArray.textureUnit);
  }

  #makeTextures() {
    this.#terrainTextureArray = new TextureArray(this.gl, terrainTextures, new Vector2(512, 512), 1, this.gl.REPEAT, this.gl.NEAREST_MIPMAP_NEAREST),
    this.#alphaTextureArray = new TextureArray(this.gl, alphaTextures, new Vector2(512, 512), 2, this.gl.REPEAT, this.gl.NEAREST_MIPMAP_NEAREST)

    this.#dataTexture = new Texture(this.gl, "textures/terrain.png", new Vector2(2041, 2041), 0)
    this.#dataTexture.load(() => {
      this.#onready()
    })
  }

  #onready() {
    this.#handleResize()
    document.body.classList.add('loaded')

    this.#alphaTextureArray.load((idx) => {
      if (idx < 0) {
        this.#terrainTextureArray.load((idx) => {
          if (idx >= 0) {
            this.hasTerrainTexture[idx] = 1;
          }
        })
      }
    });
  }

  #handleResize() {
    glhelpers.resizeCanvasToDisplaySize(this.canvas, settings.data.maxRenderQuality + 1 - settings.data.renderQuality)
    
    // Update viewport size for both cameras
    this.camera2D.ViewportSize.x = this.canvas.width
    this.camera2D.ViewportSize.y = this.canvas.height
    this.flyingCamera.ViewportSize.x = this.canvas.width
    this.flyingCamera.ViewportSize.y = this.canvas.height
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
    
    // Update current camera's viewport size
    this.currentCamera.ViewportSize.x = this.canvas.width;
    this.currentCamera.ViewportSize.y = this.canvas.height;

    // Update the current camera
    this.currentCamera.update(dt);

    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    // Clear the canvas
    this.gl.clearColor(29/255, 34/255, 60/255, 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    // Set uniforms based on camera type
    this.#setUniforms();

    // Update overlay with current camera info
    this.#updateOverlay();
  }

  #setUniforms() {
    this.gl.uniformMatrix4fv(this.#xWorldLoc!, false, this.currentCamera.Transform);
    this.gl.uniform1f(this.#minZoomForTexturesLoc!, settings.data.minZoomForTextures);
    this.gl.uniform1f(this.#showLandcellLinesLoc, settings.data.showLandcellLines ? 1.0 : 0.0)
    this.gl.uniform1f(this.#showLandblockLinesLoc, settings.data.showLandblockLines ? 1.0 : 0.0)
    if (this.currentCameraMode === CameraMode.Camera2D) {
      // 2D camera specific uniforms
      const camera2D = this.currentCamera as Camera2D
      this.gl.uniform1f(this.#scaleLoc!, camera2D.Zoom);
      
      const pixelSize = ((this.canvas.width > this.canvas.height ? this.canvas.width : this.canvas.height) / camera2D.MapSize.x) / camera2D.Zoom;
      this.gl.uniform1f(this.#pixelSizeLoc, pixelSize);
      this.gl.uniform1i(this.#cameraMode, 0);

      // TODO: we can use this to clip the rendered area
      this.gl.uniform4f(this.#renderViewLoc!, 0, 0, 255, 255);
    } else {
      // Flying camera specific uniforms
      this.gl.uniform1f(this.#scaleLoc!, 1.0); 
      this.gl.uniform1f(this.#pixelSizeLoc, 1.0);
      this.gl.uniform1i(this.#cameraMode, 1);console.log(this.currentCamera.Transform.toString());
    }

    // Set terrain texture availability
    for (var i = 0; i < this.hasTerrainTexture.length; i++) {
      const hasTerrainTextureLoc = this.gl.getUniformLocation(this.program!, `hasTerrainTexture[${i}]`);
      this.gl.uniform1f(hasTerrainTextureLoc, this.hasTerrainTexture[i]);
    }
  }

  #updateOverlay() {
    let coordsInfo = '';
    let cameraInfo = '';
    
    if (this.currentCameraMode === CameraMode.Camera2D) {
      const camera2D = this.currentCamera as Camera2D
      coordsInfo = `Coords: ${camera2D.ScreenToCoords(new Vector3(this.mousePos.x / settings.data.renderScale, this.mousePos.y / settings.data.renderScale, 1))}`
      cameraInfo = `Camera: 2D | Zoom: ${camera2D.Zoom.toFixed(4)} | Pos: (${camera2D.Position.x.toFixed(1)}, ${camera2D.Position.y.toFixed(1)})`
    } else {
      const flyingCam = this.currentCamera as CameraFlying
      const pos = flyingCam.Position
      const yaw = (flyingCam.Yaw * 180 / Math.PI).toFixed(1)
      const pitch = (flyingCam.Pitch * 180 / Math.PI).toFixed(1)
      
      coordsInfo = `3D Position: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`
      cameraInfo = `Camera: Flying | Yaw: ${yaw}° | Pitch: ${pitch}° | Speed: ${flyingCam.MoveSpeed.toFixed(1)}`
    }

    this.overlay.innerHTML = `
    ${coordsInfo}<br />
    ${cameraInfo}<br />
    FPS: ${this.#fps}<br />
    <small>Press 'C' to switch cameras</small>
    `;
  }

  draw(dt: number) {
    const numVerts = 8 * 8 * 2 * 3; // 8 cells per lb, 2 tris per cell
    const numInstances = 255 * 255; // one for each landblock

    if (settings.data.badWireframe) {
      this.gl.drawArraysInstanced(this.gl.LINE_STRIP, 0, numVerts, numInstances);
    }
    else {
      this.gl.drawArraysInstanced(this.gl.TRIANGLES, 0, numVerts, numInstances);
    }
  }

  throwError(message: string) {
    console.error(`Error: ${message}\n\nCheck console output for more details`);
  }

  // Utility methods for external access
  get currentCameraType(): CameraMode {
    return this.currentCameraMode
  }

  getCamera2D(): Camera2D {
    return this.camera2D
  }

  getFlyingCamera(): CameraFlying {
    return this.flyingCamera
  }

  getCurrentCamera(): BaseCamera {
    return this.currentCamera
  }
}