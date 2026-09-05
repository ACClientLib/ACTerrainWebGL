import { Camera2D } from "./cameras/camera2d";
import { CameraFlying } from "./cameras/cameryflying";
import { BaseCamera } from "./cameras/basecamera";
import { CameraMode } from "./cameras/cameramode";
import { Vector3 } from "@math.gl/core";
import * as glhelpers from "./glhelpers";
import {
  AcDatClient,
  ObjectMaterial,
  IndexedChunk,
  IndexedPlacement,
  Mesh,
  SERVER_SPAWNS,
  ENV_CELLS,
  CELL_STATICS,
  SCENERY,
  CELL_SERVER_SPAWNS,
} from "./acdatclient";
import {
  intersectsFrustum,
  intersectsRectangle,
  transformBounds,
  Bounds3,
  FrustumPlanes,
} from "./objectvisibility";
import { Building3DVertSource } from "../shaders/building3d.vert";
import { Building3DFragSource } from "../shaders/building3d.frag";
import { ParticleVertSource } from "../shaders/particle.vert";
import { ParticleFragSource } from "../shaders/particle.frag";
import { BUILDING_TEXTURE_UNIT } from "./dattexture";
import { getSceneDrawState, invalidateSceneDrawState } from "./scenedrawstate";
import {
  LAND_BLOCK_SIZE,
  MAP_SIZE,
  MAX_LAND_BLOCK_INDEX,
  OBJECT_Z_BIAS,
  mapYToLandBlock,
} from "./worldgeometry";
import { LegacyMeshGpuOwner } from "./gpuresources";
import { cullForTransform, type ScenePass, type SceneRenderKey, type SceneSubmission, type SceneSubmissionSink } from "./scenesubmission";
import type { SceneView } from "./sceneview";
import { ParticleSimulation, type ParticleSimulationInstance } from "./particlesimulation";

interface GpuBatch {
  vertexBuffer: WebGLBuffer | null;
  indexBuffer: WebGLBuffer | null;
  vao: WebGLVertexArrayObject | null;
  instanceOffset: number;
  indexCount: number;
  materialResourceId: number;
  material?: ObjectMaterial;
  materialError?: string;
  particles?: import("./acdatclient").ParticleEmitterDescriptor[];
  hasWrappingUVs: boolean;
  cullState: "none" | "front" | "back";
  samplerMode: "clamp" | "repeat";
}

interface GpuMesh {
  id: number;
  batches: GpuBatch[];
}
interface ParticleDrawGroup {
  material: ObjectMaterial;
  data: number[];
  offset: number;
}
interface LoadedChunk {
  x: number;
  y: number;
  chunk: IndexedChunk;
}
interface SceneGroup {
  modelIndex: number;
  parity: boolean;
  placementSegments: IndexedPlacement[][];
  instanceSegments?: Float32Array[];
  instanceCount: number;
}
interface TwoDChunkData {
  itemCount: number;
  groups: Map<string, SceneGroup>;
  buildings: number;
  statics: number;
  serverSpawns: number;
  envCells: number;
  scenery: number;
}
interface Diagnostics {
  visibleChunks: number;
  prefetchedChunks: number;
  visiblePlacements: number;
  visibleBuildings: number;
  visibleStatics: number;
  visibleServerSpawns: number;
  visibleEnvCells: number;
  visibleScenery: number;
  visibleUniqueModels: number;
  instancedBatchCount: number;
  drawCalls: number;
  instanceBufferUploadBytes: number;
  bakedChunkBatchCount: number;
  cacheEvictions: number;
}

export interface SceneLoadDiagnostics {
  httpRequests: number;
  queuedBatches: number;
  cacheReads: number;
  processorRequests: number;
  meshes: number;
  bakedMeshes: number;
  materials: number;
  cacheEnabled: boolean;
  cacheUsageBytes: number;
  cacheQuotaBytes: number;
  cacheBytes: number;
}

const BUILDINGS = 0;
const STATICS = 1;
const MAX_2D_STATIC_FOOTPRINT = 192;
const INSTANCE_FLOATS = 10;
const PARTICLE_INSTANCE_FLOATS = 19;
const MAX_2D_PARTICLE_INSTANCES = 12000;

export class SceneGeometryRenderer {
  loadDistance = 8;

  private program: WebGLProgram | null;
  private instanceBuffer: WebGLBuffer | null;
  private particleBuffer: WebGLBuffer | null;
  private particleQuadBuffer: WebGLBuffer | null;
  private particleVao: WebGLVertexArrayObject | null;
  private particleProgram: WebGLProgram | null;
  private particleUploadData = new Float32Array(0);
  private instanceUploadData = new Float32Array(0);
  private uniforms: {
    xWorld: WebGLUniformLocation | null;
    cameraMode: WebGLUniformLocation | null;
    texture: WebGLUniformLocation | null;
    diffuse: WebGLUniformLocation | null;
    luminosity: WebGLUniformLocation | null;
    opacity: WebGLUniformLocation | null;
    alphaMode: WebGLUniformLocation | null;
    alphaCutoff: WebGLUniformLocation | null;
    renderPass: WebGLUniformLocation | null;
    cameraPosition: WebGLUniformLocation | null;
    fogColor: WebGLUniformLocation | null;
    fogStart: WebGLUniformLocation | null;
    fogEnd: WebGLUniformLocation | null;
    fogEnabled: WebGLUniformLocation | null;
    lightDirection: WebGLUniformLocation | null;
    sunlightColor: WebGLUniformLocation | null;
    ambientColor: WebGLUniformLocation | null;
  };
  private particleUniforms: {
    xWorld: WebGLUniformLocation | null;
    texture: WebGLUniformLocation | null;
    cameraRight: WebGLUniformLocation | null;
    cameraUp: WebGLUniformLocation | null;
    opacity: WebGLUniformLocation | null;
    alphaMode: WebGLUniformLocation | null;
    alphaCutoff: WebGLUniformLocation | null;
    renderPass: WebGLUniformLocation | null;
    cameraPosition: WebGLUniformLocation | null;
    fogColor: WebGLUniformLocation | null;
    fogStart: WebGLUniformLocation | null;
    fogEnd: WebGLUniformLocation | null;
    fogEnabled: WebGLUniformLocation | null;
  };
  private dats: AcDatClient;
  private chunks = new Map<string, LoadedChunk | null>();
  private meshes = new Map<number, GpuMesh | null>();
  private pendingMeshes = new Set<number>();
  private bakedMeshes = new Map<number, GpuMesh | null>();
  private pendingBakedMeshes = new Set<number>();
  private diagnostics: Diagnostics = this.emptyDiagnostics();
  private previousCameraPosition: Vector3 | null = null;
  private frameFrustum: FrustumPlanes | null = null;
  private lastResourceRequest = "";
  private decodeController = new AbortController();
  private cacheGeneration = 0;
  private resourceLoadState: "idle" | "loading" | "ready" | "error" = "idle";
  private resourceLoadError = "";
  private nextResourceRetry = 0;
  private fogDistance = 0;
  private lastEvictionKey = "";
  private pendingEviction: Set<string> | null = null;
  private camera2DVisibleBounds: Bounds3 | null = null;
  private chunkBoundsCache = new WeakMap<IndexedChunk, Bounds3>();
  private placementBoundsCache = new WeakMap<IndexedPlacement, Bounds3>();
  private oversizedStatic2DCache = new WeakMap<IndexedChunk, Set<IndexedPlacement>>();
  private twoDChunkCache = new WeakMap<IndexedChunk, TwoDChunkData>();
  private twoDAggregatedGroups = new Map<string, SceneGroup>();
  private twoDAggregateRangeKey = "";
  private twoDPreparedVisibleKey = "";
  private twoDPreparedSubmissions: SceneSubmission[] = [];
  private twoDPreparedDirty = true;
  private readonly meshOwner: LegacyMeshGpuOwner;
  private readonly commonGroups = new Map<string, { modelIndex: number; parity: boolean; instanceCount: number; offset: number }>();
  private readonly contextLostHandler = (event: Event) => {
    event.preventDefault();
    invalidateSceneDrawState(this.gl);
    this.program = null;
    this.instanceBuffer = null;
    this.particleProgram = null;
    this.particleVao = null;
    this.particleBuffer = null;
    this.particleQuadBuffer = null;
    for (const mesh of [...this.meshes.values(), ...this.bakedMeshes.values()]) {
      if (!mesh) continue;
      for (const batch of mesh.batches) {
        batch.vertexBuffer = null;
        batch.indexBuffer = null;
        batch.vao = null;
        batch.instanceOffset = -1;
      }
    }
  };
  private readonly contextRestoredHandler = () => {
    invalidateSceneDrawState(this.gl);
    this.createProducerResources();
    this.twoDPreparedDirty = true;
  };

