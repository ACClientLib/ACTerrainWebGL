import { DatProcessor } from './datprocessor'
import { DatObjectCache, CachedResource } from './datobjectcache'
import { LoadingProfiler, type LoadingTimingSnapshot } from './loadingprofiler'

const SCENERY_FORMAT_VERSION = 1
const CACHE_OPERATION_TIMEOUT_MS = 5000
const SCENERY_REQUESTS_IN_FLIGHT = 4
const MAX_SCENERY_RESOURCE_BYTES = 128 * 1024 * 1024

export interface SceneryLoadDiagnostics {
  httpRequests: number
  queuedChunks: number
  chunkRequests: number
  resourceRequests: number
  cacheReads: number
  processorRequests: number
  cacheEnabled: boolean
  cacheUsageBytes: number
  cacheQuotaBytes: number
  cacheBytes: number
}

export interface SceneryChunkEntry {
  id: number
  bounds: { minimum: [number, number, number]; maximum: [number, number, number] }
  placementCount: number
  offset: number
  length: number
}

export interface SceneryPlacement {
  modelId: number
  origin: [number, number, number]
  rotation: [number, number, number, number]
  scale: number
}

export interface SceneryModel { originalModelId: number; meshResourceId: number; dependencyStart: number; dependencyCount: number; eligibleForInstancing?: boolean; reserved?: number; bounds: { minimum: [number, number, number]; maximum: [number, number, number] }; vertexCount: number; indexCount: number }

export class SceneryAddonClient {
  private descriptor: any = null
  private chunks = new Map<number, SceneryChunkEntry>()
  private loaded = new Map<number, SceneryPlacement[]>()
  private pending = new Map<number, Promise<SceneryPlacement[]>>()
  private models: SceneryModel[] = []
  private modelIndexesByOriginalId = new Map<number, number>()
  private dependencies: number[] = []
  private resources = new Map<number, { kind: number; encoding: number; bytes: ArrayBuffer }>()
  private resourceBytes = 0
  private processor = new DatProcessor()
  private cache = new DatObjectCache('scenery')
  private controller: AbortController | null = null
  private chunkQueue: number[] = []
  private queuedChunks = new Set<number>()
  private chunkScheduler: Promise<void> | null = null
  private retainedChunks = new Set<number>()
  private pendingResources = new Map<number, Promise<void>>()
  private requestCount = 0
  private activeRequests = 0
  private activeCacheReads = 0
  private profiler = new LoadingProfiler()
  private error = ''
  private loading = false
  private readonly chunkBatchSize = 128

  constructor(private baseUrl = import.meta.env.VITE_ACTERRAIN_API_URL ?? 'https://terrainapi.utilitybelt.me/') {
    this.baseUrl = baseUrl.endsWith('/') || baseUrl.length === 0 ? baseUrl : `${baseUrl}/`
  }

  get state(): 'disabled' | 'loading' | 'ready' | 'error' { return this.loading ? 'loading' : !this.descriptor ? (this.error ? 'error' : 'disabled') : 'ready' }
  get lastError(): string { return this.error }
  get loadedChunkCount(): number { return this.loaded.size }
  get pendingRequestCount(): number {
    const load = this.loadDiagnostics
    return load.httpRequests + load.queuedChunks + load.chunkRequests + load.resourceRequests + load.cacheReads + load.processorRequests
  }
  get loadDiagnostics(): SceneryLoadDiagnostics {
    return {
      httpRequests: this.activeRequests,
      queuedChunks: this.queuedChunks.size,
      chunkRequests: this.pending.size,
      resourceRequests: this.pendingResources.size,
      cacheReads: this.activeCacheReads,
      processorRequests: this.processor.pendingRequestCount,
      cacheEnabled: this.cache.diagnostics.enabled,
      cacheUsageBytes: this.cache.diagnostics.usageBytes,
      cacheQuotaBytes: this.cache.diagnostics.quotaBytes,
      cacheBytes: this.cache.diagnostics.cacheBytes
    }
  }
  get loadTimings(): LoadingTimingSnapshot {
    const timings = this.profiler.snapshot()
    for (const [name, timing] of Object.entries(this.cache.loadTimings)) timings[name] = timing
    for (const [name, timing] of Object.entries(this.processor.loadTimings)) timings[`decoder ${name}`] = timing
    return timings
  }
  get totalRequestCount(): number { return this.requestCount }
  get visiblePlacementCount(): number { return [...this.loaded.values()].reduce((sum, value) => sum + value.length, 0) }
  get indexedPlacementCount(): number { return [...this.chunks.values()].reduce((sum, chunk) => sum + chunk.placementCount, 0) }
  get chunksById(): ReadonlyMap<number, SceneryChunkEntry> { return this.chunks }
  get modelsByIndex(): readonly SceneryModel[] { return this.models }
  modelIndex(value: number): number | undefined { return value < this.models.length ? value : this.modelIndexesByOriginalId.get(value) }
  get sceneryResourceBytes(): number { return [...this.resources.values()].reduce((sum, resource) => sum + resource.bytes.byteLength, 0) }
  get dependenciesById(): readonly number[] { return this.dependencies }
  resource(id: number): { kind: number; encoding: number; bytes: ArrayBuffer } | undefined {
    const resource = this.resources.get(id)
    if (resource) {
      this.resources.delete(id)
      this.resources.set(id, resource)
    }
    return resource
  }
  placementsForChunk(id: number): readonly SceneryPlacement[] { return this.loaded.get(id) ?? [] }
  get loadedChunkIds(): readonly number[] { return [...this.loaded.keys()] }

