import { Matrix4 } from "@math.gl/core";
import type { LoadedModelBatch } from "../lib/acdatclient";
import { ParticleSimulation } from "../lib/particlesimulation";
import { appendParticleInstance } from "../lib/particleinstancedata";
import { createProgram, createShader } from "../lib/glhelpers";
import { ParticleVertSource } from "../shaders/particle.vert";
import { ParticleFragSource } from "../shaders/particle.frag";
import type { ExamineCamera } from "./examinecamera";

export class ExamineParticleRenderer {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quad: WebGLBuffer;
  private readonly instances: WebGLBuffer;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  private batches: { batch: LoadedModelBatch; simulations: ParticleSimulation[] }[] = [];
  private lastTime: number | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {
    const vertex = createShader(gl, gl.VERTEX_SHADER, ParticleVertSource);
    const fragment = createShader(gl, gl.FRAGMENT_SHADER, ParticleFragSource);
    const program = vertex && fragment ? createProgram(gl, vertex, fragment) : null;
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!program) {
      throw new Error("Unable to create examine particle program");
    }
    this.program = program;
    this.vao = gl.createVertexArray()!;
    this.quad = gl.createBuffer()!;
    this.instances = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    for (const [location, size, offset] of [[1, 3, 0], [2, 4, 12], [3, 3, 28], [4, 4, 40], [5, 4, 56], [6, 1, 72]]) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 76, offset);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
    for (const name of ["xWorld", "acYOrigin", "cameraRight", "cameraUp", "cameraPosition", "particleTexture", "materialOpacity", "alphaMode", "alphaCutoff", "renderPass", "fogEnabled"]) {
      this.uniforms.set(name, gl.getUniformLocation(program, name));
    }
  }

  setBatches(batches: LoadedModelBatch[]): void {
    this.batches = batches.map((batch) => ({
      batch,
      simulations: batch.mesh.particles!.map((descriptor) => new ParticleSimulation(descriptor)),
    }));
    this.lastTime = null;
  }

  get active(): boolean {
    return this.batches.length > 0;
  }

  render(camera: ExamineCamera, model: Float32Array, clamp: WebGLSampler, repeat: WebGLSampler): void {
    if (!this.active) {
      return;
    }
    const gl = this.gl;
    const uniform = (name: string) => this.uniforms.get(name)!;
    const now = performance.now();
    const delta = this.lastTime === null ? 0 : (now - this.lastTime) / 1000;
    this.lastTime = now;
    // The shared shader reflects AC Y for world rendering. Undo that reflection
    // before applying the paperdoll's AC-to-camera transform.
    const matrix = new Matrix4(camera.projection).multiplyRight(camera.view).multiplyRight(model).scale([1, -1, 1]);
    const cameraZ = -camera.view[14];
    const localCamera = [0, 1, 2].map((axis) =>
      model[axis * 4] * -model[12] + model[axis * 4 + 1] * -model[13] + model[axis * 4 + 2] * (cameraZ - model[14]),
    );
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(uniform("xWorld"), false, new Float32Array(matrix));
    gl.uniform1f(uniform("acYOrigin"), 0);
    gl.uniform3f(uniform("cameraRight"), model[0], model[4], model[8]);
    gl.uniform3f(uniform("cameraUp"), model[1], model[5], model[9]);
    gl.uniform3fv(uniform("cameraPosition"), localCamera);
    gl.uniform1i(uniform("particleTexture"), 0);
    gl.uniform1i(uniform("fogEnabled"), 0);
    gl.uniform1i(uniform("renderPass"), 1);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    for (const { batch, simulations } of this.batches) {
      const data: number[] = [];
      for (const simulation of simulations) {
        const placement = batch.particlePlacement;
        for (const instance of simulation.update(delta, placement?.offset ?? [0, 0, 0], placement?.orientation ?? [0, 0, 0, 1], placement?.scale ?? [1, 1, 1])) {
          appendParticleInstance(data, instance);
        }
      }
      if (data.length === 0) {
        continue;
      }
      const material = batch.material;
      gl.blendFunc(gl.ONE, material.alphaMode === "additive" ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, material.texture);
      const samplerMode = batch.mesh.samplerMode ?? (batch.mesh.hasWrappingUVs ? "repeat" : material.samplerMode);
      gl.bindSampler(0, samplerMode === "repeat" ? repeat : clamp);
      gl.uniform1f(uniform("materialOpacity"), material.opacity);
      gl.uniform1f(uniform("alphaCutoff"), material.alphaCutoff);
      gl.uniform1i(uniform("alphaMode"), material.alphaMode === "cutout" ? 1 : 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, data.length / 19);
    }
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  destroy(): void {
    this.setBatches([]);
    this.gl.deleteBuffer(this.instances);
    this.gl.deleteBuffer(this.quad);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
  }
}
