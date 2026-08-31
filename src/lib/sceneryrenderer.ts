import { Vector3 } from '@math.gl/core'
import * as glhelpers from './glhelpers'
import { Building3DVertSource } from '../shaders/building3d.vert'
import { Building3DFragSource } from '../shaders/building3d.frag'
import { SceneryAddonClient, SceneryPlacement } from './sceneryaddonclient'
import { BaseCamera } from './cameras/basecamera'
import { CameraMode } from './cameras/cameramode'
import { Camera2D } from './cameras/camera2d'
import { intersectsCamera, intersectsRectangle } from './objectvisibility'
import { LAND_BLOCK_SIZE, MAP_SIZE, MAX_LAND_BLOCK_INDEX } from './worldgeometry'
import { uploadResourceTexture } from './dattexture'
import { BUILDING_TEXTURE_UNIT } from './dattexture'
import { LoadingProfiler, type LoadingTimingSnapshot } from './loadingprofiler'

interface Batch { material: number; vertex: WebGLBuffer; index: WebGLBuffer; count: number; texture: WebGLTexture; translucent: boolean; additive: boolean; diffuse: number; luminosity: number; opacity: number }
interface Mesh { batches: Batch[]; bounds: { minimum: [number, number, number]; maximum: [number, number, number] }; gpuBytes: number }
interface CachedMaterial { promise: Promise<Omit<Batch, 'vertex' | 'index' | 'count'>>; references: number }
export interface SceneryDiagnostics { visibleChunks: number; loadedChunks: number; visiblePlacements: number; visibleModels: number; instances: number; drawCalls: number; gpuBytes: number; pendingRequests: number; cacheEvictions: number; failedResources: number }

const MAX_MESH_LOADS_IN_FLIGHT = 4
const MAX_CACHED_MESHES = 256

export class SceneryRenderer {
  readonly client: SceneryAddonClient
  maxGpuBytes = 128 * 1024 * 1024
  private program: WebGLProgram
  private vao: WebGLVertexArrayObject
  private instanceBuffer: WebGLBuffer
  private meshes = new Map<number, Mesh | null>()
  private pending = new Set<number>()
  private meshQueue: number[] = []
  private activeMeshLoads = 0
  private cachedGpuBytes = 0
  private materials = new Map<number, CachedMaterial>()
  private profiler = new LoadingProfiler()
  private visibleIds: number[] = []
  private instanceData = new Map<number, Float32Array>()
  private diagnostics: SceneryDiagnostics = this.empty()
  private readonly uniforms: Record<string, WebGLUniformLocation | null>

  constructor(private gl: WebGL2RenderingContext, client = new SceneryAddonClient()) {
    this.client = client
    const vertex = glhelpers.createShader(gl, gl.VERTEX_SHADER, Building3DVertSource)!
    const fragment = glhelpers.createShader(gl, gl.FRAGMENT_SHADER, Building3DFragSource)!
    this.program = glhelpers.createProgram(gl, vertex, fragment)!
    this.vao = gl.createVertexArray()!; this.instanceBuffer = gl.createBuffer()!
    this.uniforms = { xWorld: gl.getUniformLocation(this.program, 'xWorld'), texture: gl.getUniformLocation(this.program, 'buildingTexture'), diffuse: gl.getUniformLocation(this.program, 'diffuseAmount'), luminosity: gl.getUniformLocation(this.program, 'luminosity'), opacity: gl.getUniformLocation(this.program, 'opacity') }
  }

  get frameDiagnostics(): SceneryDiagnostics { return this.diagnostics }
  get pendingModelCount(): number { return this.pending.size }
  get loadTimings(): LoadingTimingSnapshot {
    return { ...this.client.loadTimings, ...this.profiler.snapshot() }
  }
  clear(): void { for (const mesh of this.meshes.values()) this.deleteMesh(mesh); this.meshes.clear(); this.pending.clear(); this.meshQueue = []; this.cachedGpuBytes = 0; this.instanceData.clear(); this.client.clear(); this.diagnostics = this.empty() }