  async load(terrainVersion: string): Promise<void> {
    this.loading = true
    this.error = ''
    try {
      const descriptorResponse = await this.request(`/v1/scenery/${terrainVersion}/descriptor`)
      if (!descriptorResponse.ok) throw new Error(`Scenery addon unavailable (${descriptorResponse.status})`)
      this.descriptor = await descriptorResponse.json()
      if (this.descriptor.terrainDatasetVersion !== terrainVersion || this.descriptor.formatVersion !== 1) throw new Error('Incompatible scenery addon')
       void this.cache.removeOtherVersions(SCENERY_FORMAT_VERSION, this.descriptor.addonVersion).catch(() => undefined)
       let source: ArrayBuffer
       const cachedIndex = await this.profiler.measure('OPFS cache index', () => this.cache.get(this.cacheKey('index')))
       if (cachedIndex && cachedIndex.formatVersion === SCENERY_FORMAT_VERSION && cachedIndex.datasetVersion === this.descriptor.addonVersion) {
         source = cachedIndex.bytes
       } else {
         const response = await this.request(this.descriptor.indexUrl)
         source = await response.arrayBuffer()
         void this.cache.set(this.cacheKey('index'), this.cached(source, 0)).catch(() => undefined)
       }
       if (source.byteLength < 8 || new DataView(source).getUint32(0, true) !== 0x49534341) throw new Error('Invalid ACTerrain scenery index')
      const view = new DataView(source); let offset = 0
      const u16 = () => { const value = view.getUint16(offset, true); offset += 2; return value }
      const u32 = () => { const value = view.getUint32(offset, true); offset += 4; return value }
      const f32 = () => { const value = view.getFloat32(offset, true); offset += 4; return value }
      if (u32() !== 0x49534341 || u16() !== 1 || u16() !== 255) throw new Error('Invalid scenery index')
       u32(); u32(); u32(); const count = u32()
       const legacyIndex = view.byteLength - offset === count * 40
       const modelCount = legacyIndex ? 0 : u32(); const resourceCount = legacyIndex ? 0 : u32()
       this.chunks.clear()
      for (let i = 0; i < count; i++) {
        const id = u32()
        const minimum: [number, number, number] = [f32(), f32(), f32()]
        const maximum: [number, number, number] = [f32(), f32(), f32()]
         this.chunks.set(id, { id, bounds: { minimum, maximum }, placementCount: u32(), offset: u32(), length: u32() })
       }
       // Index version 1 originally contained only the chunk directory. Keep it
       // readable so an old addon fails soft instead of corrupting the cursor.
       if (legacyIndex || offset === source.byteLength) { this.models = []; this.dependencies = []; return }
       this.models = Array.from({ length: modelCount }, () => ({ originalModelId: u32(), meshResourceId: u32(), dependencyStart: u32(), dependencyCount: u16(), eligibleForInstancing: view.getUint8(offset++) !== 0, reserved: view.getUint8(offset++), bounds: { minimum: [f32(), f32(), f32()] as [number, number, number], maximum: [f32(), f32(), f32()] as [number, number, number] }, vertexCount: u32(), indexCount: u32() }))
       this.modelIndexesByOriginalId = new Map(this.models.map((model, index) => [model.originalModelId, index]))
       if (this.models.some(model => model.reserved !== 0)) throw new Error('Invalid scenery model table')
       this.dependencies = Array.from({ length: this.models.reduce((sum, model) => sum + model.dependencyCount, 0) }, u32)
       if (resourceCount !== 0 && resourceCount < this.models.reduce((max, model) => Math.max(max, model.meshResourceId), 0)) throw new Error('Invalid scenery resource table')
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.loading = false
    }
  }

