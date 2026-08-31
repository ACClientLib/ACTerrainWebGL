import * as glhelpers from './glhelpers'
import { Matrix4, Vector3, Vector2 } from '@math.gl/core'

import { TextureArray } from './texturearray'
import { TerrainVertSource } from '../shaders/terrain.vert'
import { TerrainFragSource } from '../shaders/terrain.frag'

import * as settings from '../settings'
import { terrainTextures, alphaTextures, terrainColors } from '../data/terrain'
import { terrainHeightTable } from '../data/heighttable'
import { CameraMode } from './cameras/cameramode'
import { Camera2D } from './cameras/camera2d'
import { BaseCamera } from './cameras/basecamera'
import { CameraFlying } from './cameras/cameryflying'
import { CameraRoute } from './router'
import gui from './gui'
import { getFrameStats, recordCpuFrameTime, recordGpuFrameTime, updateFrameRate } from '../tools/fpscounter'
import * as codes from '../tools/codes'
import { Texture } from './texture'
import { WorldObjectRenderer } from './worldobjectrenderer'
import { SceneryAddonClient } from './sceneryaddonclient'
import { SceneryRenderer } from './sceneryrenderer'
import type { LoadingTimingSnapshot } from './loadingprofiler'
import {
  LAND_BLOCK_SIDE,
  LAND_BLOCK_SIZE,
  MAP_SIZE,
  MAX_TERRAIN_HEIGHT,
  MAX_LAND_BLOCK_INDEX,
  TERRAIN_CELLS_PER_LAND_BLOCK,
  TERRAIN_DATA_SIDE
} from './worldgeometry'

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
  #frameStart = 0
  #lastOverlayUpdate = 0
  #gpuTimerExtension: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null
  #gpuQuery: WebGLQuery | null = null
  #gpuQueryActive = false

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
  #heightTableLoc: WebGLUniformLocation | null = null
  #terrainColorsLoc: WebGLUniformLocation | null = null
  #hasTerrainTextureLoc: WebGLUniformLocation | null = null
  #terrainVao: WebGLVertexArrayObject | null = null
  #terrainInstanceBuffer: WebGLBuffer | null = null
  #terrainInstanceCapacity = 0
  #objects!: WorldObjectRenderer
  #scenery = new SceneryAddonClient()
  #sceneryRenderer!: SceneryRenderer
  #moveSpeedController: any

  #dataTexture!: Texture
  #terrainHeightData: Uint8ClampedArray | null = null
  #terrainTextureArray!: TextureArray
  #alphaTextureArray!: TextureArray

  hasTerrainTexture: number[] = []
  #hasTerrainTextureDirty = true
  #visibleLandblockCount = LAND_BLOCK_SIDE * LAND_BLOCK_SIDE

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

    this.#gpuTimerExtension = this.gl.getExtension('EXT_disjoint_timer_query_webgl2')

    this.#objects = new WorldObjectRenderer(this.gl)
    this.#sceneryRenderer = new SceneryRenderer(this.gl, this.#scenery)
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
    // Both cameras use map X/Y. The flying camera adds AC elevation on Z.
    const mapCenter = this.camera2D.MapSize.clone().divide(new Vector3(2, 2, 1))
    this.flyingCamera.Position = new Vector3(mapCenter.x, mapCenter.y, MAX_TERRAIN_HEIGHT + 500)
    
    // Look down at the map initially
    this.flyingCamera.SetRotation(Math.PI, -Math.PI / 4, 0) // Look down at 45 degrees with north at the top
    
    this.flyingCamera.MoveSpeed = 25
  }

  #addSettings() {
    gui.add(settings.data, settings.labels.showLandblockLines)
    gui.add(settings.data, settings.labels.showLandcellLines)
    gui.add(settings.data, settings.labels.showDebug).name('Show Debug Info')
    gui.add(settings.data, settings.labels.showObjects).name('Show 3D Objects')
    gui.add(settings.data, settings.labels.showServerSpawns).name('Show Server Spawns')
    gui.add(settings.data, settings.labels.showParticles).name('Show Particles')
    gui.add(settings.data, settings.labels.sceneryEnabled).name('Enable Scenery')
      .onChange((enabled: boolean) => { if (!enabled) this.#sceneryRenderer.clear(); else void this.#loadScenery() })
    gui.add(settings.data, settings.labels.minZoomFor3DObjects, 0.05, 5, 0.05).name('3D Object Zoom')
    gui.add({
      clearDatCache: () => this.#objects.clearCache()
        .then(() => this.#scenery.clearCache())
        .then(() => this.#sceneryRenderer.clear())
        .then(() => console.log('ACTerrain resource cache cleared'))
        .catch(error => console.error('Unable to clear ACTerrain resource cache', error))
    }, 'clearDatCache').name('Clear DAT Cache')
    
    // Add camera switching control
    const cameraController = {
      toggleCamera: () => this.switchCamera(
        this.currentCameraMode === CameraMode.Camera2D ? CameraMode.Flying : CameraMode.Camera2D),
      resetFlyingCamera: () => this.#initializeFlyingCamera()
    }
    
    gui.add(cameraController, 'toggleCamera').name('Switch Camera')
    gui.add(cameraController, 'resetFlyingCamera').name('Reset Flying Cam')
    
    // Flying camera specific controls
    const flyingControls = gui.addFolder('Flying Camera')
    flyingControls.add(this.#objects, 'loadDistance', 1, 32, 1).name('3D Object Load Distance')
    this.#moveSpeedController = flyingControls.add(this.flyingCamera, 'MoveSpeed', 0.1, 400).name('Move Speed')
    flyingControls.add(this.flyingCamera, 'FOV', 30, 120).name('Field of View')
  }

  updateFlyingCameraControls(): void {
    this.#moveSpeedController?.updateDisplay()
  }

  switchCamera(mode: CameraMode) {
    if (mode === this.currentCameraMode) return

    const oldMode = this.currentCameraMode
    const flyingMapPosition = oldMode === CameraMode.Flying
      ? this.flyingCamera.GetMapPosition()
      : null
    this.currentCameraMode = mode

    if (mode === CameraMode.Camera2D) {
      // Switching to 2D camera
      this.currentCamera = this.camera2D
      
      // Preserve the map location currently under the 3D camera's view.
      if (oldMode === CameraMode.Flying) {
        // Keep the map location currently under the center of the 3D view.
        const pos2D = new Vector3(flyingMapPosition!.x, flyingMapPosition!.y, 1)
        this.camera2D.CenterOnVec(pos2D)
        
        const terrainHeight = this.getTerrainHeightAt(this.flyingCamera.Position.x, this.flyingCamera.Position.y)
        const zoom = this.zoomForFlyingView(terrainHeight)
        this.camera2D.Zoom = this.capCameraZoom(zoom)
      }
      
    } 
    else if (mode === CameraMode.Flying) {
      // Switching to flying camera
      this.currentCamera = this.flyingCamera
      
      // Try to preserve context - position flying camera based on 2D camera
      if (oldMode === CameraMode.Camera2D) {
        const pos2D = this.camera2D.Position
        // Look down towards the terrain
        this.flyingCamera.SetRotation(Math.PI, -Math.PI / 2, 0)

        const topLeft = this.camera2D.ScreenToWorld(new Vector3(0, 0, 1))
        const bottomRight = this.camera2D.ScreenToWorld(
          new Vector3(this.canvas.width, this.canvas.height, 1))
        const targetWidth = Math.abs(bottomRight.x - topLeft.x)
        const targetHeight = Math.abs(bottomRight.y - topLeft.y)
        const terrainHeight = this.getTerrainHeightAt(pos2D.x, pos2D.y)
        const height = this.flyingHeightForViewport(targetWidth, targetHeight)
        this.flyingCamera.Position = new Vector3(pos2D.x, pos2D.y, terrainHeight + height)
      }
      
    }

    // Update viewport size for new camera
    this.currentCamera.ViewportSize.x = this.canvas.width
    this.currentCamera.ViewportSize.y = this.canvas.height
  }

  restoreCameraRoute(route: CameraRoute) {
    if (route.mode === "2d") {
      this.camera2D.Position = new Vector3(route.position.x, route.position.y, route.position.z)
      this.camera2D.Zoom = route.zoom!
      this.currentCameraMode = CameraMode.Camera2D
      this.currentCamera = this.camera2D
      return
    }

    this.flyingCamera.Position = new Vector3(route.position.x, route.position.y, route.position.z)
    this.flyingCamera.SetRotation(route.yaw!, route.pitch!, route.roll!)
    this.flyingCamera.FOV = route.fov!
    this.currentCameraMode = CameraMode.Flying
    this.currentCamera = this.flyingCamera
  }

  private capCameraZoom(zoom: number) {
    return Math.max(settings.data.minZoom, Math.min(settings.data.maxZoom, zoom))
  }

  private flyingHeightForZoom(zoom: number) {
    const verticalFieldOfView = this.flyingCamera.FOV * Math.PI / 180
    const visibleWorldHeight = this.canvas.height * settings.data.renderScale / zoom
    return visibleWorldHeight / (2 * Math.tan(verticalFieldOfView / 2))
  }

  private zoomForFlyingHeight(height: number) {
    const verticalFieldOfView = this.flyingCamera.FOV * Math.PI / 180
    return this.canvas.height * settings.data.renderScale /
      (2 * Math.max(1, height) * Math.tan(verticalFieldOfView / 2))
  }

  private zoomForFlyingView(groundHeight: number) {
    const groundPoints = this.flyingGroundFootprint(groundHeight)

    if (groundPoints.length < 2) {
      return this.zoomForFlyingHeight(
        this.flyingCamera.Position.z - groundHeight
      )
    }

    const minX = Math.min(...groundPoints.map(point => point.x))
    const maxX = Math.max(...groundPoints.map(point => point.x))
    const minY = Math.min(...groundPoints.map(point => point.y))
    const maxY = Math.max(...groundPoints.map(point => point.y))
    const width = Math.max(1, maxX - minX)
    const height = Math.max(1, maxY - minY)

    return Math.min(
      this.canvas.width * settings.data.renderScale / width,
      this.canvas.height * settings.data.renderScale / height
    )
  }

  private flyingHeightForViewport(targetWidth: number, targetHeight: number) {
    const originalPosition = this.flyingCamera.Position.clone()
    const referenceHeight = 1000
    this.flyingCamera.Position = new Vector3(0, 0, referenceHeight)
    const unitFootprint = this.flyingGroundFootprint()
    this.flyingCamera.Position = originalPosition

    const unitWidth = Math.max(0.000001, Math.abs(unitFootprint[1].x - unitFootprint[0].x))
    const unitHeight = Math.max(0.000001, Math.abs(unitFootprint[2].y - unitFootprint[0].y))
    return Math.max(1, referenceHeight * Math.max(
      targetWidth / unitWidth,
      targetHeight / unitHeight
    ))
  }

  private flyingGroundFootprint(groundHeight = 0) {
    const samples = [
      [0, 0],
      [this.canvas.width, 0],
      [0, this.canvas.height],
      [this.canvas.width, this.canvas.height]
    ]
    return samples.map(([x, y]) => {
      const ray = this.flyingCamera.ScreenToWorldRay(x, y)
      const distance = (groundHeight - ray.origin.z) / ray.direction.z
      return ray.origin.clone().add(ray.direction.clone().scale(distance))
    })
  }

  getTerrainHeightAt(worldX: number, worldY: number) {
    if (!this.#terrainHeightData && this.#dataTexture.image.complete) {
      const canvas = document.createElement('canvas')
      canvas.width = this.#dataTexture.image.naturalWidth || TERRAIN_DATA_SIDE
      canvas.height = this.#dataTexture.image.naturalHeight || TERRAIN_DATA_SIDE
      const context = canvas.getContext('2d')
      if (context) {
        context.drawImage(this.#dataTexture.image, 0, 0)
        this.#terrainHeightData = context.getImageData(0, 0, canvas.width, canvas.height).data
      }
    }

    if (!this.#terrainHeightData) return 0
    const x = Math.max(0, Math.min(TERRAIN_DATA_SIDE - 1,
      Math.floor(worldX / this.camera2D.MapSize.x * (TERRAIN_DATA_SIDE - 1))))
    const y = Math.max(0, Math.min(TERRAIN_DATA_SIDE - 1,
      Math.floor(worldY / this.camera2D.MapSize.y * (TERRAIN_DATA_SIDE - 1))))
    const red = this.#terrainHeightData[(y * TERRAIN_DATA_SIDE + x) * 4]
    return terrainHeightTable[Math.min(terrainHeightTable.length - 1, red)]
  }

  #setupInputs() {
    this.mousePos = new Vector2(0, 0);

    this.canvas.addEventListener("pointerdown", () => {
      this.canvas.focus({ preventScroll: true });
    });

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

    this.#terrainVao = this.gl.createVertexArray();
    this.#terrainInstanceBuffer = this.gl.createBuffer();
    this.gl.bindVertexArray(this.#terrainVao);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.#terrainInstanceBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array([0, 0]), this.gl.DYNAMIC_DRAW);
    this.#terrainInstanceCapacity = 1;
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 2 * Float32Array.BYTES_PER_ELEMENT, 0);
    this.gl.vertexAttribDivisor(0, 1);
    this.gl.bindVertexArray(null);
    
    // Tell WebGL how to convert from clip space to pixels
    this.gl.viewport(0, 0, this.gl.canvas.width, this.gl.canvas.height);
    this.gl.enable(this.gl.DEPTH_TEST);
    this.gl.depthFunc(this.gl.LESS);

    // Tell it to use our program (pair of shaders)
    this.gl.useProgram(this.program);

    // Terrain is opaque. Blending is enabled only for translucent overlays.

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
    this.#heightTableLoc = this.gl.getUniformLocation(this.program!, 'heightTable[0]');
    this.#terrainColorsLoc = this.gl.getUniformLocation(this.program!, 'terrainColors[0]');
    this.#hasTerrainTextureLoc = this.gl.getUniformLocation(this.program!, 'hasTerrainTexture[0]');
  }

  #setConstantUniforms() {
    this.gl.uniform1fv(this.#heightTableLoc, new Float32Array(terrainHeightTable));
    this.gl.uniform3fv(this.#terrainColorsLoc,
      new Float32Array(terrainColors.flatMap(color => [color.x, color.y, color.z])));

    this.gl.uniform1i(this.#terrainDataLoc, this.#dataTexture.textureUnit);
    this.gl.uniform1i(this.#terrainAtlasLoc, this.#terrainTextureArray.textureUnit);
    this.gl.uniform1i(this.#alphaAtlasLoc, this.#alphaTextureArray.textureUnit);
  }

  #makeTextures() {
    this.#terrainTextureArray = new TextureArray(this.gl, terrainTextures, new Vector2(512, 512), 1, this.gl.CLAMP_TO_EDGE, this.gl.NEAREST_MIPMAP_NEAREST),
    this.#alphaTextureArray = new TextureArray(this.gl, alphaTextures, new Vector2(512, 512), 2, this.gl.CLAMP_TO_EDGE, this.gl.NEAREST_MIPMAP_NEAREST)

    this.#dataTexture = new Texture(this.gl, "textures/terrain.png", new Vector2(TERRAIN_DATA_SIDE, TERRAIN_DATA_SIDE), 0)
    this.#dataTexture.load(() => {
      this.#onready()
    })
  }

  #onready() {
    this.#handleResize()
    document.body.classList.add('loaded')
    void this.#loadScenery()

    this.#alphaTextureArray.load((idx) => {
      if (idx < 0) {
        this.#terrainTextureArray.load((idx) => {
          // Layer 32 is the road texture, not a base terrain type. The
          // shader availability uniform only contains base terrain layers.
          if (idx >= 0 && idx < this.hasTerrainTexture.length) {
            this.hasTerrainTexture[idx] = 1;
            this.#hasTerrainTextureDirty = true
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
    const now = performance.now()
    this.#fps = updateFrameRate(now)
    this.#frameStart = now
    this.#pollGpuTimer()
    this.#beginGpuTimer()
    
    // Update current camera's viewport size
    this.currentCamera.ViewportSize.x = this.canvas.width;
    this.currentCamera.ViewportSize.y = this.canvas.height;

    // Update the current camera
    this.currentCamera.update(dt);
    this.currentCamera.prepareFrame();

    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    // Clear the canvas
    this.gl.clearColor(29/255, 34/255, 60/255, 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);

    // Set uniforms based on camera type
    this.#setUniforms();

  }

  async #loadScenery() {
    if (!settings.data.sceneryEnabled) return
    try {
      await this.#scenery.loadCurrent()
    } catch (error) {
      console.warn('Optional scenery addon unavailable', error)
    }
  }

  #ensureTerrainInstanceCapacity(count: number) {
    if (count <= this.#terrainInstanceCapacity) return

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.#terrainInstanceBuffer)
    this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(count * 2), this.gl.DYNAMIC_DRAW)
    this.#terrainInstanceCapacity = count
  }

  #setUniforms() {
    this.gl.useProgram(this.program)
    this.gl.uniformMatrix4fv(this.#xWorldLoc!, false, this.currentCamera.FrameTransform);
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

      const topLeft = camera2D.ScreenToWorld(new Vector3(0, 0, 1));
      const bottomRight = camera2D.ScreenToWorld(new Vector3(this.canvas.width, this.canvas.height, 1));
      const minX = Math.max(0, Math.floor(Math.min(topLeft.x, bottomRight.x) / LAND_BLOCK_SIZE) - 1);
      const visibleMinY = Math.min(topLeft.y, bottomRight.y);
      const visibleMaxY = Math.max(topLeft.y, bottomRight.y);
      const minY = Math.max(0, Math.floor((camera2D.MapSize.y - visibleMaxY) / LAND_BLOCK_SIZE) - 1);
      const maxX = Math.min(LAND_BLOCK_SIDE,
        Math.ceil(Math.max(topLeft.x, bottomRight.x) / LAND_BLOCK_SIZE) + 1);
      const maxY = Math.min(LAND_BLOCK_SIDE,
        Math.ceil((camera2D.MapSize.y - visibleMinY) / LAND_BLOCK_SIZE) + 1);
      const countX = Math.max(1, maxX - minX);
      const countY = Math.max(1, maxY - minY);
      this.#visibleLandblockCount = countX * countY;
      // The terrain VAO has a per-instance attribute even though 2D derives
      // the landblock position from gl_InstanceID. Keep its buffer large
      // enough for the instanced draw on the initial 2D frame as well as
      // after switching back from 3D.
      this.#ensureTerrainInstanceCapacity(this.#visibleLandblockCount)
      this.gl.uniform4f(this.#renderViewLoc!, minX, minY, countX, countY);
    } else {
      // Flying camera specific uniforms
      this.gl.uniform1f(this.#scaleLoc!, 1.0); 
      this.gl.uniform1f(this.#pixelSizeLoc, 1.0);
      this.gl.uniform1i(this.#cameraMode, 1);
      const visibleBlocks = this.#visibleTerrain3D(this.currentCamera as CameraFlying)
      const instanceData = new Float32Array(visibleBlocks.length * 2)
      visibleBlocks.forEach(([x, y], index) => {
        instanceData[index * 2] = x
        instanceData[index * 2 + 1] = y
      })
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.#terrainInstanceBuffer)
      this.gl.bufferData(this.gl.ARRAY_BUFFER, instanceData, this.gl.DYNAMIC_DRAW)
      this.#terrainInstanceCapacity = visibleBlocks.length
      this.#visibleLandblockCount = visibleBlocks.length;
      this.gl.uniform4f(this.#renderViewLoc!, 0, 0, LAND_BLOCK_SIDE, LAND_BLOCK_SIDE);
    }

    if (this.#hasTerrainTextureDirty) {
      this.gl.uniform1fv(this.#hasTerrainTextureLoc, new Float32Array(this.hasTerrainTexture));
      this.#hasTerrainTextureDirty = false
    }
  }

  #visibleTerrain3D(camera: CameraFlying): [number, number][] {
    const samples = [
      [0, 0],
      [camera.ViewportSize.x, 0],
      [0, camera.ViewportSize.y],
      [camera.ViewportSize.x, camera.ViewportSize.y]
    ]
    const mapExtent = Math.sqrt(2) * MAP_SIZE
    // Keep the camera cell in the candidate range. At shallow view angles,
    // all four corner rays can terminate well in front of the camera, which
    // otherwise drops nearby terrain even though it is inside the frustum.
    const points = [camera.Position, ...samples.map(([x, y]) => {
      const ray = camera.ScreenToWorldRay(x, y)
      const distance = ray.direction.z < -0.000001
        ? Math.max(0, (0 - ray.origin.z) / ray.direction.z)
        : mapExtent
      return ray.origin.clone().add(ray.direction.clone().scale(Math.min(distance, mapExtent)))
    })]
    const minX = Math.max(0, Math.floor(Math.min(...points.map(point => point.x)) / LAND_BLOCK_SIZE) - 1)
    const maxX = Math.min(MAX_LAND_BLOCK_INDEX, Math.floor(Math.max(...points.map(point => point.x)) / LAND_BLOCK_SIZE) + 1)
    const minY = Math.max(0, Math.floor((MAP_SIZE - Math.max(...points.map(point => point.y))) / LAND_BLOCK_SIZE) - 1)
    const maxY = Math.min(MAX_LAND_BLOCK_INDEX, Math.floor((MAP_SIZE - Math.min(...points.map(point => point.y))) / LAND_BLOCK_SIZE) + 1)
    const result: [number, number][] = []
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        result.push([x, y])
      }
    }
    return result
  }

  #updateOverlay() {
    const now = performance.now()
    if (now - this.#lastOverlayUpdate < 100) return
    this.#lastOverlayUpdate = now
    let coordsInfo = '';
    const objectStats = this.#objects.frameDiagnostics
    const objectLoading = this.#objects.loadDiagnostics
    const sceneryLoading = this.#scenery.loadDiagnostics
    const fetching = this.#objects.pendingApiRequestCount + this.#sceneryRenderer.frameDiagnostics.pendingRequests
    const fetchingInfo = settings.data.showDebug
      ? `Fetching: ${fetching} ` +
        `(HTTP ${objectLoading.httpRequests + sceneryLoading.httpRequests}, ` +
        `queued batches ${objectLoading.queuedBatches}, queued chunks ${sceneryLoading.queuedChunks}, ` +
        `cache ${objectLoading.cacheReads + sceneryLoading.cacheReads}, ` +
        `decode ${objectLoading.processorRequests + sceneryLoading.processorRequests}, ` +
        `models ${objectLoading.meshes + objectLoading.bakedMeshes + this.#sceneryRenderer.pendingModelCount})`
      : `Fetching: ${fetching}`
    const objectLoadInfo = this.#objects.objectLoadState === 'error'
      ? ` | Load error: ${this.#objects.objectLoadError}`
      : this.#objects.objectLoadState === 'loading'
        ? ' | Loading resources…'
        : ''
    
    if (this.currentCameraMode === CameraMode.Camera2D) {
      const camera2D = this.currentCamera as Camera2D
      coordsInfo = `Coords: ${camera2D.ScreenToCoords(new Vector3(this.mousePos.x / settings.data.renderScale, this.mousePos.y / settings.data.renderScale, 1))}`
    } else {
      const flyingCam = this.currentCamera as CameraFlying
      const pos = flyingCam.Position
      const mapPos = flyingCam.GetMapPosition()
      
      coordsInfo = `3D Position: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) | ` +
        `Map: (${mapPos.x.toFixed(1)}, ${(this.camera2D.MapSize.y - mapPos.y).toFixed(1)})`
    }

    const frameStats = getFrameStats()
    const performanceInfo = settings.data.showDebug
      ? `Frame: ${frameStats.frameMs.toFixed(2)} ms avg / ${frameStats.frameP95Ms.toFixed(2)} ms p95 / ${frameStats.frameP99Ms.toFixed(2)} ms p99 | ` +
        `CPU: ${frameStats.cpuMs.toFixed(2)} ms avg / ${frameStats.cpuP95Ms.toFixed(2)} ms p95 / ${frameStats.cpuP99Ms.toFixed(2)} ms p99 | ` +
        `GPU: ${frameStats.gpuMs > 0 ? `${frameStats.gpuMs.toFixed(2)} ms avg / ${frameStats.gpuP95Ms.toFixed(2)} ms p95 / ${frameStats.gpuP99Ms.toFixed(2)} ms p99` : 'n/a'}<br />`
      : ''
    const loadingPerformanceInfo = settings.data.showDebug
      ? `${this.formatLoadingTimings('Object loading', this.#objects.loadTimings)}<br />` +
        `${this.formatLoadingTimings('Scenery loading', this.#sceneryRenderer.loadTimings)}<br />` +
        `Cache: ${objectLoading.cacheEnabled ? 'OPFS' : 'network only'}, ` +
        `${(objectLoading.cacheBytes / 1048576).toFixed(0)} MB packs, ` +
        `${(objectLoading.cacheUsageBytes / 1048576).toFixed(0)} / ${(objectLoading.cacheQuotaBytes / 1048576).toFixed(0)} MB origin usage/quota<br />`
      : ''
    const debugInfo = settings.data.showDebug
      ? `Objects: ${objectStats.visiblePlacements} visible (${objectStats.visibleBuildings} buildings, ${objectStats.visibleStatics} statics, ${objectStats.visibleEnvCells} envcells, ${objectStats.visibleServerSpawns} server spawns)${objectLoadInfo} | ` +
        `Chunks: ${objectStats.visibleChunks} visible / ${objectStats.prefetchedChunks} prefetched | Models: ${objectStats.visibleUniqueModels} | ` +
        `Instanced batches: ${objectStats.instancedBatchCount} | Draw calls: ${objectStats.drawCalls} | Evictions: ${objectStats.cacheEvictions}<br />` +
        `Scenery: ${this.#scenery.state}, ${this.#sceneryRenderer.frameDiagnostics.visibleChunks}/${this.#sceneryRenderer.frameDiagnostics.loadedChunks} chunks, ${this.#sceneryRenderer.frameDiagnostics.visiblePlacements} placements (${this.#scenery.visiblePlacementCount} decoded / ${this.#scenery.indexedPlacementCount} indexed), ${this.#sceneryRenderer.frameDiagnostics.visibleModels} models (${this.#scenery.modelsByIndex.length} indexed), ${this.#sceneryRenderer.frameDiagnostics.drawCalls} draws, ${this.#sceneryRenderer.frameDiagnostics.pendingRequests} pending, ${this.#sceneryRenderer.frameDiagnostics.gpuBytes} GPU bytes<br />` +
        loadingPerformanceInfo
      : ''

    this.overlay.innerHTML = `
    ${coordsInfo} | FPS: ${this.#fps} | ${fetchingInfo}<br />
    ${performanceInfo}
    ${debugInfo}
    <small>Press 'C' to switch cameras</small>
    `;
  }

  private formatLoadingTimings(label: string, timings: LoadingTimingSnapshot): string {
    const entries = Object.entries(timings)
    if (entries.length === 0) return `${label}: no samples yet`
    return `${label} avg / p95 / max ms: ` + entries.map(([name, timing]) =>
      `${name} ${timing.average.toFixed(1)} / ${timing.p95.toFixed(1)} / ${timing.max.toFixed(1)} (${timing.count})`).join(' | ')
  }

  draw(dt: number) {
    const numVerts = TERRAIN_CELLS_PER_LAND_BLOCK * TERRAIN_CELLS_PER_LAND_BLOCK * 2 * 3;
    const numInstances = this.#visibleLandblockCount;

    this.gl.bindVertexArray(this.#terrainVao)
    this.gl.disable(this.gl.BLEND);
    if (settings.data.badWireframe) {
      this.gl.drawArraysInstanced(this.gl.LINE_STRIP, 0, numVerts, numInstances);
    }
    else {
      this.gl.drawArraysInstanced(this.gl.TRIANGLES, 0, numVerts, numInstances);
    }

    this.#objects.render(this.currentCamera, this.currentCameraMode, settings.data.showObjects, settings.data.showServerSpawns, settings.data.showParticles,
      settings.data.minZoomFor3DObjects)
    if (settings.data.sceneryEnabled) this.#sceneryRenderer.render(this.currentCamera, this.currentCameraMode,
      this.#objects.loadDistance * LAND_BLOCK_SIZE, settings.data.minZoomFor3DObjects)

    this.#endGpuTimer()
    if (this.#frameStart > 0) {
      recordCpuFrameTime(performance.now() - this.#frameStart)
    }

    // Update the overlay after object rendering has scheduled any API requests.
    this.#updateOverlay()
  }

  #beginGpuTimer() {
    if (!this.#gpuTimerExtension || this.#gpuQuery) return
    this.#gpuQuery = this.gl.createQuery()
    if (this.#gpuQuery) {
      this.gl.beginQuery(this.#gpuTimerExtension.TIME_ELAPSED_EXT, this.#gpuQuery)
      this.#gpuQueryActive = true
    }
  }

  #endGpuTimer() {
    if (this.#gpuTimerExtension && this.#gpuQuery && this.#gpuQueryActive) {
      this.gl.endQuery(this.#gpuTimerExtension.TIME_ELAPSED_EXT)
      this.#gpuQueryActive = false
    }
  }

  #pollGpuTimer() {
    if (!this.#gpuTimerExtension || !this.#gpuQuery) return

    const disjoint = this.gl.getParameter(this.#gpuTimerExtension.GPU_DISJOINT_EXT)
    const available = this.gl.getQueryParameter(this.#gpuQuery, this.gl.QUERY_RESULT_AVAILABLE)
    if (available || disjoint) {
      if (available && !disjoint) {
        const gpuMs = Number(this.gl.getQueryParameter(this.#gpuQuery, this.gl.QUERY_RESULT)) / 1_000_000
        recordGpuFrameTime(gpuMs)
      }
      this.gl.deleteQuery(this.#gpuQuery)
      this.#gpuQuery = null
      this.#gpuQueryActive = false
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
