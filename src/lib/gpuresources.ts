import type { V3MeshView } from "../v3/v3types";
import { ResourceRegistry } from "./resourceRegistry";

export interface LegacyMeshBatchSource {
  vertices?: Float32Array;
  indices?: Uint32Array;
}

export interface LegacyMeshSource {
  batches: LegacyMeshBatchSource[];
  vertexCount?: number;
  indexCount?: number;
}

export interface LegacyGpuBatch {
  vertexBuffer: WebGLBuffer | null;
  indexBuffer: WebGLBuffer | null;
  vertexCount: number;
  indexCount: number;
}

export interface LegacyGpuMesh {
  batches: LegacyGpuBatch[];
  gpuBytes: number;
}

interface LegacyCpuMesh {
  source: LegacyMeshSource;
  target: LegacyGpuMesh;
  indexed: boolean;
}

/** Registry-backed owner for the static mesh buffers used by legacy passes. */
export class LegacyMeshGpuOwner {
  readonly registry: ResourceRegistry<LegacyCpuMesh, LegacyGpuMesh>;
  private readonly gl: WebGL2RenderingContext;
  private readonly restoring = new Set<import("./resourceRegistry").ResourceGeneration<LegacyCpuMesh, LegacyGpuMesh>>();
  private readonly leases = new Map<number, import("./resourceRegistry").ResourceLease<LegacyCpuMesh, LegacyGpuMesh>>();
  private readonly contextLostHandler = (event: Event) => { event.preventDefault(); this.registry.contextLost(); };
  private readonly contextRestoredHandler = () => { this.registry.contextRestored(); };

  constructor(gl: WebGL2RenderingContext, budgets = { encodedBytes: 0, decodedBytes: 256 * 1024 * 1024, gpuBytes: 256 * 1024 * 1024, uploadBytesPerFrame: 8 * 1024 * 1024 }) {
    this.gl = gl;
    gl.canvas.addEventListener("webglcontextlost", this.contextLostHandler, false);
    gl.canvas.addEventListener("webglcontextrestored", this.contextRestoredHandler, false);
    this.registry = new ResourceRegistry({ budgets, destroyGpu: (mesh) => this.destroy(mesh), contextRestored: (generation) => { this.restoring.add(generation); } });
  }

  beginFrame(): void {
    this.registry.beginFrame();
    for (const generation of [...this.restoring]) {
      this.restoring.delete(generation);
      this.restore(generation);
    }
  }

  upload(id: number, source: LegacyMeshSource, indexed: boolean): LegacyGpuMesh {
    const target: LegacyGpuMesh = { batches: [], gpuBytes: 0 };
    const cpu = { source, target, indexed };
    const bytes = this.decodedBytes(source);
    const reservation = this.registry.reserveUpload(bytes);
    if (!reservation) throw new Error("Legacy mesh upload budget exceeded");
    try { this.allocate(cpu); } finally { reservation.release(); }
    this.registry.publish(id, cpu, { encodedBytes: 0, decodedBytes: this.decodedBytes(source) }, target, target.gpuBytes);
    this.leases.get(id)?.release();
    const lease = this.registry.acquire(id);
    if (lease) this.leases.set(id, lease);
    return target;
  }

  retain(id: number): import("./resourceRegistry").ResourceLease<LegacyCpuMesh, LegacyGpuMesh> | undefined {
    return this.registry.acquire(id);
  }

  current(id: number): LegacyGpuMesh | undefined {
    return this.registry.current(id)?.gpu;
  }

  release(id: number): void {
    const lease = this.registry.acquire(id);
    lease?.release();
    this.registry.remove(id);
  }

  remove(id: number): void { this.leases.get(id)?.release(); this.leases.delete(id); this.registry.remove(id); }

  dispose(): void {
    this.gl.canvas.removeEventListener("webglcontextlost", this.contextLostHandler);
    this.gl.canvas.removeEventListener("webglcontextrestored", this.contextRestoredHandler);
    this.registry.replaceDataset();
    this.leases.clear();
  }

