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
} from "./acdatclient";
import {
  intersectsCamera,
  intersectsRectangle,
  transformBounds,
  Bounds3,
} from "./objectvisibility";
import { Building3DVertSource } from "../shaders/building3d.vert";
import { Building3DFragSource } from "../shaders/building3d.frag";
import { ParticleVertSource } from "../shaders/particle.vert";
import { ParticleFragSource } from "../shaders/particle.frag";
import { BUILDING_TEXTURE_UNIT } from "./dattexture";
import {
  LAND_BLOCK_SIZE,
  MAP_SIZE,
  MAX_LAND_BLOCK_INDEX,
  OBJECT_Z_BIAS,
} from "./worldgeometry";
import { LoadingProfiler, type LoadingTimingSnapshot } from "./loadingprofiler";

interface GpuBatch {
  vertexBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  indexCount: number;
  materialResourceId: number;
  material?: ObjectMaterial;
  materialError?: string;
  particles?: import("./acdatclient").ParticleInstance[];
}

interface GpuMesh {
  batches: GpuBatch[];
}
interface ParticleDrawGroup {
  material: ObjectMaterial;
  data: number[];
}
interface LoadedChunk {
  x: number;
  y: number;
  chunk: IndexedChunk;
}
interface Diagnostics {
  visibleChunks: number;
  prefetchedChunks: number;
  visiblePlacements: number;
  visibleBuildings: number;
  visibleStatics: number;
  visibleServerSpawns: number;
  visibleEnvCells: number;
  visibleUniqueModels: number;
  instancedBatchCount: number;
  drawCalls: number;
  instanceBufferUploadBytes: number;
  bakedChunkBatchCount: number;
  cacheEvictions: number;
}

export interface ObjectLoadDiagnostics {
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
const INSTANCE_FLOATS = 10;
const PARTICLE_INSTANCE_FLOATS = 19;

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const scaleVec = (a: Vec3, value: number): Vec3 => [
  a[0] * value,
  a[1] * value,
  a[2] * value,
];
const transformVec = (v: Vec3, q: Quat): Vec3 => {
  const t: Vec3 = [
    2 * (q[1] * v[2] - q[2] * v[1]),
    2 * (q[2] * v[0] - q[0] * v[2]),
    2 * (q[0] * v[1] - q[1] * v[0]),
  ];
  return [
    v[0] + q[3] * t[0] + q[1] * t[2] - q[2] * t[1],
    v[1] + q[3] * t[1] + q[2] * t[0] - q[0] * t[2],
    v[2] + q[3] * t[2] + q[0] * t[1] - q[1] * t[0],
  ];
};
const multiplyQuat = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

export class WorldObjectRenderer {
  loadDistance = 6;

  private program: WebGLProgram | null;
  private vao: WebGLVertexArrayObject | null;
  private instanceBuffer: WebGLBuffer | null;
  private particleBuffer: WebGLBuffer | null;
  private particleQuadBuffer: WebGLBuffer | null;
  private particleVao: WebGLVertexArrayObject | null;
  private particleProgram: WebGLProgram | null;
  private particleUploadData = new Float32Array(0);
  private instanceUploadData = new Float32Array(0);
  private uniforms: {
    xWorld: WebGLUniformLocation | null;
    texture: WebGLUniformLocation | null;
    diffuse: WebGLUniformLocation | null;
    luminosity: WebGLUniformLocation | null;
    opacity: WebGLUniformLocation | null;
  };
  private particleUniforms: {
    xWorld: WebGLUniformLocation | null;
    texture: WebGLUniformLocation | null;
    cameraRight: WebGLUniformLocation | null;
    cameraUp: WebGLUniformLocation | null;
    opacity: WebGLUniformLocation | null;
  };
  private dats: AcDatClient;
  private chunks = new Map<string, LoadedChunk | null>();
  private meshes = new Map<number, GpuMesh | null>();
  private pendingMeshes = new Set<number>();
  private bakedMeshes = new Map<number, GpuMesh | null>();
  private pendingBakedMeshes = new Set<number>();
  private diagnostics: Diagnostics = this.emptyDiagnostics();
  private previousCameraPosition: Vector3 | null = null;
  private lastResourceRequest = "";
  private decodeController = new AbortController();
  private cacheGeneration = 0;
  private resourceLoadState: "idle" | "loading" | "ready" | "error" = "idle";
  private resourceLoadError = "";
  private nextResourceRetry = 0;
  private showParticles = true;
  private chunkBoundsCache = new WeakMap<IndexedChunk, Bounds3>();
  private placementBoundsCache = new WeakMap<IndexedPlacement, Bounds3>();
  private profiler = new LoadingProfiler();