  async loadCurrent(): Promise<void> {
    const response = await this.request('/v1/datasets/current?formatVersion=7')
    if (!response.ok) throw new Error(`Terrain dataset unavailable (${response.status})`)
    const descriptor = await response.json()
    if (typeof descriptor.version !== 'string') throw new Error('Invalid terrain dataset descriptor')
    await this.load(descriptor.version)
  }

  async loadChunks(ids: number[], signal?: AbortSignal): Promise<void> {
    if (!this.descriptor) return
    if (this.controller?.signal.aborted || !this.controller) this.controller = new AbortController()
    this.retainedChunks = new Set(ids)
    this.trim(ids)
    this.chunkQueue = this.chunkQueue.filter(id => this.retainedChunks.has(id))
    this.queuedChunks = new Set(this.chunkQueue)
    // New visible chunks go ahead of older queued work. In-flight requests
    // are allowed to finish instead of being cancelled on every camera move.
    const newChunks = ids.filter(id => this.chunks.has(id) && !this.loaded.has(id) && !this.pending.has(id) && !this.queuedChunks.has(id))
    for (const id of newChunks.reverse()) { this.chunkQueue.unshift(id); this.queuedChunks.add(id) }
    if (!this.chunkScheduler) {
      const controller = this.controller
      const scheduler = this.runChunkScheduler(controller)
      this.chunkScheduler = scheduler
      void scheduler.then(() => {
        if (this.chunkScheduler === scheduler) this.chunkScheduler = null
      }, () => {
        if (this.chunkScheduler === scheduler) this.chunkScheduler = null
      })
    }
    if (signal?.aborted) return
    await this.chunkScheduler!
  }

  private async runChunkScheduler(controller: AbortController | null): Promise<void> {
    const worker = async () => {
      while (this.chunkQueue.length > 0 && !controller?.signal.aborted) {
        const batch = this.chunkQueue.splice(0, this.chunkBatchSize)
        for (const id of batch) this.queuedChunks.delete(id)
        const promise = this.profiler.measure('chunk batch', () => this.fetchChunks(batch, controller!.signal))
        const chunkPromises = new Map<number, Promise<SceneryPlacement[]>>()
        for (const id of batch) {
          const chunkPromise = promise.then(chunks => chunks.get(id)!).catch(() => [])
          chunkPromises.set(id, chunkPromise)
          this.pending.set(id, chunkPromise)
        }
        try {
          const chunks = await promise
          for (const [id, placements] of chunks) this.loaded.set(id, placements)
          this.trim([...this.retainedChunks])
        } catch (error) {
          if (!controller?.signal.aborted) console.warn(`Scenery chunk batch skipped`, error)
        } finally {
          for (const id of batch) if (this.pending.get(id) === chunkPromises.get(id)) this.pending.delete(id)
        }
      }
    }
    await Promise.all(Array.from({ length: SCENERY_REQUESTS_IN_FLIGHT }, worker))
  }

  clear(): void { this.controller?.abort(); this.chunkScheduler = null; this.chunkQueue = []; this.queuedChunks.clear(); this.retainedChunks.clear(); this.loaded.clear(); this.pending.clear(); this.pendingResources.clear(); this.resources.clear(); this.resourceBytes = 0; this.models = []; this.modelIndexesByOriginalId.clear(); this.dependencies = []; this.descriptor = null; this.chunks.clear(); this.error = ''; this.loading = false }

  async clearCache(): Promise<void> {
    await this.cache.clear()
    this.clear()
  }

  async loadResources(ids: number[], signal?: AbortSignal): Promise<void> {
    if (!this.descriptor) return
    const uncached = [...new Set(ids)].filter(id => !this.resources.has(id) && !this.pendingResources.has(id))
    const existing = [...new Set(ids)].flatMap(id => { const promise = this.pendingResources.get(id); return promise ? [promise] : [] })
    const batch = uncached.length === 0 ? null : this.profiler.measure('resource load', () => this.fetchResources(uncached, signal))
    if (batch) for (const id of uncached) this.pendingResources.set(id, batch)
    try {
      await Promise.all([...(batch ? [batch] : []), ...existing])
    } finally {
      if (batch) for (const id of uncached) if (this.pendingResources.get(id) === batch) this.pendingResources.delete(id)
    }
  }

