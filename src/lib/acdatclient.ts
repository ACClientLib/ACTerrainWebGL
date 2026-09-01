import { BUILDING_TEXTURE_UNIT, uploadResourceTexture } from "./dattexture";
import { DatObjectCache } from "./datobjectcache";
import { DatProcessor } from "./datprocessor";
import { LoadingProfiler, type LoadingTimingSnapshot } from "./loadingprofiler";

const SUPPORTED_FORMAT_VERSION = 7;
const ACIX_MAGIC = 0x58494341;
const ACRB_MAGIC = 0x42524341;

export interface ObjectMaterial {
  texture: WebGLTexture;
  textureResourceId?: number;
  translucent: boolean;
  luminosity: number;
  diffuse: number;
  opacity: number;
  additive: boolean;
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
export interface ParticleInstance {
  center: [number, number, number];
  scale: number;
  opacity: number;
  dimensions: [number, number, number];
  centerOffset: [number, number, number];
  planeOrientation: [number, number, number, number];
  rotation: [number, number, number, number];
  billboard: boolean;
}
export interface MeshBatch {
  materialResourceId: number;
  vertices?: Float32Array;
  indices?: Uint32Array;
  particles?: ParticleInstance[];
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
}
interface CachedTexture {
  promise: Promise<WebGLTexture>;
  references: number;
}

class HttpStatusError extends Error {
  constructor(public status: number) {
    super(`ACTerrain API returned HTTP ${status}`);
  }
}

const MAX_RESOURCE_BYTES = 128 * 1024 * 1024;
const MAX_DECODED_MESHES = 128;
const RESOURCE_BATCH_SIZE = 256;
const RESOURCE_BATCHES_IN_FLIGHT = 12;
const CACHE_OPERATION_TIMEOUT_MS = 5000;

interface ResourceBatchWaiter {
  priority: number;
  sequence: number;
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: DOMException) => void;
}

export interface AcDatLoadDiagnostics {
  httpRequests: number;
  queuedBatches: number;
  cacheReads: number;
  processorRequests: number;
  materials: number;
  cacheEnabled: boolean;
  cacheUsageBytes: number;
  cacheQuotaBytes: number;
  cacheBytes: number;
}

export class AcDatClient {
  private baseUrl: string;
  private cache = new DatObjectCache("terrain");
  private processor = new DatProcessor();
  private ready: Promise<void> | null = null;
  private descriptor!: {
    version: string;
    formatVersion: number;
    indexUrl: string;
  };
  private chunks = new Map<number, IndexedChunk>();
  private placements: IndexedPlacement[] = [];
  private placementSlices = new WeakMap<IndexedChunk, IndexedPlacement[]>();
  private models: IndexedModel[] = [];
  private modelIndexesByOriginalId = new Map<number, number>();
  private dependencies: number[] = [];
  private resources = new Map<number, ResourceEntry>();
  private resourceBytes = 0;
  private meshes = new Map<number, Promise<Mesh>>();
  private materials = new Map<number, CachedMaterial>();
  private pendingMaterials = new Set<Promise<ObjectMaterial>>();
  private textures = new Map<number, CachedTexture>();
  private visibleController: AbortController | null = null;
  private preloadController: AbortController | null = null;
  private loadGeneration = 0;
  private activeRequests = 0;
  private requestCount = 0;
  private activeCacheReads = 0;
  private activeResourceBatches = 0;
  private resourceBatchSequence = 0;
  private resourceBatchWaiters: ResourceBatchWaiter[] = [];
  private pendingResources = new Map<number, Promise<void>>();
  private profiler = new LoadingProfiler();