  constructor(private gl: WebGL2RenderingContext) {
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
    this.vao = gl.createVertexArray();
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
    };
    this.uniforms = {
      xWorld: this.program
        ? gl.getUniformLocation(this.program, "xWorld")
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
    };
    this.dats = new AcDatClient(gl);
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
    this.lastResourceRequest = "";
    this.resourceLoadState = "idle";
    this.resourceLoadError = "";
    this.nextResourceRetry = 0;
    return this.dats.clearCache();
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
  get loadDiagnostics(): ObjectLoadDiagnostics {
    const load = this.dats.loadDiagnostics;
    return {
      ...load,
      meshes: this.pendingMeshes.size,
      bakedMeshes: this.pendingBakedMeshes.size,
    };
  }
  get loadTimings(): LoadingTimingSnapshot {
    return { ...this.dats.loadTimings, ...this.profiler.snapshot() };
  }
  get frameDiagnostics(): Diagnostics {
    return { ...this.diagnostics };
  }
  get objectLoadState(): "idle" | "loading" | "ready" | "error" {
    return this.resourceLoadState;
  }
  get objectLoadError(): string {
    return this.resourceLoadError;
  }

  render(
    camera: BaseCamera,
    mode: CameraMode,
    enabled: boolean,
    showServerSpawns: boolean,
    showParticles: boolean,
    minimumZoom: number,
  ): void {
    this.showParticles = showParticles;
    const reason = !enabled
      ? "disabled"
      : !this.program
        ? "shader program unavailable"
        : !this.vao
          ? "VAO unavailable"
          : !this.instanceBuffer
            ? "instance buffer unavailable"
            : !this.isCloseEnough(camera, mode, minimumZoom)
              ? `zoom ${mode === CameraMode.Camera2D ? (camera as Camera2D).Zoom : "3D"} < ${minimumZoom}`
              : "";
    if (reason) return;
    const visibleBlocks =
      mode === CameraMode.Camera2D
        ? this.visible2D(camera as Camera2D)
        : this.visible3D(camera as CameraFlying);
    const preloadBlocks = this.preloadRing(visibleBlocks, camera);
    this.requestChunks(visibleBlocks, preloadBlocks);
    this.diagnostics = this.emptyDiagnostics();
    this.diagnostics.prefetchedChunks = preloadBlocks.length;

    const visible: { placement: IndexedPlacement; x: number; y: number }[] = [];
    let visibleBuildings = 0;
    let visibleStatics = 0;
    let visibleServerSpawns = 0;
    for (const [x, y] of visibleBlocks) {
      const loaded = this.chunks.get(`${x},${y}`);
      if (!loaded) continue;
      if (
        mode !== CameraMode.Camera2D &&
        !this.chunkVisible(loaded, camera, mode)
      )
        continue;
      this.diagnostics.visibleChunks++;
      for (const placement of this.dats.placementsForChunk(loaded.chunk)) {
        if (placement.category === SERVER_SPAWNS && !showServerSpawns) continue;
        if (
          mode !== CameraMode.Camera2D &&
          !this.placementVisible(placement, loaded, camera, mode)
        )
          continue;
        visible.push({ placement, x, y });
        if (placement.category === BUILDINGS) visibleBuildings++;
        else if (placement.category === STATICS) visibleStatics++;
        else if (placement.category === SERVER_SPAWNS) visibleServerSpawns++;
      }
    }
    this.diagnostics.visiblePlacements = visible.length;
    this.diagnostics.visibleBuildings = visibleBuildings;
    this.diagnostics.visibleStatics = visibleStatics;
    this.diagnostics.visibleServerSpawns = visibleServerSpawns;
    this.diagnostics.visibleEnvCells = visible.filter(
      (item) => item.placement.category === ENV_CELLS,
    ).length;

    const groups = new Map<
      number,
      { placement: IndexedPlacement; x: number; y: number }[]
    >();
    for (const item of visible) {
      if (item.placement.geometryPath === 1) continue;
      const group = groups.get(item.placement.modelIndex) ?? [];
      group.push(item);
      groups.set(item.placement.modelIndex, group);
    }
    this.diagnostics.visibleUniqueModels = groups.size;
    this.diagnostics.instancedBatchCount = [...groups.values()].reduce(
      (total, items) =>
        total +
        (this.meshes.get(items[0].placement.modelIndex)?.batches.length ?? 0),
      0,
    );
    const previousActiveTexture = this.gl.getParameter(
      this.gl.ACTIVE_TEXTURE,
    ) as number;
    const previousArrayBuffer = this.gl.getParameter(
      this.gl.ARRAY_BUFFER_BINDING,
    ) as WebGLBuffer | null;
    const previousElementArrayBuffer = this.gl.getParameter(
      this.gl.ELEMENT_ARRAY_BUFFER_BINDING,
    ) as WebGLBuffer | null;
    const depthTestEnabled = this.gl.isEnabled(this.gl.DEPTH_TEST);
    const cullFaceEnabled = this.gl.isEnabled(this.gl.CULL_FACE);
    const blendEnabled = this.gl.isEnabled(this.gl.BLEND);
    const depthWriteEnabled = this.gl.getParameter(
      this.gl.DEPTH_WRITEMASK,
    ) as boolean;
    try {
      this.drawBakedChunks(camera, mode, visibleBlocks, false);
      this.drawGroups(camera, groups, false);
      this.drawBakedChunks(camera, mode, visibleBlocks, true);
      this.drawGroups(camera, groups, true);
    } finally {
      this.gl.depthMask(depthWriteEnabled);
      depthTestEnabled
        ? this.gl.enable(this.gl.DEPTH_TEST)
        : this.gl.disable(this.gl.DEPTH_TEST);
      cullFaceEnabled
        ? this.gl.enable(this.gl.CULL_FACE)
        : this.gl.disable(this.gl.CULL_FACE);
      blendEnabled
        ? this.gl.enable(this.gl.BLEND)
        : this.gl.disable(this.gl.BLEND);
      this.gl.activeTexture(previousActiveTexture);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, previousArrayBuffer);
      this.gl.bindBuffer(
        this.gl.ELEMENT_ARRAY_BUFFER,
        previousElementArrayBuffer,
      );
    }
    this.evictOutside(
      new Set(
        [...visibleBlocks, ...preloadBlocks].map(([x, y]) => `${x},${y}`),
      ),
    );
  }