  constructor(
    private gl: WebGL2RenderingContext,
    descriptorPath = "v3/dataset",
    cacheNamespace: import("./opfsresourcecacheprotocol").CacheNamespace = "dat",
  ) {
    this.meshOwner = new LegacyMeshGpuOwner(gl);
    const vertex = glhelpers.createShader(
      gl,
      gl.VERTEX_SHADER,
      Building3DVertSource,
    );
    const fragment = glhelpers.createShader(
      gl,
      gl.FRAGMENT_SHADER,
      Building3DFragSource,
    );
    this.program =
      vertex && fragment ? glhelpers.createProgram(gl, vertex, fragment) : null;
    this.instanceBuffer = gl.createBuffer();
    this.particleBuffer = gl.createBuffer();
    const particleVertex = glhelpers.createShader(
      gl,
      gl.VERTEX_SHADER,
      ParticleVertSource,
    );
    const particleFragment = glhelpers.createShader(
      gl,
      gl.FRAGMENT_SHADER,
      ParticleFragSource,
    );
    this.particleProgram =
      particleVertex && particleFragment
        ? glhelpers.createProgram(gl, particleVertex, particleFragment)
        : null;
    this.particleVao = gl.createVertexArray();
    this.particleQuadBuffer = gl.createBuffer();
    if (this.particleQuadBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleQuadBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]),
        gl.STATIC_DRAW,
      );
    }
    this.configureParticleVao();
    this.particleUniforms = {
      xWorld: this.particleProgram
        ? gl.getUniformLocation(this.particleProgram, "xWorld")
        : null,
      texture: this.particleProgram
        ? gl.getUniformLocation(this.particleProgram, "particleTexture")
        : null,
      cameraRight: this.particleProgram
        ? gl.getUniformLocation(this.particleProgram, "cameraRight")
        : null,
      cameraUp: this.particleProgram
        ? gl.getUniformLocation(this.particleProgram, "cameraUp")
        : null,
      opacity: this.particleProgram
        ? gl.getUniformLocation(this.particleProgram, "materialOpacity")
        : null,
      alphaMode: this.particleProgram
        ? gl.getUniformLocation(this.particleProgram, "alphaMode")
        : null,
      alphaCutoff: this.particleProgram
        ? gl.getUniformLocation(this.particleProgram, "alphaCutoff")
        : null,
      renderPass: this.particleProgram
        ? gl.getUniformLocation(this.particleProgram, "renderPass")
        : null,
      cameraPosition: this.particleProgram
        ? gl.getUniformLocation(this.particleProgram, "cameraPosition")
        : null,
      fogColor: this.particleProgram
        ? gl.getUniformLocation(this.particleProgram, "fogColor")
        : null,
      fogStart: this.particleProgram
        ? gl.getUniformLocation(this.particleProgram, "fogStart")
        : null,
      fogEnd: this.particleProgram
        ? gl.getUniformLocation(this.particleProgram, "fogEnd")
        : null,
      fogEnabled: this.particleProgram
        ? gl.getUniformLocation(this.particleProgram, "fogEnabled")
        : null,
    };
    this.uniforms = {
      xWorld: this.program
        ? gl.getUniformLocation(this.program, "xWorld")
        : null,
      cameraMode: this.program
        ? gl.getUniformLocation(this.program, "cameraMode")
        : null,
      texture: this.program
        ? gl.getUniformLocation(this.program, "buildingTexture")
        : null,
      diffuse: this.program
        ? gl.getUniformLocation(this.program, "diffuseAmount")
        : null,
      luminosity: this.program
        ? gl.getUniformLocation(this.program, "luminosity")
        : null,
      opacity: this.program
        ? gl.getUniformLocation(this.program, "opacity")
        : null,
      alphaMode: this.program
        ? gl.getUniformLocation(this.program, "alphaMode")
        : null,
      alphaCutoff: this.program ? gl.getUniformLocation(this.program, "alphaCutoff") : null,
      renderPass: this.program
        ? gl.getUniformLocation(this.program, "renderPass")
        : null,
      cameraPosition: this.program
        ? gl.getUniformLocation(this.program, "cameraPosition")
        : null,
      fogColor: this.program
        ? gl.getUniformLocation(this.program, "fogColor")
        : null,
      fogStart: this.program
        ? gl.getUniformLocation(this.program, "fogStart")
        : null,
      fogEnd: this.program
        ? gl.getUniformLocation(this.program, "fogEnd")
        : null,
      fogEnabled: this.program
        ? gl.getUniformLocation(this.program, "fogEnabled")
        : null,
      lightDirection: this.program ? gl.getUniformLocation(this.program, "lightDirection") : null,
      sunlightColor: this.program ? gl.getUniformLocation(this.program, "sunlightColor") : null,
      ambientColor: this.program ? gl.getUniformLocation(this.program, "ambientColor") : null,
    };
    this.dats = new AcDatClient(gl, undefined, descriptorPath, cacheNamespace);
    gl.canvas.addEventListener("webglcontextlost", this.contextLostHandler, false);
    gl.canvas.addEventListener("webglcontextrestored", this.contextRestoredHandler, false);
  }

  get datClient(): AcDatClient {
    return this.dats;
  }

  get textureProfile(): string {
    return this.dats.textureProfile;
  }

  get datasetDiagnostics(): object {
    return this.dats.datasetDiagnostics;
  }

  isCloseEnough(
    camera: BaseCamera,
    mode: CameraMode,
    minimumZoom: number,
  ): boolean {
    return (
      mode !== CameraMode.Camera2D || (camera as Camera2D).Zoom >= minimumZoom
    );
  }

  clearCache(): Promise<void> {
    this.cacheGeneration++;
    this.decodeController.abort();
    this.decodeController = new AbortController();
    for (const mesh of this.meshes.values()) this.deleteMesh(mesh);
    for (const mesh of this.bakedMeshes.values()) this.deleteMesh(mesh);
    this.meshes.clear();
    this.bakedMeshes.clear();
    this.pendingMeshes.clear();
    this.pendingBakedMeshes.clear();
    this.chunks.clear();
    this.particleSimulations.clear();
    this.particleFrozenData.clear();
    this.particle2DFrozen = false;
    this.particle2DVisibleKey = "";
    this.twoDPreparedVisibleKey = "";
    this.twoDPreparedSubmissions = [];
    this.twoDPreparedDirty = true;
    this.twoDChunkCache = new WeakMap<IndexedChunk, TwoDChunkData>();
    this.twoDAggregatedGroups.clear();
    this.twoDAggregateRangeKey = "";
    this.lastResourceRequest = "";
    this.resourceLoadState = "idle";
    this.resourceLoadError = "";
    this.nextResourceRetry = 0;
    return this.dats.clearCache();
  }

  shutdown(): void {
    this.decodeController.abort();
    this.dats.shutdown();
  }

  terrainData(): Promise<ArrayBuffer> {
    return this.dats.terrainData();
  }
  get apiRequestCount(): number {
    return this.dats.totalRequestCount;
  }
  get pendingApiRequestCount(): number {
    const load = this.loadDiagnostics;
    return (
      load.httpRequests +
      load.queuedBatches +
      load.cacheReads +
      load.processorRequests +
      load.meshes +
      load.bakedMeshes +
      load.materials
    );
  }

  get pendingGpuUploadCount(): number {
    return this.dats.pendingGpuUploadCount;
  }
  get loadDiagnostics(): SceneLoadDiagnostics {
    const load = this.dats.loadDiagnostics;
    return {
      ...load,
      meshes: this.pendingMeshes.size,
      bakedMeshes: this.pendingBakedMeshes.size,
    };
  }
  get frameDiagnostics(): Diagnostics {
    return { ...this.diagnostics };
  }
  get loadedResourceBytes(): number {
    return this.dats.loadedResourceBytes;
  }
  get sceneLoadState(): "idle" | "loading" | "ready" | "error" {
    return this.resourceLoadState;
  }
  get sceneLoadError(): string {
    return this.resourceLoadError;
  }

  render(
    camera: BaseCamera,
    mode: CameraMode,
    minimumZoom: number,
    maximumDistanceLandblocks: number | undefined,
    submissions: SceneSubmissionSink,
  ): void {
    this.meshOwner.beginFrame();
    this.dats.beginFrame();
    if (this.pendingEviction) {
      const retained = this.pendingEviction;
      this.pendingEviction = null;
      this.evictOutside(retained);
    }
    this.refreshMeshHandles();
    this.fogDistance =
      mode === CameraMode.Flying
        ? (maximumDistanceLandblocks ?? this.loadDistance) * LAND_BLOCK_SIZE
        : 0;
    const reason = !this.program
        ? "shader program unavailable"
        : !this.instanceBuffer
          ? "instance buffer unavailable"
          : !this.isCloseEnough(camera, mode, minimumZoom)
            ? `zoom ${mode === CameraMode.Camera2D ? (camera as Camera2D).Zoom : "3D"} < ${minimumZoom}`
            : "";
    if (reason) return;
    this.frameFrustum = mode === CameraMode.Flying ? camera.FrameFrustum : null;
    const visibleBlocks = mode === CameraMode.Camera2D
      ? this.visible2D(camera as Camera2D)
      : this.visible3D(camera as CameraFlying, maximumDistanceLandblocks);
    this.camera2DVisibleBounds = mode === CameraMode.Camera2D
      ? this.screenBounds(camera as Camera2D)
      : null;
    const preloadBlocks =
      mode === CameraMode.Flying ? [] : this.preloadRing(visibleBlocks, camera);
    this.requestChunks(visibleBlocks, preloadBlocks);
    this.diagnostics = this.emptyDiagnostics();
    this.diagnostics.prefetchedChunks = preloadBlocks.length;

    const visible: IndexedPlacement[] = [];
    let visibleBuildings = 0;
    let visibleStatics = 0;
    let visibleServerSpawns = 0;
    let visibleEnvCells = 0;
    let visibleScenery = 0;
    let visiblePlacementCount = 0;
    for (const [x, y] of visibleBlocks) {
      const loaded = this.chunks.get(`${x},${y}`);
      if (!loaded) continue;
      if (
        mode !== CameraMode.Camera2D &&
        !this.chunkVisible(loaded, camera, mode)
      )
        continue;
      this.diagnostics.visibleChunks++;
      if (mode === CameraMode.Camera2D) {
        const chunk = this.twoDChunkData(loaded);
        visiblePlacementCount += chunk.itemCount;
        visibleBuildings += chunk.buildings;
        visibleStatics += chunk.statics;
        visibleServerSpawns += chunk.serverSpawns;
        visibleEnvCells += chunk.envCells;
        visibleScenery += chunk.scenery;
        continue;
      }
      const placements = this.dats.placementsForChunk(loaded.chunk);
      for (const placement of placements) {
        if (!this.placementVisible(placement, loaded, camera, mode))
          continue;
        visible.push(placement);
        if (placement.category === BUILDINGS) visibleBuildings++;
        else if (placement.category === STATICS || placement.category === CELL_STATICS) visibleStatics++;
        else if (placement.category === SERVER_SPAWNS || placement.category === CELL_SERVER_SPAWNS) visibleServerSpawns++;
        else if (placement.category === ENV_CELLS) visibleEnvCells++;
        else if (placement.category === SCENERY) visibleScenery++;
      }
    }
    this.diagnostics.visiblePlacements = mode === CameraMode.Camera2D
      ? visiblePlacementCount
      : visible.length;
    this.diagnostics.visibleBuildings = visibleBuildings;
    this.diagnostics.visibleStatics = visibleStatics;
    this.diagnostics.visibleServerSpawns = visibleServerSpawns;
    this.diagnostics.visibleEnvCells = visibleEnvCells;
    this.diagnostics.visibleScenery = visibleScenery;

    const groups = mode === CameraMode.Camera2D
      ? this.twoDAggregateGroups(visibleBlocks)
      : this.groupVisible3D(visible);
    this.diagnostics.visibleUniqueModels = new Set(
      [...groups.values()].map((group) => group.modelIndex),
    ).size;
    this.diagnostics.instancedBatchCount = [...new Set(
      [...groups.values()].map((group) => group.modelIndex),
    )].reduce(
      (total, items) =>
        total + (this.meshes.get(items)?.batches.length ?? 0),
      0,
    );
    this.prepareCommonSubmissions(camera, mode, groups, visibleBlocks, submissions);
    const retainedKeys = [...visibleBlocks, ...preloadBlocks]
      .map(([x, y]) => `${x},${y}`)
      .sort();
    const evictionKey = retainedKeys.join("|");
    if (evictionKey !== this.lastEvictionKey) {
      this.lastEvictionKey = evictionKey;
      this.pendingEviction = new Set(retainedKeys);
    }
  }

  private groupVisible3D(visible: IndexedPlacement[]): Map<string, SceneGroup> {
    const groups = new Map<string, SceneGroup>();
    for (const placement of visible) {
      if (placement.geometryPath === 1) continue;
      const parity = placement.scale[0] * placement.scale[1] * placement.scale[2] < 0;
      const key = `${placement.modelIndex}:${parity ? 1 : 0}`;
      const group: SceneGroup = groups.get(key) ?? {
        modelIndex: placement.modelIndex,
        parity,
        placementSegments: [[]],
        instanceCount: 0,
      };
      group.placementSegments[0].push(placement);
      group.instanceCount++;
      groups.set(key, group);
    }
    return groups;
  }

  private twoDAggregateGroups(visibleBlocks: [number, number][]): Map<string, SceneGroup> {
    const rangeKey = visibleBlocks.map(([x, y]) => `${x},${y}`).join("|");
    if (rangeKey === this.twoDAggregateRangeKey) return this.twoDAggregatedGroups;

    const groups = new Map<string, SceneGroup>();
    for (const [x, y] of visibleBlocks) {
      const key = `${x},${y}`;
      const loaded = this.chunks.get(key);
      if (!loaded) continue;
      for (const [groupKey, chunkGroup] of this.twoDChunkData(loaded).groups) {
        const existing = groups.get(groupKey);
        if (existing) {
          existing.placementSegments.push(...chunkGroup.placementSegments);
          existing.instanceSegments!.push(...chunkGroup.instanceSegments!);
          existing.instanceCount += chunkGroup.instanceCount;
        } else {
          groups.set(groupKey, {
            modelIndex: chunkGroup.modelIndex,
            parity: chunkGroup.parity,
            placementSegments: [...chunkGroup.placementSegments],
            instanceSegments: [...chunkGroup.instanceSegments!],
            instanceCount: chunkGroup.instanceCount,
          });
        }
      }
    }
    this.twoDAggregatedGroups = groups;
    this.twoDAggregateRangeKey = rangeKey;
    return this.twoDAggregatedGroups;
  }

  private prepareCommonSubmissions(
    camera: BaseCamera,
    mode: CameraMode,
    groups: Map<string, SceneGroup>,
    visibleBlocks: [number, number][],
    submit: SceneSubmissionSink,
  ): void {
    const now = performance.now() * 0.001;
    const deltaTime = this.particleLastFrameTime === 0 ? 1 / 60 : Math.max(0, now - this.particleLastFrameTime);
    this.particleLastFrameTime = now;
    this.particleFrameDeltaTime = deltaTime;
    const visibleKey = visibleBlocks.map(([x, y]) => `${x},${y}`).join("|");
    const preparedKey = mode === CameraMode.Camera2D
      ? `${visibleKey}|zoom:${(camera as Camera2D).Zoom}`
      : visibleKey;
    if (mode === CameraMode.Camera2D &&
        preparedKey === this.twoDPreparedVisibleKey &&
        !this.twoDPreparedDirty) {
      for (const submission of this.twoDPreparedSubmissions) submit(submission);
      return;
    }
    if (mode !== CameraMode.Camera2D || visibleKey !== this.twoDPreparedVisibleKey) {
      this.twoDPreparedDirty = mode === CameraMode.Camera2D;
    }
    if (mode !== CameraMode.Camera2D || visibleKey !== this.particle2DVisibleKey) {
      this.particle2DFrozen = mode === CameraMode.Camera2D;
      this.particleFrozenData.clear();
    }
    this.particle2DVisibleKey = mode === CameraMode.Camera2D ? visibleKey : "";
    this.particleSimulationSeen.clear();
    this.commonGroups.clear();
    for (const group of this.particleGroups.values()) group.data.length = 0;
    const preparedSubmissions: SceneSubmission[] = [];
    const preparedSubmit: SceneSubmissionSink = (submission) => {
      preparedSubmissions.push(submission);
      submit(submission);
    };
    let particleInstancesRemaining = mode === CameraMode.Camera2D
      ? MAX_2D_PARTICLE_INSTANCES
      : Number.POSITIVE_INFINITY;
    const drawableGroups: { key: string; group: SceneGroup; mesh: GpuMesh }[] = [];
    let requiredFloats = 0;
    for (const [key, group] of groups) {
      const mesh = this.meshes.get(group.modelIndex);
      if (mesh === undefined) {
        this.requestMesh(group.modelIndex);
        continue;
      }
      if (!mesh) continue;
      drawableGroups.push({ key, group, mesh });
      requiredFloats += group.instanceCount * INSTANCE_FLOATS;
    }
    if (this.instanceUploadData.length < requiredFloats) {
      this.instanceUploadData = new Float32Array(Math.max(requiredFloats, this.instanceUploadData.length * 2, INSTANCE_FLOATS * 64));
    }
    let instanceOffset = 0;
    for (const { key, group, mesh } of drawableGroups) {
      const groupOffset = instanceOffset;
      this.commonGroups.set(key, { modelIndex: group.modelIndex, parity: group.parity, instanceCount: group.instanceCount, offset: groupOffset });
      if (group.instanceSegments) {
        let floatOffset = groupOffset;
        for (const data of group.instanceSegments) {
          this.instanceUploadData.set(data, floatOffset);
          floatOffset += data.length;
        }
      } else {
        let itemOffset = 0;
        for (const placements of group.placementSegments) {
          for (const placement of placements) {
            this.writePlacementInstance(this.instanceUploadData, groupOffset + itemOffset * INSTANCE_FLOATS, placement);
            itemOffset++;
          }
        }
      }
      instanceOffset += group.instanceCount * INSTANCE_FLOATS;
      for (let batchIndex = 0; batchIndex < mesh.batches.length; batchIndex++) {
        const batch = mesh.batches[batchIndex];
        if (!batch.material || batch.materialError) continue;
        if (!batch.particles && batch.indexCount > 0) {
          this.emitCommonMeshSubmission(key, batch, batchIndex, group.instanceCount, preparedSubmit);
        }
        if (batch.particles) {
          for (let segmentIndex = 0; segmentIndex < group.placementSegments.length && particleInstancesRemaining > 0; segmentIndex++) {
            particleInstancesRemaining -= this.appendParticlesForGroup(
              batch,
              group.placementSegments[segmentIndex],
              `${group.modelIndex}:${group.parity ? 1 : 0}:${batchIndex}:${segmentIndex}`,
              particleInstancesRemaining,
              mode === CameraMode.Camera2D && this.particle2DFrozen,
            );
          }
        }
      }
    }
    requiredFloats = instanceOffset;
    const bakedResult = this.prepareCommonBaked(
      camera,
      mode,
      visibleBlocks,
      preparedSubmit,
      requiredFloats,
      particleInstancesRemaining,
    );
    requiredFloats = bakedResult.offset;
    particleInstancesRemaining = bakedResult.particleInstancesRemaining;
    if (requiredFloats > 0) {
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, this.instanceUploadData.subarray(0, requiredFloats), this.gl.DYNAMIC_DRAW);
      this.diagnostics.instanceBufferUploadBytes += requiredFloats * Float32Array.BYTES_PER_ELEMENT;
    }
    let particleFloats = 0;
    for (const [material, group] of this.particleGroups) {
      if (group.data.length === 0) {
        this.particleGroups.delete(material);
        continue;
      }
      group.offset = particleFloats;
      particleFloats += group.data.length;
    }
    if (particleFloats > 0 && this.particleBuffer) {
      if (this.particleUploadData.length < particleFloats) {
        this.particleUploadData = new Float32Array(Math.max(particleFloats, this.particleUploadData.length * 2, PARTICLE_INSTANCE_FLOATS * 64));
      }
      for (const group of this.particleGroups.values()) {
        this.particleUploadData.set(group.data, group.offset);
      }
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.particleBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, this.particleUploadData.subarray(0, particleFloats), this.gl.DYNAMIC_DRAW);
    }
    for (const [material, group] of this.particleGroups) {
      if (group.data.length === 0) continue;
      const renderClass = material.alphaMode === "additive" ? "additive" : material.alphaMode === "cutout" ? "masked" : material.alphaMode === "blended" ? "sourceOver" : "opaque";
      preparedSubmit({
        key: { renderClass, programVariant: "particle", cullState: "none", meshBatch: -1, material: material.indexedMaterialResourceId ?? -1, sampler: "clamp", parity: false },
        instanceCount: group.data.length / PARTICLE_INSTANCE_FLOATS,
        draw: (view, pass) => this.drawCommonParticle(view, group, pass),
      });
    }
    for (const key of this.particleSimulations.keys()) {
      if (!this.particleSimulationSeen.has(key)) {
        this.particleSimulations.delete(key);
        this.particleFrozenData.delete(key);
      }
    }
    for (const key of this.particleFrozenData.keys()) {
      if (!this.particleSimulationSeen.has(key)) this.particleFrozenData.delete(key);
    }
    if (mode === CameraMode.Camera2D) {
      this.twoDPreparedVisibleKey = preparedKey;
      this.twoDPreparedSubmissions = preparedSubmissions;
      this.twoDPreparedDirty = false;
    } else {
      this.twoDPreparedVisibleKey = "";
      this.twoDPreparedSubmissions = [];
      this.twoDPreparedDirty = true;
    }
  }

  private emitCommonMeshSubmission(groupKey: string, batch: GpuBatch, batchIndex: number, instanceCount: number, submit: SceneSubmissionSink): void {
    const group = this.commonGroups.get(groupKey)!;
    const material = batch.material!;
    const renderClass: SceneRenderKey["renderClass"] = material.alphaMode === "cutout" ? "masked" : material.alphaMode === "blended" ? "sourceOver" : material.alphaMode === "additive" ? "additive" : "opaque";
    submit({
      key: { renderClass, programVariant: "world-geometry", cullState: cullForTransform(batch.cullState, group.parity), meshBatch: group.modelIndex * 65536 + batchIndex, material: batch.materialResourceId, sampler: batch.samplerMode, parity: group.parity },
      instanceCount,
      draw: (view, pass) => this.drawCommonMesh(view, group, batch, pass),
    });
  }

  private drawCommonMesh(view: SceneView, group: { modelIndex: number; instanceCount: number; offset: number }, batch: GpuBatch, pass: ScenePass): void {
    if (!batch.material || !batch.vao) return;
    const gl = this.gl;
    const state = getSceneDrawState(gl);
    if (!state.valid || state.program !== this.program) {
      state.valid = true;
      state.program = this.program;
      state.meshPass = null;
      state.meshBatch = null;
      state.meshMaterial = null;
      state.meshInstanceOffset = -1;
      state.particlePass = null;
      state.particleMaterial = null;
      state.particleOffset = -1;
      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.uniforms.xWorld, false, view.viewProjection);
      gl.uniform1i(this.uniforms.cameraMode, view.cameraMode === CameraMode.Camera2D ? 0 : 1);
      gl.uniform3f(this.uniforms.cameraPosition, ...view.cameraPosition);
      gl.uniform3f(this.uniforms.fogColor, ...view.fog.color);
      gl.uniform1f(this.uniforms.fogStart, view.fog.start);
      gl.uniform1f(this.uniforms.fogEnd, view.fog.end);
      gl.uniform1i(this.uniforms.fogEnabled, view.fog.enabled ? 1 : 0);
      gl.uniform3f(this.uniforms.lightDirection, ...view.lighting.direction);
      gl.uniform3f(this.uniforms.sunlightColor, ...view.lighting.sunlight);
      gl.uniform3f(this.uniforms.ambientColor, ...view.lighting.ambient);
      gl.uniform1i(this.uniforms.texture, BUILDING_TEXTURE_UNIT);
      gl.uniform1i(this.uniforms.renderPass, pass === "additive" ? 1 : pass === "revealage" ? 2 : pass === "fallback" ? 3 : pass === "opaque" ? 4 : 0);
      gl.activeTexture(gl.TEXTURE0 + BUILDING_TEXTURE_UNIT);
    }
    if (state.meshPass !== pass) {
      state.meshPass = pass;
      state.meshBatch = null;
      state.meshMaterial = null;
      gl.uniform1i(this.uniforms.renderPass, pass === "additive" ? 1 : pass === "revealage" ? 2 : pass === "fallback" ? 3 : pass === "opaque" ? 4 : 0);
    }
    if (state.meshMaterial !== batch.material) {
      state.meshMaterial = batch.material;
      gl.bindTexture(gl.TEXTURE_2D, batch.material.texture);
      gl.uniform1f(this.uniforms.diffuse, batch.material.diffuse);
      gl.uniform1f(this.uniforms.luminosity, batch.material.luminosity);
      gl.uniform1f(this.uniforms.opacity, batch.material.opacity);
      gl.uniform1f(this.uniforms.alphaCutoff, batch.material.alphaCutoff);
      gl.uniform1i(this.uniforms.alphaMode, batch.material.alphaMode === "cutout" ? 1 : batch.material.alphaMode === "blended" ? 2 : batch.material.alphaMode === "additive" ? 3 : 0);
    }
    if (state.meshBatch !== batch) {
      state.meshBatch = batch;
      state.meshInstanceOffset = -1;
      gl.bindVertexArray(batch.vao);
    }
    if (state.meshInstanceOffset !== group.offset) {
      state.meshInstanceOffset = group.offset;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      const byteOffset = group.offset * Float32Array.BYTES_PER_ELEMENT;
      gl.vertexAttribPointer(3, 3, gl.FLOAT, false, INSTANCE_FLOATS * 4, byteOffset);
      gl.vertexAttribPointer(4, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, byteOffset + 12);
      gl.vertexAttribPointer(5, 3, gl.FLOAT, false, INSTANCE_FLOATS * 4, byteOffset + 28);
    }
    gl.drawElementsInstanced(gl.TRIANGLES, batch.indexCount, gl.UNSIGNED_INT, 0, group.instanceCount);
    this.diagnostics.drawCalls++;
  }

  private prepareCommonBaked(
    camera: BaseCamera,
    mode: CameraMode,
    visibleBlocks: [number, number][],
    submit: SceneSubmissionSink,
    offset: number,
    particleInstancesRemaining: number,
  ): { offset: number; particleInstancesRemaining: number } {
    const groups = new Map<number, { mesh: GpuMesh; items: { placement: IndexedPlacement; x: number; y: number }[]; offset: number }>();
    for (const [x, y] of visibleBlocks) {
      const loaded = this.chunks.get(`${x},${y}`);
      if (!loaded || (mode !== CameraMode.Camera2D && !this.chunkVisible(loaded, camera, mode))) continue;
      for (const baked of loaded.chunk.bakedMeshes) {
        const mesh = this.bakedMeshes.get(baked.resourceId);
        if (mesh === undefined) { this.requestBakedMesh(baked.resourceId); continue; }
        if (!mesh) continue;
        let group = groups.get(baked.resourceId);
        if (!group) {
          group = { mesh, items: [], offset };
          groups.set(baked.resourceId, group);
        }
        for (let batchIndex = 0; batchIndex < mesh.batches.length; batchIndex++) {
          const batch = mesh.batches[batchIndex];
          if (!batch.particles || !batch.material) continue;
          const particleGroup: ParticleDrawGroup = this.particleGroups.get(batch.material) ?? { material: batch.material, data: [], offset: 0 };
          this.particleGroups.set(batch.material, particleGroup);
          particleInstancesRemaining -= this.appendParticleInstances(
            particleGroup.data,
            batch.particles,
            // Baked particle descriptors already contain absolute world
            // coordinates after BakedChunkBuilder transforms them.
            0,
            0,
            0,
            [0, 0, 0, 1],
            [1, 1, 1],
            `baked:${baked.resourceId}:${x}:${y}:${batchIndex}`,
            particleInstancesRemaining,
            mode === CameraMode.Camera2D && this.particle2DFrozen,
          );
        }
        const instanceOffset = offset;
        if (this.instanceUploadData.length < instanceOffset + INSTANCE_FLOATS) {
          this.instanceUploadData = new Float32Array(Math.max(instanceOffset + INSTANCE_FLOATS, this.instanceUploadData.length * 2, INSTANCE_FLOATS * 64));
        }
        this.instanceUploadData[instanceOffset] = x * LAND_BLOCK_SIZE;
        this.instanceUploadData[instanceOffset + 1] = y * LAND_BLOCK_SIZE;
        this.instanceUploadData[instanceOffset + 2] = 0;
        this.instanceUploadData[instanceOffset + 6] = 1;
        this.instanceUploadData[instanceOffset + 7] = 1;
        this.instanceUploadData[instanceOffset + 8] = 1;
        this.instanceUploadData[instanceOffset + 9] = 1;
        group.items.push({ placement: { category: ENV_CELLS, geometryPath: 1, modelIndex: baked.resourceId, origin: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, x, y });
        offset += INSTANCE_FLOATS;
      }
    }
    for (const [resourceId, group] of groups) {
      for (let batchIndex = 0; batchIndex < group.mesh.batches.length; batchIndex++) {
        const batch = group.mesh.batches[batchIndex];
        if (!batch.material || batch.materialError || batch.particles || batch.indexCount === 0) continue;
        const renderClass: SceneRenderKey["renderClass"] = batch.material.alphaMode === "cutout" ? "masked" : batch.material.alphaMode === "blended" ? "sourceOver" : batch.material.alphaMode === "additive" ? "additive" : "opaque";
        submit({ key: { renderClass, programVariant: "world-baked", cullState: batch.cullState, meshBatch: 0x40000000 | resourceId * 256 + batchIndex, material: batch.materialResourceId, sampler: batch.samplerMode, parity: false }, instanceCount: group.items.length, draw: (view, pass) => this.drawCommonMesh(view, { modelIndex: resourceId, instanceCount: group.items.length, offset: group.offset }, batch, pass) });
      }
    }
    return { offset, particleInstancesRemaining };
  }


  private appendParticlesForGroup(
    batch: GpuBatch,
    placements: IndexedPlacement[],
    groupKey: string,
    maxInstances: number,
    freeze: boolean,
  ): number {
    if (!batch.particles || !batch.material || maxInstances <= 0) return 0;
    const group: ParticleDrawGroup = this.particleGroups.get(batch.material) ?? { material: batch.material, data: [], offset: 0 };
    this.particleGroups.set(batch.material, group);
    let appended = 0;
    for (let itemIndex = 0; itemIndex < placements.length; itemIndex++) {
      if (appended >= maxInstances) break;
      const placement = placements[itemIndex];
      appended += this.appendParticleInstances(
        group.data,
        batch.particles,
        placement.origin[0],
        placement.origin[1],
        placement.origin[2],
        placement.rotation,
        placement.scale,
        `${groupKey}:${itemIndex}`,
        maxInstances - appended,
        freeze,
      );
    }
    return appended;
  }

  private drawCommonParticle(view: SceneView, group: ParticleDrawGroup, pass: ScenePass): void {
    if (!this.particleBuffer || !this.particleProgram || !this.particleVao || !this.particleQuadBuffer) return;
    const gl = this.gl;
    const state = getSceneDrawState(gl);
    if (!state.valid || state.program !== this.particleProgram) {
      state.valid = true;
      state.program = this.particleProgram;
      state.meshPass = null;
      state.meshBatch = null;
      state.meshMaterial = null;
      state.particlePass = null;
      state.particleMaterial = null;
      state.particleOffset = -1;
      gl.useProgram(this.particleProgram);
      gl.bindVertexArray(this.particleVao);
      gl.uniformMatrix4fv(this.particleUniforms.xWorld, false, view.viewProjection);
      gl.uniform3f(this.particleUniforms.cameraRight, ...view.particleRight);
      gl.uniform3f(this.particleUniforms.cameraUp, ...view.particleUp);
      gl.uniform3f(this.particleUniforms.cameraPosition, ...view.cameraPosition);
      gl.uniform3f(this.particleUniforms.fogColor, ...view.fog.color);
      gl.uniform1f(this.particleUniforms.fogStart, view.fog.start);
      gl.uniform1f(this.particleUniforms.fogEnd, view.fog.end);
      gl.uniform1i(this.particleUniforms.fogEnabled, view.fog.enabled ? 1 : 0);
      gl.uniform1i(this.particleUniforms.texture, BUILDING_TEXTURE_UNIT);
      gl.uniform1i(this.particleUniforms.renderPass, pass === "additive" ? 1 : pass === "revealage" ? 2 : pass === "fallback" ? 3 : 0);
      gl.activeTexture(gl.TEXTURE0 + BUILDING_TEXTURE_UNIT);
    }
    if (state.particlePass !== pass) {
      state.particlePass = pass;
      state.particleMaterial = null;
      gl.uniform1i(this.particleUniforms.renderPass, pass === "additive" ? 1 : pass === "revealage" ? 2 : pass === "fallback" ? 3 : 0);
    }
    if (state.particleOffset !== group.offset) {
      state.particleOffset = group.offset;
      this.configureParticleInstanceAttributes(group.offset);
    }
    if (state.particleMaterial !== group.material) {
      state.particleMaterial = group.material;
      // Materials can briefly retain their old handle while the texture registry
      // restores or evicts the underlying GPU texture. Never bind an invalid
      // handle; the material will be refreshed by AcDatClient on a later frame.
      gl.bindTexture(gl.TEXTURE_2D, group.material.texture);
      gl.uniform1f(this.particleUniforms.opacity, group.material.opacity);
      gl.uniform1f(this.particleUniforms.alphaCutoff, group.material.alphaCutoff);
      gl.uniform1i(this.particleUniforms.alphaMode, group.material.alphaMode === "cutout" ? 1 : group.material.alphaMode === "blended" ? 2 : group.material.alphaMode === "additive" ? 3 : 0);
    }
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, group.data.length / PARTICLE_INSTANCE_FLOATS);
    this.diagnostics.drawCalls++;
  }

  private requestChunks(
    visibleBlocks: [number, number][],
    preloadBlocks: [number, number][],
  ): void {
    // The preload list is sorted by camera movement, so its order can change
    // while the requested set stays the same. Use a canonical key to avoid
    // aborting an otherwise valid load on every movement/zoom event.
    const requestKey = [...visibleBlocks, ...preloadBlocks]
      .map(([x, y]) => `${x},${y}`)
      .sort()
      .join("|");
    if (requestKey === this.lastResourceRequest) return;
    if (performance.now() < this.nextResourceRetry) return;
    this.decodeController.abort();
    this.decodeController = new AbortController();
    const generation = this.cacheGeneration;
    this.lastResourceRequest = requestKey;
    this.resourceLoadState = "loading";
    this.resourceLoadError = "";
    this.dats
      .loadVisible(visibleBlocks, preloadBlocks)
      .then(() => {
        if (generation === this.cacheGeneration) {
          visibleBlocks.forEach(([x, y]) => {
            const chunk = this.dats.chunk(x, y);
            this.chunks.set(`${x},${y}`, chunk ? { x, y, chunk } : null);
          });
          this.twoDAggregateRangeKey = "";
          this.twoDPreparedDirty = true;
          if (this.lastResourceRequest === requestKey) {
            this.resourceLoadState = "ready";
            this.nextResourceRetry = 0;
          }
        }
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError"))
          console.error("Unable to load ACTerrain scene resources", error);
        if (
          generation === this.cacheGeneration &&
          this.lastResourceRequest === requestKey
        ) {
          this.lastResourceRequest = "";
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            this.resourceLoadState = "error";
            this.resourceLoadError =
              error instanceof Error ? error.message : String(error);
            this.nextResourceRetry = performance.now() + 5000;
          }
        }
      });
  }

  private requestMesh(modelIndex: number): void {
    if (this.pendingMeshes.has(modelIndex)) return;
    const generation = this.cacheGeneration;
    this.pendingMeshes.add(modelIndex);
    this.dats
      .mesh(modelIndex, this.decodeController.signal)
      .then((mesh) => {
        if (generation === this.cacheGeneration) {
          this.meshes.set(
            modelIndex,
            this.uploadMesh(modelIndex, mesh),
          );
          this.twoDPreparedDirty = true;
        }
      })
      .catch((error) => {
        if (
          generation === this.cacheGeneration &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          console.error(
            `Unable to load ACTerrain model index ${modelIndex}`,
            error,
          );
          this.meshes.set(modelIndex, null);
          this.twoDPreparedDirty = true;
        }
      })
      .finally(() => {
        if (generation === this.cacheGeneration)
          this.pendingMeshes.delete(modelIndex);
      });
  }

  private requestBakedMesh(resourceId: number): void {
    if (this.pendingBakedMeshes.has(resourceId)) return;
    const generation = this.cacheGeneration;
    this.pendingBakedMeshes.add(resourceId);
    this.dats
      .bakedMesh(resourceId, this.decodeController.signal)
      .then((mesh) => {
        if (generation === this.cacheGeneration) {
          this.bakedMeshes.set(
            resourceId,
            this.uploadMesh(0x40000000 | resourceId, mesh),
          );
          this.twoDPreparedDirty = true;
        }
      })
      .catch((error) => {
        if (
          generation === this.cacheGeneration &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          console.error(
            `Unable to load ACTerrain baked chunk ${resourceId}`,
            error,
          );
          this.bakedMeshes.set(resourceId, null);
          this.twoDPreparedDirty = true;
        }
      })
      .finally(() => {
        if (generation === this.cacheGeneration)
          this.pendingBakedMeshes.delete(resourceId);
      });
  }

  private uploadMesh(id: number, source: Mesh): GpuMesh {
    const gpu = this.meshOwner.upload(id, source, true);
    const batches = source.batches.map((item, index) => {
      const buffers = gpu.batches[index];
      const batch: GpuBatch = {
        vertexBuffer: buffers.vertexBuffer!,
        indexBuffer: buffers.indexBuffer!,
        vao: null,
        instanceOffset: -1,
        indexCount: item.indices?.length ?? 0,
        materialResourceId: item.materialResourceId,
        particles: item.particles,
        hasWrappingUVs: item.hasWrappingUVs === true,
        cullState: item.cullState ?? "none",
        samplerMode: item.samplerMode ?? (item.hasWrappingUVs === true ? "repeat" : "clamp"),
      };
      batch.vao = this.createBatchVao(batch);
      this.dats
        .material(item.materialResourceId)
        .then((material) => {
          batch.material = material;
          this.twoDPreparedDirty = true;
        })
        .catch((error) => {
          batch.materialError = String(error);
          this.twoDPreparedDirty = true;
          console.error("Unable to load ACTerrain material", {
            materialResourceId: item.materialResourceId,
            textureProfile: this.dats.textureProfile,
            error,
          });
        });
      return batch;
    });
    return { id, batches };
  }

  private particleGroups = new Map<ObjectMaterial, ParticleDrawGroup>();
  private particleSimulations = new Map<string, ParticleSimulation>();
  private particleSimulationSeen = new Set<string>();
  private particleLastFrameTime = 0;
  private particleFrameDeltaTime = 1 / 60;
  private particle2DFrozen = false;
  private particle2DVisibleKey = "";
  private particleFrozenData = new Map<string, number[]>();

  private appendParticleInstances(
    data: number[],
    particles: import("./acdatclient").ParticleEmitterDescriptor[],
    originX: number,
    originY: number,
    originZ: number,
    rotation: [number, number, number, number],
    scale: [number, number, number],
    simulationKey: string,
    maxInstances: number,
    freeze: boolean,
  ): number {
    if (maxInstances <= 0) return 0;
    let appended = 0;
    for (let descriptorIndex = 0; descriptorIndex < particles.length; descriptorIndex++) {
      if (appended >= maxInstances) break;
      const descriptor = particles[descriptorIndex];
      const key = `${simulationKey}:${descriptorIndex}:${descriptor.hookIndex}:${descriptor.seed}`;
      let simulation = this.particleSimulations.get(key);
      if (!simulation) {
        simulation = new ParticleSimulation(descriptor);
        this.particleSimulations.set(key, simulation);
      }
      if (this.particleSimulationSeen.has(key)) continue;
      this.particleSimulationSeen.add(key);
      const cached = freeze ? this.particleFrozenData.get(key) : undefined;
      if (cached) {
        const count = Math.min(
          cached.length,
          (maxInstances - appended) * PARTICLE_INSTANCE_FLOATS,
        );
        for (let index = 0; index < count; index++) data.push(cached[index]);
        appended += count / PARTICLE_INSTANCE_FLOATS;
        continue;
      }
      const instances = simulation.update(
        this.particleFrameDeltaTime,
        [originX, originY, originZ],
        rotation,
        scale,
        maxInstances - appended,
      );
      const frozen = freeze ? [] : null;
      for (const instance of instances) {
        if (frozen) this.appendParticleInstance(frozen, instance);
        this.appendParticleInstance(data, instance);
      }
      if (frozen) this.particleFrozenData.set(key, frozen);
      appended += instances.length;
    }
    return appended;
  }

  private appendParticleInstance(data: number[], instance: ParticleSimulationInstance): void {
    const fullBillboard = instance.billboard === 1;
    const cameraAligned = instance.billboard > 0.5;
    const sizeX = fullBillboard ? instance.dimensions[0] : instance.planeSize[0];
    const sizeY = fullBillboard ? instance.dimensions[2] : instance.planeSize[1];
    let centerX = instance.position[0];
    let centerY = instance.position[1];
    let centerZ = instance.position[2];
    if (fullBillboard) {
      centerZ += instance.centerOffset[2] * instance.scale;
    } else {
      const q = instance.rotation;
      const v0 = instance.centerOffset[0] * instance.scale;
      const v1 = instance.centerOffset[1] * instance.scale;
      const v2 = instance.centerOffset[2] * instance.scale;
      const tx = 2 * (q[1] * v2 - q[2] * v1);
      const ty = 2 * (q[2] * v0 - q[0] * v2);
      const tz = 2 * (q[0] * v1 - q[1] * v0);
      centerX += v0 + q[3] * tx + q[1] * tz - q[2] * ty;
      centerY += v1 + q[3] * ty + q[2] * tx - q[0] * tz;
      centerZ += v2 + q[3] * tz + q[0] * ty - q[1] * tx;
    }
    data.push(
      centerX, centerY, centerZ,
      instance.scale,
      instance.opacity, 0, 0,
      sizeX, 0, sizeY,
      instance.planeOrientation[0], instance.planeOrientation[1], instance.planeOrientation[2], instance.planeOrientation[3],
      instance.rotation[0], instance.rotation[1], instance.rotation[2], instance.rotation[3], cameraAligned ? instance.billboard : 0,
    );
  }

  private normalize(v: [number, number, number]): [number, number, number] { const n = Math.hypot(v[0], v[1], v[2]); return n < 0.0002 ? [0, 0, 0] : [v[0] / n, v[1] / n, v[2] / n]; }
  private rotate(q: [number, number, number, number], v: [number, number, number]): [number, number, number] { const t = [2 * (q[1] * v[2] - q[2] * v[1]), 2 * (q[2] * v[0] - q[0] * v[2]), 2 * (q[0] * v[1] - q[1] * v[0])]; return [v[0] + q[3] * t[0] + q[1] * t[2] - q[2] * t[1], v[1] + q[3] * t[1] + q[2] * t[0] - q[0] * t[2], v[2] + q[3] * t[2] + q[0] * t[1] - q[1] * t[0]]; }
  private mulQuat(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] { return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]]; }
  private add(a: [number, number, number], b: [number, number, number]): [number, number, number] { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  private mul(a: [number, number, number], s: number): [number, number, number] { return [a[0] * s, a[1] * s, a[2] * s]; }
  private lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
  private clamp(a: number, min: number, max: number): number { return Math.max(min, Math.min(max, a)); }

  private particleDepth(data: number[], camera: BaseCamera): number {
    if (data.length < 3) return 0;
    const dx = data[0] - camera.Position.x;
    const dy = MAP_SIZE - data[1] - camera.Position.y;
    const dz = data[2] - camera.Position.z;
    return dx * dx + dy * dy + dz * dz;
  }

  private placementVisible(
    placement: IndexedPlacement,
    loaded: LoadedChunk,
    camera: BaseCamera,
    mode: CameraMode,
  ): boolean {
    const model = this.dats.model(placement.modelIndex);
    if (!model) return false;
    if (mode !== CameraMode.Camera2D) {
      return this.frameFrustum
        ? intersectsFrustum(
            this.placementBounds(placement, loaded, model.bounds),
            this.frameFrustum,
          )
        : true;
    }
    const bounds = this.placementBounds(placement, loaded, model.bounds);
    return this.camera2DVisibleBounds
      ? intersectsRectangle(
          bounds,
          new Vector3(...this.camera2DVisibleBounds.minimum),
          new Vector3(...this.camera2DVisibleBounds.maximum),
        )
      : true;
  }

  private twoDChunkData(loaded: LoadedChunk): TwoDChunkData {
    const cached = this.twoDChunkCache.get(loaded.chunk);
    if (cached) return cached;
    const placements = this.dats.placementsForChunk(loaded.chunk);
    const oversizedStatics = this.oversizedStatics2D(loaded, placements);
    const data: TwoDChunkData = {
      itemCount: 0,
      groups: new Map<string, SceneGroup>(),
      buildings: 0,
      statics: 0,
      serverSpawns: 0,
      envCells: 0,
      scenery: 0,
    };
    for (const placement of placements) {
      if (placement.category === CELL_STATICS || placement.category === CELL_SERVER_SPAWNS) continue;
      if (oversizedStatics.has(placement)) continue;
      data.itemCount++;
      if (placement.category === BUILDINGS) data.buildings++;
      else if (placement.category === STATICS) data.statics++;
      else if (placement.category === SERVER_SPAWNS) data.serverSpawns++;
      else if (placement.category === ENV_CELLS) data.envCells++;
      else if (placement.category === SCENERY) data.scenery++;
      if (placement.geometryPath === 1) continue;
      const parity = placement.scale[0] * placement.scale[1] * placement.scale[2] < 0;
      const key = `${placement.modelIndex}:${parity ? 1 : 0}`;
      const group: SceneGroup = data.groups.get(key) ?? {
        modelIndex: placement.modelIndex,
        parity,
        placementSegments: [[]],
        instanceCount: 0,
      };
      group.placementSegments[0].push(placement);
      group.instanceCount++;
      data.groups.set(key, group);
    }
    for (const group of data.groups.values()) {
      const instances = new Float32Array(group.instanceCount * INSTANCE_FLOATS);
      const placements = group.placementSegments[0];
      for (let index = 0; index < placements.length; index++) {
        this.writePlacementInstance(instances, index * INSTANCE_FLOATS, placements[index]);
      }
      group.instanceSegments = [instances];
    }
    this.twoDChunkCache.set(loaded.chunk, data);
    return data;
  }

  private writePlacementInstance(target: Float32Array, base: number, placement: IndexedPlacement): void {
    target[base] = placement.origin[0];
    target[base + 1] = placement.origin[1];
    target[base + 2] = placement.origin[2] + OBJECT_Z_BIAS;
    target[base + 3] = placement.rotation[0];
    target[base + 4] = placement.rotation[1];
    target[base + 5] = placement.rotation[2];
    target[base + 6] = placement.rotation[3];
    target[base + 7] = placement.scale[0];
    target[base + 8] = placement.scale[1];
    target[base + 9] = placement.scale[2];
  }

  private oversizedStatics2D(
    loaded: LoadedChunk,
    placements: IndexedPlacement[],
  ): Set<IndexedPlacement> {
    const cached = this.oversizedStatic2DCache.get(loaded.chunk);
    if (cached) return cached;
    const oversized = new Set<IndexedPlacement>();
    for (const placement of placements) {
      if (placement.category !== STATICS) continue;
      const model = this.dats.model(placement.modelIndex);
      if (!model) continue;
      const bounds = this.placementBounds(placement, loaded, model.bounds);
      if (
        bounds.maximum[0] - bounds.minimum[0] > MAX_2D_STATIC_FOOTPRINT ||
        bounds.maximum[1] - bounds.minimum[1] > MAX_2D_STATIC_FOOTPRINT
      ) {
        oversized.add(placement);
      }
    }
    this.oversizedStatic2DCache.set(loaded.chunk, oversized);
    return oversized;
  }

  private visible2D(camera: Camera2D): [number, number][] {
    const a = camera.ScreenToWorld(new Vector3(0, 0, 1));
    const b = camera.ScreenToWorld(
      new Vector3(camera.ViewportSize.x, camera.ViewportSize.y, 1),
    );
    return this.range(
      Math.max(0, Math.floor(Math.min(a.x, b.x) / LAND_BLOCK_SIZE)),
      Math.min(
        MAX_LAND_BLOCK_INDEX,
        Math.floor(Math.max(a.x, b.x) / LAND_BLOCK_SIZE),
      ),
      Math.max(
        0,
        Math.floor((MAP_SIZE - Math.max(a.y, b.y)) / LAND_BLOCK_SIZE),
      ),
      Math.min(
        MAX_LAND_BLOCK_INDEX,
        Math.floor((MAP_SIZE - Math.min(a.y, b.y)) / LAND_BLOCK_SIZE),
      ),
    );
  }

  private visible3D(
    camera: CameraFlying,
    maximumDistanceLandblocks?: number,
  ): [number, number][] {
    const radius = Math.min(
      this.loadDistance,
      maximumDistanceLandblocks ?? this.loadDistance,
    );
    const centerX = Math.max(
      0,
      Math.min(
        MAX_LAND_BLOCK_INDEX,
        Math.floor(camera.Position.x / LAND_BLOCK_SIZE),
      ),
    );
    const centerY = mapYToLandBlock(camera.Position.y);
    const candidates = this.range(
      Math.max(0, centerX - radius),
      Math.min(MAX_LAND_BLOCK_INDEX, centerX + radius),
      Math.max(0, centerY - radius),
      Math.min(MAX_LAND_BLOCK_INDEX, centerY + radius),
    );
    const visible = candidates.filter(([x, y]) =>
      !this.frameFrustum || intersectsFrustum(this.landBlockBounds(x, y), this.frameFrustum),
    );
    const center = camera.Position;
    visible.sort((a, b) => {
      const adx = a[0] * LAND_BLOCK_SIZE + LAND_BLOCK_SIZE / 2 - center.x;
      const ady = MAP_SIZE - (a[1] * LAND_BLOCK_SIZE + LAND_BLOCK_SIZE / 2) - center.y;
      const bdx = b[0] * LAND_BLOCK_SIZE + LAND_BLOCK_SIZE / 2 - center.x;
      const bdy = MAP_SIZE - (b[1] * LAND_BLOCK_SIZE + LAND_BLOCK_SIZE / 2) - center.y;
      return adx * adx + ady * ady - bdx * bdx - bdy * bdy;
    });
    return visible;
  }

  private landBlockBounds(x: number, y: number): Bounds3 {
    return {
      minimum: [x * LAND_BLOCK_SIZE, MAP_SIZE - (y + 1) * LAND_BLOCK_SIZE, -4096],
      maximum: [(x + 1) * LAND_BLOCK_SIZE, MAP_SIZE - y * LAND_BLOCK_SIZE, 4096],
    };
  }

  private setFogUniforms(
    uniforms: {
      cameraPosition: WebGLUniformLocation | null;
      fogColor: WebGLUniformLocation | null;
      fogStart: WebGLUniformLocation | null;
      fogEnd: WebGLUniformLocation | null;
      fogEnabled: WebGLUniformLocation | null;
    },
    camera: BaseCamera,
  ): void {
    this.gl.uniform3f(
      uniforms.cameraPosition,
      camera.Position.x,
      camera.Position.y,
      camera.Position.z,
    );
    this.gl.uniform3f(uniforms.fogColor, 29 / 255, 34 / 255, 60 / 255);
    this.gl.uniform1f(
      uniforms.fogStart,
      Math.max(0, this.fogDistance - LAND_BLOCK_SIZE),
    );
    this.gl.uniform1f(uniforms.fogEnd, this.fogDistance);
    this.gl.uniform1i(uniforms.fogEnabled, this.fogDistance > 0 ? 1 : 0);
  }

  private preloadRing(
    visible: [number, number][],
    camera: BaseCamera,
  ): [number, number][] {
    if (visible.length === 0) return [];
    const keys = new Set(visible.map(([x, y]) => `${x},${y}`));
    const result: [number, number][] = [];
    const distance = 1;
    const position = camera.Position;
    const previous = this.previousCameraPosition;
    const movement = previous
      ? position.clone().subtract(previous)
      : new Vector3(0, 0, 0);
    this.previousCameraPosition = position.clone();
    const minX = Math.max(0, Math.min(...visible.map(([x]) => x)) - distance);
    const maxX = Math.min(
      MAX_LAND_BLOCK_INDEX,
      Math.max(...visible.map(([x]) => x)) + distance,
    );
    const minY = Math.max(0, Math.min(...visible.map(([, y]) => y)) - distance);
    const maxY = Math.min(
      MAX_LAND_BLOCK_INDEX,
      Math.max(...visible.map(([, y]) => y)) + distance,
    );
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!keys.has(`${x},${y}`)) {
          result.push([x, y]);
        }
      }
    }
    const center = this.currentMapPosition(camera);
    result.sort((a, b) => {
      const adx = a[0] * LAND_BLOCK_SIZE + LAND_BLOCK_SIZE / 2 - center.x;
      const ady =
        a[1] * LAND_BLOCK_SIZE + LAND_BLOCK_SIZE / 2 - (MAP_SIZE - center.y);
      const bdx = b[0] * LAND_BLOCK_SIZE + LAND_BLOCK_SIZE / 2 - center.x;
      const bdy =
        b[1] * LAND_BLOCK_SIZE + LAND_BLOCK_SIZE / 2 - (MAP_SIZE - center.y);
      const directionPriority =
        bdx * movement.x -
        bdy * movement.y -
        (adx * movement.x - ady * movement.y);
      return (
        directionPriority || adx * adx + ady * ady - (bdx * bdx + bdy * bdy)
      );
    });
    return result;
  }

  private currentMapPosition(camera: BaseCamera): Vector3 {
    return camera instanceof CameraFlying
      ? camera.GetMapPosition()
      : camera.Position;
  }

  private chunkBounds(loaded: LoadedChunk): Bounds3 {
    const cached = this.chunkBoundsCache.get(loaded.chunk);
    if (cached) return cached;
    const bounds = transformBounds(
      loaded.chunk.bounds,
      (point) =>
        new Vector3(
          point.x,
          MAP_SIZE - point.y,
          point.z,
        ),
    );
    this.chunkBoundsCache.set(loaded.chunk, bounds);
    return bounds;
  }

  private placementBounds(
    placement: IndexedPlacement,
    loaded: LoadedChunk,
    bounds: Bounds3,
  ): Bounds3 {
    const cached = this.placementBoundsCache.get(placement);
    if (cached) return cached;
    const transformed = transformBounds(bounds, (point) => {
      const scaled = new Vector3(
        point.x * placement.scale[0],
        point.y * placement.scale[1],
        point.z * placement.scale[2],
      );
      const q = placement.rotation;
      const vector = new Vector3(
        q[3] * scaled.x + q[1] * scaled.z - q[2] * scaled.y,
        q[3] * scaled.y + q[2] * scaled.x - q[0] * scaled.z,
        q[3] * scaled.z + q[0] * scaled.y - q[1] * scaled.x,
      );
      const cross = new Vector3(
        q[1] * vector.z - q[2] * vector.y,
        q[2] * vector.x - q[0] * vector.z,
        q[0] * vector.y - q[1] * vector.x,
      );
      return new Vector3(
        placement.origin[0] +
          scaled.x +
          2 * cross.x,
        MAP_SIZE -
          (placement.origin[1] + scaled.y + 2 * cross.y),
        placement.origin[2] + scaled.z + 2 * cross.z,
      );
    });
    this.placementBoundsCache.set(placement, transformed);
    return transformed;
  }

  private chunkVisible(
    loaded: LoadedChunk,
    camera: BaseCamera,
    mode: CameraMode,
  ): boolean {
    if (mode === CameraMode.Camera2D) {
      return this.camera2DVisibleBounds
        ? intersectsRectangle(
            this.chunkBounds(loaded),
            new Vector3(...this.camera2DVisibleBounds.minimum),
            new Vector3(...this.camera2DVisibleBounds.maximum),
          )
        : true;
    }
    return this.frameFrustum
      ? intersectsFrustum(this.chunkBounds(loaded), this.frameFrustum)
      : true;
  }

  private screenBounds(camera: Camera2D): Bounds3 {
    const a = camera.ScreenToWorld(new Vector3(0, 0, 1));
    const b = camera.ScreenToWorld(
      new Vector3(camera.ViewportSize.x, camera.ViewportSize.y, 1),
    );
    return {
      minimum: [Math.min(a.x, b.x), Math.min(a.y, b.y), -4096],
      maximum: [Math.max(a.x, b.x), Math.max(a.y, b.y), 4096],
    };
  }

  private evictOutside(retained: Set<string>): void {
    const retainedModels = new Set<number>();
    const retainedBaked = new Set<number>();
    for (const key of retained) {
      const loaded = this.chunks.get(key);
      if (!loaded) continue;
      for (const placement of this.dats.placementsForChunk(loaded.chunk))
        retainedModels.add(placement.modelIndex);
      for (const baked of loaded.chunk.bakedMeshes)
        retainedBaked.add(baked.resourceId);
    }
    let chunksChanged = false;
    for (const [key] of this.chunks) {
      if (retained.has(key)) continue;
      this.chunks.delete(key);
      chunksChanged = true;
    }
    if (chunksChanged) {
      this.twoDAggregateRangeKey = "";
      this.twoDPreparedDirty = true;
    }
    for (const [modelIndex, mesh] of this.meshes)
      if (!retainedModels.has(modelIndex)) {
        this.deleteMesh(mesh);
        this.meshes.delete(modelIndex);
        this.diagnostics.cacheEvictions++;
      }
    for (const [resourceId, mesh] of this.bakedMeshes)
      if (!retainedBaked.has(resourceId)) {
        this.deleteMesh(mesh);
        this.bakedMeshes.delete(resourceId);
        this.diagnostics.cacheEvictions++;
      }
  }

  private deleteMesh(mesh: GpuMesh | null | undefined): void {
    if (!mesh) return;
    for (const batch of mesh.batches) {
      if (batch.vao) this.gl.deleteVertexArray(batch.vao);
      batch.vao = null;
    }
    this.meshOwner.remove(mesh.id);
    for (const batch of mesh.batches) {
      this.dats.releaseMaterial(batch.materialResourceId);
    }
  }

  private refreshMeshHandles(): void {
    const refresh = (mesh: GpuMesh) => {
      const current = this.meshOwner.current(mesh.id);
      if (!current) return;
      mesh.batches.forEach((batch, index) => {
        const source = current.batches[index];
        if (!source || batch.vertexBuffer === source.vertexBuffer && batch.indexBuffer === source.indexBuffer) return;
        if (batch.vao) this.gl.deleteVertexArray(batch.vao);
        batch.vertexBuffer = source.vertexBuffer ?? null;
        batch.indexBuffer = source.indexBuffer ?? null;
        batch.instanceOffset = -1;
        batch.vao = this.createBatchVao(batch);
      });
    };
    for (const mesh of this.meshes.values()) if (mesh) refresh(mesh);
    for (const mesh of this.bakedMeshes.values()) if (mesh) refresh(mesh);
  }

  private createProducerResources(): void {
    const gl = this.gl;
    const vertex = glhelpers.createShader(gl, gl.VERTEX_SHADER, Building3DVertSource);
    const fragment = glhelpers.createShader(gl, gl.FRAGMENT_SHADER, Building3DFragSource);
    this.program = vertex && fragment ? glhelpers.createProgram(gl, vertex, fragment) : null;
    this.instanceBuffer = gl.createBuffer();
    const particleVertex = glhelpers.createShader(gl, gl.VERTEX_SHADER, ParticleVertSource);
    const particleFragment = glhelpers.createShader(gl, gl.FRAGMENT_SHADER, ParticleFragSource);
    this.particleProgram = particleVertex && particleFragment ? glhelpers.createProgram(gl, particleVertex, particleFragment) : null;
    this.particleVao = gl.createVertexArray();
    this.particleBuffer = gl.createBuffer();
    this.particleQuadBuffer = gl.createBuffer();
    if (this.particleQuadBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleQuadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    }
    this.configureParticleVao();
    const uniform = (program: WebGLProgram | null, name: string) => program ? gl.getUniformLocation(program, name) : null;
    this.uniforms = {
      xWorld: uniform(this.program, "xWorld"), cameraMode: uniform(this.program, "cameraMode"), texture: uniform(this.program, "buildingTexture"),
      diffuse: uniform(this.program, "diffuseAmount"), luminosity: uniform(this.program, "luminosity"), opacity: uniform(this.program, "opacity"),
      alphaMode: uniform(this.program, "alphaMode"), alphaCutoff: uniform(this.program, "alphaCutoff"), renderPass: uniform(this.program, "renderPass"),
      cameraPosition: uniform(this.program, "cameraPosition"), fogColor: uniform(this.program, "fogColor"), fogStart: uniform(this.program, "fogStart"),
      fogEnd: uniform(this.program, "fogEnd"), fogEnabled: uniform(this.program, "fogEnabled"), lightDirection: uniform(this.program, "lightDirection"),
      sunlightColor: uniform(this.program, "sunlightColor"), ambientColor: uniform(this.program, "ambientColor"),
    };
    this.particleUniforms = {
      xWorld: uniform(this.particleProgram, "xWorld"), texture: uniform(this.particleProgram, "particleTexture"), cameraRight: uniform(this.particleProgram, "cameraRight"),
      cameraUp: uniform(this.particleProgram, "cameraUp"), opacity: uniform(this.particleProgram, "materialOpacity"), alphaMode: uniform(this.particleProgram, "alphaMode"), alphaCutoff: uniform(this.particleProgram, "alphaCutoff"), renderPass: uniform(this.particleProgram, "renderPass"),
      cameraPosition: uniform(this.particleProgram, "cameraPosition"), fogColor: uniform(this.particleProgram, "fogColor"), fogStart: uniform(this.particleProgram, "fogStart"),
      fogEnd: uniform(this.particleProgram, "fogEnd"), fogEnabled: uniform(this.particleProgram, "fogEnabled"),
    };
  }

  private createBatchVao(batch: GpuBatch): WebGLVertexArrayObject | null {
    if (!batch.vertexBuffer || !batch.indexBuffer || !this.instanceBuffer) return null;
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) return null;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.vertexBuffer);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 12);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 24);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, INSTANCE_FLOATS * 4, 0);
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, 12);
    gl.vertexAttribPointer(5, 3, gl.FLOAT, false, INSTANCE_FLOATS * 4, 28);
    for (const location of [0, 1, 2, 3, 4, 5]) gl.enableVertexAttribArray(location);
    gl.vertexAttribDivisor(3, 1);
    gl.vertexAttribDivisor(4, 1);
    gl.vertexAttribDivisor(5, 1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, batch.indexBuffer);
    gl.bindVertexArray(null);
    return vao;
  }

  private configureParticleVao(): void {
    if (!this.particleVao || !this.particleQuadBuffer || !this.particleBuffer) return;
    const gl = this.gl;
    gl.bindVertexArray(this.particleVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleQuadBuffer);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
    this.configureParticleInstanceAttributes(0);
    for (let location = 1; location <= 6; location++) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
  }

  private configureParticleInstanceAttributes(floatOffset: number): void {
    if (!this.particleBuffer) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
    const stride = PARTICLE_INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
    const byteOffset = floatOffset * Float32Array.BYTES_PER_ELEMENT;
    const attributes = [[1, 3, 0], [2, 4, 12], [3, 3, 28], [4, 4, 40], [5, 4, 56], [6, 1, 72]];
    for (const [location, size, offset] of attributes) {
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, byteOffset + offset);
    }
  }

  private range(
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
  ): [number, number][] {
    const result: [number, number][] = [];
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) result.push([x, y]);
    return result;
  }
  private emptyDiagnostics(): Diagnostics {
    return {
      visibleChunks: 0,
      prefetchedChunks: 0,
      visiblePlacements: 0,
      visibleBuildings: 0,
      visibleStatics: 0,
      visibleServerSpawns: 0,
      visibleEnvCells: 0,
      visibleScenery: 0,
      visibleUniqueModels: 0,
      instancedBatchCount: 0,
      drawCalls: 0,
      instanceBufferUploadBytes: 0,
      bakedChunkBatchCount: 0,
      cacheEvictions: 0,
    };
  }
}