  private allocate(cpu: LegacyCpuMesh): void {
    const batches: LegacyGpuBatch[] = [];
    const vertexBuffers = new Map<Float32Array, WebGLBuffer>();
    let bytes = 0;
    try {
      for (const item of cpu.source.batches) {
        let vertexBuffer: WebGLBuffer | null = null;
        if (item.vertices) {
          vertexBuffer = vertexBuffers.get(item.vertices) ?? null;
          if (!vertexBuffer) {
            vertexBuffer = this.gl.createBuffer();
            if (!vertexBuffer) throw new Error("Unable to allocate legacy mesh vertex buffer");
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, vertexBuffer);
            this.gl.bufferData(this.gl.ARRAY_BUFFER, item.vertices, this.gl.STATIC_DRAW);
            vertexBuffers.set(item.vertices, vertexBuffer);
            bytes += item.vertices.byteLength;
          }
        }
        const indexBuffer = cpu.indexed && item.indices ? this.gl.createBuffer() : null;
        if (item.vertices && !vertexBuffer || cpu.indexed && item.indices && !indexBuffer) throw new Error("Unable to allocate legacy mesh buffer");
        if (indexBuffer && item.indices) { this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer); this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, item.indices, this.gl.STATIC_DRAW); bytes += item.indices.byteLength; }
        batches.push({ vertexBuffer, indexBuffer, vertexCount: item.vertices?.length ?? 0, indexCount: item.indices?.length ?? 0 });
      }
      cpu.target.batches = batches;
      cpu.target.gpuBytes = bytes;
    } catch (error) {
      this.destroy({ batches, gpuBytes: bytes });
      for (const buffer of vertexBuffers.values()) {
        if (!batches.some((batch) => batch.vertexBuffer === buffer))
          this.gl.deleteBuffer(buffer);
      }
      throw error;
    }
  }

  private restore(generation: import("./resourceRegistry").ResourceGeneration<LegacyCpuMesh, LegacyGpuMesh>): void {
    try {
      this.allocate(generation.cpu);
      if (!this.registry.attachGpu(generation, generation.cpu.target, generation.cpu.target.gpuBytes)) this.destroy(generation.cpu.target);
    } catch {
      this.registry.markUploadPending(generation.id, false);
    }
  }

  private destroy(mesh: LegacyGpuMesh): void {
    const vertexBuffers = new Set<WebGLBuffer>();
    for (const batch of mesh.batches) {
      if (batch.vertexBuffer) vertexBuffers.add(batch.vertexBuffer);
      if (batch.indexBuffer) this.gl.deleteBuffer(batch.indexBuffer);
      batch.vertexBuffer = null;
      batch.indexBuffer = null;
    }
    for (const buffer of vertexBuffers) this.gl.deleteBuffer(buffer);
    mesh.gpuBytes = 0;
  }

  private decodedBytes(source: LegacyMeshSource): number {
    const vertices = new Set<Float32Array>();
    let bytes = 0;
    for (const item of source.batches) {
      if (item.vertices && !vertices.has(item.vertices)) {
        vertices.add(item.vertices);
        bytes += item.vertices.byteLength;
      }
      bytes += item.indices?.byteLength ?? 0;
    }
    return bytes;
  }
}

export interface GpuMesh {
  vertexBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  indexType: number;
  indexCount: number;
  gpuBytes: number;
}

export interface MeshAttributeLocations {
  position: number;
  normal: number;
  uv: number;
}

export class GpuResourceOwner {
  readonly samplers: { clamp: WebGLSampler; repeat: WebGLSampler };
  readonly registry: ResourceRegistry<V3MeshView, GpuMesh>;
  private readonly gl: WebGL2RenderingContext;
  private readonly attributes: MeshAttributeLocations;
  private readonly restoreQueue = new Set<import("./resourceRegistry").ResourceGeneration<V3MeshView, GpuMesh>>();
  private readonly contextLostHandler = (event: Event) => { event.preventDefault(); this.contextLost(); };
  private readonly contextRestoredHandler = () => this.contextRestored();

