import * as glhelpers from "./glhelpers";
import { Matrix4, Vector3, Vector2 } from "@math.gl/core";

import { TextureArray } from "./texturearray";
import { TerrainVertSource } from "../shaders/terrain.vert";
import { TerrainFragSource } from "../shaders/terrain.frag";
import { TerrainOverviewVertSource } from "../shaders/terrainoverview.vert";
import { TerrainOverviewFragSource } from "../shaders/terrainoverview.frag";

import * as settings from "../settings";
import { CameraMode } from "./cameras/cameramode";
import { Camera2D } from "./cameras/camera2d";
import { BaseCamera } from "./cameras/basecamera";
import { CameraFlying } from "./cameras/cameryflying";
import { CameraRoute } from "./router";
import { TerrainDataClient } from "./terraindataclient";
import { SceneGeometryRenderer } from "./scenegeometryrenderer";
import { invalidateSceneDrawState } from "./scenedrawstate";
import { intersectsFrustum } from "./objectvisibility";
import {
  LAND_BLOCK_SIDE,
  LAND_BLOCK_SIZE,
  MAP_SIZE,
  mapYToLandBlock,
  TERRAIN_CELLS_PER_LAND_BLOCK,
  TERRAIN_CELL_SIZE,
  TERRAIN_DATA_SIDE,
} from "./worldgeometry";
import { SceneRenderer } from "./scenerenderer";
import { createSceneView, type SceneLighting, type SceneView } from "./sceneview";
import type { SceneSubmission } from "./scenesubmission";
import { LabelsClient } from "./labelsclient";

function isTouchDevice() {
  return (
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches) ||
    navigator.maxTouchPoints > 0 ||
    typeof window.ontouchstart !== "undefined"
  );
}

export class TerrainRenderer {
  canvas: HTMLCanvasElement;
  loader: Element;
  gl: WebGL2RenderingContext;
  quality: number;

  vertexShader: WebGLShader | null = null;
  fragmentShader: WebGLShader | null = null;
  program: WebGLProgram | null = null;
  #overviewProgram: WebGLProgram | null = null;
  #overviewXWorldLoc: WebGLUniformLocation | null = null;
  #overviewTextureLoc: WebGLUniformLocation | null = null;
  #overviewTexture: WebGLTexture | null = null;
  readonly #overviewTextureUnit = 4;

  // uniform locations
  #xWorldLoc: WebGLUniformLocation | null = null;
  #scaleLoc: WebGLUniformLocation | null = null;
  #renderViewLoc: WebGLUniformLocation | null = null;
  #terrainDataLoc: WebGLUniformLocation | null = null;
  #terrainAtlasLoc: WebGLUniformLocation | null = null;
  #alphaAtlasLoc: WebGLUniformLocation | null = null;
  #minZoomForTexturesLoc: WebGLUniformLocation | null = null;
  #cameraMode: WebGLUniformLocation | null = null;
  #heightTableLoc: WebGLUniformLocation | null = null;
  #maxTerrainHeightLoc: WebGLUniformLocation | null = null;
  #terrainColorsLoc: WebGLUniformLocation | null = null;
  #hasTerrainTextureLoc: WebGLUniformLocation | null = null;
  #terrainGridEnabledLoc: WebGLUniformLocation | null = null;
  #cameraPositionLoc: WebGLUniformLocation | null = null;
  #fogColorLoc: WebGLUniformLocation | null = null;
  #fogStartLoc: WebGLUniformLocation | null = null;
  #fogEndLoc: WebGLUniformLocation | null = null;
  #fogEnabledLoc: WebGLUniformLocation | null = null;
  #lightDirectionLoc: WebGLUniformLocation | null = null;
  #sunlightColorLoc: WebGLUniformLocation | null = null;
  #ambientColorLoc: WebGLUniformLocation | null = null;
  #terrainVao: WebGLVertexArrayObject | null = null;
  #terrainInstanceBuffer: WebGLBuffer | null = null;
  #terrainInstanceCapacity = 0;
  #submissions: SceneSubmission[] = [];
  #sceneGeometry!: SceneGeometryRenderer;
  #serverGeometry?: SceneGeometryRenderer;
  private readonly minTerrainTextureCellArea = 4;
  private terrainColorData = new Float32Array(32 * 3);
  private terrainHeightTable = new Float32Array(256);
  private maxTerrainHeight = 0;
  readonly sceneRenderer: SceneRenderer;
  sceneView!: SceneView;

  #dataTexture!: TerrainDataClient;
  #terrainHeightData: Uint8ClampedArray | null = null;
  #terrainTextureArray!: TextureArray;
  #alphaTextureArray!: TextureArray;
  #terrainReady = false;

  hasTerrainTexture: number[] = [];
  #hasTerrainTextureDirty = true;
  #visibleLandblockCount = LAND_BLOCK_SIDE * LAND_BLOCK_SIDE;

  // Camera system
  camera2D: Camera2D;
  flyingCamera: CameraFlying;
  currentCamera: BaseCamera;
  currentCameraMode: CameraMode = CameraMode.Camera2D;
  #restoredFlyingCameraRoute = false;
  #updateMoveSpeedControl: (() => void) | null = null;
  #isShutdown = false;

  mousePos = new Vector2();
  #invalidateCallback: (() => void) | null = null;
  #invalidated = false;
  #monitorFps = document.querySelector<HTMLElement>("#monitor-fps");
  #loadingSpinner = document.querySelector<HTMLElement>("#loading-spinner");
  #loadingDetails = document.querySelector<HTMLElement>("#loading-details");
  #monitorFrameCount = 0;
  #monitorFrameStarted = performance.now();
  #labels?: LabelsClient;

  constructor(
    canvas: HTMLCanvasElement,
    loader: Element,
    quality: number,
    datDescriptorPath = "v3/dataset",
    serverDescriptorPath?: string,
    labelsPath?: string,
  ) {
    this.canvas = canvas;
    this.loader = loader;
    this.gl = canvas.getContext("webgl2")!;
    this.quality = quality;

    // Initialize both cameras
    this.camera2D = new Camera2D(this.canvas, this);
    this.flyingCamera = new CameraFlying(this.canvas, this);
    this.currentCamera = this.camera2D;
    this.#updateMobileControlsVisibility();

    this.#handleResize();

    if (!this.gl) {
      this.throwError("No Canvas / webgl2?");
    }
    this.sceneRenderer = new SceneRenderer(this.gl);
    this.gl.canvas.addEventListener("webglcontextrestored", () => {
      this.invalidate("context restoration");
    });

    this.#sceneGeometry = new SceneGeometryRenderer(
      this.gl,
      datDescriptorPath,
      "dat",
    );
    this.#serverGeometry = serverDescriptorPath
      ? new SceneGeometryRenderer(this.gl, serverDescriptorPath, "server")
      : undefined;
    if (labelsPath) {
      this.#labels = new LabelsClient(labelsPath, document.querySelector<HTMLElement>("#labels-overlay")!);
      this.#labels.loadPois();
    }
    this.#applySettings();
    this.#addSettings();
    this.#setupGL();
    this.#setupInputs();

    this.#makeTextures();

    // Initialize 2D camera setup
    this.#initialize2DCamera();

