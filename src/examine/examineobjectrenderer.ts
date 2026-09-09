import { ExamineParticleRenderer } from "./examineparticlerenderer";
import {
  type AcDatClient,
  type LoadedModelBatch,
} from "../lib/acdatclient";
import { ExamineObjectLoader } from "./examineobjectloader";
import { createExamineCamera, type ExamineCamera } from "./examinecamera";
import { ExamineFragmentShader, ExamineVertexShader } from "./examineshaders";
import type { ExamineWindowState } from "./examinecreaturepanel";

type RenderBatch = LoadedModelBatch & {
  vertexBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  indexCount: number;
  order: number;
};
type PlacementTransform = { rotation: [number, number, number, number]; scale: [number, number, number] };

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create examine shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "unknown shader error";
    gl.deleteShader(shader);
    throw new Error(`Unable to compile examine shader: ${message}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to create examine program");
  const vertex = compile(gl, gl.VERTEX_SHADER, ExamineVertexShader);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, ExamineFragmentShader);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? "unknown link error";
    gl.deleteProgram(program);
    throw new Error(`Unable to link examine program: ${message}`);
  }
  return program;
}

export class ExamineObjectRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly loader: ExamineObjectLoader;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly clampSampler: WebGLSampler;
  private readonly repeatSampler: WebGLSampler;
  private readonly projectionLocation: WebGLUniformLocation | null;
  private readonly viewLocation: WebGLUniformLocation | null;
  private readonly modelLocation: WebGLUniformLocation | null;
  private readonly textureLocation: WebGLUniformLocation | null;
  private readonly opacityLocation: WebGLUniformLocation | null;
  private readonly luminosityLocation: WebGLUniformLocation | null;
  private readonly diffuseLocation: WebGLUniformLocation | null;
  private readonly alphaCutoffLocation: WebGLUniformLocation | null;
  private readonly alphaModeLocation: WebGLUniformLocation | null;
  private batches: RenderBatch[] = [];
  private particleBatches: LoadedModelBatch[] = [];
  private readonly particles: ExamineParticleRenderer;
  private animationFrame: number | null = null;
  private bounds: { minimum: [number, number, number]; maximum: [number, number, number] } | null = null;
  private camera: ExamineCamera | null = null;
  private modelMatrix = new Float32Array([
    0.9063, 0, -0.4226, 0,
    0, 1, 0, 0,
    0.4226, 0, 0.9063, 0,
    0, 0, 0, 1,
  ]);
  private loadController: AbortController | null = null;
  private generation = 0;
  private destroyed = false;
  private error: Error | null = null;
  private loaded: import("../lib/acdatclient").WorldObjectData | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly datClient: AcDatClient,
    private readonly onState?: (state: ExamineWindowState) => void,
  ) {
    const gl = canvas.getContext("webgl2", { alpha: true });
    if (!gl) throw new Error("Examine rendering requires WebGL2");
    this.gl = gl;
    this.loader = new ExamineObjectLoader(datClient);
    this.particles = new ExamineParticleRenderer(gl);
    this.program = createProgram(gl);
    const vao = gl.createVertexArray();
    const clampSampler = gl.createSampler();
    const repeatSampler = gl.createSampler();
    if (!vao || !clampSampler || !repeatSampler) throw new Error("Unable to create examine GPU resources");
    this.vao = vao;
    this.clampSampler = clampSampler;
    this.repeatSampler = repeatSampler;
    for (const sampler of [clampSampler, repeatSampler]) {
      gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    gl.samplerParameteri(clampSampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(clampSampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(repeatSampler, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.samplerParameteri(repeatSampler, gl.TEXTURE_WRAP_T, gl.REPEAT);
    this.projectionLocation = gl.getUniformLocation(this.program, "projection");
    this.viewLocation = gl.getUniformLocation(this.program, "view");
    this.modelLocation = gl.getUniformLocation(this.program, "model");
    this.textureLocation = gl.getUniformLocation(this.program, "materialTexture");
    this.opacityLocation = gl.getUniformLocation(this.program, "opacity");
    this.luminosityLocation = gl.getUniformLocation(this.program, "luminosity");
    this.diffuseLocation = gl.getUniformLocation(this.program, "diffuse");
    this.alphaCutoffLocation = gl.getUniformLocation(this.program, "alphaCutoff");
    this.alphaModeLocation = gl.getUniformLocation(this.program, "alphaMode");
    this.resize();
  }

  get lastError(): Error | null { return this.error; }
  get loadedObject(): import("../lib/acdatclient").WorldObjectData {
    if (!this.loaded) throw new Error("No examine object is loaded");
    return this.loaded;
  }

  async loadObject(guid: number | string, signal?: AbortSignal, modelIndex?: number, _placement?: PlacementTransform): Promise<void> {
    if (this.destroyed) throw new Error("Examine renderer has been destroyed");
    this.loadController?.abort();
    this.releaseBatches();
    this.bounds = null;
    this.camera = null;
    const controller = new AbortController();
    this.loadController = controller;
    const generation = ++this.generation;
    const forwardAbort = () => controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    if (signal?.aborted) controller.abort();
    this.error = null;
    this.loaded = null;
    try {
      const loaded = await this.loader.load(guid, controller.signal, (phase) => {
        if (generation === this.generation && !controller.signal.aborted && !this.destroyed) {
          this.onState?.(phase);
        }
      }, modelIndex);
      if (generation !== this.generation || controller.signal.aborted || this.destroyed) {
        this.loader.release(loaded);
        return;
      }
      this.releaseBatches();
      this.loaded = loaded.object;
      this.bounds = this.renderedBounds(loaded.batches, loaded.mesh.bounds);
      this.camera = createExamineCamera(this.bounds, this.canvas.width, this.canvas.height, 1);
      this.updateModelMatrix();
      try {
        for (const [order, batch] of loaded.batches.entries()) {
          if (batch.mesh.particles) {
            this.particleBatches.push(batch);
          } else {
            this.batches.push(this.uploadBatch(batch, order));
          }
        }
      } catch (cause) {
        const uploadedCount = this.batches.length + this.particleBatches.length;
        this.releaseBatches();
        this.loader.release({ ...loaded, batches: loaded.batches.slice(uploadedCount) });
        throw cause;
      }
      this.particles.setBatches(this.particleBatches);
      this.resize();
      this.startAnimation();
    } catch (cause) {
      if (generation !== this.generation || controller.signal.aborted) return;
      this.releaseBatches();
      this.bounds = null;
      this.camera = null;
      this.error = cause instanceof Error ? cause : new Error(String(cause));
      throw this.error;
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
      if (this.loadController === controller) this.loadController = null;
    }
  }

  clear(): void {
    if (this.destroyed) return;
    this.loadController?.abort();
    this.generation++;
    this.releaseBatches();
    this.bounds = null;
    this.camera = null;
    this.loaded = null;
    this.error = null;
  }

  resize(): void {
    if (this.destroyed) return;
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * devicePixelRatio));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * devicePixelRatio));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
    if (this.bounds) this.camera = createExamineCamera(this.bounds, width, height, 1);
  }

  render(): void {
    if (this.destroyed) return;
    this.datClient.beginFrame();
    if (!this.camera) return;
    const gl = this.gl;
    gl.depthMask(true);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(this.projectionLocation, false, this.camera.projection);
    gl.uniformMatrix4fv(this.viewLocation, false, this.camera.view);
    gl.uniformMatrix4fv(this.modelLocation, false, this.modelMatrix);
    gl.uniform1i(this.textureLocation, 0);
    for (const mode of ["opaque", "cutout", "blended", "additive"] as const) {
      for (const batch of this.batches) {
        if (batch.material.alphaMode !== mode) continue;
        this.drawBatch(batch);
      }
    }
    gl.bindVertexArray(null);
    this.particles.render(this.camera, this.modelMatrix, this.clampSampler, this.repeatSampler);
  }

  private startAnimation(): void {
    if (!this.particles.active || this.animationFrame !== null) {
      return;
    }
    this.animationFrame = requestAnimationFrame(() => {
      this.animationFrame = null;
      this.render();
      this.startAnimation();
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadController?.abort();
    this.releaseBatches();
    this.bounds = null;
    this.camera = null;
    this.loaded = null;
    this.particles.destroy();
    this.gl.deleteSampler(this.clampSampler);
    this.gl.deleteSampler(this.repeatSampler);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
  }

  private uploadBatch(batch: LoadedModelBatch, order: number): RenderBatch {
    const vertices = batch.mesh.vertices;
    const indices = batch.mesh.indices;
    if (!vertices || !indices) throw new Error("Examine mesh batch has no indexed geometry");
    const vertexBuffer = this.gl.createBuffer();
    const indexBuffer = this.gl.createBuffer();
    if (!vertexBuffer || !indexBuffer) {
      this.gl.deleteBuffer(vertexBuffer);
      this.gl.deleteBuffer(indexBuffer);
      throw new Error("Unable to create examine mesh buffers");
    }
    this.gl.bindVertexArray(this.vao);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, vertexBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STATIC_DRAW);
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, indices, this.gl.STATIC_DRAW);
    this.gl.enableVertexAttribArray(0);
    this.gl.enableVertexAttribArray(1);
    this.gl.enableVertexAttribArray(2);
    this.gl.vertexAttribPointer(0, 3, this.gl.FLOAT, false, 32, 0);
    this.gl.vertexAttribPointer(1, 3, this.gl.FLOAT, false, 32, 12);
    this.gl.vertexAttribPointer(2, 2, this.gl.FLOAT, false, 32, 24);
    return { ...batch, vertexBuffer, indexBuffer, indexCount: indices.length, order };
  }

  private drawBatch(batch: RenderBatch): void {
    const gl = this.gl;
    const material = batch.material;
    const cull = batch.mesh.cullState ?? material.cullState;
    if (cull === "none") gl.disable(gl.CULL_FACE);
    else {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(cull === "front" ? gl.FRONT : gl.BACK);
    }
    if (material.alphaMode === "blended" || material.alphaMode === "additive") {
      gl.enable(gl.BLEND);
      gl.blendFunc(
        material.alphaMode === "additive" ? gl.ONE : gl.SRC_ALPHA,
        material.alphaMode === "additive" ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA,
      );
    } else gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, material.texture);
    const samplerMode = batch.mesh.samplerMode ?? (batch.mesh.hasWrappingUVs ? "repeat" : material.samplerMode);
    gl.bindSampler(0, samplerMode === "repeat" ? this.repeatSampler : this.clampSampler);
    gl.uniform1f(this.opacityLocation, material.opacity);
    gl.uniform1f(this.luminosityLocation, material.luminosity);
    gl.uniform1f(this.diffuseLocation, material.diffuse);
    gl.uniform1f(this.alphaCutoffLocation, material.alphaCutoff);
    gl.uniform1i(this.alphaModeLocation, material.alphaMode === "cutout" ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.vertexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, batch.indexBuffer);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 12);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 24);
    gl.drawElements(gl.TRIANGLES, batch.indexCount, gl.UNSIGNED_INT, 0);
  }

  private releaseBatches(): void {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.particles.setBatches([]);
    const releases: Promise<void>[] = [];
    for (const batch of this.batches) {
      this.gl.deleteBuffer(batch.vertexBuffer);
      this.gl.deleteBuffer(batch.indexBuffer);
      releases.push(this.datClient.releaseMaterial(batch.mesh.materialResourceId));
    }
    this.batches = [];
    for (const batch of this.particleBatches) {
      releases.push(this.datClient.releaseMaterial(batch.mesh.materialResourceId));
    }
    this.particleBatches = [];
    // Flush this client's deferred texture deletions after material releases finish.
    void Promise.all(releases).then(() => this.datClient.beginFrame());
    this.gl.depthMask(true);
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
  }

  private updateModelMatrix(): void {
    if (!this.bounds) return;
    const center = this.bounds.minimum.map((value, index) =>
      (value + this.bounds!.maximum[index]) * 0.5,
    );
    const display = [0, 1, 0, 0] as [number, number, number, number];
    // ACTerrain meshes use Z-up. The examine camera uses Y-up, so convert
    // AC (X, Y, Z) into examine (X, Z, -Y) before applying display rotation.
    const acToExamine = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] as [number, number, number, number];
    const q = this.multiplyQuaternion(display, acToExamine);
    const rotation = this.quaternionMatrix(q);
    const [cx, cy, cz] = center;
    const tx = -(rotation[0] * cx + rotation[4] * cy + rotation[8] * cz);
    const ty = -(rotation[1] * cx + rotation[5] * cy + rotation[9] * cz);
    const tz = -(rotation[2] * cx + rotation[6] * cy + rotation[10] * cz);
    this.modelMatrix = new Float32Array([
      rotation[0], rotation[1], rotation[2], 0,
      rotation[4], rotation[5], rotation[6], 0,
      rotation[8], rotation[9], rotation[10], 0,
      tx, ty, tz, 1,
    ]);
  }

  private renderedBounds(
    batches: LoadedModelBatch[],
    fallback: { minimum: [number, number, number]; maximum: [number, number, number] },
  ): { minimum: [number, number, number]; maximum: [number, number, number] } {
    const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
    const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let vertexCount = 0;
    for (const batch of batches) {
      if (batch.mesh.particles) {
        continue;
      }
      const vertices = batch.mesh.vertices;
      if (!vertices) continue;
      vertexCount += vertices.length / 8;
      for (let offset = 0; offset < vertices.length; offset += 8) {
        for (let axis = 0; axis < 3; axis++) {
          minimum[axis] = Math.min(minimum[axis], vertices[offset + axis]);
          maximum[axis] = Math.max(maximum[axis], vertices[offset + axis]);
        }
      }
    }
    return vertexCount > 0 ? { minimum, maximum } : fallback;
  }

  private multiplyQuaternion(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
  }

  private quaternionMatrix(q: [number, number, number, number]): number[] {
    const [x, y, z, w] = q;
    return [
      1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
      2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
      2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
      0, 0, 0, 1,
    ];
  }
}