  private async fetchResources(uncached: number[], signal?: AbortSignal): Promise<void> {
    this.activeCacheReads++
    const cacheStarted = performance.now()
    const cached = await this.cache.getMany(uncached.map(id => this.cacheKey(`resource:${id}`))).finally(() => {
      this.activeCacheReads--
      this.profiler.record('OPFS cache resources total', performance.now() - cacheStarted)
    })
    const missing: number[] = []
    cached.forEach((entry, index) => {
      const id = uncached[index]
      if (entry && entry.formatVersion === SCENERY_FORMAT_VERSION && entry.datasetVersion === this.descriptor.addonVersion && entry.resourceId === id &&
        [1, 2, 3, 4].includes(entry.kind) && [0, 1].includes(entry.encoding)) {
        this.rememberResource(id, { kind: entry.kind, encoding: entry.encoding, bytes: entry.bytes })
      }
      else missing.push(id)
    })
    for (let start = 0; start < missing.length; start += 256) {
      const response = await this.request(`/v1/scenery/${this.descriptor.addonVersion}/resources/batch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ResourceIds: missing.slice(start, start + 256) }), signal })
      if (!response.ok) throw new Error(`Scenery resource request failed (${response.status})`)
      const buffer = await response.arrayBuffer(); const view = new DataView(buffer); let offset = 0
      const u16 = () => { const value = view.getUint16(offset, true); offset += 2; return value }; const u32 = () => { const value = view.getUint32(offset, true); offset += 4; return value }
      if (u32() !== 0x42524341 || u16() !== 7) throw new Error('Invalid scenery resource batch')
       const cacheEntries: [string, CachedResource][] = []
       for (let i = 0, count = u16(); i < count; i++) { const id = u32(); const kind = view.getUint8(offset++); const encoding = view.getUint8(offset++); if (u16() !== 0) throw new Error('Invalid scenery resource'); const encoded = u32(); u32(); const bytes = buffer.slice(offset, offset + encoded); offset += encoded; this.rememberResource(id, { kind, encoding, bytes }); cacheEntries.push([this.cacheKey(`resource:${id}`), this.cached(bytes, id, kind, encoding)]) }
       void this.cache.setMany(cacheEntries).catch(() => undefined)
    }
  }

  async mesh(modelIndex: number): Promise<import('./acdatclient').Mesh> { const model = this.models[modelIndex]; if (!model) throw new Error('Missing scenery model'); await this.loadResources([model.meshResourceId, ...this.dependencies.slice(model.dependencyStart, model.dependencyStart + model.dependencyCount)]); const resource = this.resource(model.meshResourceId)!; return this.profiler.measure('mesh decode', () => this.processor.decodeMesh({ id: model.meshResourceId, encoding: resource.encoding, bytes: resource.bytes })) }
  async texture(id: number): Promise<import('./datprocessorprotocol').ProcessedResourceTexture> { const resource = this.resource(id); if (!resource) throw new Error(`Missing scenery texture ${id}`); return this.profiler.measure('texture decode', () => this.processor.decodeTexture({ id, encoding: resource.encoding, bytes: resource.bytes })) }

  private async fetchChunks(ids: number[], signal: AbortSignal): Promise<Map<number, SceneryPlacement[]>> {
    const result = new Map<number, SceneryPlacement[]>()
    const missing: number[] = []
    const cached = await this.readCached(ids)
    for (const id of ids) {
      const bytes = cached.get(id)
      if (bytes) result.set(id, this.parseChunk(id, bytes))
      else missing.push(id)
    }
    if (missing.length === 0) return result
    const response = await this.request(`/v1/scenery/${this.descriptor.addonVersion}/chunks/batch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ChunkIds: missing }), signal })
    if (!response.ok) throw new Error(`Scenery chunk batch request failed (${response.status})`)
    const view = new DataView(await response.arrayBuffer()); let offset = 0
    const u16 = () => { const value = view.getUint16(offset, true); offset += 2; return value }
    const u32 = () => { const value = view.getUint32(offset, true); offset += 4; return value }
    if (u32() !== 0x42534341 || u16() !== 1) throw new Error('Invalid scenery chunk batch')
    const received = new Set<number>()
    const cacheEntries: [string, CachedResource][] = []
    for (let i = 0, count = u16(); i < count; i++) {
      const id = u32(); const length = u32(); if (received.has(id) || !missing.includes(id) || offset + length > view.byteLength) throw new Error('Invalid scenery chunk batch entry')
      const bytes = view.buffer.slice(view.byteOffset + offset, view.byteOffset + offset + length); offset += length
      result.set(id, this.parseChunk(id, bytes)); received.add(id)
      cacheEntries.push([this.cacheKey(`chunk:${id >>> 0}`), this.cached(bytes, id)])
    }
    if (offset !== view.byteLength || received.size !== missing.length || result.size !== ids.length) throw new Error('Invalid scenery chunk batch')
    void this.cache.setMany(cacheEntries).catch(() => undefined)
    return result
  }

  private parseChunk(id: number, bytes: ArrayBuffer): SceneryPlacement[] {
    const entry = this.chunks.get(id)!; const view = new DataView(bytes); const result: SceneryPlacement[] = []
    if (bytes.byteLength % 36 !== 0) throw new Error('Invalid scenery chunk payload')
    for (let offset = 0; offset < view.byteLength; offset += 36) result.push({ modelId: view.getUint32(offset, true), origin: [view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true), view.getFloat32(offset + 12, true)], rotation: [view.getFloat32(offset + 16, true), view.getFloat32(offset + 20, true), view.getFloat32(offset + 24, true), view.getFloat32(offset + 28, true)], scale: view.getFloat32(offset + 32, true) })
    if (result.length !== entry.placementCount) throw new Error('Invalid scenery chunk placement count')
    return result
  }

  private async readCached(ids: number[]): Promise<Map<number, ArrayBuffer>> {
    const keys = ids.map(id => this.cacheKey(`chunk:${id >>> 0}`)); const result = new Map<number, ArrayBuffer>()
    this.activeCacheReads++
    const cacheStarted = performance.now()
    const read = this.cache.getMany(keys).catch(() => null).finally(() => {
      this.activeCacheReads--
      this.profiler.record('OPFS cache chunks total', performance.now() - cacheStarted)
    }); const entries = await Promise.race([read, new Promise<null>(resolve => setTimeout(() => resolve(null), CACHE_OPERATION_TIMEOUT_MS))])
    if (entries === null) return result
    entries.forEach((entry, index) => { const id = ids[index]; if (entry && entry.formatVersion === SCENERY_FORMAT_VERSION && entry.datasetVersion === this.descriptor.addonVersion && entry.resourceId === id) result.set(id, entry.bytes) })
    return result
  }

  private cached(bytes: ArrayBuffer, resourceId: number, kind = 0, encoding = 0): CachedResource { return { formatVersion: SCENERY_FORMAT_VERSION, datasetVersion: this.descriptor.addonVersion, resourceId, kind, encoding, bytes } }
  private cacheKey(name: string): string { return `scenery:${SCENERY_FORMAT_VERSION}:${this.descriptor?.addonVersion ?? 'unknown'}:${name}` }

  private trim(retained: number[]): void {
    const keep = new Set(retained)
    for (const id of this.loaded.keys()) {
      if (!keep.has(id)) {
        this.loaded.delete(id)
      }
    }
  }

  private rememberResource(id: number, resource: { kind: number; encoding: number; bytes: ArrayBuffer }): void {
    const previous = this.resources.get(id)
    if (previous) this.resourceBytes -= previous.bytes.byteLength
    this.resources.delete(id)
    this.resources.set(id, resource)
    this.resourceBytes += resource.bytes.byteLength
    while (this.resourceBytes > MAX_SCENERY_RESOURCE_BYTES && this.resources.size > 1) {
      const oldest = this.resources.keys().next().value as number
      const removed = this.resources.get(oldest)!
      this.resources.delete(oldest)
      this.resourceBytes -= removed.bytes.byteLength
    }
  }

   private async request(path: string, init?: RequestInit): Promise<Response> {
     this.requestCount++
     const url = /^https?:/i.test(path) ? path : this.baseUrl.length === 0 ? new URL(path, window.location.origin).toString() : new URL(path.replace(/^\//, ''), this.baseUrl).toString()
     this.activeRequests++
     const started = performance.now()
     try {
       return await fetch(url, init)
     } finally {
       this.activeRequests--
       this.profiler.record('HTTP', performance.now() - started)
     }
   }
}