  constructor(
    private gl: WebGL2RenderingContext,
    baseUrl = import.meta.env.VITE_ACTERRAIN_API_URL ??
      "https://terrainapi.utilitybelt.me/",
  ) {
    this.baseUrl =
      baseUrl.endsWith("/") || baseUrl.length === 0 ? baseUrl : `${baseUrl}/`;
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
  get pendingMaterialCount(): number {
    return this.pendingMaterials.size;
  }
  get loadDiagnostics(): AcDatLoadDiagnostics {
    return {
      httpRequests: this.activeRequests,
      queuedBatches: this.resourceBatchWaiters.length,
      cacheReads: this.activeCacheReads,
      processorRequests: this.processor.pendingRequestCount,
      materials: this.pendingMaterials.size,
      cacheEnabled: this.cache.diagnostics.enabled,
      cacheUsageBytes: this.cache.diagnostics.usageBytes,
      cacheQuotaBytes: this.cache.diagnostics.quotaBytes,
      cacheBytes: this.cache.diagnostics.cacheBytes,
    };
  }
  get loadTimings(): LoadingTimingSnapshot {
    const timings = this.profiler.snapshot();
    for (const [name, timing] of Object.entries(this.cache.loadTimings))
      timings[name] = timing;
    for (const [name, timing] of Object.entries(this.processor.loadTimings))
      timings[`decoder ${name}`] = timing;
    return timings;
  }

  async loadVisible(
    blocks: [number, number][],
    preloadBlocks: [number, number][] = [],
  ): Promise<void> {
    const generation = ++this.loadGeneration;
    await this.ensureReady();
    this.visibleController?.abort();
    this.preloadController?.abort();
    const visibleController = new AbortController();
    this.visibleController = visibleController;
    try {
      await this.loadBlockResources(blocks, visibleController.signal, 0);
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
    void this.cache
      .removeOtherVersions(SUPPORTED_FORMAT_VERSION, this.descriptor.version)
      .catch((error) =>
        console.warn(`Resource cache cleanup skipped: ${error}`),
      );
  }

  chunk(x: number, y: number): IndexedChunk | undefined {
    return this.chunks.get(((x << 24) | (y << 16) | 0xfffe) >>> 0);
  }

  placementsForChunk(
    chunk: IndexedChunk,
    category?: number,
  ): IndexedPlacement[] {
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
    return this.modelIndexesByOriginalId.get(originalModelId);
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
      this.pendingMaterials.add(promise);
      void promise.then(
        () => this.pendingMaterials.delete(promise),
        () => this.pendingMaterials.delete(promise),
      );
    }
    cached.references++;
    return cached.promise;
  }

  releaseMaterial(id: number): void {
    const cached = this.materials.get(id);
    if (!cached || --cached.references > 0) return;
    void cached.promise
      .then((material) => {
        if (cached.references !== 0 || this.materials.get(id) !== cached)
          return;
        this.materials.delete(id);
        if (material.textureResourceId === undefined)
          this.gl.deleteTexture(material.texture);
        else this.releaseTexture(material.textureResourceId);
      })
      .catch(() => undefined);
  }

  async clearCache(): Promise<void> {
    this.visibleController?.abort();
    this.preloadController?.abort();
    for (const material of this.materials.values()) {
      void material.promise
        .then((value) => {
          if (value.textureResourceId === undefined)
            this.gl.deleteTexture(value.texture);
        })
        .catch(() => undefined);
    }
    for (const texture of this.textures.values()) {
      void texture.promise
        .then((value) => this.gl.deleteTexture(value))
        .catch(() => undefined);
    }
    await this.cache.clear();
    this.resources.clear();
    this.resourceBytes = 0;
    this.pendingResources.clear();
    this.meshes.clear();
    this.materials.clear();
    this.textures.clear();
  }

  private async ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.profiler
        .measure("index load", () => this.loadIndex())
        .catch((error) => {
          this.ready = null;
          throw error;
        });
    }
    return this.ready;
  }

  private async loadIndex(): Promise<void> {
    const descriptorResponse = await this.request(
      `v1/datasets/current?formatVersion=${SUPPORTED_FORMAT_VERSION}`,
    );
    const descriptor = await descriptorResponse.json();
    if (descriptor.formatVersion !== SUPPORTED_FORMAT_VERSION)
      throw new Error(
        `Unsupported ACTerrain format version ${descriptor.formatVersion}`,
      );
    if (
      typeof descriptor.version !== "string" ||
      typeof descriptor.indexUrl !== "string"
    )
      throw new Error("Invalid ACTerrain dataset descriptor");
    this.descriptor = descriptor;
    const indexUrl = new URL(this.url(descriptor.indexUrl));
    indexUrl.searchParams.set(
      "formatVersion",
      String(SUPPORTED_FORMAT_VERSION),
    );
    const indexResponse = await this.request(indexUrl.toString());
    const bytes = await indexResponse.arrayBuffer();
    await this.parseIndex(bytes);
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

  private async loadBatch(ids: number[]): Promise<void> {
    const started = performance.now();
    try {
      const response = await this.request(
        `v1/datasets/${this.descriptor.version}/resources/batch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ResourceIds: ids }),
        },
      );
      const buffer = await response.arrayBuffer();
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
      const requested = new Set(ids);
      const count = u16();
      if (count !== requested.size)
        throw new Error("Incomplete ACTerrain resource batch");
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
          !requested.has(id) ||
          ![1, 2, 3, 4].includes(kind) ||
          ![0, 1].includes(encoding) ||
          reserved !== 0 ||
          (encoding === 0 && encodedLength !== decodedLength) ||
          offset + encodedLength > buffer.byteLength
        ) {
          throw new Error("Invalid ACTerrain resource batch entry");
        }
        const bytes = buffer.slice(offset, offset + encodedLength);
        offset += encodedLength;
        received.add(id);
        entries.push({ id, kind, encoding, bytes });
      }
      if (offset !== buffer.byteLength || received.size !== requested.size)
        throw new Error("Incomplete ACTerrain resource batch");
      for (const entry of entries) this.rememberResource(entry);
      void this.cache
        .setMany(
          entries.map(
            (entry) =>
              [
                this.cacheKey(entry.id),
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
        .catch((error) =>
          console.warn(`Resource cache write skipped: ${error}`),
        );
    } finally {
      this.profiler.record("resource batch", performance.now() - started);
    }
  }

  private async loadBlockResources(
    blocks: [number, number][],
    signal: AbortSignal,
    priority: number,
  ): Promise<void> {
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
      for (const baked of chunk.bakedMeshes) {
        ids.add(baked.resourceId);
        for (const dependency of baked.dependencyResourceIds)
          ids.add(dependency);
      }
    }

    const resourceIds = [...ids];
    const batches: number[][] = [];
    for (
      let start = 0;
      start < resourceIds.length;
      start += RESOURCE_BATCH_SIZE
    )
      batches.push(resourceIds.slice(start, start + RESOURCE_BATCH_SIZE));
    let cursor = 0;
    const worker = async () => {
      while (cursor < batches.length) {
        const batch = batches[cursor++];
        if (signal.aborted)
          throw new DOMException(
            "Viewport resource load was superseded",
            "AbortError",
          );
        await this.acquireResourceBatchSlot(priority, signal);
        try {
          if (signal.aborted)
            throw new DOMException(
              "Viewport resource load was superseded",
              "AbortError",
            );
          await this.loadResourceBatch(batch);
        } finally {
          this.releaseResourceBatchSlot();
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(RESOURCE_BATCHES_IN_FLIGHT, batches.length) },
        worker,
      ),
    );
  }

  private async loadResourceBatch(ids: number[]): Promise<void> {
    const unique = [...new Set(ids)].filter((id) => !this.resources.has(id));
    const existing = unique.flatMap((id) => {
      const pending = this.pendingResources.get(id);
      return pending ? [pending] : [];
    });
    const uncached = unique.filter((id) => !this.pendingResources.has(id));
    let created: Promise<void> | null = null;
    if (uncached.length > 0) {
      created = (async () => {
        const missing = await this.loadCached(uncached);
        await this.loadBatchWithSplit(missing);
      })();
      for (const id of uncached) this.pendingResources.set(id, created);
    }
    try {
      await Promise.all([...(created ? [created] : []), ...existing]);
    } finally {
      if (created) {
        for (const id of uncached)
          if (this.pendingResources.get(id) === created)
            this.pendingResources.delete(id);
      }
    }
  }

  private async loadBatchWithSplit(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.loadBatch(ids);
    } catch (error) {
      if (
        !(error instanceof HttpStatusError) ||
        error.status !== 413 ||
        ids.length === 1
      )
        throw error;
      const middle = Math.ceil(ids.length / 2);
      await this.loadBatchWithSplit(ids.slice(0, middle));
      await this.loadBatchWithSplit(ids.slice(middle));
    }
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
    return this.profiler.measure("mesh decode", () =>
      this.processor.decodeMesh(
        { id, encoding: entry.encoding, bytes: entry.bytes },
        signal,
      ),
    );
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

  private async loadCached(ids: number[]): Promise<number[]> {
    const uncached = ids.filter((id) => !this.resources.has(id));
    if (uncached.length === 0) return [];
    this.activeCacheReads++;
    const cacheStarted = performance.now();
    const cacheRead = this.cache
      .getMany(uncached.map((id) => this.cacheKey(id)))
      .catch(() => null)
      .finally(() => {
        this.activeCacheReads--;
        this.profiler.record(
          "OPFS cache read total",
          performance.now() - cacheStarted,
        );
      });
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), CACHE_OPERATION_TIMEOUT_MS),
    );
    const entries = await Promise.race([cacheRead, timeout]);
    if (entries === null) return uncached;
    const missing: number[] = [];
    entries.forEach((entry, index) => {
      const id = uncached[index];
      if (
        !entry ||
        entry.formatVersion !== SUPPORTED_FORMAT_VERSION ||
        entry.datasetVersion !== this.descriptor.version ||
        entry.resourceId !== id
      ) {
        missing.push(id);
        return;
      }
      this.rememberResource({
        id,
        kind: entry.kind,
        encoding: entry.encoding,
        bytes: entry.bytes,
      });
    });
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
    if (this.activeResourceBatches < RESOURCE_BATCHES_IN_FLIGHT) {
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
    if (previous) this.resourceBytes -= previous.bytes.byteLength;
    this.resources.delete(entry.id);
    this.resources.set(entry.id, entry);
    this.resourceBytes += entry.bytes.byteLength;
    while (this.resourceBytes > MAX_RESOURCE_BYTES && this.resources.size > 1) {
      const oldest = this.resources.keys().next().value as number;
      const removed = this.resources.get(oldest)!;
      this.resources.delete(oldest);
      this.resourceBytes -= removed.bytes.byteLength;
    }
  }

  private trimMeshCache(): void {
    while (this.meshes.size > MAX_DECODED_MESHES)
      this.meshes.delete(this.meshes.keys().next().value as number);
  }

  private async decodeMaterial(id: number): Promise<ObjectMaterial> {
    const buffer = await this.decodeResource(id, 2);
    if (buffer.byteLength !== 20)
      throw new Error(`Invalid ACTerrain material resource ${id}`);
    const view = new DataView(buffer);
    const flags = view.getUint8(0);
    if (
      (flags & ~7) !== 0 ||
      view.getUint8(1) !== 0 ||
      view.getUint8(2) !== 0 ||
      view.getUint8(3) !== 0
    ) {
      throw new Error(`Invalid ACTerrain material resource ${id}`);
    }
    const luminosity = view.getFloat32(4, true);
    const diffuse = view.getFloat32(8, true);
    const opacity = view.getFloat32(12, true);
    const textureResourceId =
      (flags & 1) !== 0 ? view.getUint32(16, true) : undefined;
    const texture =
      textureResourceId === undefined
        ? this.solidTexture(new Uint8Array(buffer.slice(16, 20)))
        : await this.acquireTexture(textureResourceId);
    return {
      texture,
      textureResourceId,
      translucent: (flags & 2) !== 0,
      luminosity,
      diffuse,
      opacity,
      additive: (flags & 4) !== 0,
    };
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
    }
    cached.references++;
    return cached.promise;
  }

  private releaseTexture(id: number): void {
    const cached = this.textures.get(id);
    if (!cached || --cached.references > 0) return;
    void cached.promise
      .then((texture) => {
        if (cached.references !== 0 || this.textures.get(id) !== cached) return;
        this.textures.delete(id);
        this.gl.deleteTexture(texture);
      })
      .catch(() => undefined);
  }

  private async decodeTexture(id: number): Promise<WebGLTexture> {
    const entry = await this.resource(id, 3);
    const surface = await this.profiler.measure("texture decode", () =>
      this.processor.decodeTexture({
        id,
        encoding: entry.encoding,
        bytes: entry.bytes,
      }),
    );
    return uploadResourceTexture(this.gl, surface);
  }

  private async resource(id: number, kind?: number): Promise<ResourceEntry> {
    let entry = this.resources.get(id);
    if (!entry) {
      const cached = await this.cache.get(this.cacheKey(id));
      if (!cached) throw new Error(`Missing ACTerrain resource ${id}`);
      entry = {
        id,
        kind: cached.kind,
        encoding: cached.encoding,
        bytes: cached.bytes,
      };
      this.rememberResource(entry);
    } else {
      this.rememberResource(entry);
    }
    if (kind !== undefined && entry.kind !== kind)
      throw new Error(
        `ACTerrain resource ${id} has kind ${entry.kind}, expected ${kind}`,
      );
    return entry;
  }

  private solidTexture(color: Uint8Array): WebGLTexture {
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
    return texture;
  }

  private cacheKey(id: number): string {
    return `${SUPPORTED_FORMAT_VERSION}:${this.descriptor.version}:${id}`;
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
    for (let attempt = 0; attempt < 4; attempt++) {
      this.activeRequests++;
      this.requestCount++;
      const started = performance.now();
      try {
        const response = await fetch(this.url(path), init);
        if (response.ok) return response;
        if (![429, 502, 503, 504].includes(response.status) || attempt === 3)
          throw new HttpStatusError(response.status);
      } catch (error) {
        if (
          init?.signal?.aborted ||
          error instanceof HttpStatusError ||
          attempt === 3
        )
          throw error;
      } finally {
        this.activeRequests--;
        this.profiler.record("HTTP", performance.now() - started);
      }
      await this.waitForRetry(
        init?.signal ?? undefined,
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