    // Initialize flying camera setup
    this.#initializeFlyingCamera();
  }

  #applySettings(): void {
    this.#labels?.setEnabled(settings.data.showLabels);
    this.#sceneGeometry.loadDistance = settings.data.distanceLandblocks;
    if (this.#serverGeometry) this.#serverGeometry.loadDistance = settings.data.distanceLandblocks;
    this.flyingCamera.MoveSpeed = settings.data.moveSpeed;
    this.flyingCamera.MobileMoveSensitivity = settings.data.mobileMoveSensitivity;
    this.flyingCamera.MobileLookSensitivity = settings.data.mobileLookSensitivity;
    this.flyingCamera.MobileLookInvertY = settings.data.mobileLookInvertY;
    this.flyingCamera.FOV = settings.data.fov;
    this.#updateFlyingFarPlane();
    this.invalidate("settings");
  }

  get isShutdown(): boolean {
    return this.#isShutdown;
  }

  shutdown(): void {
    if (this.#isShutdown) return;
    this.#isShutdown = true;
    this.#sceneGeometry.shutdown();
    this.#serverGeometry?.shutdown();
  }

  #initialize2DCamera() {
    // resize map to fit
    if (this.canvas.height > this.canvas.width) {
      this.camera2D.Zoom = this.canvas.height / this.camera2D.MapSize.y;
    } else {
      this.camera2D.Zoom = this.canvas.width / this.camera2D.MapSize.x;
    }

    // center map
    this.camera2D.CenterOnVec(
      this.camera2D.MapSize.clone().divide(new Vector3(2, 2, 1)),
    );
  }

  #resetCamera() {
    this.switchCamera(CameraMode.Camera2D);
    this.camera2D.Position = new Vector3(24162.252488664108, 29663.566666805677, 2.4964);
    this.invalidate("input");
  }

  #initializeFlyingCamera() {
    // Both cameras use map X/Y. The flying camera adds AC elevation on Z.
    const mapCenter = this.camera2D.MapSize.clone().divide(
      new Vector3(2, 2, 1),
    );
    this.flyingCamera.Position = new Vector3(mapCenter.x, mapCenter.y, 500);

    // Look down at the map initially
    this.flyingCamera.SetRotation(
      Math.PI,
      -(Math.PI / 2 - Math.PI / 18),
      0,
    ); // Look down at 10 degrees off vertical with north at the top

    this.#updateFlyingFarPlane();
  }

  #addSettings() {
    const section = document.querySelector<HTMLElement>("#config-content")!;
    const actionsSection = document.querySelector<HTMLElement>("#sidebar-actions-content")!;
    const updateControls = new Set<() => void>();
    const addRange = (label: string, value: () => number, set: (value: number) => void, min: number, max: number, step: number) => {
      const row = document.createElement("label");
      row.className = "control-row range-row";
      row.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}"><output></output>`;
      const input = row.querySelector<HTMLInputElement>("input")!;
      const output = row.querySelector<HTMLOutputElement>("output")!;
      const update = () => { input.value = String(value()); output.value = input.value; };
      updateControls.add(update);
      input.addEventListener("input", () => { set(Number(input.value)); update(); });
      update(); section.append(row); return row;
    };
    const addCheckbox = (label: string, value: () => boolean, set: (value: boolean) => void) => {
      const row = document.createElement("label"); row.className = "control-row checkbox-row";
      row.innerHTML = `<span>${label}</span><input type="checkbox">`;
      const input = row.querySelector<HTMLInputElement>("input")!; input.checked = value();
      updateControls.add(() => { input.checked = value(); });
      input.addEventListener("change", () => set(input.checked)); section.append(row); return row;
    };
    const addActionButton = (label: string, action: () => void | Promise<void>) => {
      const button = document.createElement("button"); button.className = "action-button"; button.textContent = label;
      button.addEventListener("click", () => void action()); actionsSection.append(button);
    };
    const texture = document.createElement("label"); texture.className = "control-row";
    texture.innerHTML = `<span>Texture Type</span><select><option value="auto">Auto</option><option value="bc">BC / S3TC</option><option value="etc2">ETC2</option><option value="rgba8">RGBA8</option></select>`;
    const textureSelect = texture.querySelector<HTMLSelectElement>("select")!; textureSelect.value = settings.data.textureProfile;
    textureSelect.addEventListener("change", () => { settings.data.textureProfile = settings.parseTextureProfilePreference(textureSelect.value); this.shutdown(); window.location.reload(); }); section.append(texture);
    const activeTexture = document.createElement("div");
    activeTexture.className = "control-row active-value";
    activeTexture.innerHTML = `<span>Active Texture Type</span><span>${this.#sceneGeometry.textureProfile}</span>`;
    section.append(activeTexture);
    addRange("Min 3D Object Zoom", () => settings.data.minZoomFor3DObjects, (v) => { settings.data.minZoomFor3DObjects = v; }, 0.05, 5, 0.05);
    addCheckbox("Show Labels", () => settings.data.showLabels, (v) => { settings.data.showLabels = v; });
    addCheckbox("Terrain Grid", () => settings.data.terrainGridEnabled, (v) => { settings.data.terrainGridEnabled = v; this.invalidate("input"); });
    addRange("3D Object / Fog Distance", () => settings.data.distanceLandblocks, (v) => { settings.data.distanceLandblocks = v; this.#updateFlyingFarPlane(); }, 3, 25, 1);
    const moveSpeed = addRange("Move Speed", () => settings.data.moveSpeed, (v) => { settings.data.moveSpeed = v; }, 0.1, 2000, 0.1);
    moveSpeed.classList.add("desktop-only-control");
    this.#updateMoveSpeedControl = () => {
      const input = moveSpeed.querySelector<HTMLInputElement>("input")!;
      const output = moveSpeed.querySelector<HTMLOutputElement>("output")!;
      input.value = String(settings.data.moveSpeed);
      output.value = input.value;
    };
    const mobileMoveSensitivity = addRange("Touch Move Sensitivity", () => settings.data.mobileMoveSensitivity, (v) => { settings.data.mobileMoveSensitivity = v; }, 0, 200, 0.1);
    const mobileLookSensitivity = addRange("Touch Look Sensitivity", () => settings.data.mobileLookSensitivity, (v) => { settings.data.mobileLookSensitivity = v; }, 0, 3, 0.01);
    mobileMoveSensitivity.classList.add("mobile-only-control");
    mobileLookSensitivity.classList.add("mobile-only-control");
    const mobileLookInvertY = addCheckbox("Invert Touch Look Vertical", () => settings.data.mobileLookInvertY, (v) => { settings.data.mobileLookInvertY = v; });
    mobileLookInvertY.classList.add("mobile-only-control");
    if (isTouchDevice()) document.documentElement.classList.add("touch-device");
    addRange("Field of View", () => settings.data.fov, (v) => { settings.data.fov = v; }, 30, 120, 1);
    addActionButton("Clear Data Caches & Reload", async () => { try { await Promise.all([...this.#geometries().map((geometry) => geometry.clearCache()), this.#labels?.clearCache()]); this.shutdown(); window.location.reload(); } catch (error) { console.error("Unable to clear ACTerrain data caches", error); } });
    addActionButton("Print Diagnostics", () => this.#printDiagnostics());
    addActionButton("Reset Settings to Defaults", () => {
      settings.resetSettings();
      this.shutdown();
      const url = new URL(window.location.href);
      url.searchParams.delete("dataset");
      window.location.assign(url.toString());
    });
    document.querySelector<HTMLButtonElement>("#switch-camera")!.addEventListener("click", () => this.switchCamera(this.currentCameraMode === CameraMode.Camera2D ? CameraMode.Flying : CameraMode.Camera2D));
    document.querySelector<HTMLButtonElement>("#reset-camera")!.addEventListener("click", () => this.#resetCamera());
    settings.subscribe(() => {
      this.#applySettings();
      textureSelect.value = settings.data.textureProfile;
      this.#updateMoveSpeedControl?.();
      for (const update of updateControls) update();
    });
    const toggle = document.querySelector<HTMLButtonElement>("#settings-toggle")!;
    const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
    const close = document.querySelector<HTMLButtonElement>("#sidebar-close")!;
    document.querySelectorAll<HTMLButtonElement>(".sidebar-section-toggle").forEach((button) => {
      button.addEventListener("click", () => {
        const content = document.getElementById(button.getAttribute("aria-controls")!);
        const expanded = button.getAttribute("aria-expanded") === "true";
        if (!expanded) {
          document.querySelectorAll<HTMLButtonElement>(".sidebar-section-toggle").forEach((other) => {
            if (other === button) return;
            other.setAttribute("aria-expanded", "false");
            document.getElementById(other.getAttribute("aria-controls")!)?.classList.add("collapsed");
            const otherIndicator = other.querySelector("span:last-child");
            if (otherIndicator) otherIndicator.textContent = "⌄";
          });
        }
        button.setAttribute("aria-expanded", String(!expanded));
        content?.classList.toggle("collapsed", expanded);
        const indicator = button.querySelector("span:last-child");
        if (indicator) indicator.textContent = expanded ? "⌄" : "⌃";
      });
    });
    const setOpen = (open: boolean) => { sidebar.classList.toggle("open", open); toggle.setAttribute("aria-expanded", String(open)); };
    const releaseCameraInput = () => {
      if (document.pointerLockElement) document.exitPointerLock();
    };
    toggle.addEventListener("pointerdown", releaseCameraInput);
    sidebar.addEventListener("pointerdown", releaseCameraInput);
    toggle.addEventListener("click", () => setOpen(!sidebar.classList.contains("open")));
    close.addEventListener("click", () => setOpen(false));
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setOpen(false);
    });
  }

  #printDiagnostics(): void {
    const diagnostics = {
      camera: {
        mode: this.currentCameraMode,
        position: {
          x: this.currentCamera.Position.x,
          y: this.currentCamera.Position.y,
          z: this.currentCamera.Position.z,
        },
        zoom: this.camera2D.Zoom,
      },
      sceneGeometry: {
        transparency: {
          tier: this.sceneRenderer.tier,
          drawBuffersIndexed:
            this.sceneRenderer.capabilities.drawBuffersIndexed,
          colorBufferFloat: this.sceneRenderer.capabilities.colorBufferFloat,
          floatBlend: this.sceneRenderer.capabilities.floatBlend,
        },
        dataset: this.#sceneGeometry.datasetDiagnostics,
        server: this.#serverGeometry?.datasetDiagnostics,
        loadState: this.#sceneGeometry.sceneLoadState,
        loadError: this.#sceneGeometry.sceneLoadError,
        frame: this.#sceneGeometry.frameDiagnostics,
        loading: this.#sceneGeometry.loadDiagnostics,
      },
    };

    console.log("[ACTerrain diagnostics]", diagnostics);
  }

  updateFlyingCameraControls(): void {
    this.#updateMoveSpeedControl?.();
  }

  focusLocation(x: number, y: number, type: "poi" | "npc" | "portal"): void {
    if (this.currentCameraMode !== CameraMode.Camera2D) this.switchCamera(CameraMode.Camera2D);
    this.camera2D.Zoom = this.capCameraZoom(type === "poi" ? 0.12 : 40);
    this.camera2D.CenterOnVec(new Vector3(x, y, 1));
    this.invalidate("input");
  }

  #updateMobileControlsVisibility(): void {
    document
      .getElementById("mobile-controls")
      ?.classList.toggle("camera-2d", this.currentCameraMode === CameraMode.Camera2D);
  }

  switchCamera(mode: CameraMode) {
    if (mode === this.currentCameraMode) return;

    const oldMode = this.currentCameraMode;
    this.currentCameraMode = mode;
    this.#updateMobileControlsVisibility();

    if (mode === CameraMode.Camera2D) {
      // Switching to 2D camera
      this.currentCamera = this.camera2D;

      // Preserve the map location represented by the camera transition.
      if (oldMode === CameraMode.Flying) {
        // The tilted camera is offset behind the focal point, so use the
        // terrain point at the center of the 3D view rather than camera XY.
        const pos2D = this.flyingCamera.GetMapPosition();
        pos2D.z = 1;
        this.camera2D.CenterOnVec(pos2D);

        const terrainHeight = this.getTerrainClearanceHeightAt(
          pos2D.x,
          pos2D.y,
        );
        const height = Math.min(
          Math.max(1, this.flyingCamera.Position.z - terrainHeight),
          settings.data.distanceLandblocks * LAND_BLOCK_SIZE * 0.8,
        );
        const zoom = this.zoomForFlyingHeight(height);
        this.camera2D.Zoom = this.capCameraZoom(zoom);
      }
    } else if (mode === CameraMode.Flying) {
      // Switching to flying camera
      this.currentCamera = this.flyingCamera;

      // Try to preserve context - position flying camera based on 2D camera
      if (oldMode === CameraMode.Camera2D) {
        const pos2D = this.camera2D.Position;
        // Both cameras use the terrain renderer's world-space coordinates.
        // Set the same north-up, near-vertical view used by the initial flying
        // camera before measuring the viewport footprint. Calling LookAt on
        // the point directly below the camera would reset yaw to zero and
        // make the view nearly vertical.
        this.flyingCamera.SetRotation(
          Math.PI,
          -(Math.PI / 2 - Math.PI / 18),
          0,
        );
        const terrainHeight = this.getTerrainClearanceHeightAt(
          pos2D.x,
          pos2D.y,
        );
        const desiredHeight = this.flyingHeightForZoom(this.camera2D.Zoom);
        const height = Math.min(
          desiredHeight,
          settings.data.distanceLandblocks * LAND_BLOCK_SIZE * 0.8,
        );
        const forward = this.flyingCamera.GetForward();
        const groundDistance = height / Math.max(0.0001, -forward.z);
        const cameraX = pos2D.x - forward.x * groundDistance;
        const cameraY = pos2D.y - forward.y * groundDistance;
        const viewTerrainHeight = this.getTerrainClearanceHeightInArea(
          cameraX,
          cameraY,
          height * 1.5,
        );
        this.flyingCamera.Position = new Vector3(
          cameraX,
          cameraY,
          Math.max(
            terrainHeight + height,
            viewTerrainHeight + 1,
          ),
        );
      }
    }

    // Update viewport size for new camera
    this.currentCamera.ViewportSize.x = this.canvas.width;
    this.currentCamera.ViewportSize.y = this.canvas.height;
    this.invalidate("input");
  }

  restoreCameraRoute(route: CameraRoute) {
    if (route.mode === "2d") {
      this.camera2D.Position = new Vector3(
        route.position.x,
        route.position.y,
        route.position.z,
      );
      this.camera2D.Zoom = route.zoom!;
      this.currentCameraMode = CameraMode.Camera2D;
      this.currentCamera = this.camera2D;
      this.#updateMobileControlsVisibility();
      this.invalidate("input");
      return;
    }

    this.flyingCamera.Position = new Vector3(
      route.position.x,
      route.position.y,
      route.position.z,
    );
    this.#restoredFlyingCameraRoute = true;
    this.flyingCamera.SetRotation(route.yaw!, route.pitch!, route.roll!);
    this.flyingCamera.FOV = route.fov!;
    this.currentCameraMode = CameraMode.Flying;
    this.currentCamera = this.flyingCamera;
    this.#updateMobileControlsVisibility();
    this.invalidate("input");
  }

  setInvalidationCallback(callback: () => void): void {
    this.#invalidateCallback = callback;
  }

  get animationActive(): boolean {
    return (
      this.currentCamera === this.flyingCamera &&
      this.flyingCamera.hasActiveInput
    );
  }

  invalidate(
    _source:
      | "input"
      | "animation"
      | "resize"
      | "visibility"
      | "resource publication"
      | "context restoration"
      | "initialization"
      | "settings",
  ): void {
    this.#invalidated = true;
    this.#invalidateCallback?.();
  }

  private capCameraZoom(zoom: number) {
    return Math.max(
      settings.data.minZoom,
      Math.min(settings.data.maxZoom, zoom),
    );
  }

  private flyingHeightForZoom(zoom: number) {
    const visibleWorldHeight =
      (this.canvas.height * settings.data.renderScale) / zoom;
    return visibleWorldHeight / this.groundSpanPerFlyingHeight();
  }

  private zoomForFlyingHeight(height: number) {
    return (
      (this.canvas.height * settings.data.renderScale) /
      (Math.max(1, height) * this.groundSpanPerFlyingHeight())
    );
  }

  private groundSpanPerFlyingHeight() {
    const transform = this.flyingCamera.Transform;
    const inverseTransform = transform.clone().invert();
    const topRay = this.flyingCamera.ScreenToWorldRay(
      this.canvas.width / 2,
      0,
      transform,
      inverseTransform,
    );
    const bottomRay = this.flyingCamera.ScreenToWorldRay(
      this.canvas.width / 2,
      this.canvas.height,
      transform,
      inverseTransform,
    );
    const topDistance = -1 / topRay.direction.z;
    const bottomDistance = -1 / bottomRay.direction.z;
    const topY = topRay.direction.y * topDistance;
    const bottomY = bottomRay.direction.y * bottomDistance;
    return Math.max(0.0001, Math.abs(bottomY - topY));
  }

  getTerrainHeightAt(worldX: number, worldY: number) {
    this.#terrainHeightData ??= this.#dataTexture.pixels;

    if (!this.#terrainHeightData) return 0;
    const x = Math.max(
      0,
      Math.min(
        TERRAIN_DATA_SIDE - 1,
        Math.floor(
          (worldX / this.camera2D.MapSize.x) * (TERRAIN_DATA_SIDE - 1),
        ),
      ),
    );
    const y = Math.max(
      0,
      Math.min(
        TERRAIN_DATA_SIDE - 1,
        Math.floor(
          (worldY / this.camera2D.MapSize.y) * (TERRAIN_DATA_SIDE - 1),
        ),
      ),
    );
    const imageY = y;
    const red = this.#terrainHeightData[(imageY * TERRAIN_DATA_SIDE + x) * 4];
    return this.terrainHeightTable[
      Math.min(this.terrainHeightTable.length - 1, red)
    ];
  }

  private getTerrainClearanceHeightAt(worldX: number, worldY: number) {
    return this.getTerrainClearanceHeightInArea(worldX, worldY, 0);
  }

  private getTerrainClearanceHeightInArea(
    worldX: number,
    worldY: number,
    radius: number,
  ) {
    this.#terrainHeightData ??= this.#dataTexture.pixels;

    if (!this.#terrainHeightData) return 0;

    const x = Math.max(
      0,
      Math.min(
        TERRAIN_DATA_SIDE - 1,
        Math.floor(
          (worldX / this.camera2D.MapSize.x) * (TERRAIN_DATA_SIDE - 1),
        ),
      ),
    );
    const y = Math.max(
      0,
      Math.min(
        TERRAIN_DATA_SIDE - 1,
        Math.floor(
          (worldY / this.camera2D.MapSize.y) * (TERRAIN_DATA_SIDE - 1),
        ),
      ),
    );
    const imageY = y;
    const samples = Math.ceil(
      radius / (this.camera2D.MapSize.x / (TERRAIN_DATA_SIDE - 1)),
    );
    let height = 0;

    for (
      let sampleX = Math.max(0, x - samples);
      sampleX <= Math.min(TERRAIN_DATA_SIDE - 1, x + samples + 1);
      sampleX++
    ) {
      for (
        let sampleY = Math.max(0, imageY - samples);
        sampleY <= Math.min(TERRAIN_DATA_SIDE - 1, imageY + samples + 1);
        sampleY++
      ) {
        const red =
          this.#terrainHeightData[
            (sampleY * TERRAIN_DATA_SIDE + sampleX) * 4
          ];
        height = Math.max(
          height,
          this.terrainHeightTable[
            Math.min(this.terrainHeightTable.length - 1, red)
          ],
        );
      }
    }

    return height;
  }

  #setupInputs() {
    this.mousePos = new Vector2(0, 0);

    this.canvas.addEventListener("pointerdown", () => {
      this.canvas.focus({ preventScroll: true });
    });

    window.addEventListener("resize", () => {
      this.#handleResize();
      this.invalidate("resize");
    });

    window.addEventListener("mousemove", (event) => {
      this.mousePos.x = event.clientX;
      this.mousePos.y = event.clientY;
    });
    for (const eventName of [
      "pointerdown",
      "pointermove",
      "pointerup",
      "wheel",
      "keydown",
      "keyup",
      "touchstart",
      "touchmove",
      "touchend",
    ]) {
      window.addEventListener(eventName, () => this.invalidate("input"));
    }

    // Add keyboard shortcut for quick camera switching
    window.addEventListener("keydown", (event) => {
      if (event.key === "c" || event.key === "C") {
        const newMode =
          this.currentCameraMode === CameraMode.Camera2D
            ? CameraMode.Flying
            : CameraMode.Camera2D;
        this.switchCamera(newMode);
      }
    });

    document.addEventListener("visibilitychange", () =>
      this.invalidate("visibility"),
    );
  }

  #setupGL() {
    if (!this.#createShaders()) {
      this.throwError("Unable to create shaders!");
      return false;
    }

    if (!this.#createProgram()) {
      this.throwError("Unable to program!");
      return false;
    }
    const overviewVertexShader = glhelpers.createShader(
      this.gl,
      this.gl.VERTEX_SHADER,
      TerrainOverviewVertSource,
    );
    const overviewFragmentShader = glhelpers.createShader(
      this.gl,
      this.gl.FRAGMENT_SHADER,
      TerrainOverviewFragSource,
    );
    this.#overviewProgram =
      overviewVertexShader && overviewFragmentShader
        ? glhelpers.createProgram(
            this.gl,
            overviewVertexShader,
            overviewFragmentShader,
          )
        : null;
    if (!this.#overviewProgram) {
      this.throwError("Unable to create terrain overview program!");
      return false;
    }

    this.#buildData();

    this.#terrainVao = this.gl.createVertexArray();
    this.#terrainInstanceBuffer = this.gl.createBuffer();
    this.gl.bindVertexArray(this.#terrainVao);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.#terrainInstanceBuffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new Float32Array([0, 0]),
      this.gl.DYNAMIC_DRAW,
    );
    this.#terrainInstanceCapacity = 1;
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(
      0,
      2,
      this.gl.FLOAT,
      false,
      2 * Float32Array.BYTES_PER_ELEMENT,
      0,
    );
    this.gl.vertexAttribDivisor(0, 1);
    this.gl.bindVertexArray(null);

    // Tell WebGL how to convert from clip space to pixels
    this.gl.viewport(0, 0, this.gl.canvas.width, this.gl.canvas.height);
    this.gl.enable(this.gl.DEPTH_TEST);
    this.gl.depthFunc(this.gl.LESS);

    // Tell it to use our program (pair of shaders)
    this.gl.useProgram(this.program);

    // Terrain is opaque. Blending is enabled only for translucent overlays.

    this.#xWorldLoc = this.gl.getUniformLocation(this.program!, "xWorld");
    this.#scaleLoc = this.gl.getUniformLocation(this.program!, "scale");
    this.#renderViewLoc = this.gl.getUniformLocation(
      this.program!,
      "renderView",
    );
    this.#terrainDataLoc = this.gl.getUniformLocation(
      this.program!,
      "terrainData",
    );
    this.#terrainAtlasLoc = this.gl.getUniformLocation(
      this.program!,
      "terrainAtlas",
    );
    this.#alphaAtlasLoc = this.gl.getUniformLocation(
      this.program!,
      "alphaAtlas",
    );
    this.#minZoomForTexturesLoc = this.gl.getUniformLocation(
      this.program!,
      "minZoomForTextures",
    );
    this.#cameraMode = this.gl.getUniformLocation(this.program!, "cameraMode");
    this.#heightTableLoc = this.gl.getUniformLocation(
      this.program!,
      "heightTable[0]",
    );
    this.#maxTerrainHeightLoc = this.gl.getUniformLocation(
      this.program!,
      "maxTerrainHeight",
    );
    this.#terrainColorsLoc = this.gl.getUniformLocation(
      this.program!,
      "terrainColors[0]",
    );
    this.#hasTerrainTextureLoc = this.gl.getUniformLocation(
      this.program!,
      "hasTerrainTexture[0]",
    );
    this.#terrainGridEnabledLoc = this.gl.getUniformLocation(
      this.program!,
      "terrainGridEnabled",
    );
    this.#cameraPositionLoc = this.gl.getUniformLocation(
      this.program!,
      "cameraPosition",
    );
    this.#fogColorLoc = this.gl.getUniformLocation(this.program!, "fogColor");
    this.#fogStartLoc = this.gl.getUniformLocation(this.program!, "fogStart");
    this.#fogEndLoc = this.gl.getUniformLocation(this.program!, "fogEnd");
    this.#fogEnabledLoc = this.gl.getUniformLocation(
      this.program!,
      "fogEnabled",
    );
    this.#lightDirectionLoc = this.gl.getUniformLocation(
      this.program!,
      "lightDirection",
    );
    this.#sunlightColorLoc = this.gl.getUniformLocation(
      this.program!,
      "sunlightColor",
    );
    this.#ambientColorLoc = this.gl.getUniformLocation(
      this.program!,
      "ambientColor",
    );
    this.#overviewXWorldLoc = this.gl.getUniformLocation(
      this.#overviewProgram,
      "xWorld",
    );
    this.#overviewTextureLoc = this.gl.getUniformLocation(
      this.#overviewProgram,
      "terrainOverview",
    );
  }

  #setConstantUniforms() {
    this.gl.useProgram(this.program);
    this.gl.uniform1fv(this.#heightTableLoc, this.terrainHeightTable);
    this.gl.uniform1f(this.#maxTerrainHeightLoc, this.maxTerrainHeight);
    this.gl.uniform3fv(this.#terrainColorsLoc, this.terrainColorData);

    this.gl.uniform1i(this.#terrainDataLoc, this.#dataTexture.textureUnit);
    this.gl.uniform1i(
      this.#terrainAtlasLoc,
      this.#terrainTextureArray.textureUnit,
    );
    this.gl.uniform1i(this.#alphaAtlasLoc, this.#alphaTextureArray.textureUnit);
  }

  #makeTextures() {
    this.#dataTexture = new TerrainDataClient(this.gl, 0);
    void this.#dataTexture
      .load(this.#sceneGeometry.terrainData())
      .then(() => {
        const catalog = this.#dataTexture.catalog!;
        this.terrainHeightTable = new Float32Array(catalog.heightTable);
        this.maxTerrainHeight =
          this.terrainHeightTable[this.terrainHeightTable.length - 1];
        this.terrainColorData = new Float32Array(catalog.colors.flat());
        this.camera2D.MapSize.z = this.maxTerrainHeight;
        if (!this.#restoredFlyingCameraRoute) {
          this.flyingCamera.Position.z = this.maxTerrainHeight + 500;
        }
        this.#terrainTextureArray = new TextureArray(
          this.gl,
          catalog.surfaces.length,
          new Vector2(512, 512),
          1,
          this.gl.REPEAT,
          this.gl.NEAREST_MIPMAP_NEAREST,
        );
        const maskIds = [
          ...new Set(
            [
              ...catalog.cornerMasks,
              ...catalog.sideMasks,
              ...catalog.roadMasks,
            ].map((mask) => mask.textureId),
          ),
        ];
        this.#alphaTextureArray = new TextureArray(
          this.gl,
          maskIds.length,
          new Vector2(512, 512),
          2,
          this.gl.CLAMP_TO_EDGE,
          this.gl.NEAREST_MIPMAP_NEAREST,
        );
        this.#terrainHeightData = this.#dataTexture.pixels;
        this.#createTerrainOverviewTexture();
        this.#setConstantUniforms();
        this.#setTerrainCatalogUniforms(this.program!);
        return this.#loadTerrainTextures(maskIds);
      })
      .then(() => {
        this.#onready();
        this.invalidate("resource publication");
      })
      .catch((error) =>
        this.throwError(`Unable to load terrain data: ${error}`),
      );
  }

  #createTerrainOverviewTexture(): void {
    const gl = this.gl;
    const source = new Uint8Array(TERRAIN_DATA_SIDE * TERRAIN_DATA_SIDE * 4);
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) {
      throw new Error("Unable to create terrain overview framebuffer");
    }
    const previousFramebuffer = gl.getParameter(
      gl.FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.#dataTexture.texture,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
      gl.deleteFramebuffer(framebuffer);
      throw new Error("Unable to read terrain control texture");
    }
    gl.readPixels(
      0,
      0,
      TERRAIN_DATA_SIDE,
      TERRAIN_DATA_SIDE,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
    gl.deleteFramebuffer(framebuffer);

    const pixels = new Uint8Array(TERRAIN_DATA_SIDE * TERRAIN_DATA_SIDE * 4);
    for (
      let sourceOffset = 0, targetOffset = 0;
      sourceOffset < source.length;
      sourceOffset += 4, targetOffset += 4
    ) {
      const colorOffset = Math.min(31, source[sourceOffset + 1]) * 3;
      pixels[targetOffset] = Math.round(
        this.terrainColorData[colorOffset] * 255,
      );
      pixels[targetOffset + 1] = Math.round(
        this.terrainColorData[colorOffset + 1] * 255,
      );
      pixels[targetOffset + 2] = Math.round(
        this.terrainColorData[colorOffset + 2] * 255,
      );
      pixels[targetOffset + 3] = 255;
    }

    this.#overviewTexture = gl.createTexture();
    if (!this.#overviewTexture) {
      throw new Error("Unable to create terrain overview texture");
    }
    gl.activeTexture(gl.TEXTURE0 + this.#overviewTextureUnit);
    gl.bindTexture(gl.TEXTURE_2D, this.#overviewTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      TERRAIN_DATA_SIDE,
      TERRAIN_DATA_SIDE,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  #onready() {
    this.#handleResize();
    this.#terrainReady = true;
    document.body.classList.add("loaded");
  }

  async #loadTerrainTextures(maskIds: number[]): Promise<void> {
    const catalog = this.#dataTexture.catalog!;
    const resourceIds = [
      ...new Set([
        ...catalog.surfaces.map((surface) => surface.textureId),
        ...maskIds,
      ]),
    ];
    await this.#sceneGeometry.datClient.loadResources(resourceIds);
    const [terrain, masks] = await Promise.all([
      Promise.all(
        catalog.surfaces.map((surface) =>
          this.#sceneGeometry.datClient.texture(surface.textureId),
        ),
      ),
      Promise.all(
        maskIds.map((id) => this.#sceneGeometry.datClient.texture(id)),
      ),
    ]);
    this.#alphaTextureArray.load(masks, () => undefined);
    this.#terrainTextureArray.load(terrain, (index) => {
      if (index >= 0 && index < this.hasTerrainTexture.length) {
        this.hasTerrainTexture[index] = 1;
        this.#hasTerrainTextureDirty = true;
      }
    });
  }

  #handleResize() {
    glhelpers.resizeCanvasToDisplaySize(
      this.canvas,
      settings.data.maxRenderQuality + 1 - settings.data.renderQuality,
    );

    // Update viewport size for both cameras
    this.camera2D.ViewportSize.x = this.canvas.width;
    this.camera2D.ViewportSize.y = this.canvas.height;
    this.flyingCamera.ViewportSize.x = this.canvas.width;
    this.flyingCamera.ViewportSize.y = this.canvas.height;
  }

  #buildData() {
    for (var i = 0; i < 32; i++) {
      this.hasTerrainTexture[i] = 0;
    }
  }

  #createShaders() {
    this.vertexShader = glhelpers.createShader(
      this.gl,
      this.gl.VERTEX_SHADER,
      TerrainVertSource,
    );
    this.fragmentShader = glhelpers.createShader(
      this.gl,
      this.gl.FRAGMENT_SHADER,
      TerrainFragSource,
    );

    return this.vertexShader && this.fragmentShader;
  }

  #createProgram() {
    this.program = glhelpers.createProgram(
      this.gl,
      this.vertexShader!,
      this.fragmentShader!,
    );
    return !!this.program;
  }

  update(dt: number) {
    this.#invalidated = false;

    // Update current camera's viewport size
    this.currentCamera.ViewportSize.x = this.canvas.width;
    this.currentCamera.ViewportSize.y = this.canvas.height;

    // Update the current camera
    this.currentCamera.update(dt);
    this.currentCamera.prepareFrame();
    this.sceneView = createSceneView(
      this.currentCamera,
      this.currentCameraMode,
      {
        color: [29 / 255, 34 / 255, 60 / 255],
        start:
          this.currentCameraMode === CameraMode.Flying
            ? Math.max(
                0,
                settings.data.distanceLandblocks * LAND_BLOCK_SIZE -
                  LAND_BLOCK_SIZE,
              )
            : 0,
        end:
          this.currentCameraMode === CameraMode.Flying
            ? settings.data.distanceLandblocks * LAND_BLOCK_SIZE
            : 0,
        enabled: this.currentCameraMode === CameraMode.Flying,
      },
      this.#getLighting(),
    );

    this.sceneRenderer?.resize(this.canvas.width, this.canvas.height);

    // Set uniforms based on camera type
    this.#setUniforms();
  }

  #getLighting() {
    const { directionX, directionY, directionZ, lightIntensity: intensity } =
      settings.data;
    const length = Math.hypot(directionX, directionY, directionZ);
    const direction =
      length > 0
        ? ([directionX / length, directionY / length, directionZ / length] as [
            number,
            number,
            number,
          ])
        : ([0, 0, 1] as [number, number, number]);
    let regionLighting: SceneLighting;
    try {
      regionLighting = this.#sceneGeometry.datClient.getRegionLighting();
    } catch {
      regionLighting = {
        direction: [0, 0, 1] as [number, number, number],
        sunlight: [1, 1, 1] as [number, number, number],
        ambient: [0.25, 0.25, 0.25] as [number, number, number],
      };
    }
    return {
      direction,
      sunlight: regionLighting.sunlight.map((value) => value * intensity) as [
        number,
        number,
        number,
      ],
      ambient: regionLighting.ambient,
    };
  }

  #ensureTerrainInstanceCapacity(count: number) {
    if (count <= this.#terrainInstanceCapacity) return;

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.#terrainInstanceBuffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new Float32Array(count * 2),
      this.gl.DYNAMIC_DRAW,
    );
    this.#terrainInstanceCapacity = count;
  }

  #setUniforms() {
    this.gl.useProgram(this.program);
    this.gl.uniformMatrix4fv(
      this.#xWorldLoc!,
      false,
      this.currentCamera.FrameTransform,
    );
    const minZoomForTextures =
      this.currentCameraMode === CameraMode.Camera2D
        ? Math.max(
            settings.data.minZoomForTextures,
            (Math.sqrt(this.minTerrainTextureCellArea) *
              settings.data.renderScale) /
              TERRAIN_CELL_SIZE,
          )
        : settings.data.minZoomForTextures;
    this.gl.uniform1f(this.#minZoomForTexturesLoc!, minZoomForTextures);
    this.gl.uniform1i(
      this.#terrainGridEnabledLoc!,
      settings.data.terrainGridEnabled ? 1 : 0,
    );
    if (this.currentCameraMode === CameraMode.Camera2D) {
      // 2D camera specific uniforms
      const camera2D = this.currentCamera as Camera2D;
      this.gl.uniform1f(this.#scaleLoc!, camera2D.Zoom);

      this.gl.uniform1i(this.#cameraMode, 0);

      const topLeft = camera2D.ScreenToWorld(new Vector3(0, 0, 1));
      const bottomRight = camera2D.ScreenToWorld(
        new Vector3(this.canvas.width, this.canvas.height, 1),
      );
      const minX = Math.max(
        0,
        Math.floor(Math.min(topLeft.x, bottomRight.x) / LAND_BLOCK_SIZE),
      );
      const visibleMinY = Math.min(topLeft.y, bottomRight.y);
      const visibleMaxY = Math.max(topLeft.y, bottomRight.y);
      const minY = Math.max(
        0,
        Math.floor((camera2D.MapSize.y - visibleMaxY) / LAND_BLOCK_SIZE),
      );
      const maxX = Math.min(
        LAND_BLOCK_SIDE,
        Math.ceil(Math.max(topLeft.x, bottomRight.x) / LAND_BLOCK_SIZE),
      );
      const maxY = Math.min(
        LAND_BLOCK_SIDE,
        Math.ceil((camera2D.MapSize.y - visibleMinY) / LAND_BLOCK_SIZE),
      );
      const countX = Math.max(1, maxX - minX);
      const countY = Math.max(1, maxY - minY);
      this.#visibleLandblockCount = countX * countY;
      // The terrain VAO has a per-instance attribute even though 2D derives
      // the landblock position from gl_InstanceID. Keep its buffer large
      // enough for the instanced draw on the initial 2D frame as well as
      // after switching back from 3D.
      this.#ensureTerrainInstanceCapacity(this.#visibleLandblockCount);
      this.gl.uniform4f(this.#renderViewLoc!, minX, minY, countX, countY);
    } else {
      // Flying camera specific uniforms
      this.gl.uniform1f(this.#scaleLoc!, 1.0);
      this.gl.uniform1i(this.#cameraMode, 1);
      const centerX = Math.max(
        0,
        Math.min(
          254,
          Math.floor(this.flyingCamera.Position.x / LAND_BLOCK_SIZE),
        ),
      );
      const centerY = mapYToLandBlock(this.flyingCamera.Position.y);
      const radius = settings.data.distanceLandblocks;
      const frustum = this.currentCamera.FrameFrustum;
      const instances: number[] = [];
      for (
        let y = Math.max(0, centerY - radius);
        y <= Math.min(254, centerY + radius);
        y++
      ) {
        const worldMinY = MAP_SIZE - (y + 1) * LAND_BLOCK_SIZE;
        const worldMaxY = MAP_SIZE - y * LAND_BLOCK_SIZE;
        for (
          let x = Math.max(0, centerX - radius);
          x <= Math.min(254, centerX + radius);
          x++
        ) {
          if (
            !intersectsFrustum(
              {
                minimum: [x * LAND_BLOCK_SIZE, worldMinY, 0],
                maximum: [
                  (x + 1) * LAND_BLOCK_SIZE,
                  worldMaxY,
                  this.maxTerrainHeight,
                ],
              },
              frustum,
            )
          ) {
            continue;
          }
          instances.push(x, y);
        }
      }
      this.#visibleLandblockCount = instances.length / 2;
      this.#ensureTerrainInstanceCapacity(this.#visibleLandblockCount);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.#terrainInstanceBuffer);
      this.gl.bufferSubData(
        this.gl.ARRAY_BUFFER,
        0,
        new Float32Array(instances),
      );
      this.gl.uniform4f(
        this.#renderViewLoc!,
        0,
        0,
        LAND_BLOCK_SIDE,
        LAND_BLOCK_SIDE,
      );
    }

    if (this.#hasTerrainTextureDirty) {
      this.gl.uniform1fv(
        this.#hasTerrainTextureLoc,
        new Float32Array(this.hasTerrainTexture),
      );
      this.#hasTerrainTextureDirty = false;
    }
    const fogEnabled = this.currentCameraMode === CameraMode.Flying;
    const fogEnd = settings.data.distanceLandblocks * LAND_BLOCK_SIZE;
    const fogStart = Math.max(0, fogEnd - LAND_BLOCK_SIZE);
    this.gl.uniform3f(
      this.gl.getUniformLocation(this.program!, "cameraPosition"),
      this.currentCamera.Position.x,
      this.currentCamera.Position.y,
      this.currentCamera.Position.z,
    );
    this.gl.uniform3f(
      this.gl.getUniformLocation(this.program!, "fogColor"),
      29 / 255,
      34 / 255,
      60 / 255,
    );
    this.gl.uniform1f(
      this.gl.getUniformLocation(this.program!, "fogStart"),
      fogStart,
    );
    this.gl.uniform1f(
      this.gl.getUniformLocation(this.program!, "fogEnd"),
      fogEnd,
    );
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program!, "fogEnabled"),
      fogEnabled ? 1 : 0,
    );
    this.gl.uniform3f(
      this.gl.getUniformLocation(this.program!, "lightDirection"),
      ...this.sceneView.lighting.direction,
    );
    this.gl.uniform3f(
      this.gl.getUniformLocation(this.program!, "sunlightColor"),
      ...this.sceneView.lighting.sunlight,
    );
    this.gl.uniform3f(
      this.gl.getUniformLocation(this.program!, "ambientColor"),
      ...this.sceneView.lighting.ambient,
    );
  }

  #updateOverlay() {
    const geometries = this.#geometries();
    const isLoading = geometries.some(
      (geometry) =>
        geometry.pendingApiRequestCount > 0 ||
        geometry.pendingGpuUploadCount > 0,
    );
    this.#loadingSpinner?.classList.toggle("visible", isLoading);
    this.#updateLoadingDetails(geometries);
    if (this.#sceneGeometry.sceneLoadState === "error") {
      this.loader.textContent = `Unable to load terrain: ${this.#sceneGeometry.sceneLoadError}`;
    }
    if (this.#serverGeometry?.sceneLoadState === "error") {
      this.loader.textContent = `Unable to load server overlay: ${this.#serverGeometry.sceneLoadError}`;
    }
    this.#monitorFrameCount++;
    const now = performance.now();
    const elapsed = now - this.#monitorFrameStarted;
    if (elapsed >= 500) {
      const fps = (this.#monitorFrameCount * 1000) / elapsed;
      if (this.#monitorFps) this.#monitorFps.textContent = fps.toFixed(1);
      this.#monitorFrameCount = 0;
      this.#monitorFrameStarted = now;
    }
  }

  #updateLoadingDetails(geometries: SceneGeometryRenderer[]): void {
    if (!this.#loadingDetails) return;

    const sections = geometries
      .map((geometry, index) => {
        const load = geometry.loadDiagnostics;
        const name = index === 0 ? "Terrain" : "Server overlay";
        const waitRows: [string, number][] = [
          ["Network requests", load.httpRequests],
          ["Queued batches", load.queuedBatches],
          ["Cache reads", load.cacheReads],
          ["Data worker", load.processorRequests],
          ["Meshes", load.meshes],
          ["Baked meshes", load.bakedMeshes],
          ["Materials", load.materials],
          ["GPU uploads", geometry.pendingGpuUploadCount],
        ];
        const rows = waitRows
          .filter(([, count]) => count > 0)
          .map(
            ([label, count]) =>
              `<div class="loading-details-row"><span>${label}</span><span>${count}</span></div>`,
          )
          .join("");

        return rows.length > 0
          ? `<div class="loading-details-section"><div class="loading-details-title">${name}</div>${rows}</div>`
          : "";
      })
      .join("");

    this.#loadingDetails.innerHTML = sections || "Nothing pending";
  }

  draw(dt: number) {
    if (!this.#terrainReady) {
      this.#updateOverlay();
      return;
    }

    const numVerts =
      TERRAIN_CELLS_PER_LAND_BLOCK * TERRAIN_CELLS_PER_LAND_BLOCK * 2 * 3;
    const numInstances = this.#visibleLandblockCount;

    const submissions = this.#submissions;
    submissions.length = 0;
    this.#sceneGeometry.render(
      this.currentCamera,
      this.currentCameraMode,
      settings.data.minZoomFor3DObjects,
      this.currentCameraMode === CameraMode.Flying
        ? settings.data.distanceLandblocks
        : undefined,
      (submission) => submissions.push(submission),
    );
    this.#serverGeometry?.render(
      this.currentCamera,
      this.currentCameraMode,
      settings.data.minZoomFor3DObjects,
      this.currentCameraMode === CameraMode.Flying
        ? settings.data.distanceLandblocks
        : undefined,
      (submission) => submissions.push(submission),
    );

    submissions.push({
      key: {
        renderClass: "opaque",
        programVariant: "terrain",
        cullState: "none",
        meshBatch: 0,
        material: 0,
        sampler: "clamp",
        parity: false,
      },
      instanceCount: numInstances,
      draw: (view) => this.#drawTerrainBatch(view, numVerts, numInstances),
    });

    this.sceneRenderer.render(this.sceneView, submissions);
    this.#labels?.update(
      this.currentCamera,
      this.currentCameraMode === CameraMode.Flying
        ? settings.data.distanceLandblocks * LAND_BLOCK_SIZE
        : undefined,
    );

    this.#updateOverlay();
    if (this.#geometries().some((geometry) => geometry.pendingApiRequestCount > 0)) {
      this.invalidate("resource publication");
    }
  }

  #geometries(): SceneGeometryRenderer[] {
    return this.#serverGeometry
      ? [this.#sceneGeometry, this.#serverGeometry]
      : [this.#sceneGeometry];
  }

  #drawTerrainBatch(
    view: SceneView,
    numVerts: number,
    numInstances: number,
  ): void {
    if (
      !this.program ||
      !this.#terrainVao ||
      !this.#dataTexture ||
      !this.#terrainTextureArray ||
      !this.#alphaTextureArray
    )
      return;
    if (view.cameraMode === CameraMode.Camera2D && this.#useTerrainOverview()) {
      this.#drawTerrainOverview(view);
      return;
    }
    const gl = this.gl;
    invalidateSceneDrawState(gl);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.#xWorldLoc, false, view.viewProjection);
    gl.uniform1i(
      this.#cameraMode,
      view.cameraMode === CameraMode.Camera2D ? 0 : 1,
    );
    gl.uniform1i(this.#terrainGridEnabledLoc, settings.data.terrainGridEnabled ? 1 : 0);
    gl.uniform3f(this.#cameraPositionLoc, ...view.cameraPosition);
    gl.uniform3f(this.#fogColorLoc, ...view.fog.color);
    gl.uniform1f(this.#fogStartLoc, view.fog.start);
    gl.uniform1f(this.#fogEndLoc, view.fog.end);
    gl.uniform1i(this.#fogEnabledLoc, view.fog.enabled ? 1 : 0);
    gl.uniform3f(this.#lightDirectionLoc, ...view.lighting.direction);
    gl.uniform3f(this.#sunlightColorLoc, ...view.lighting.sunlight);
    gl.uniform3f(this.#ambientColorLoc, ...view.lighting.ambient);
    gl.activeTexture(gl.TEXTURE0 + this.#dataTexture.textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, this.#dataTexture.texture);
    gl.activeTexture(gl.TEXTURE0 + this.#terrainTextureArray.textureUnit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.#terrainTextureArray.texture);
    gl.activeTexture(gl.TEXTURE0 + this.#alphaTextureArray.textureUnit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.#alphaTextureArray.texture);
    gl.bindVertexArray(this.#terrainVao);
    const terrainDepthBias = view.cameraMode === CameraMode.Camera2D;
    if (terrainDepthBias) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
    }
    gl.drawArraysInstanced(gl.TRIANGLES, 0, numVerts, numInstances);
    if (terrainDepthBias) gl.disable(gl.POLYGON_OFFSET_FILL);
  }

  #useTerrainOverview(): boolean {
    const cellPixels =
      (TERRAIN_CELL_SIZE * this.camera2D.Zoom) / settings.data.renderScale;
    return cellPixels * cellPixels <= this.minTerrainTextureCellArea;
  }

  #drawTerrainOverview(view: SceneView): void {
    if (!this.#overviewProgram || !this.#terrainVao || !this.#overviewTexture) {
      return;
    }
    const gl = this.gl;
    gl.useProgram(this.#overviewProgram);
    gl.uniformMatrix4fv(this.#overviewXWorldLoc, false, view.viewProjection);
    gl.uniform1i(this.#overviewTextureLoc, this.#overviewTextureUnit);
    gl.activeTexture(gl.TEXTURE0 + this.#overviewTextureUnit);
    gl.bindTexture(gl.TEXTURE_2D, this.#overviewTexture);
    gl.bindVertexArray(this.#terrainVao);
    const depthTest = gl.isEnabled(gl.DEPTH_TEST);
    const depthMask = gl.getParameter(gl.DEPTH_WRITEMASK) as boolean;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.depthMask(depthMask);
    if (depthTest) gl.enable(gl.DEPTH_TEST);
  }

  #setTerrainCatalogUniforms(program: WebGLProgram): void {
    const catalog = this.#dataTexture.catalog;
    if (!catalog) throw new Error("Terrain blend catalog is unavailable");
    const alphaIds = [
      ...new Set(
        [
          ...catalog.cornerMasks,
          ...catalog.sideMasks,
          ...catalog.roadMasks,
        ].map((mask) => mask.textureId),
      ),
    ];
    const setMasks = (
      name: string,
      masks: { code: number; textureId: number }[],
    ) => {
      if (masks.length > 32)
        throw new Error(`${name} terrain mask catalog is too large`);
      const layers = masks.map((mask) => alphaIds.indexOf(mask.textureId));
      if (layers.some((layer) => layer < 0))
        throw new Error(
          `${name} terrain mask catalog references a missing texture`,
        );
      this.gl.uniform1i(
        this.gl.getUniformLocation(program, `${name}MaskCount`),
        masks.length,
      );
      this.gl.uniform1iv(
        this.gl.getUniformLocation(program, `${name}MaskCodes[0]`),
        new Int32Array(masks.map((mask) => mask.code)),
      );
      this.gl.uniform1iv(
        this.gl.getUniformLocation(program, `${name}MaskLayers[0]`),
        new Int32Array(layers),
      );
    };
    this.gl.useProgram(program);
    this.gl.uniform1fv(
      this.gl.getUniformLocation(program, "terrainTiling[0]"),
      new Float32Array(
        catalog.surfaces.map((surface) => surface.textureTiling),
      ),
    );
    setMasks("corner", catalog.cornerMasks);
    setMasks("side", catalog.sideMasks);
    setMasks("road", catalog.roadMasks);
  }

  #updateFlyingFarPlane(): void {
    this.flyingCamera.Far = Math.max(
      4096,
      settings.data.distanceLandblocks * LAND_BLOCK_SIZE +
        LAND_BLOCK_SIZE * Math.SQRT2 +
        this.maxTerrainHeight,
    );
  }

  throwError(message: string) {
    console.error(`Error: ${message}\n\nCheck console output for more details`);
  }

  // Utility methods for external access
  get currentCameraType(): CameraMode {
    return this.currentCameraMode;
  }

  getCamera2D(): Camera2D {
    return this.camera2D;
  }

  getFlyingCamera(): CameraFlying {
    return this.flyingCamera;
  }

  getCurrentCamera(): BaseCamera {
    return this.currentCamera;
  }
}