  constructor(gl: WebGL2RenderingContext, attributes: MeshAttributeLocations, budgets = { encodedBytes: 128 * 1024 * 1024, decodedBytes: 256 * 1024 * 1024, gpuBytes: 256 * 1024 * 1024, uploadBytesPerFrame: 8 * 1024 * 1024 }) {
    this.gl = gl;
    this.attributes = attributes;
    gl.canvas.addEventListener("webglcontextlost", this.contextLostHandler, false);
    gl.canvas.addEventListener("webglcontextrestored", this.contextRestoredHandler, false);
    this.samplers = { clamp: this.createSampler(), repeat: this.createSampler() };
    this.configureSamplers();
    this.registry = new ResourceRegistry({
      budgets,
      destroyGpu: (mesh) => this.destroyMesh(mesh),
      contextRestored: (generation) => { this.restoreQueue.add(generation); },
    });
  }

  beginFrame(): void {
    this.registry.beginFrame();
    for (const generation of [...this.restoreQueue]) {
      if (generation.gpu !== undefined) {
        this.restoreQueue.delete(generation);
        continue;
      }
      void this.restoreMesh(generation);
      if (generation.gpu !== undefined) this.restoreQueue.delete(generation);
    }
  }

  uploadMesh(id: number, mesh: V3MeshView, encodedBytes: number): boolean {
    const vertexCount = mesh.vertexData.byteLength / 24;
    const indexCount = mesh.indexData.byteLength / 4;
    const useShort = vertexCount <= 0xffff;
    const indexData = useShort ? new Uint16Array(indexCount) : new Uint32Array(mesh.indexData.buffer, mesh.indexData.byteOffset, indexCount);
    if (useShort) {
      const source = new Uint32Array(mesh.indexData.buffer, mesh.indexData.byteOffset, indexCount);
      for (let i = 0; i < source.length; i++) indexData[i] = source[i];
    }
    const uploadBytes = mesh.vertexData.byteLength + indexData.byteLength;
    if (!this.registry.canUpload()) return false;
    const reservation = this.registry.reserveUpload(uploadBytes);
    if (!reservation) return false;
    const vertexBuffer = this.gl.createBuffer();
    const indexBuffer = this.gl.createBuffer();
    const vao = this.gl.createVertexArray();
    if (!vertexBuffer || !indexBuffer || !vao) {
      if (vertexBuffer) this.gl.deleteBuffer(vertexBuffer);
      if (indexBuffer) this.gl.deleteBuffer(indexBuffer);
      if (vao) this.gl.deleteVertexArray(vao);
      reservation.release();
      throw new Error("Unable to allocate v3 mesh GPU resources");
    }
    try {
      this.gl.bindVertexArray(vao);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, vertexBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, mesh.vertexData, this.gl.STATIC_DRAW);
      this.gl.enableVertexAttribArray(this.attributes.position);
      this.gl.vertexAttribPointer(this.attributes.position, 3, this.gl.FLOAT, false, 24, 0);
      this.gl.enableVertexAttribArray(this.attributes.normal);
      this.gl.vertexAttribPointer(this.attributes.normal, 4, this.gl.SHORT, true, 24, 12);
      this.gl.enableVertexAttribArray(this.attributes.uv);
      this.gl.vertexAttribPointer(this.attributes.uv, 2, this.gl.HALF_FLOAT, false, 24, 20);
      this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, indexData, this.gl.STATIC_DRAW);
      this.gl.bindVertexArray(null);
      this.registry.publish(id, mesh, { encodedBytes, decodedBytes: mesh.vertexData.byteLength + mesh.indexData.byteLength }, { vertexBuffer, indexBuffer, vao, indexType: useShort ? this.gl.UNSIGNED_SHORT : this.gl.UNSIGNED_INT, indexCount, gpuBytes: uploadBytes }, uploadBytes);
      reservation.release();
      return true;
    } catch (error) {
      this.gl.bindVertexArray(null);
      this.gl.deleteVertexArray(vao);
      this.gl.deleteBuffer(vertexBuffer);
      this.gl.deleteBuffer(indexBuffer);
      reservation.release();
      throw error;
    }
  }

  contextLost(): void {
    this.restoreQueue.clear();
    this.registry.contextLost();
  }

  contextRestored(): void {
    this.samplers.clamp = this.createSampler();
    this.samplers.repeat = this.createSampler();
    this.configureSamplers();
    this.registry.contextRestored();
  }

  destroy(): void {
    this.gl.canvas.removeEventListener("webglcontextlost", this.contextLostHandler);
    this.gl.canvas.removeEventListener("webglcontextrestored", this.contextRestoredHandler);
    this.registry.replaceDataset();
    this.gl.deleteSampler(this.samplers.clamp);
    this.gl.deleteSampler(this.samplers.repeat);
  }

  private createSampler(): WebGLSampler {
    const sampler = this.gl.createSampler();
    if (!sampler) throw new Error("Unable to allocate v3 sampler");
    return sampler;
  }

  private configureSamplers(): void {
    const gl = this.gl;
    gl.samplerParameteri(this.samplers.clamp, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.samplerParameteri(this.samplers.clamp, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.samplers.clamp, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(this.samplers.clamp, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(this.samplers.repeat, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.samplerParameteri(this.samplers.repeat, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.samplers.repeat, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.samplerParameteri(this.samplers.repeat, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }

  private destroyMesh(mesh: GpuMesh): void {
    this.gl.deleteVertexArray(mesh.vao);
    this.gl.deleteBuffer(mesh.vertexBuffer);
    this.gl.deleteBuffer(mesh.indexBuffer);
  }

  private async restoreMesh(generation: import("./resourceRegistry").ResourceGeneration<V3MeshView, GpuMesh>): Promise<void> {
    const mesh = generation.cpu;
    const vertexCount = mesh.vertexData.byteLength / 24;
    const indexCount = mesh.indexData.byteLength / 4;
    const useShort = vertexCount <= 0xffff;
    const indexData = useShort ? new Uint16Array(indexCount) : new Uint32Array(mesh.indexData.buffer, mesh.indexData.byteOffset, indexCount);
    if (useShort) {
      const source = new Uint32Array(mesh.indexData.buffer, mesh.indexData.byteOffset, indexCount);
      for (let i = 0; i < source.length; i++) indexData[i] = source[i];
    }
    const uploadBytes = mesh.vertexData.byteLength + indexData.byteLength;
    const reservation = this.registry.reserveUpload(uploadBytes);
    if (!reservation) return;
    const vertexBuffer = this.gl.createBuffer();
    const indexBuffer = this.gl.createBuffer();
    const vao = this.gl.createVertexArray();
    if (!vertexBuffer || !indexBuffer || !vao) {
      if (vertexBuffer) this.gl.deleteBuffer(vertexBuffer);
      if (indexBuffer) this.gl.deleteBuffer(indexBuffer);
      if (vao) this.gl.deleteVertexArray(vao);
      reservation.release();
      return;
    }
    try {
      this.gl.bindVertexArray(vao);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, vertexBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, mesh.vertexData, this.gl.STATIC_DRAW);
      this.gl.enableVertexAttribArray(this.attributes.position);
      this.gl.vertexAttribPointer(this.attributes.position, 3, this.gl.FLOAT, false, 24, 0);
      this.gl.enableVertexAttribArray(this.attributes.normal);
      this.gl.vertexAttribPointer(this.attributes.normal, 4, this.gl.SHORT, true, 24, 12);
      this.gl.enableVertexAttribArray(this.attributes.uv);
      this.gl.vertexAttribPointer(this.attributes.uv, 2, this.gl.HALF_FLOAT, false, 24, 20);
      this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, indexData, this.gl.STATIC_DRAW);
      this.gl.bindVertexArray(null);
      if (!this.registry.attachGpu(generation, { vertexBuffer, indexBuffer, vao, indexType: useShort ? this.gl.UNSIGNED_SHORT : this.gl.UNSIGNED_INT, indexCount, gpuBytes: uploadBytes }, uploadBytes)) this.destroyMesh({ vertexBuffer, indexBuffer, vao, indexType: 0, indexCount, gpuBytes: uploadBytes });
      reservation.release();
    } catch (error) {
      this.gl.bindVertexArray(null);
      this.gl.deleteVertexArray(vao);
      this.gl.deleteBuffer(vertexBuffer);
      this.gl.deleteBuffer(indexBuffer);
      reservation.release();
      throw error;
    }
  }
}