  render(camera: BaseCamera, mode: CameraMode, distance: number, minimumZoom: number): void {
    this.diagnostics = this.empty(); if (this.client.state !== 'ready') return
    if (mode === CameraMode.Camera2D && (camera as Camera2D).Zoom < minimumZoom) return
    const ids: number[] = []
    const ranges = mode === CameraMode.Camera2D
      ? this.visible2D(camera as Camera2D)
      : this.visible3D(camera, distance)
    for (let y = ranges.minY; y <= ranges.maxY; y++) for (let x = ranges.minX; x <= ranges.maxX; x++) { const id = ((x << 24) | (y << 16) | 0xfffe) >>> 0; const entry = this.client.chunksById.get(id); if (entry && this.chunkVisible(entry, id, camera, mode)) ids.push(id) }
    const changed = ids.length !== this.visibleIds.length || ids.some((id, index) => id !== this.visibleIds[index])
    this.visibleIds = ids; this.diagnostics.visibleChunks = ids.length; this.diagnostics.loadedChunks = this.client.loadedChunkIds.length
    if (changed) void this.client.loadChunks(ids)
    const models = new Set<number>(); const grouped = new Map<number, number[]>()
    for (const id of ids) for (const placement of this.client.placementsForChunk(id)) { if (this.diagnostics.instances >= 100000) break; const modelIndex = this.client.modelIndex(placement.modelId); const model = modelIndex === undefined ? undefined : this.client.modelsByIndex[modelIndex]; if (!model || modelIndex === undefined) continue; models.add(modelIndex); const list = grouped.get(modelIndex) ?? []; list.push(...this.transformInstance(placement, id)); grouped.set(modelIndex, list); this.diagnostics.visiblePlacements++ }
    this.diagnostics.visibleModels = models.size; this.diagnostics.instances = this.diagnostics.visiblePlacements
    this.scheduleMeshes(models)
    this.draw(camera, grouped)
    this.trimMeshes(models)
    this.diagnostics.gpuBytes = this.cachedGpuBytes
    this.diagnostics.pendingRequests = this.client.pendingRequestCount + this.pending.size
  }

  private visible2D(camera: Camera2D): { minX: number; maxX: number; minY: number; maxY: number } {
    const a = camera.ScreenToWorld(new Vector3(0, 0, 1))
    const b = camera.ScreenToWorld(new Vector3(camera.ViewportSize.x, camera.ViewportSize.y, 1))
    return {
      minX: Math.max(0, Math.floor(Math.min(a.x, b.x) / LAND_BLOCK_SIZE)),
      maxX: Math.min(MAX_LAND_BLOCK_INDEX, Math.floor(Math.max(a.x, b.x) / LAND_BLOCK_SIZE)),
      minY: Math.max(0, Math.floor((MAP_SIZE - Math.max(a.y, b.y)) / LAND_BLOCK_SIZE)),
      maxY: Math.min(MAX_LAND_BLOCK_INDEX, Math.floor((MAP_SIZE - Math.min(a.y, b.y)) / LAND_BLOCK_SIZE))
    }
  }

  private visible3D(camera: BaseCamera, distance: number): { minX: number; maxX: number; minY: number; maxY: number } {
    const position = camera.Position
    const radius = Math.max(1, Math.ceil(distance / LAND_BLOCK_SIZE))
    const centerX = Math.floor(position.x / LAND_BLOCK_SIZE)
    const centerY = Math.floor((MAP_SIZE - position.y) / LAND_BLOCK_SIZE)
    return {
      minX: Math.max(0, centerX - radius),
      maxX: Math.min(MAX_LAND_BLOCK_INDEX, centerX + radius),
      minY: Math.max(0, centerY - radius),
      maxY: Math.min(MAX_LAND_BLOCK_INDEX, centerY + radius)
    }
  }