  private drawGroups(
    camera: BaseCamera,
    groups: Map<
      number,
      { placement: IndexedPlacement; x: number; y: number }[]
    >,
    translucent: boolean,
  ): void {
    const gl = this.gl;
    const previousProgram = gl.getParameter(
      gl.CURRENT_PROGRAM,
    ) as WebGLProgram | null;
    const previousVao = gl.getParameter(
      gl.VERTEX_ARRAY_BINDING,
    ) as WebGLVertexArrayObject | null;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.uniformMatrix4fv(this.uniforms.xWorld, false, camera.FrameTransform);
    gl.uniform1i(this.uniforms.texture, BUILDING_TEXTURE_UNIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    for (const [modelIndex, items] of groups) {
      const mesh = this.meshes.get(modelIndex);
      if (mesh === undefined) {
        this.requestMesh(modelIndex);
        continue;
      }
      if (!mesh) continue;
      this.meshes.delete(modelIndex);
      this.meshes.set(modelIndex, mesh);
      const batches = mesh.batches.filter(
        (batch) =>
          batch.material &&
          !batch.materialError &&
          ((this.showParticles &&
            batch.particles &&
            batch.particles.length > 0) ||
            batch.indexCount > 0) &&
          batch.material.translucent === translucent,
      );
      if (batches.length === 0) continue;
      const requiredFloats = items.length * INSTANCE_FLOATS;
      if (this.instanceUploadData.length < requiredFloats) {
        this.instanceUploadData = new Float32Array(
          Math.max(
            requiredFloats,
            this.instanceUploadData.length * 2,
            INSTANCE_FLOATS * 64,
          ),
        );
      }
      const instances = this.instanceUploadData.subarray(0, requiredFloats);
      items.forEach((item, index) => {
        const placement = item.placement;
        const base = index * INSTANCE_FLOATS;
        // Keep envcell floors slightly above the exterior terrain, matching the
        // existing building-exterior z-fight avoidance offset.
        instances[base] = item.x * LAND_BLOCK_SIZE + placement.origin[0];
        instances[base + 1] = item.y * LAND_BLOCK_SIZE + placement.origin[1];
        instances[base + 2] = placement.origin[2] + OBJECT_Z_BIAS;
        instances[base + 3] = placement.rotation[0];
        instances[base + 4] = placement.rotation[1];
        instances[base + 5] = placement.rotation[2];
        instances[base + 6] = placement.rotation[3];
        instances[base + 7] = placement.scale[0];
        instances[base + 8] = placement.scale[1];
        instances[base + 9] = placement.scale[2];
      });
      gl.bufferData(gl.ARRAY_BUFFER, instances, gl.DYNAMIC_DRAW);
      this.diagnostics.instanceBufferUploadBytes += instances.byteLength;
      for (const batch of batches) {
        if (batch.particles || !batch.vertexBuffer || !batch.indexBuffer)
          continue;
        const material = batch.material!;
        gl.activeTexture(gl.TEXTURE0 + BUILDING_TEXTURE_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, material.texture);
        gl.uniform1f(this.uniforms.diffuse, material.diffuse);
        gl.uniform1f(this.uniforms.luminosity, material.luminosity);
        gl.uniform1f(this.uniforms.opacity, material.opacity);
        if (translucent) {
          gl.enable(gl.BLEND);
          gl.blendFunc(
            gl.SRC_ALPHA,
            material.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA,
          );
          gl.depthMask(false);
        } else {
          gl.disable(gl.BLEND);
          gl.depthMask(true);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, batch.vertexBuffer);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 12);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 24);
        gl.enableVertexAttribArray(0);
        gl.enableVertexAttribArray(1);
        gl.enableVertexAttribArray(2);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
        gl.vertexAttribPointer(3, 3, gl.FLOAT, false, INSTANCE_FLOATS * 4, 0);
        gl.vertexAttribPointer(4, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, 12);
        gl.vertexAttribPointer(5, 3, gl.FLOAT, false, INSTANCE_FLOATS * 4, 28);
        gl.enableVertexAttribArray(3);
        gl.enableVertexAttribArray(4);
        gl.enableVertexAttribArray(5);
        gl.vertexAttribDivisor(3, 1);
        gl.vertexAttribDivisor(4, 1);
        gl.vertexAttribDivisor(5, 1);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, batch.indexBuffer);
        gl.drawElementsInstanced(
          gl.TRIANGLES,
          batch.indexCount,
          gl.UNSIGNED_INT,
          0,
          items.length,
        );
        this.diagnostics.drawCalls++;
      }
      if (this.showParticles) {
        for (const batch of mesh.batches) {
          if (
            !batch.particles ||
            !batch.material ||
            batch.material.translucent !== translucent
          )
            continue;
          const group = this.particleGroups.get(batch.material) ?? {
            material: batch.material,
            data: [],
          };
          this.particleGroups.set(batch.material, group);
          for (const item of items)
            this.appendParticleInstances(
              group.data,
              batch.particles,
              item.x * LAND_BLOCK_SIZE + item.placement.origin[0],
              item.y * LAND_BLOCK_SIZE + item.placement.origin[1],
              item.placement.origin[2],
              item.placement.rotation,
              item.placement.scale,
            );
        }
      }
    }
    this.drawParticleGroups(camera, translucent);
    gl.depthMask(true);
    gl.bindVertexArray(previousVao);
    gl.useProgram(previousProgram);
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
          if (this.lastResourceRequest === requestKey) {
            this.resourceLoadState = "ready";
            this.nextResourceRetry = 0;
          }
        }
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError"))
          console.error("Unable to load ACTerrain object resources", error);
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
        if (generation === this.cacheGeneration)
          this.meshes.set(
            modelIndex,
            this.profiler.measureSync("model upload", () =>
              this.uploadMesh(mesh),
            ),
          );
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
        if (generation === this.cacheGeneration)
          this.bakedMeshes.set(
            resourceId,
            this.profiler.measureSync("baked upload", () =>
              this.uploadMesh(mesh),
            ),
          );
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
        }
      })
      .finally(() => {
        if (generation === this.cacheGeneration)
          this.pendingBakedMeshes.delete(resourceId);
      });
  }

  private drawBakedChunks(
    camera: BaseCamera,
    mode: CameraMode,
    candidates: [number, number][],
    translucent: boolean,
  ): void {
    const gl = this.gl;
    const previousProgram = gl.getParameter(
      gl.CURRENT_PROGRAM,
    ) as WebGLProgram | null;
    const previousVao = gl.getParameter(
      gl.VERTEX_ARRAY_BINDING,
    ) as WebGLVertexArrayObject | null;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.uniformMatrix4fv(this.uniforms.xWorld, false, camera.FrameTransform);
    gl.uniform1i(this.uniforms.texture, BUILDING_TEXTURE_UNIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    for (const [x, y] of candidates) {
      const loaded = this.chunks.get(`${x},${y}`);
      if (!loaded) continue;
      if (
        mode !== CameraMode.Camera2D &&
        !this.chunkVisible(loaded, camera, mode)
      )
        continue;
      for (const baked of loaded.chunk.bakedMeshes) {
        const resourceId = baked.resourceId;
        const mesh = this.bakedMeshes.get(resourceId);
        if (mesh === undefined) {
          this.requestBakedMesh(resourceId);
          continue;
        }
        if (!mesh) continue;
        this.bakedMeshes.delete(resourceId);
        this.bakedMeshes.set(resourceId, mesh);
        const batches = mesh.batches.filter(
          (batch) =>
            batch.material &&
            !batch.materialError &&
            (batch.indexCount > 0 ||
              (this.showParticles &&
                batch.particles &&
                batch.particles.length > 0)) &&
            batch.material.translucent === translucent,
        );
        if (batches.length === 0) continue;
        const instances = new Float32Array([
          x * LAND_BLOCK_SIZE,
          y * LAND_BLOCK_SIZE,
          0,
          0,
          0,
          0,
          1,
          1,
          1,
          1,
        ]);
        gl.bufferData(gl.ARRAY_BUFFER, instances, gl.DYNAMIC_DRAW);
        this.diagnostics.instanceBufferUploadBytes += instances.byteLength;
        this.diagnostics.bakedChunkBatchCount += batches.length;
        for (const batch of batches) {
          const material = batch.material!;
          gl.activeTexture(gl.TEXTURE0 + BUILDING_TEXTURE_UNIT);
          gl.bindTexture(gl.TEXTURE_2D, material.texture);
          gl.uniform1f(this.uniforms.diffuse, material.diffuse);
          gl.uniform1f(this.uniforms.luminosity, material.luminosity);
          gl.uniform1f(this.uniforms.opacity, material.opacity);
          if (translucent) {
            gl.enable(gl.BLEND);
            gl.blendFunc(
              gl.SRC_ALPHA,
              material.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA,
            );
            gl.depthMask(false);
          } else {
            gl.disable(gl.BLEND);
            gl.depthMask(true);
          }
          if (!batch.vertexBuffer || !batch.indexBuffer) continue;
          gl.bindBuffer(gl.ARRAY_BUFFER, batch.vertexBuffer);
          gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
          gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 12);
          gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 24);
          gl.enableVertexAttribArray(0);
          gl.enableVertexAttribArray(1);
          gl.enableVertexAttribArray(2);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
          gl.vertexAttribPointer(3, 3, gl.FLOAT, false, INSTANCE_FLOATS * 4, 0);
          gl.vertexAttribPointer(
            4,
            4,
            gl.FLOAT,
            false,
            INSTANCE_FLOATS * 4,
            12,
          );
          gl.vertexAttribPointer(
            5,
            3,
            gl.FLOAT,
            false,
            INSTANCE_FLOATS * 4,
            28,
          );
          gl.enableVertexAttribArray(3);
          gl.enableVertexAttribArray(4);
          gl.enableVertexAttribArray(5);
          gl.vertexAttribDivisor(3, 1);
          gl.vertexAttribDivisor(4, 1);
          gl.vertexAttribDivisor(5, 1);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, batch.indexBuffer);
          gl.drawElementsInstanced(
            gl.TRIANGLES,
            batch.indexCount,
            gl.UNSIGNED_INT,
            0,
            1,
          );
          this.diagnostics.drawCalls++;
        }
        if (this.showParticles) {
          for (const batch of mesh.batches) {
            if (
              !batch.particles ||
              !batch.material ||
              batch.material.translucent !== translucent
            )
              continue;
            const group = this.particleGroups.get(batch.material) ?? {
              material: batch.material,
              data: [],
            };
            this.particleGroups.set(batch.material, group);
            this.appendParticleInstances(
              group.data,
              batch.particles,
              x * LAND_BLOCK_SIZE,
              y * LAND_BLOCK_SIZE,
              0,
              [0, 0, 0, 1],
              [1, 1, 1],
            );
          }
        }
      }
    }
    this.drawParticleGroups(camera, translucent);
    gl.depthMask(true);
    gl.bindVertexArray(previousVao);
    gl.useProgram(previousProgram);
  }

  private uploadMesh(source: Mesh): GpuMesh {
    const batches = source.batches.map((item) => {
      const vertexBuffer = item.vertices ? this.gl.createBuffer()! : undefined;
      const indexBuffer = item.indices ? this.gl.createBuffer()! : undefined;
      if (vertexBuffer) {
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, vertexBuffer);
        this.gl.bufferData(
          this.gl.ARRAY_BUFFER,
          item.vertices!,
          this.gl.STATIC_DRAW,
        );
      }
      if (indexBuffer) {
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        this.gl.bufferData(
          this.gl.ELEMENT_ARRAY_BUFFER,
          item.indices!,
          this.gl.STATIC_DRAW,
        );
      }
      const batch: GpuBatch = {
        vertexBuffer: vertexBuffer!,
        indexBuffer: indexBuffer!,
        indexCount: item.indices?.length ?? 0,
        materialResourceId: item.materialResourceId,
        particles: item.particles,
      };
      this.dats
        .material(item.materialResourceId)
        .then((material) => (batch.material = material))
        .catch((error) => (batch.materialError = String(error)));
      return batch;
    });
    return { batches };
  }

  private particleGroups = new Map<ObjectMaterial, ParticleDrawGroup>();

  private appendParticleInstances(
    data: number[],
    particles: import("./acdatclient").ParticleInstance[],
    originX: number,
    originY: number,
    originZ: number,
    rotation: [number, number, number, number],
    scale: [number, number, number],
  ): void {
    for (const particle of particles) {
      const centerBase = add(
        [originX, originY, originZ],
        transformVec(mul(particle.center, scale), rotation),
      );
      const dimensions = mul(particle.dimensions, scale);
      const orientation = multiplyQuat(rotation, particle.rotation);
      const centerOffset = particle.billboard
        ? ([0, 0, particle.centerOffset[2] * particle.scale] as [
            number,
            number,
            number,
          ])
        : transformVec(
            scaleVec(particle.centerOffset, particle.scale),
            orientation,
          );
      const center = add(centerBase, centerOffset);
      const height = particle.billboard ? dimensions[2] : dimensions[1];
      data.push(
        center[0],
        center[1],
        center[2],
        particle.scale,
        particle.opacity,
        0,
        0,
        dimensions[0],
        0,
        height,
        particle.planeOrientation[0],
        particle.planeOrientation[1],
        particle.planeOrientation[2],
        particle.planeOrientation[3],
        orientation[0],
        orientation[1],
        orientation[2],
        orientation[3],
        particle.billboard ? 1 : 0,
      );
    }
  }

  private drawParticleGroups(camera: BaseCamera, translucent: boolean): void {
    if (
      !this.particleBuffer ||
      !this.particleProgram ||
      !this.particleVao ||
      !this.particleQuadBuffer
    )
      return;
    if (this.particleGroups.size === 0) return;
    const gl = this.gl;
    gl.useProgram(this.particleProgram);
    gl.bindVertexArray(this.particleVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleQuadBuffer);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribDivisor(0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
    const stride = PARTICLE_INSTANCE_FLOATS * 4;
    const attributes = [
      [1, 3, 0],
      [2, 4, 12],
      [3, 3, 28],
      [4, 4, 40],
      [5, 4, 56],
      [6, 1, 72],
    ];
    for (const [location, size, offset] of attributes) {
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.uniformMatrix4fv(
      this.particleUniforms.xWorld,
      false,
      camera.FrameTransform,
    );
    gl.uniform3f(
      this.particleUniforms.cameraRight,
      camera.ParticleRight.x,
      camera.ParticleRight.y,
      camera.ParticleRight.z,
    );
    gl.uniform3f(
      this.particleUniforms.cameraUp,
      camera.ParticleUp.x,
      camera.ParticleUp.y,
      camera.ParticleUp.z,
    );
    gl.uniform1i(this.particleUniforms.texture, BUILDING_TEXTURE_UNIT);
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    for (const group of this.particleGroups.values()) {
      if (this.particleUploadData.length < group.data.length) {
        this.particleUploadData = new Float32Array(
          Math.max(
            group.data.length,
            this.particleUploadData.length * 2,
            PARTICLE_INSTANCE_FLOATS * 64,
          ),
        );
      }
      const data = this.particleUploadData.subarray(0, group.data.length);
      data.set(group.data);
      gl.bindTexture(gl.TEXTURE_2D, group.material.texture);
      gl.uniform1f(this.particleUniforms.opacity, group.material.opacity);
      gl.blendFunc(
        gl.SRC_ALPHA,
        group.material.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA,
      );
      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(
        gl.TRIANGLES,
        0,
        6,
        data.length / PARTICLE_INSTANCE_FLOATS,
      );
      this.diagnostics.drawCalls++;
      this.diagnostics.instanceBufferUploadBytes += data.byteLength;
    }
    this.particleGroups.clear();
  }

  private placementVisible(
    placement: IndexedPlacement,
    loaded: LoadedChunk,
    camera: BaseCamera,
    mode: CameraMode,
  ): boolean {
    const model = this.dats.model(placement.modelIndex);
    if (!model) return false;
    const bounds = this.placementBounds(placement, loaded, model.bounds);
    if (mode === CameraMode.Camera2D) {
      const c = camera as Camera2D;
      const a = c.ScreenToWorld(new Vector3(0, 0, 1));
      const b = c.ScreenToWorld(
        new Vector3(c.ViewportSize.x, c.ViewportSize.y, 1),
      );
      return intersectsRectangle(
        bounds,
        new Vector3(Math.min(a.x, b.x), Math.min(a.y, b.y), -4096),
        new Vector3(Math.max(a.x, b.x), Math.max(a.y, b.y), 4096),
      );
    }
    return intersectsCamera(bounds, camera.FrameTransform);
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

  private visible3D(camera: CameraFlying): [number, number][] {
    const maximumDistance = this.loadDistance * LAND_BLOCK_SIZE;
    const points = [camera.Position];
    const samples = [
      [0, 0],
      [camera.ViewportSize.x, 0],
      [0, camera.ViewportSize.y],
      [camera.ViewportSize.x, camera.ViewportSize.y],
      [camera.ViewportSize.x / 2, camera.ViewportSize.y / 2],
    ];
    for (const [screenX, screenY] of samples) {
      const ray = camera.ScreenToWorldRay(
        screenX,
        screenY,
        camera.FrameTransform,
        camera.FrameInverseTransform,
      );
      // Keep the full ray endpoint as well as the ground intersection. The
      // ground hit only describes where terrain enters the frustum; using it
      // as the endpoint drops tall objects that are visible beyond that hit.
      const farPoint = ray.origin
        .clone()
        .add(ray.direction.clone().scale(maximumDistance));
      points.push(farPoint);
      if (ray.direction.z < -0.000001) {
        const groundDistance = -ray.origin.z / ray.direction.z;
        if (groundDistance >= 0 && groundDistance <= maximumDistance) {
          points.push(
            ray.origin.clone().add(ray.direction.clone().scale(groundDistance)),
          );
        }
      }
    }
    const minX = Math.max(
      0,
      Math.floor(
        Math.min(...points.map((point) => point.x)) / LAND_BLOCK_SIZE,
      ) - 1,
    );
    const maxX = Math.min(
      MAX_LAND_BLOCK_INDEX,
      Math.floor(
        Math.max(...points.map((point) => point.x)) / LAND_BLOCK_SIZE,
      ) + 1,
    );
    const minY = Math.max(
      0,
      Math.floor(
        (MAP_SIZE - Math.max(...points.map((point) => point.y))) /
          LAND_BLOCK_SIZE,
      ) - 1,
    );
    const maxY = Math.min(
      MAX_LAND_BLOCK_INDEX,
      Math.floor(
        (MAP_SIZE - Math.min(...points.map((point) => point.y))) /
          LAND_BLOCK_SIZE,
      ) + 1,
    );
    return this.range(minX, maxX, minY, maxY);
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
          loaded.x * LAND_BLOCK_SIZE + point.x,
          MAP_SIZE - (loaded.y * LAND_BLOCK_SIZE + point.y),
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
        loaded.x * LAND_BLOCK_SIZE +
          placement.origin[0] +
          scaled.x +
          2 * cross.x,
        MAP_SIZE -
          (loaded.y * LAND_BLOCK_SIZE +
            placement.origin[1] +
            scaled.y +
            2 * cross.y),
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
      const c = camera as Camera2D;
      const a = c.ScreenToWorld(new Vector3(0, 0, 1));
      const b = c.ScreenToWorld(
        new Vector3(c.ViewportSize.x, c.ViewportSize.y, 1),
      );
      return intersectsRectangle(
        this.chunkBounds(loaded),
        new Vector3(Math.min(a.x, b.x), Math.min(a.y, b.y), -4096),
        new Vector3(Math.max(a.x, b.x), Math.max(a.y, b.y), 4096),
      );
    }
    return intersectsCamera(this.chunkBounds(loaded), camera.FrameTransform);
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
    for (const [key] of this.chunks)
      if (!retained.has(key)) this.chunks.delete(key);
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
      this.gl.deleteBuffer(batch.vertexBuffer);
      this.gl.deleteBuffer(batch.indexBuffer);
      this.dats.releaseMaterial(batch.materialResourceId);
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
      visibleUniqueModels: 0,
      instancedBatchCount: 0,
      drawCalls: 0,
      instanceBufferUploadBytes: 0,
      bakedChunkBatchCount: 0,
      cacheEvictions: 0,
    };
  }
}
