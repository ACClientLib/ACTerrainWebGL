import {
  BUILDING_TEXTURE_UNIT,
  IndexedTextureLoader,
  uploadResourceTexture,
} from "./dattexture";
import { DatObjectCache, type CachedResource } from "./datobjectcache";
import type { CacheNamespace } from "./opfsresourcecacheprotocol";
import { DatProcessor } from "./datprocessor";
import {
  SUPPORTED_FORMAT_VERSION,
  type TextureProfile,
} from "./formatcontract";
import { parseV3SceneIndex } from "../v3/v3sceneindex";
import { parseV3Material, parseV3PlacementChunk } from "../v3/v3parsers";
import { ResourceRegistry, type ResourceLease } from "./resourceRegistry";
import {
  selectTextureProfile,
  type TextureCapabilities,
} from "./textureprofile";
import {
  interpolateRegionLighting,
  parseRegionLighting,
  type RegionLightingDescriptor,
} from "./regionlighting";

function readFloat16(view: DataView, offset: number): number {
  const value = view.getUint16(offset, true);
  const sign = value & 0x8000 ? -1 : 1;
  const exponent = (value >>> 10) & 0x1f;
  const fraction = value & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

const ACIX_MAGIC = 0x58494341;
const ACRB_MAGIC = 0x42524341;
const ACRI_MAGIC = 0x49524341;

export interface ObjectMaterial {
  texture: WebGLTexture;
  textureResourceId?: number;
  solidTextureResourceId?: number;
  alphaMode: "opaque" | "cutout" | "blended" | "additive";
  luminosity: number;
  diffuse: number;
  opacity: number;
  indexedMaterialResourceId?: number;
  cullState: "none" | "front" | "back";
  samplerMode: "clamp" | "repeat";
  alphaCutoff: number;
}

export interface IndexedPlacement {
  category: number;
  geometryPath: number;
  modelIndex: number;
  origin: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export const SERVER_SPAWNS = 2;
export const ENV_CELLS = 3;
export const CELL_STATICS = 4;
export const SCENERY = 5;
export const CELL_SERVER_SPAWNS = 6;

export interface IndexedChunkRange {
  category: number;
  start: number;
  count: number;
}
export interface IndexedBakedMesh {
  resourceId: number;
  dependencyResourceIds: number[];
}
export interface IndexedChunk {
  id: number;
  bounds: {
    minimum: [number, number, number];
    maximum: [number, number, number];
  };
  placementStart: number;
  placementCount: number;
  ranges: IndexedChunkRange[];
  bakedMeshes: IndexedBakedMesh[];
  placementResourceId?: number;
}
export interface IndexedModel {
  originalModelId: number;
  meshResourceId: number;
  dependencyStart: number;
  dependencyCount: number;
  eligibleForInstancing: boolean;
  eligibleForBaking: boolean;
  bounds: {
    minimum: [number, number, number];
    maximum: [number, number, number];
  };
  vertexCount: number;
  indexCount: number;
}
interface ResourceEntry {
  id: number;
  kind: number;
  encoding: number;
  bytes: ArrayBuffer;
}
interface ResourceCatalogEntry {
  kind: number;
  commonEncoding: number;
  decodedLength: number;
  commonLength: number;
  bcLength: number;
  etc2Length: number;
  rgba8Length: number;
}
export interface ParticleEmitterDescriptor {
  emitterType: number;
  particleType: number;
  parentLocal: boolean;
  representation: number;
  seed: number;
  hookIndex: number;
  parentOrigin: [number, number, number];
  parentOrientation: [number, number, number, number];
  offset: [number, number, number];
  offsetDirection: [number, number, number];
  minOffset: number;
  maxOffset: number;
  a: [number, number, number];
  minA: number;
  maxA: number;
  b: [number, number, number];
  minB: number;
  maxB: number;
  c: [number, number, number];
  minC: number;
  maxC: number;
  birthrate: number;
  maxParticles: number;
  initialParticles: number;
  totalParticles: number;
  totalSeconds: number;
  lifespan: number;
  lifespanRandom: number;
  startScale: number;
  finalScale: number;
  scaleRandom: number;
  startTranslucency: number;
  finalTranslucency: number;
  translucencyRandom: number;
  dimensions: [number, number, number];
  centerOffset: [number, number, number];
  planeOrientation: [number, number, number, number];
}
export interface MeshBatch {
  materialResourceId: number;
  hasWrappingUVs?: boolean;
  vertices?: Float32Array;
  indices?: Uint32Array;
  particles?: ParticleEmitterDescriptor[];
  cullState?: "none" | "front" | "back";
  samplerMode?: "clamp" | "repeat";
}
export interface Mesh {
  bounds: IndexedModel["bounds"];
  batches: MeshBatch[];
  vertexCount: number;
  indexCount: number;
}
interface CachedMaterial {
  promise: Promise<ObjectMaterial>;
  references: number;
  lease?: ResourceLease<ObjectMaterial, ObjectMaterial>;
}
interface CachedTexture {
  promise: Promise<WebGLTexture>;
  references: number;
  lease?: ResourceLease<TextureCpu, WebGLTexture>;
}

interface TextureCpu {
  resource?: ResourceEntry;
  color?: Uint8Array;
  decodedBytes: number;
  gpuBytes: number;
}

class HttpStatusError extends Error {
  constructor(public status: number) {
    super(`ACTerrain API returned HTTP ${status}`);
  }
}

const MAX_RESOURCE_BYTES = 512 * 1024 * 1024;
const MAX_DECODED_MESHES = 128;
const MAX_RESOURCE_BUNDLES_IN_FLIGHT = 4;
const MAX_BATCH_IDS = 256;
const TARGET_BATCH_BYTES = 8 * 1024 * 1024;
const HARD_BATCH_BYTES = 16 * 1024 * 1024;
const CACHE_OPERATION_TIMEOUT_MS = 5000;
const SLOW_CACHE_READ_MS = 1000;

interface ResourceBatchWaiter {
  priority: number;
  sequence: number;
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: DOMException) => void;
}

export interface AcDatLoadDiagnostics {
  httpRequests: number;
  totalHttpRequests: number;
  queuedBatches: number;
  cacheReads: number;
  processorRequests: number;
  materials: number;
  cacheEnabled: boolean;
  cacheUsageBytes: number;
  cacheQuotaBytes: number;
  cacheBytes: number;
  cacheQueuedBytes: number;
  cacheEvictionCount: number;
  cachePendingHits: number;
  cacheReinitializations: number;
  lifecycleFlushesRequested: number;
  lifecycleFlushesCompleted: number;
  lifecycleFlushesFailed: number;
  lifecycleFlushesInterrupted: number;
  lifecycleFlushBytesDrained: number;
  lifecycleFlushWritesDrained: number;
  lifecycleFlushDurationMs: number;
  lifecycleWritesRemainingAtShutdown: number;
  resourceCacheMisses: number;
  resourceUniqueCacheMissIds: number;
  resourceRepeatedCacheMissIds: number;
  resourceNetworkIds: number;
  resourceUniqueNetworkIds: number;
  resourceRepeatedNetworkIds: number;
  resourceCacheReadAborted: number;
}

export class AcDatClient {
  private baseUrl: string;
  private cache: DatObjectCache;
  private processor = new DatProcessor();
  private ready: Promise<void> | null = null;
  private descriptor!: {
    version: string;
    formatVersion: number;
    sceneIndexUrl: string;
    resourceIndexUrl: string;
    resourcesUrl: string;
    terrainDataUrl: string | null;
    cacheFootprintBytes: Record<string, number>;
    placementElevationOrigin: number;
    placementElevationScale: number;
    regionLighting: RegionLightingDescriptor;
  };
  private resourceCatalog: ResourceCatalogEntry[] = [];
  private terrainDataPromise: Promise<ArrayBuffer> | null = null;
  private chunks = new Map<number, IndexedChunk>();
  private placements: IndexedPlacement[] = [];
  private decodedPlacements = new Map<number, IndexedPlacement[]>();
  private placementSlices = new WeakMap<IndexedChunk, IndexedPlacement[]>();
  private models: IndexedModel[] = [];
  private modelIndexesByOriginalId = new Map<number, number>();
  private dependencies: number[] = [];
  private resources = new Map<number, ResourceEntry>();
  private resourceBytes = 0;
  private readonly registry = new ResourceRegistry<ResourceEntry>({
    budgets: {
      encodedBytes: 256 * 1024 * 1024,
      decodedBytes: 256 * 1024 * 1024,
      gpuBytes: 256 * 1024 * 1024,
      uploadBytesPerFrame: 8 * 1024 * 1024,
    },
    destroyCpu: (entry) => {
      if (this.resources.get(entry.id) !== entry) return;
      this.resources.delete(entry.id);
      this.resourceBytes -= entry.bytes.byteLength;
    },
  });
  private materialRegistry!: ResourceRegistry<ObjectMaterial, ObjectMaterial>;
  private textureRegistry!: ResourceRegistry<TextureCpu, WebGLTexture>;
  private meshRegistry!: ResourceRegistry<Mesh>;
  private meshes = new Map<number, Promise<Mesh>>();
  private materials = new Map<number, CachedMaterial>();
  private pendingMaterials = new Set<Promise<ObjectMaterial>>();
  private textures = new Map<number, CachedTexture>();
  private indexedTextures: IndexedTextureLoader;
  private visibleController: AbortController | null = null;
  private preloadController: AbortController | null = null;
  private lifecycleController = new AbortController();
  private visibleDemand = new Set<number>();
  private preloadDemand = new Set<number>();
  private loadGeneration = 0;
  private activeRequests = 0;
  private requestCount = 0;
  private activeCacheReads = 0;
  private activeResourceBatches = 0;
  private resourceBatchSequence = 0;
  private resourceBatchWaiters: ResourceBatchWaiter[] = [];
  private pendingResources = new Map<number, Promise<void>>();
  private resourceCacheMisses = 0;
  private resourceCacheMissSeen = new Set<number>();
  private resourceNetworkIds = 0;
  private resourceNetworkSeen = new Set<number>();
  private resourceUniqueCacheMissIds = 0;
  private resourceRepeatedCacheMissIds = 0;
  private resourceUniqueNetworkIds = 0;
  private resourceRepeatedNetworkIds = 0;
  private resourceCacheReadAborted = 0;
  private readonly textureCapabilities: TextureCapabilities;
  private readonly contextLostHandler = (event: Event) => {
    event.preventDefault();
    this.textureRegistry.contextLost();
  };
  private readonly contextRestoredHandler = () =>
    this.textureRegistry.contextRestored();

  constructor(
    private gl: WebGL2RenderingContext,
    baseUrl = import.meta.env.VITE_ACTERRAIN_API_URL ??
      "https://terrainapi.utilitybelt.me/",
    private readonly descriptorPath = "v3/dataset",
    cacheNamespace: CacheNamespace = "dat",
  ) {
    this.baseUrl =
      baseUrl.endsWith("/") || baseUrl.length === 0 ? baseUrl : `${baseUrl}/`;
    this.cache = new DatObjectCache(cacheNamespace);
    this.indexedTextures = new IndexedTextureLoader(gl);
    this.textureCapabilities = selectTextureProfile(gl);
    gl.canvas.addEventListener(
      "webglcontextlost",
      this.contextLostHandler,
      false,
    );
    gl.canvas.addEventListener(
      "webglcontextrestored",
      this.contextRestoredHandler,
      false,
    );
    this.materialRegistry = new ResourceRegistry({
      budgets: {
        encodedBytes: 0,
        decodedBytes: 64 * 1024 * 1024,
        gpuBytes: 0,
        uploadBytesPerFrame: 0,
      },
      destroyCpu: (material) => {
        if (material.indexedMaterialResourceId !== undefined)
          this.indexedTextures.release(material.indexedMaterialResourceId);
        else if (material.solidTextureResourceId !== undefined)
          this.textureRegistry.remove(material.solidTextureResourceId);
        else if (material.textureResourceId !== undefined)
          this.releaseTexture(material.textureResourceId);
      },
    });
    this.textureRegistry = new ResourceRegistry({
      budgets: {
        encodedBytes: 128 * 1024 * 1024,
        decodedBytes: 256 * 1024 * 1024,
        gpuBytes: 256 * 1024 * 1024,
        uploadBytesPerFrame: 8 * 1024 * 1024,
      },
      destroyGpu: (texture) => this.gl.deleteTexture(texture),
      contextRestored: (generation) => {
        void this.restoreTexture(generation);
      },
    });
    this.meshRegistry = new ResourceRegistry({
      budgets: {
        encodedBytes: 0,
        decodedBytes: 256 * 1024 * 1024,
        gpuBytes: 0,
        uploadBytesPerFrame: 0,
      },
    });
  }

  get activeRequestCount(): number {
    return this.activeRequests;
  }
  get totalRequestCount(): number {
    return this.requestCount;
  }
  get pendingRequestCount(): number {
    return this.activeRequests + this.processor.pendingRequestCount;
  }
  get textureProfile(): TextureProfile {
    return this.textureCapabilities.profile;
  }
  beginFrame(): void {
    this.textureRegistry.beginFrame();
    this.indexedTextures.beginFrame();
    for (const cached of this.materials.values())
      void cached.promise
        .then((material) => {
          if (material.indexedMaterialResourceId !== undefined) {
            const texture = this.indexedTextures.current(
              material.indexedMaterialResourceId,
            );
            if (texture) material.texture = texture;
          }
        })
        .catch(() => undefined);
  }
  get pendingMaterialCount(): number {
    return this.pendingMaterials.size;
  }
  get pendingGpuUploadCount(): number {
    return (
      this.textureRegistry.pendingUploadCount +
      this.indexedTextures.pendingGpuUploadCount
    );
  }
  get modelsByIndex(): readonly IndexedModel[] {
    return this.models;
  }
  get loadedResourceBytes(): number {
    return this.resourceBytes;
  }
  get loadDiagnostics(): AcDatLoadDiagnostics {
    return {
      httpRequests: this.activeRequests,
      totalHttpRequests: this.requestCount,
      queuedBatches: this.resourceBatchWaiters.length,
      cacheReads: this.activeCacheReads,
      processorRequests: this.processor.pendingRequestCount,
      materials: this.pendingMaterials.size,
      cacheEnabled: this.cache.diagnostics.enabled,
      cacheUsageBytes: this.cache.diagnostics.usageBytes,
      cacheQuotaBytes: this.cache.diagnostics.quotaBytes,
      cacheBytes: this.cache.diagnostics.cacheBytes,
      cacheQueuedBytes: this.cache.diagnostics.queuedBytes,
      cacheEvictionCount: this.cache.diagnostics.evictionCount,
      cachePendingHits: this.cache.diagnostics.pendingHits,
      cacheReinitializations: this.cache.diagnostics.reinitializations,
      lifecycleFlushesRequested:
        this.cache.diagnostics.lifecycleFlushesRequested,
      lifecycleFlushesCompleted:
        this.cache.diagnostics.lifecycleFlushesCompleted,
      lifecycleFlushesFailed: this.cache.diagnostics.lifecycleFlushesFailed,
      lifecycleFlushesInterrupted:
        this.cache.diagnostics.lifecycleFlushesInterrupted,
      lifecycleFlushBytesDrained:
        this.cache.diagnostics.lifecycleFlushBytesDrained,
      lifecycleFlushWritesDrained:
        this.cache.diagnostics.lifecycleFlushWritesDrained,
      lifecycleFlushDurationMs: this.cache.diagnostics.lifecycleFlushDurationMs,
      lifecycleWritesRemainingAtShutdown:
        this.cache.diagnostics.lifecycleWritesRemainingAtShutdown,
      resourceCacheMisses: this.resourceCacheMisses,
      resourceUniqueCacheMissIds: this.resourceUniqueCacheMissIds,
      resourceRepeatedCacheMissIds: this.resourceRepeatedCacheMissIds,
      resourceNetworkIds: this.resourceNetworkIds,
      resourceUniqueNetworkIds: this.resourceUniqueNetworkIds,
      resourceRepeatedNetworkIds: this.resourceRepeatedNetworkIds,
      resourceCacheReadAborted: this.resourceCacheReadAborted,
    };
  }

  async terrainData(): Promise<ArrayBuffer> {
    await this.ensureReady();
    if (!this.descriptor.terrainDataUrl)
      throw new Error("This ACTerrain dataset does not contain terrain data");
    if (!this.terrainDataPromise) {
      // Dataset artifact URLs contain the immutable dataset version. Let the
      // browser use its normal HTTP cache policy for this versioned resource.
      this.terrainDataPromise = this.request(this.descriptor.terrainDataUrl)
        .then((response) => response.arrayBuffer())
        .catch((error) => {
          this.terrainDataPromise = null;
          throw error;
        });
    }
    return this.terrainDataPromise;
  }

  async initialize(): Promise<void> {
    await this.ensureReady();
  }

  async loadVisible(
    blocks: [number, number][],
    preloadBlocks: [number, number][] = [],
  ): Promise<void> {
    const generation = ++this.loadGeneration;
    await this.ensureReady();
    const nextVisibleDemand = this.resourceIdsForBlocks(blocks);
    const nextPreloadDemand = this.resourceIdsForBlocks(preloadBlocks);
    if (
      !this.hasDemandOverlap(
        this.visibleDemand,
        nextVisibleDemand,
        nextPreloadDemand,
      )
    )
      this.visibleController?.abort();
    if (
      !this.hasDemandOverlap(
        this.preloadDemand,
        nextVisibleDemand,
        nextPreloadDemand,
      )
    )
      this.preloadController?.abort();
    this.visibleDemand = nextVisibleDemand;
    this.preloadDemand = nextPreloadDemand;
    const visibleController = new AbortController();
    this.visibleController = visibleController;
    try {
      const initialResources = new Set([
        ...this.placementResourceIdsForBlocks(blocks),
        ...this.bakedResourceIdsForBlocks(blocks),
      ]);
      await this.loadResourceIds(
        [...initialResources],
        0,
        visibleController.signal,
      );
      await this.decodePlacementChunks(blocks, visibleController.signal);
    } finally {
      if (this.visibleController === visibleController)
        this.visibleController = null;
    }
    if (generation !== this.loadGeneration)
      throw new DOMException(
        "Viewport resource load was superseded",
        "AbortError",
      );

    if (preloadBlocks.length > 0) {
      const preloadController = new AbortController();
      this.preloadController = preloadController;
      void this.loadBlockResources(preloadBlocks, preloadController.signal, 1)
        .catch((error) => {
          if (!this.isAbortError(error))
            console.warn(`ACTerrain preload skipped: ${error}`);
        })
        .finally(() => {
          if (this.preloadController === preloadController)
            this.preloadController = null;
        });
    }
  }

  chunk(x: number, y: number): IndexedChunk | undefined {
    return this.chunks.get(((x << 24) | (y << 16) | 0xfffe) >>> 0);
  }

  placementsForChunk(
    chunk: IndexedChunk,
    category?: number,
  ): IndexedPlacement[] {
    const decoded = this.decodedPlacements.get(chunk.id);
    if (decoded) {
      return category === undefined
        ? decoded
        : decoded.filter((placement) => placement.category === category);
    }
    if (category === undefined) {
      let placements = this.placementSlices.get(chunk);
      if (!placements) {
        placements = this.placements.slice(
          chunk.placementStart,
          chunk.placementStart + chunk.placementCount,
        );
        this.placementSlices.set(chunk, placements);
      }
      return placements;
    }
    const range = chunk.ranges.find((item) => item.category === category);
    return range
      ? this.placements.slice(
          chunk.placementStart + range.start,
          chunk.placementStart + range.start + range.count,
        )
      : [];
  }

  serverSpawnsForChunk(chunk: IndexedChunk): IndexedPlacement[] {
    return this.placementsForChunk(chunk, SERVER_SPAWNS);
  }

  model(modelIndex: number): IndexedModel | undefined {
    return this.models[modelIndex];
  }
  modelIndex(originalModelId: number): number | undefined {
    return originalModelId < this.models.length
      ? originalModelId
      : this.modelIndexesByOriginalId.get(originalModelId);
  }

  mesh(modelIndex: number, signal?: AbortSignal): Promise<Mesh> {
    let promise = this.meshes.get(modelIndex);
    if (!promise) {
      let created!: Promise<Mesh>;
      created = this.decodeMesh(
        this.models[modelIndex]?.meshResourceId,
        1,
        signal,
      ).catch((error) => {
        if (this.meshes.get(modelIndex) === created)
          this.meshes.delete(modelIndex);
        throw error;
      });
      promise = created;
      this.meshes.set(modelIndex, promise);
    } else {
      this.meshes.delete(modelIndex);
      this.meshes.set(modelIndex, promise);
    }
    this.trimMeshCache();
    return promise;
  }

  bakedMesh(resourceId: number, signal?: AbortSignal): Promise<Mesh> {
    return this.decodeMesh(resourceId, 4, signal);
  }

  async loadResources(
    ids: number[],
    signal?: AbortSignal,
    priority = 0,
  ): Promise<void> {
    await this.ensureReady();
    await this.loadResourceIds(
      ids,
      priority,
      signal ?? this.lifecycleController.signal,
    );
  }

  resourceEntry(id: number): ResourceEntry | undefined {
    const entry = this.resources.get(id);
    if (entry) {
      this.resources.delete(id);
      this.resources.set(id, entry);
    }
    return entry;
  }

  async resourceData(id: number, kind?: number): Promise<ResourceEntry> {
    return this.resource(id, kind);
  }

  resourceIdsForModels(modelIndexes: Iterable<number>): number[] {
    const ids = new Set<number>();
    for (const modelIndex of modelIndexes) {
      const model = this.models[modelIndex];
      if (!model) continue;
      ids.add(model.meshResourceId);
      for (
        let i = model.dependencyStart;
        i < model.dependencyStart + model.dependencyCount;
        i++
      )
        ids.add(this.dependencies[i]);
    }
    return [...ids];
  }

  get datasetDiagnostics(): object {
    return {
      version: this.descriptor.version,
      sceneIndexUrl: this.url(this.descriptor.sceneIndexUrl),
      resourceIndexUrl: this.url(this.descriptor.resourceIndexUrl),
      resourcesUrl: this.url(
        this.descriptor.resourcesUrl.replace(
          "{profile}",
          this.textureCapabilities.profile,
        ),
      ),
    };
  }

  chunkById(id: number): IndexedChunk | undefined {
    return this.chunks.get(id);
  }

  placementResourceIdForChunk(id: number): number | undefined {
    return this.chunks.get(id)?.placementResourceId;
  }

  private decodeSceneryPlacement(
    record: Uint8Array,
    modelIndex: number,
    category: number,
    negativeDeterminant: boolean,
  ): IndexedPlacement {
    if (record.byteLength !== 20)
      throw new Error("Invalid v3 scenery placement record");
    const view = new DataView(
      record.buffer,
      record.byteOffset,
      record.byteLength,
    );
    const largest = view.getUint16(14, true) & 3;
    const sign = (view.getUint16(14, true) & 4) !== 0 ? -1 : 1;
    const values: number[] = [];
    for (let offset = 8; offset < 14; offset += 2)
      values.push(view.getInt16(offset, true) / 46340);
    const rotation = [0, 0, 0, 0];
    let next = 0;
    for (let component = 0; component < 4; component++)
      rotation[component] = component === largest ? 0 : values[next++];
    rotation[largest] =
      sign *
      Math.sqrt(
        Math.max(
          0,
          1 - rotation.reduce((sum, value) => sum + value * value, 0),
        ),
      );
    const blockX = view.getUint8(0);
    const blockY = view.getUint8(1);
    const scale = readFloat16(view, 16) * (negativeDeterminant ? -1 : 1);
    return {
      category,
      geometryPath: 0,
      modelIndex,
      origin: [
        blockX * 192 + (view.getUint16(2, true) / 65535) * 192,
        blockY * 192 + (view.getUint16(4, true) / 65535) * 192,
        this.descriptor.placementElevationOrigin +
          view.getUint16(6, true) * this.descriptor.placementElevationScale,
      ],
      rotation: rotation as [number, number, number, number],
      scale: [scale, scale, scale],
    };
  }

  private decodeOrdinaryPlacement(
    record: Uint8Array,
    modelIndex: number,
    chunkId: number,
    category: number,
  ): IndexedPlacement {
    if (record.byteLength !== 24)
      throw new Error("Invalid v3 ordinary placement record");
    const view = new DataView(
      record.buffer,
      record.byteOffset,
      record.byteLength,
    );
    if (view.getUint16(6, true) !== 0 || view.getUint16(22, true) !== 0)
      throw new Error("Invalid v3 ordinary placement reserved fields");
    const largest = view.getUint16(14, true) & 3;
    const sign = (view.getUint16(14, true) & 4) !== 0 ? -1 : 1;
    const values = [
      view.getInt16(8, true) / 46340,
      view.getInt16(10, true) / 46340,
      view.getInt16(12, true) / 46340,
    ];
    const rotation = [0, 0, 0, 0];
    let next = 0;
    for (let component = 0; component < 4; component++)
      rotation[component] = component === largest ? 0 : values[next++];
    rotation[largest] =
      sign *
      Math.sqrt(
        Math.max(
          0,
          1 - rotation.reduce((sum, value) => sum + value * value, 0),
        ),
      );
    const blockX = (chunkId >>> 24) & 0xff;
    const blockY = (chunkId >>> 16) & 0xff;
    return {
      category,
      geometryPath: 0,
      modelIndex,
      origin: [
        blockX * 192 + (view.getUint16(0, true) / 65535) * 192,
        blockY * 192 + (view.getUint16(2, true) / 65535) * 192,
        this.descriptor.placementElevationOrigin +
          view.getUint16(4, true) * this.descriptor.placementElevationScale,
      ],
      rotation: rotation as [number, number, number, number],
      scale: [
        readFloat16(view, 16),
        readFloat16(view, 18),
        readFloat16(view, 20),
      ],
    };
  }

  private async decodePlacementChunks(
    blocks: [number, number][],
    signal: AbortSignal,
  ): Promise<void> {
    const modelIndexes = new Set<number>();
    for (const [x, y] of blocks) {
      const chunk = this.chunk(x, y);
      if (
        !chunk ||
        chunk.placementResourceId === undefined ||
        this.decodedPlacements.has(chunk.id)
      )
        continue;
      const encoded = await this.decodeResource(chunk.placementResourceId, 6);
      this.decodePlacements(chunk.id, encoded);
      for (const placement of this.decodedPlacements.get(chunk.id) ?? [])
        modelIndexes.add(placement.modelIndex);
      if (signal.aborted)
        throw new DOMException(
          "Viewport resource load was superseded",
          "AbortError",
        );
    }
    void this.loadResourceIds(
      this.resourceIdsForModels(modelIndexes),
      0,
      signal,
    ).catch((error) => {
      if (!this.isAbortError(error))
        console.warn(`ACTerrain model prefetch skipped: ${error}`);
    });
  }

  private decodePlacements(chunkId: number, encoded: ArrayBuffer): void {
    const parsed = parseV3PlacementChunk(encoded);
    if (parsed.chunkId !== chunkId)
      throw new Error("Placement resource does not match its scene chunk");
    const placements = parsed.groups.flatMap((group) =>
      group.recordSize === 24
        ? group.records.map((record) =>
            this.decodeOrdinaryPlacement(
              record,
              group.modelIndex,
              chunkId,
              group.category,
            ),
          )
        : group.records.map((record) =>
            this.decodeSceneryPlacement(
              record,
              group.modelIndex,
              group.category,
              group.negativeDeterminant,
            ),
          ),
    );
    this.decodedPlacements.set(chunkId, placements);
  }

  material(id: number): Promise<ObjectMaterial> {
    let cached = this.materials.get(id);
    if (!cached) {
      let created!: CachedMaterial;
      const promise = this.decodeMaterial(id).catch((error) => {
        if (this.materials.get(id) === created) this.materials.delete(id);
        throw error;
      });
      created = { promise, references: 0 };
      cached = created;
      this.materials.set(id, cached);
      const entry = cached;
      void promise
        .then(() => {
          if (this.materials.get(id) === entry)
            entry.lease = this.materialRegistry.acquire(id);
        })
        .catch(() => undefined);
      this.pendingMaterials.add(promise);
      void promise.then(
        () => this.pendingMaterials.delete(promise),
        () => this.pendingMaterials.delete(promise),
      );
    }
    const entry = cached;
    entry.references++;
    return entry.promise;
  }

  releaseMaterial(id: number): void {
    const cached = this.materials.get(id);
    if (!cached || --cached.references > 0) return;
    void cached.promise
      .then((material) => {
        if (cached.references !== 0 || this.materials.get(id) !== cached)
          return;
        this.materials.delete(id);
        cached.lease?.release();
        this.materialRegistry.remove(id);
      })
      .catch(() => undefined);
  }

  async clearCache(): Promise<void> {
    this.lifecycleController.abort();
    this.visibleController?.abort();
    this.preloadController?.abort();
    await this.cache.clear();
    this.resources.clear();
    this.resourceBytes = 0;
    for (const material of this.materials.values()) material.lease?.release();
    for (const texture of this.textures.values()) texture.lease?.release();
    this.registry.replaceDataset();
    this.materialRegistry.replaceDataset();
    this.textureRegistry.replaceDataset();
    this.indexedTextures.clear();
    this.meshRegistry.replaceDataset();
    this.pendingResources.clear();
    this.decodedPlacements.clear();
    this.lifecycleController = new AbortController();
    this.meshes.clear();
    this.materials.clear();
    this.textures.clear();
  }

  shutdown(): void {
    this.lifecycleController.abort();
    this.visibleController?.abort();
    this.preloadController?.abort();
    this.processor.shutdown();
  }

  private async ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.loadIndex().catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  private async loadIndex(): Promise<void> {
    const descriptorResponse = await this.request(this.descriptorPath, {
      cache: "no-cache",
    });
    const descriptor = await descriptorResponse.json();
    if (descriptor.formatVersion !== SUPPORTED_FORMAT_VERSION)
      throw new Error(
        `Unsupported ACTerrain format version ${descriptor.formatVersion}`,
      );
    if (
      typeof descriptor.version !== "string" ||
      typeof descriptor.sceneIndexUrl !== "string" ||
      typeof descriptor.resourceIndexUrl !== "string" ||
      typeof descriptor.resourcesUrl !== "string" ||
      !(typeof descriptor.terrainDataUrl === "string" || descriptor.terrainDataUrl === null) ||
      !Number.isFinite(descriptor.placementElevationOrigin) ||
      !Number.isFinite(descriptor.placementElevationScale) ||
      descriptor.placementElevationScale <= 0 ||
      !Array.isArray(descriptor.textureProfiles) ||
      descriptor.textureProfiles.join(",") !== "bc,etc2,rgba8" ||
      !descriptor.cacheFootprintBytes ||
      typeof descriptor.cacheFootprintBytes[
        this.textureCapabilities.profile
      ] !== "number"
    )
      throw new Error("Invalid ACTerrain dataset descriptor");
    const regionLighting = parseRegionLighting(descriptor.regionLighting);
    this.descriptor = descriptor;
    this.descriptor.regionLighting = regionLighting;
    await this.cache.configure(
      SUPPORTED_FORMAT_VERSION,
      descriptor.version,
      this.textureCapabilities.profile,
      descriptor.cacheFootprintBytes[this.textureCapabilities.profile],
    );
    const [sceneIndex, resourceIndex] = await Promise.all([
      this.request(descriptor.sceneIndexUrl).then((response) =>
        response.arrayBuffer(),
      ),
      this.request(descriptor.resourceIndexUrl).then((response) =>
        response.arrayBuffer(),
      ),
    ]);
    this.parseV3SceneDirectory(sceneIndex);
    this.parseResourceCatalog(resourceIndex);
    if (descriptor.contentKind !== "server") await this.cache.removeLegacyCaches();
  }

  getRegionLighting(timeOfDay = 0.5) {
    if (!this.descriptor?.regionLighting)
      throw new Error("ACTerrain region lighting is unavailable");
    return interpolateRegionLighting(this.descriptor.regionLighting, timeOfDay);
  }

  private parseV3SceneDirectory(source: ArrayBuffer): void {
    const index = parseV3SceneIndex(source);
    this.models = index.models.map((model) => ({
      ...model,
      eligibleForInstancing: true,
      eligibleForBaking: false,
      vertexCount: 0,
      indexCount: 0,
    }));
    this.dependencies = [...index.dependencies];
    this.modelIndexesByOriginalId = new Map(
      this.models.map((model, i) => [model.originalModelId, i]),
    );
    this.chunks = new Map(
      index.chunks.map((chunk) => [
        chunk.id,
        {
          id: chunk.id,
          bounds: chunk.bounds,
          placementStart: 0,
          placementCount: chunk.placementCount,
          ranges: [],
          bakedMeshes: [],
          placementResourceId: chunk.placementResourceId,
        },
      ]),
    );
    this.placements = [];
    this.decodedPlacements.clear();
  }

  private parseResourceCatalog(source: ArrayBuffer): void {
    const view = new DataView(source);
    if (
      source.byteLength < 12 ||
      view.getUint32(0, true) !== ACRI_MAGIC ||
      view.getUint16(4, true) !== SUPPORTED_FORMAT_VERSION ||
      view.getUint16(6, true) !== 0
    )
      throw new Error("Invalid ACTerrain resource index");
    const count = view.getUint32(8, true);
    if (source.byteLength !== 12 + count * 56)
      throw new Error("Invalid ACTerrain resource index length");
    this.resourceCatalog = [];
    for (let id = 0; id < count; id++) {
      const offset = 12 + id * 56;
      const kind = view.getUint8(offset);
      const commonEncoding = view.getUint8(offset + 1);
      const flags = view.getUint16(offset + 2, true);
      const decodedLength = view.getUint32(offset + 4, true);
      const commonLength = view.getUint32(offset + 16, true);
      const bcLength = view.getUint32(offset + 28, true);
      const etc2Length = view.getUint32(offset + 40, true);
      const rgba8Length = view.getUint32(offset + 52, true);
      if (
        ![1, 2, 3, 4, 5, 6].includes(kind) ||
        (flags & 1) === 0 ||
        commonLength === 0
      )
        throw new Error(`Invalid ACTerrain resource index entry ${id}`);
      this.resourceCatalog.push({
        kind,
        commonEncoding,
        decodedLength,
        commonLength,
        bcLength,
        etc2Length,
        rgba8Length,
      });
    }
  }

  private async parseIndex(source: ArrayBuffer): Promise<void> {
    const buffer = source;
    if (
      buffer.byteLength < 6 ||
      new DataView(buffer).getUint32(0, true) !== ACIX_MAGIC
    )
      throw new Error("Invalid ACTerrain exterior index");
    const reader = new DataView(buffer);
    let offset = 0;
    const u16 = () => {
      const value = reader.getUint16(offset, true);
      offset += 2;
      return value;
    };
    const u32 = () => {
      const value = reader.getUint32(offset, true);
      offset += 4;
      return value;
    };
    const f32 = () => {
      const value = reader.getFloat32(offset, true);
      offset += 4;
      return value;
    };
    if (u32() !== ACIX_MAGIC || u16() !== SUPPORTED_FORMAT_VERSION)
      throw new Error("Invalid ACTerrain exterior index");
    const landblockSide = u16();
    const cellIteration = u32();
    const portalIteration = u32();
    const highresIteration = u32();
    const sourceVersion = `c${cellIteration}p${portalIteration}h${highresIteration}`;
    if (
      landblockSide !== 255 ||
      !new RegExp(`^${sourceVersion}-[0-9a-f]{16}$`).test(
        this.descriptor.version,
      )
    )
      throw new Error("Dataset descriptor and exterior index do not match");
    const chunkCount = u32();
    const placementCount = u32();
    const modelCount = u32();
    const dependencyCount = u32();
    const chunkDirectory: IndexedChunk[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const id = u32();
      if ((id & 0xffff) !== 0xfffe)
        throw new Error(
          `Invalid ACTerrain exterior chunk 0x${id.toString(16).padStart(8, "0")}`,
        );
      const bounds = this.readBounds(f32);
      const placementStart = u32();
      const blockPlacementCount = u16();
      const rangeCount = u16();
      const ranges = Array.from({ length: rangeCount }, () => {
        const category = reader.getUint8(offset++);
        if (reader.getUint8(offset++) !== 0 || u16() !== 0)
          throw new Error("Invalid ACTerrain chunk range");
        const start = u32();
        const count = u16();
        if (u16() !== 0) throw new Error("Invalid ACTerrain chunk range");
        return { category, start, count };
      });
      const bakedCount = u16();
      if (u16() !== 0) throw new Error("Invalid ACTerrain chunk");
      const bakedMeshes = Array.from({ length: bakedCount }, () => {
        const resourceId = u32();
        const dependencyCount = u16();
        if (u16() !== 0) throw new Error("Invalid ACTerrain baked mesh");
        return {
          resourceId,
          dependencyResourceIds: Array.from({ length: dependencyCount }, u32),
        };
      });
      chunkDirectory.push({
        id,
        bounds,
        placementStart,
        placementCount: blockPlacementCount,
        ranges,
        bakedMeshes,
      });
    }
    this.chunks = new Map(chunkDirectory.map((chunk) => [chunk.id, chunk]));
    this.placementSlices = new WeakMap<IndexedChunk, IndexedPlacement[]>();
    this.placements = Array.from({ length: placementCount }, () => ({
      category: reader.getUint8(offset++),
      geometryPath: reader.getUint8(offset++),
      reserved: u16(),
      modelIndex: u32(),
      origin: [f32(), f32(), f32()] as [number, number, number],
      rotation: [f32(), f32(), f32(), f32()] as [
        number,
        number,
        number,
        number,
      ],
      scale: [f32(), f32(), f32()] as [number, number, number],
    })).map((placement) => {
      if (placement.reserved !== 0 || ![0, 1].includes(placement.geometryPath))
        throw new Error("Invalid ACTerrain placement");
      const { reserved, ...value } = placement;
      return value;
    });
    this.models = Array.from({ length: modelCount }, () => {
      const model = {
        originalModelId: u32(),
        meshResourceId: u32(),
        dependencyStart: u32(),
        dependencyCount: u16(),
        eligibleForInstancing: reader.getUint8(offset++) !== 0,
        eligibleForBaking: reader.getUint8(offset++) !== 0,
        bounds: this.readBounds(f32),
        vertexCount: u32(),
        indexCount: u32(),
      };
      return model;
    });
    this.modelIndexesByOriginalId = new Map(
      this.models.map((model, index) => [model.originalModelId, index]),
    );
    this.dependencies = Array.from({ length: dependencyCount }, u32);
    if (offset !== buffer.byteLength)
      throw new Error("Exterior index has trailing bytes");
  }

  private async loadBlockResources(
    blocks: [number, number][],
    signal: AbortSignal,
    priority: number,
  ): Promise<void> {
    const ids = this.resourceIdsForBlocks(blocks);
    if (ids.size === 0) return;
    if (signal.aborted)
      throw new DOMException(
        "Viewport resource load was superseded",
        "AbortError",
      );
    await this.loadResourceIds([...ids], priority, signal);
  }

  private resourceIdsForBlocks(blocks: [number, number][]): Set<number> {
    const ids = new Set<number>();
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const [x, y] = blocks[blockIndex];
      const chunk = this.chunk(x, y);
      if (!chunk) continue;
      for (
        let index = chunk.placementStart;
        index < chunk.placementStart + chunk.placementCount;
        index++
      ) {
        this.addPlacementResources(index, ids);
      }
      if (chunk.placementResourceId !== undefined)
        ids.add(chunk.placementResourceId);
      for (const baked of chunk.bakedMeshes) {
        ids.add(baked.resourceId);
        for (const dependency of baked.dependencyResourceIds)
          ids.add(dependency);
      }
    }

    return ids;
  }

  private placementResourceIdsForBlocks(
    blocks: [number, number][],
  ): Set<number> {
    const ids = new Set<number>();
    for (const [x, y] of blocks) {
      const chunk = this.chunk(x, y);
      if (chunk?.placementResourceId !== undefined)
        ids.add(chunk.placementResourceId);
    }
    return ids;
  }

  private bakedResourceIdsForBlocks(blocks: [number, number][]): Set<number> {
    const ids = new Set<number>();
    for (const [x, y] of blocks) {
      const chunk = this.chunk(x, y);
      if (!chunk) continue;
      for (const baked of chunk.bakedMeshes) {
        ids.add(baked.resourceId);
        for (const dependency of baked.dependencyResourceIds)
          ids.add(dependency);
      }
    }
    return ids;
  }

  private hasDemandOverlap(
    previous: Set<number>,
    visible: Set<number>,
    preload: Set<number>,
  ): boolean {
    for (const id of previous)
      if (visible.has(id) || preload.has(id)) return true;
    return false;
  }

  private async loadResourceIds(
    ids: number[],
    priority: number,
    signal: AbortSignal,
  ): Promise<void> {
    const unique = [...new Set(ids)].filter((id) => !this.resources.has(id));
    const existing = unique.flatMap((id) => {
      const pending = this.pendingResources.get(id);
      return pending ? [pending] : [];
    });
    const uncached = unique.filter((id) => !this.pendingResources.has(id));
    if (uncached.length === 0) {
      await Promise.all(existing);
      return;
    }

    let created!: Promise<void>;
    created = (async () => {
      const missing = await this.loadCached(uncached, signal);
      if (missing.length === 0) return;
      const batches = this.formResourceBatches(missing);
      await Promise.all(
        batches.map((batch) =>
          this.loadExactResourceBatch(batch, priority, signal),
        ),
      );
    })();
    for (const id of uncached) this.pendingResources.set(id, created);
    try {
      await Promise.all([created, ...existing]);
    } finally {
      for (const id of uncached)
        if (this.pendingResources.get(id) === created)
          this.pendingResources.delete(id);
    }
  }

  private formResourceBatches(ids: number[]): number[][] {
    const batches: number[][] = [];
    let batch: number[] = [];
    let bytes = 8;
    for (const id of ids) {
      const length = this.resourceEncodedLength(id);
      if (length > HARD_BATCH_BYTES - 16)
        throw new Error(`Resource ${id} exceeds the 16 MiB request limit`);
      if (
        batch.length > 0 &&
        (batch.length === MAX_BATCH_IDS ||
          bytes + 16 + length > TARGET_BATCH_BYTES)
      ) {
        batches.push(batch);
        batch = [];
        bytes = 8;
      }
      batch.push(id);
      bytes += 16 + length;
    }
    if (batch.length > 0) batches.push(batch);
    return batches;
  }

  private resourceEncodedLength(id: number): number {
    const entry = this.resourceCatalog[id];
    if (!entry) throw new Error(`Unknown ACTerrain resource ${id}`);
    if (entry.kind !== 3) return entry.commonLength;
    const variantLength = (
      {
        bc: entry.bcLength,
        etc2: entry.etc2Length,
        rgba8: entry.rgba8Length,
      } as Record<string, number>
    )[this.textureCapabilities.profile];
    return variantLength || entry.commonLength;
  }

  private async loadExactResourceBatch(
    ids: number[],
    priority: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.resourceNetworkIds += ids.length;
    for (const id of ids) {
      if (this.resourceNetworkSeen.add(id)) this.resourceUniqueNetworkIds++;
      else this.resourceRepeatedNetworkIds++;
    }
    await this.acquireResourceBatchSlot(priority, signal);
    try {
      let response: Response;
      try {
        response = await this.request(
          this.descriptor.resourcesUrl.replace(
            "{profile}",
            this.textureCapabilities.profile,
          ),
          {
            method: "POST",
            // text/plain is a CORS-safelisted content type. The body remains
            // JSON, but using this media type lets the browser send the
            // cross-origin batch POST without an OPTIONS preflight.
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({
              resourceIds: ids,
            }),
            signal,
          },
        );
      } catch (error) {
        if (error instanceof HttpStatusError && error.status === 413)
          throw new Error(
            `ACTerrain exact resource batch rejected with 413 (${ids.length} IDs, ${ids.reduce((sum, id) => sum + this.resourceEncodedLength(id), 8)} encoded bytes)`,
          );
        throw error;
      }
      await this.readResourceBatch(await response.arrayBuffer(), new Set(ids));
    } finally {
      this.releaseResourceBatchSlot();
    }
  }

  private async readResourceBatch(
    source: ArrayBuffer,
    knownResourceIds: Set<number>,
  ): Promise<Set<number>> {
    const buffer = source;
    const reader = new DataView(buffer);
    let offset = 0;
    const u16 = () => {
      const value = reader.getUint16(offset, true);
      offset += 2;
      return value;
    };
    const u32 = () => {
      const value = reader.getUint32(offset, true);
      offset += 4;
      return value;
    };
    if (u32() !== ACRB_MAGIC || u16() !== SUPPORTED_FORMAT_VERSION)
      throw new Error("Invalid ACTerrain resource batch");
    const count = u16();
    const received = new Set<number>();
    const entries: ResourceEntry[] = [];
    for (let i = 0; i < count; i++) {
      const id = u32();
      const kind = reader.getUint8(offset++);
      const encoding = reader.getUint8(offset++);
      const reserved = u16();
      const encodedLength = u32();
      const decodedLength = u32();
      if (
        received.has(id) ||
        !knownResourceIds.has(id) ||
        ![1, 2, 3, 4, 5, 6].includes(kind) ||
        ![0, 1].includes(encoding) ||
        reserved !== 0 ||
        (encoding === 0 && encodedLength !== decodedLength) ||
        offset + encodedLength > buffer.byteLength
      )
        throw new Error("Invalid ACTerrain resource batch entry");
      const bytes = buffer.slice(offset, offset + encodedLength);
      offset += encodedLength;
      received.add(id);
      entries.push({ id, kind, encoding, bytes });
    }
    if (offset !== buffer.byteLength)
      throw new Error("Invalid ACTerrain resource batch length");
    if (received.size !== knownResourceIds.size)
      throw new Error("ACTerrain resource batch omitted a requested ID");
    for (const entry of entries) this.rememberResource(entry);
    void this.cache
      .setMany(
        entries.map(
          (entry) =>
            [
              this.cacheKey(entry.id, entry.kind),
              {
                formatVersion: SUPPORTED_FORMAT_VERSION,
                datasetVersion: this.descriptor.version,
                resourceId: entry.id,
                kind: entry.kind,
                encoding: entry.encoding,
                bytes: entry.bytes,
              },
            ] as const,
        ),
      )
      .catch((error) => console.warn(`Resource cache write skipped: ${error}`));
    return received;
  }

  private async decodeResource(
    id: number,
    kind?: number,
  ): Promise<ArrayBuffer> {
    const entry = await this.resource(id, kind);
    if (entry.encoding === 0) return entry.bytes;
    if (entry.encoding === 1)
      return new Response(
        new Blob([entry.bytes])
          .stream()
          .pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer();
    throw new Error(
      `ACTerrain resource ${id} has unsupported encoding ${entry.encoding}`,
    );
  }

  private async decodeMesh(
    id: number | undefined,
    kind = 1,
    signal?: AbortSignal,
  ): Promise<Mesh> {
    if (id === undefined) throw new Error("Missing ACTerrain mesh");
    const entry = await this.resource(id, kind);
    return (async () => {
      const mesh = await this.processor.decodeMesh(
        { id, encoding: entry.encoding, bytes: entry.bytes },
        signal,
      );
      const decodedBytes = mesh.batches.reduce(
        (total, batch) =>
          total +
          (batch.vertices?.byteLength ?? 0) +
          (batch.indices?.byteLength ?? 0),
        0,
      );
      this.meshRegistry.publish(id, mesh, { encodedBytes: 0, decodedBytes });
      return mesh;
    })();
  }

  private addPlacementResources(index: number, ids: Set<number>): void {
    const placement = this.placements[index];
    const model = placement && this.models[placement.modelIndex];
    if (!model) return;
    if (placement.geometryPath === 1) return;
    ids.add(model.meshResourceId);
    for (
      let i = model.dependencyStart;
      i < model.dependencyStart + model.dependencyCount;
      i++
    )
      ids.add(this.dependencies[i]);
  }

  private async loadCached(
    ids: number[],
    signal: AbortSignal,
  ): Promise<number[]> {
    const uncached = ids.filter((id) => !this.resources.has(id));
    if (uncached.length === 0) return [];
    this.activeCacheReads++;
    const cacheStarted = performance.now();
    const cacheAbort = new AbortController();
    let cacheTimedOut = false;
    signal.addEventListener("abort", () => cacheAbort.abort(), { once: true });
    const cacheRead = this.cache
      .getMany(
        uncached.map((id) =>
          this.cacheKey(id, this.resourceCatalog[id]?.kind ?? 0),
        ),
        cacheAbort.signal,
      )
      .then((entries) => {
        const elapsed = performance.now() - cacheStarted;
        if (!cacheTimedOut && elapsed >= SLOW_CACHE_READ_MS)
          console.warn(
            `[ACTerrain] Slow OPFS resource cache read: ${Math.round(elapsed)}ms (${uncached.length} resources)`,
          );
        return entries;
      })
      .catch(() => null)
      .finally(() => {
        this.activeCacheReads--;
      });
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => {
        cacheTimedOut = true;
        cacheAbort.abort();
        resolve(null);
      }, CACHE_OPERATION_TIMEOUT_MS),
    );
    const entries = await Promise.race([cacheRead, timeout]);
    const elapsed = performance.now() - cacheStarted;
    if (entries === null && elapsed >= CACHE_OPERATION_TIMEOUT_MS)
      console.warn(
        `[ACTerrain] OPFS resource cache read timed out after ${Math.round(elapsed)}ms (${uncached.length} resources); falling back to network`,
      );
    if (signal.aborted) {
      this.resourceCacheReadAborted++;
      throw new DOMException(
        "Resource cache read was superseded",
        "AbortError",
      );
    }
    if (entries === null) {
      this.resourceCacheMisses += uncached.length;
      for (const id of uncached) {
        if (this.resourceCacheMissSeen.add(id))
          this.resourceUniqueCacheMissIds++;
        else this.resourceRepeatedCacheMissIds++;
      }
      return uncached;
    }
    const missing: number[] = [];
    for (let index = 0; index < uncached.length; index++) {
      const id = uncached[index];
      const entry = entries[index];
      if (
        !entry ||
        entry.formatVersion !== SUPPORTED_FORMAT_VERSION ||
        entry.datasetVersion !== this.descriptor.version ||
        entry.resourceId !== id ||
        entry.kind !== this.resourceCatalog[id]?.kind
      ) {
        this.resourceCacheMisses++;
        if (this.resourceCacheMissSeen.add(id))
          this.resourceUniqueCacheMissIds++;
        else this.resourceRepeatedCacheMissIds++;
        missing.push(id);
        continue;
      }
      this.rememberResource({
        id,
        kind: entry.kind,
        encoding: entry.encoding,
        bytes: entry.bytes,
      });
    }
    return missing;
  }

  private acquireResourceBatchSlot(
    priority: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted)
      return Promise.reject(
        new DOMException("Viewport resource load was superseded", "AbortError"),
      );
    if (this.activeResourceBatches < MAX_RESOURCE_BUNDLES_IN_FLIGHT) {
      this.activeResourceBatches++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: ResourceBatchWaiter = {
        priority,
        sequence: this.resourceBatchSequence++,
        signal,
        resolve,
        reject,
      };
      const cancel = () => {
        const index = this.resourceBatchWaiters.indexOf(waiter);
        if (index < 0) return;
        this.resourceBatchWaiters.splice(index, 1);
        reject(
          new DOMException(
            "Viewport resource load was superseded",
            "AbortError",
          ),
        );
      };
      signal.addEventListener("abort", cancel, { once: true });
      this.resourceBatchWaiters.push(waiter);
    });
  }

  private releaseResourceBatchSlot(): void {
    while (this.resourceBatchWaiters.length > 0) {
      let nextIndex = 0;
      for (let index = 1; index < this.resourceBatchWaiters.length; index++) {
        const candidate = this.resourceBatchWaiters[index];
        const next = this.resourceBatchWaiters[nextIndex];
        if (
          candidate.priority < next.priority ||
          (candidate.priority === next.priority &&
            candidate.sequence > next.sequence)
        )
          nextIndex = index;
      }
      const [next] = this.resourceBatchWaiters.splice(nextIndex, 1);
      if (next.signal.aborted) {
        next.reject(
          new DOMException(
            "Viewport resource load was superseded",
            "AbortError",
          ),
        );
        continue;
      }
      next.resolve();
      return;
    }
    this.activeResourceBatches--;
  }

  private readBounds(f32: () => number): IndexedModel["bounds"] {
    return { minimum: [f32(), f32(), f32()], maximum: [f32(), f32(), f32()] };
  }

  private rememberResource(entry: ResourceEntry): void {
    const previous = this.resources.get(entry.id);
    if (previous === entry) return;
    if (previous) this.resourceBytes -= previous.bytes.byteLength;
    this.resources.delete(entry.id);
    this.resources.set(entry.id, entry);
    this.resourceBytes += entry.bytes.byteLength;
    this.registry.publish(entry.id, entry, {
      encodedBytes: entry.bytes.byteLength,
      decodedBytes: 0,
    });
    while (this.resourceBytes > MAX_RESOURCE_BYTES && this.resources.size > 1) {
      const oldest = this.resources.keys().next().value as number;
      const removed = this.resources.get(oldest)!;
      this.resources.delete(oldest);
      this.resourceBytes -= removed.bytes.byteLength;
    }
  }

  private trimMeshCache(): void {
    while (this.meshes.size > MAX_DECODED_MESHES) {
      const modelIndex = this.meshes.keys().next().value as number;
      this.meshes.delete(modelIndex);
      const resourceId = this.models[modelIndex]?.meshResourceId;
      if (resourceId !== undefined) this.meshRegistry.remove(resourceId);
    }
  }

  private async decodeMaterial(id: number): Promise<ObjectMaterial> {
    const buffer = await this.decodeResource(id, 2);
    const material = parseV3Material(buffer);
    let textureResourceId: number | undefined;
    let solidTextureResourceId: number | undefined;
    let indexedMaterialResourceId: number | undefined;
    let texture: WebGLTexture;
    if (material.indexedImageResourceId !== 0) {
      indexedMaterialResourceId = id;
      texture = await this.indexedTextures.acquire(
        id,
        {
          imageResourceId: material.indexedImageResourceId,
          basePaletteResourceId: material.basePaletteResourceId,
          patches: material.palettePatches,
          clipMap: material.clipMap,
        },
        (resourceId, kind) => this.resource(resourceId, kind),
      );
    } else if (material.textureResourceId !== 0) {
      textureResourceId = material.textureResourceId;
      texture = await this.acquireTexture(textureResourceId);
    } else {
      solidTextureResourceId = -1000000000 - id;
      texture = this.solidTexture(
        solidTextureResourceId,
        new Uint8Array(
          material.color.map((value) =>
            Math.round(Math.max(0, Math.min(1, value)) * 255),
          ),
        ),
      );
    }
    const result = {
      texture,
      textureResourceId,
      solidTextureResourceId,
      alphaMode: (material.renderClass === "masked"
        ? "cutout"
        : material.renderClass === "sourceOver"
          ? "blended"
          : material.renderClass === "additive"
            ? "additive"
            : "opaque") as ObjectMaterial["alphaMode"],
      luminosity: material.luminosity,
      diffuse: material.diffuse,
      opacity: material.opacity,
      indexedMaterialResourceId,
      cullState: material.cullState,
      samplerMode: material.samplerMode,
      alphaCutoff: material.alphaCutoff,
    };
    this.materialRegistry.publish(id, result, {
      encodedBytes: 0,
      decodedBytes: 64,
    });
    return result;
  }

  private acquireTexture(id: number): Promise<WebGLTexture> {
    let cached = this.textures.get(id);
    if (!cached) {
      let created!: CachedTexture;
      const promise = this.decodeTexture(id).catch((error) => {
        if (this.textures.get(id) === created) this.textures.delete(id);
        throw error;
      });
      created = { promise, references: 0 };
      cached = created;
      this.textures.set(id, cached);
      const entry = cached;
      void promise
        .then(() => {
          if (this.textures.get(id) === entry)
            entry.lease = this.textureRegistry.acquire(id);
        })
        .catch(() => undefined);
    }
    const entry = cached;
    entry.references++;
    return entry.promise;
  }

  releaseTexture(id: number): void {
    const cached = this.textures.get(id);
    if (!cached) {
      this.textureRegistry.remove(id);
      return;
    }
    if (--cached.references > 0) return;
    void cached.promise
      .then((texture) => {
        if (cached.references !== 0 || this.textures.get(id) !== cached) return;
        this.textures.delete(id);
        cached.lease?.release();
        this.textureRegistry.remove(id);
      })
      .catch(() => undefined);
  }

  fallbackTexture(id: number, color: Uint8Array): WebGLTexture {
    return this.solidTexture(id, color);
  }

  private async decodeTexture(id: number): Promise<WebGLTexture> {
    const entry = await this.resource(id, 3);
    return (async () => {
      const uploaded = await uploadResourceTexture(
        this.gl,
        entry,
        this.textureCapabilities.profile,
        this.textureCapabilities.extensions,
      );
      const cpu = {
        resource: entry,
        decodedBytes: uploaded.decodedBytes,
        gpuBytes: uploaded.gpuBytes,
      };
      this.textureRegistry.publish(
        id,
        cpu,
        {
          encodedBytes: entry.bytes.byteLength,
          decodedBytes: uploaded.decodedBytes,
        },
        uploaded.texture,
        uploaded.gpuBytes,
      );
      return uploaded.texture;
    })();
  }

  private async restoreTexture(
    generation: import("./resourceRegistry").ResourceGeneration<
      TextureCpu,
      WebGLTexture
    >,
  ): Promise<void> {
    if (!this.textureRegistry.canUpload() || generation.gpu !== undefined)
      return;
    try {
      const uploaded = generation.cpu.resource
        ? await uploadResourceTexture(
            this.gl,
            generation.cpu.resource,
            this.textureCapabilities.profile,
            this.textureCapabilities.extensions,
          )
        : this.uploadSolidTexture(generation.cpu.color!);
      if (
        !this.textureRegistry.attachGpu(
          generation,
          uploaded.texture,
          uploaded.gpuBytes,
        )
      )
        this.gl.deleteTexture(uploaded.texture);
      else
        for (const cached of this.materials.values())
          void cached.promise
            .then((material) => {
              if (
                material.textureResourceId === generation.id ||
                material.solidTextureResourceId === generation.id
              )
                material.texture = uploaded.texture;
            })
            .catch(() => undefined);
    } catch {
      this.textureRegistry.markUploadPending(generation.id, true);
    }
  }

  private async resource(id: number, kind?: number): Promise<ResourceEntry> {
    let entry = this.resources.get(id);
    if (!entry) {
      await this.loadResourceIds([id], 0, this.lifecycleController.signal);
      entry = this.resources.get(id);
      // loadResourceIds publishes cache and network hits into the memory LRU.
      // Only fall back to OPFS if a large shared batch evicted this entry
      // before the caller resumed.
      if (!entry) {
        const cached = await this.cache.get(this.cacheKey(id, kind ?? 0));
        if (!cached) throw new Error(`Missing ACTerrain resource ${id}`);
        entry = {
          id,
          kind: cached.kind,
          encoding: cached.encoding,
          bytes: cached.bytes,
        };
      }
    }
    this.rememberResource(entry);
    if (kind !== undefined && entry.kind !== kind)
      throw new Error(
        `ACTerrain resource ${id} has kind ${entry.kind}, expected ${kind}`,
      );
    return entry;
  }

  async texture(id: number): Promise<WebGLTexture> {
    return this.acquireTexture(id);
  }

  async indexedTexture(
    materialId: number,
    imageResourceId: number,
    basePaletteResourceId: number,
    patches: readonly {
      replacementPaletteResourceId: number;
      offset: number;
      length: number;
    }[],
    clipMap: boolean,
  ): Promise<WebGLTexture> {
    return this.indexedTextures.acquire(
      materialId,
      {
        imageResourceId,
        basePaletteResourceId,
        patches,
        clipMap,
      },
      async (id, kind) => {
        const entry = await this.resource(id, kind);
        return entry;
      },
    );
  }

  releaseIndexedTexture(materialId: number): void {
    this.indexedTextures.release(materialId);
  }

  indexedTextureCurrent(materialId: number): WebGLTexture | undefined {
    return this.indexedTextures.current(materialId);
  }

  private solidTexture(id: number, color: Uint8Array): WebGLTexture {
    const uploaded = this.uploadSolidTexture(color);
    this.textureRegistry.publish(
      id,
      { color: color.slice(), decodedBytes: 4, gpuBytes: 4 },
      { encodedBytes: 0, decodedBytes: 4 },
      uploaded.texture,
      uploaded.gpuBytes,
    );
    return uploaded.texture;
  }

  private uploadSolidTexture(color: Uint8Array): {
    texture: WebGLTexture;
    gpuBytes: number;
  } {
    const texture = this.gl.createTexture()!;
    const previous = this.gl.getParameter(this.gl.ACTIVE_TEXTURE) as number;
    this.gl.activeTexture(this.gl.TEXTURE0 + BUILDING_TEXTURE_UNIT);
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      1,
      1,
      0,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      color,
    );
    this.gl.generateMipmap(this.gl.TEXTURE_2D);
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_MIN_FILTER,
      this.gl.LINEAR,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_MAG_FILTER,
      this.gl.LINEAR,
    );
    this.gl.activeTexture(previous);
    return { texture, gpuBytes: 4 };
  }

  private cacheKey(id: number, kind: number): string {
    return `${this.descriptor.version}:${kind === 3 ? this.textureCapabilities.profile : "common"}:resource:${id}`;
  }
  private url(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    if (this.baseUrl.length === 0)
      return new URL(
        path.startsWith("/") ? path : `/${path}`,
        window.location.origin,
      ).toString();
    return new URL(
      path.replace(/^\//, ""),
      new URL(this.baseUrl, window.location.href),
    ).toString();
  }
  private async request(path: string, init?: RequestInit): Promise<Response> {
    const requestInit: RequestInit = {
      ...init,
      signal: init?.signal ?? this.lifecycleController.signal,
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      this.activeRequests++;
      this.requestCount++;
      const started = performance.now();
      try {
        const response = await fetch(this.url(path), requestInit);
        if (response.ok) return response;
        if (![429, 502, 503, 504].includes(response.status) || attempt === 3)
          throw new HttpStatusError(response.status);
      } catch (error) {
        if (
          requestInit.signal?.aborted ||
          error instanceof HttpStatusError ||
          attempt === 3
        )
          throw error;
      } finally {
        this.activeRequests--;
      }
      await this.waitForRetry(
        requestInit.signal ?? undefined,
        (attempt + 1) ** 2 * 100 + Math.random() * 100,
      );
    }
    throw new Error("ACTerrain API request failed");
  }

  private waitForRetry(
    signal: AbortSignal | undefined,
    delay: number,
  ): Promise<void> {
    if (signal?.aborted)
      return Promise.reject(
        new DOMException("Viewport resource load was superseded", "AbortError"),
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(
            new DOMException(
              "Viewport resource load was superseded",
              "AbortError",
            ),
          );
        },
        { once: true },
      );
    });
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
  }
}