  private draw(camera: BaseCamera, grouped: Map<number, number[]>): void {
    const gl = this.gl
    const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null
    const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null
    const previousActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number
    const previousBlend = gl.isEnabled(gl.BLEND)
    const previousCull = gl.isEnabled(gl.CULL_FACE)
    const previousDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK) as boolean
    gl.useProgram(this.program); gl.bindVertexArray(this.vao); gl.uniformMatrix4fv(this.uniforms.xWorld, false, camera.FrameTransform); gl.uniform1i(this.uniforms.texture, BUILDING_TEXTURE_UNIT); gl.activeTexture(gl.TEXTURE0 + BUILDING_TEXTURE_UNIT); gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE)
    for (const [modelIndex, values] of grouped) { const mesh = this.meshes.get(modelIndex); if (!mesh) continue; this.meshes.delete(modelIndex); this.meshes.set(modelIndex, mesh); const data = new Float32Array(values); gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
      for (const batch of mesh.batches) { gl.bindBuffer(gl.ARRAY_BUFFER, batch.vertex); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 12); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 24); gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 40, 0); gl.vertexAttribPointer(4, 4, gl.FLOAT, false, 40, 12); gl.vertexAttribPointer(5, 3, gl.FLOAT, false, 40, 28); for (const location of [0, 1, 2, 3, 4, 5]) gl.enableVertexAttribArray(location); gl.vertexAttribDivisor(3, 1); gl.vertexAttribDivisor(4, 1); gl.vertexAttribDivisor(5, 1); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, batch.index); gl.bindTexture(gl.TEXTURE_2D, batch.texture); gl.uniform1f(this.uniforms.diffuse, batch.diffuse); gl.uniform1f(this.uniforms.luminosity, batch.luminosity); gl.uniform1f(this.uniforms.opacity, batch.opacity); if (batch.translucent) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, batch.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false) } else { gl.disable(gl.BLEND); gl.depthMask(true) } gl.drawElementsInstanced(gl.TRIANGLES, batch.count, gl.UNSIGNED_INT, 0, values.length / 10); this.diagnostics.drawCalls++ }
    }
    gl.depthMask(previousDepthMask); if (previousBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND); if (previousCull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE); gl.activeTexture(previousActiveTexture); gl.bindVertexArray(previousVao); gl.useProgram(previousProgram)
  }

  private async upload(modelIndex: number, source: import('./acdatclient').Mesh): Promise<void> {
    const batches: Batch[] = []
    let gpuBytes = 0
    const previousVao = this.gl.getParameter(this.gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null
    const previousArrayBuffer = this.gl.getParameter(this.gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null
    const previousElementArrayBuffer = this.gl.getParameter(this.gl.ELEMENT_ARRAY_BUFFER_BINDING) as WebGLBuffer | null
    try {
      // Buffer uploads must not attach an index buffer to the terrain VAO (or
      // any other caller-owned VAO). ELEMENT_ARRAY_BUFFER is VAO state.
      this.gl.bindVertexArray(null)
      for (const item of source.batches) {
        if (!item.vertices || !item.indices) continue
        const material = await this.acquireMaterial(item.materialResourceId)
        const vertex = this.gl.createBuffer()!
        const index = this.gl.createBuffer()!
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, vertex)
        this.gl.bufferData(this.gl.ARRAY_BUFFER, item.vertices, this.gl.STATIC_DRAW)
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, index)
        this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, item.indices, this.gl.STATIC_DRAW)
        gpuBytes += item.vertices.byteLength + item.indices.byteLength
        batches.push({ ...material, vertex, index, count: item.indices.length })
      }
    } catch (error) {
      for (const batch of batches) {
        this.gl.deleteBuffer(batch.vertex)
        this.gl.deleteBuffer(batch.index)
        this.releaseMaterial(batch.material)
      }
      throw error
    } finally {
      this.gl.bindVertexArray(null)
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, previousArrayBuffer)
      this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, previousElementArrayBuffer)
      this.gl.bindVertexArray(previousVao)
    }
    this.cachedGpuBytes += gpuBytes
    this.meshes.set(modelIndex, { batches, bounds: source.bounds, gpuBytes })
  }

  private acquireMaterial(id: number): Promise<Omit<Batch, 'vertex' | 'index' | 'count'>> {
    let cached = this.materials.get(id)
    if (!cached) {
      let created!: CachedMaterial
      const promise = this.loadMaterial(id).catch(error => {
        if (this.materials.get(id) === created) this.materials.delete(id)
        throw error
      })
      created = { promise, references: 0 }
      cached = created
      this.materials.set(id, cached)
    }
    cached.references++
    return cached.promise
  }
  private async loadMaterial(id: number): Promise<Omit<Batch, 'vertex' | 'index' | 'count'>> { const resource = this.client.resource(id); if (!resource) throw new Error(`Missing scenery material ${id}`); const bytes = resource.encoding === 0 ? resource.bytes : await new Response(new Blob([resource.bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); const view = new DataView(bytes); const flags = view.getUint8(0); let texture: WebGLTexture; if ((flags & 1) !== 0) { try { const textureId = view.getUint32(16, true); texture = uploadResourceTexture(this.gl, await this.client.texture(textureId)) } catch (error) { console.warn(`Scenery texture for material ${id} skipped`, error); texture = this.solidTexture(new Uint8Array([160, 160, 160, 255])) } } else { texture = this.solidTexture(new Uint8Array(bytes.slice(16, 20))) } return { material: id, texture, translucent: (flags & 2) !== 0, additive: (flags & 4) !== 0, diffuse: view.getFloat32(8, true), luminosity: view.getFloat32(4, true), opacity: view.getFloat32(12, true) } }
  private solidTexture(color: Uint8Array): WebGLTexture { const texture = this.gl.createTexture()!; const previousActiveTexture = this.gl.getParameter(this.gl.ACTIVE_TEXTURE) as number; this.gl.activeTexture(this.gl.TEXTURE0 + BUILDING_TEXTURE_UNIT); this.gl.bindTexture(this.gl.TEXTURE_2D, texture); this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, 1, 1, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, color); this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR); this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR); this.gl.activeTexture(previousActiveTexture); return texture }
  private transformInstance(p: SceneryPlacement, id: number): number[] { const x = (id >>> 24) & 255; const y = (id >>> 16) & 255; return [x * LAND_BLOCK_SIZE + p.origin[0], y * LAND_BLOCK_SIZE + p.origin[1], p.origin[2], p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3], p.scale, p.scale, p.scale] }
  private chunkVisible(entry: { bounds: { minimum: [number, number, number]; maximum: [number, number, number] } }, id: number, camera: BaseCamera, mode: CameraMode): boolean { const blockX = (id >>> 24) & 255; const blockY = (id >>> 16) & 255; const x = blockX * LAND_BLOCK_SIZE; const y = blockY * LAND_BLOCK_SIZE; const bounds = { minimum: [x + entry.bounds.minimum[0], MAP_SIZE - (y + entry.bounds.maximum[1]), entry.bounds.minimum[2]] as [number, number, number], maximum: [x + entry.bounds.maximum[0], MAP_SIZE - (y + entry.bounds.minimum[1]), entry.bounds.maximum[2]] as [number, number, number] }; if (mode === CameraMode.Camera2D) { const c = camera as Camera2D; const a = c.ScreenToWorld(new Vector3(0, 0, 1)); const b = c.ScreenToWorld(new Vector3(c.ViewportSize.x, c.ViewportSize.y, 1)); return intersectsRectangle(bounds, new Vector3(Math.min(a.x, b.x), Math.min(a.y, b.y), -4096), new Vector3(Math.max(a.x, b.x), Math.max(a.y, b.y), 4096)) } return intersectsCamera(bounds, camera.FrameTransform) }
  private scheduleMeshes(visible: Set<number>): void {
    this.meshQueue = this.meshQueue.filter(id => {
      if (visible.has(id)) return true
      this.pending.delete(id)
      return false
    })
    for (const id of visible) {
      if (this.meshes.has(id) || this.pending.has(id)) continue
      this.pending.add(id)
      this.meshQueue.push(id)
    }
    this.pumpMeshQueue()
  }

  private pumpMeshQueue(): void {
    while (this.activeMeshLoads < MAX_MESH_LOADS_IN_FLIGHT && this.meshQueue.length > 0) {
      const modelIndex = this.meshQueue.shift()!
      if (!this.pending.has(modelIndex)) continue
      this.activeMeshLoads++
      void this.client.mesh(modelIndex).then(mesh => this.profiler.measure('model upload', () => this.upload(modelIndex, mesh))).catch(error => {
        console.warn(`Scenery model ${modelIndex} skipped`, error)
        this.meshes.set(modelIndex, null)
        this.diagnostics.failedResources++
      }).finally(() => {
        this.activeMeshLoads--
        this.pending.delete(modelIndex)
        this.pumpMeshQueue()
      })
    }
  }

  private trimMeshes(visible: Set<number>): void {
    while (this.cachedGpuBytes > this.maxGpuBytes || this.meshes.size > MAX_CACHED_MESHES) {
      const candidate = [...this.meshes.keys()].find(id => !visible.has(id))
      if (candidate === undefined) break
      const mesh = this.meshes.get(candidate)
      this.deleteMesh(mesh)
      this.meshes.delete(candidate)
      this.diagnostics.cacheEvictions++
    }
  }

  private releaseMaterial(id: number): void {
    const cached = this.materials.get(id)
    if (!cached || --cached.references > 0) return
    void cached.promise.then(material => {
      if (cached.references !== 0 || this.materials.get(id) !== cached) return
      this.materials.delete(id)
      this.gl.deleteTexture(material.texture)
    }).catch(() => undefined)
  }

  private deleteMesh(mesh: Mesh | null | undefined): void {
    if (!mesh) return
    this.cachedGpuBytes -= mesh.gpuBytes
    for (const batch of mesh.batches) {
      this.gl.deleteBuffer(batch.vertex)
      this.gl.deleteBuffer(batch.index)
      this.releaseMaterial(batch.material)
    }
  }
  private empty(): SceneryDiagnostics { return { visibleChunks: 0, loadedChunks: 0, visiblePlacements: 0, visibleModels: 0, instances: 0, drawCalls: 0, gpuBytes: 0, pendingRequests: 0, cacheEvictions: 0, failedResources: 0 } }
}
