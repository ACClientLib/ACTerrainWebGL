import type {
  AcDatClient,
  ObjectMaterial,
  ParticleEmitterDescriptor,
} from "./acdatclient";
import type { EvaluatedRegionSky, EvaluatedSkyObject } from "./regionsky";
import type { ScenePass, SceneSubmissionSink } from "./scenesubmission";
import type { SceneView } from "./sceneview";
import { Building3DFragSource } from "../shaders/building3d.frag";
import { SkyVertSource } from "../shaders/sky.vert";
import { SkyEffectController } from "./skyeffects";
import type { SkyParticleInput } from "./scenegeometryrenderer";
import { invalidateSceneDrawState } from "./scenedrawstate";
import type { LegacyMeshGpuOwner } from "./gpuresources";

interface SkyBatch {
  vao: WebGLVertexArrayObject;
  indexCount: number;
  material: ObjectMaterial;
}
interface SkyParticleBatch {
  material: ObjectMaterial;
  particles: ParticleEmitterDescriptor[];
}

/** Owns authored sky draws; SceneRenderer owns their pass and GL state. */
export class SkyboxRenderer {
  private program!: WebGLProgram;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  private readonly batches = new Map<number, SkyBatch[]>();
  private readonly particleBatches = new Map<number, SkyParticleBatch[]>();
  private readonly materialIds: number[] = [];
  private readonly meshLeases: ReturnType<LegacyMeshGpuOwner["acquire"]>[] = [];
  private readonly effects = new SkyEffectController();
  private lastFrameTime = performance.now();
  private effectSeconds = 0;
  private generation = 0;
  private groupIndex = -1;
  private requestedGroupIndex = -1;
  private selectedSky: EvaluatedRegionSky | null = null;
  private ready = false;
  private destroyed = false;
  private contextLost = false;

  private readonly onContextLost = () => {
    this.contextLost = true;
    this.clear();
  };
  private readonly onContextRestored = () => {
    this.contextLost = false;
    this.createProgram();
  };

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly dats: AcDatClient,
    private readonly meshOwner: LegacyMeshGpuOwner,
    private readonly onReady?: () => void,
  ) {
    this.createProgram();
    gl.canvas.addEventListener("webglcontextlost", this.onContextLost);
    gl.canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  private createProgram(): void {
    const gl = this.gl;
    const vertex = this.compile(gl.VERTEX_SHADER, SkyVertSource);
    const fragment = this.compile(gl.FRAGMENT_SHADER, Building3DFragSource);
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      throw new Error("Unable to allocate sky program");
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(message ?? "Unable to link sky program");
    }
    this.program = program;
    this.uniforms.clear();
    for (const name of [
      "xWorld",
      "skyOrigin",
      "skyRotation",
      "uvOffset",
      "buildingTexture",
      "diffuseAmount",
      "luminosity",
      "opacity",
      "alphaCutoff",
      "alphaMode",
      "renderPass",
      "cameraPosition",
      "fogEnabled",
      "lightDirection",
      "sunlightColor",
      "ambientColor",
    ]) {
      this.uniforms.set(name, gl.getUniformLocation(program, name));
    }
  }

  select(sky: EvaluatedRegionSky | null): EvaluatedRegionSky | null {
    if (!sky || this.destroyed || this.contextLost) {
      if (this.selectedSky || this.requestedGroupIndex !== -1) {
        this.clear();
      }
      return null;
    }
    if (this.requestedGroupIndex !== sky.groupIndex) {
      this.requestedGroupIndex = sky.groupIndex;
      const generation = ++this.generation;
      void this.loadGroup(sky, generation);
    }
    if (this.groupIndex === sky.groupIndex) {
      this.selectedSky = sky;
    }
    return this.selectedSky;
  }

  submit(sky: EvaluatedRegionSky, submit: SceneSubmissionSink): void {
    if (this.destroyed || this.contextLost) {
      return;
    }
    if (!this.ready) {
      return;
    }
    const now = performance.now();
    const delta = Math.max(
      0,
      Math.min((now - this.lastFrameTime) / 1000, 0.25),
    );
    this.lastFrameTime = now;
    this.effectSeconds += delta;
    this.effects.advance(delta);
    for (const item of sky.objects) {
      if (!item.visible || item.meshResourceId === null) {
        continue;
      }
      const batches = this.batches.get(item.meshResourceId) ?? [];
      for (let index = 0; index < batches.length; index++) {
        const batch = batches[index];
        const renderClass =
          batch.material.alphaMode === "additive" ? "additive" : "sourceOver";
        submit({
          skyPass:
            (item.object.properties & 1) !== 0 ? "foreground" : "background",
          skyObjectIndex: item.object.objectIndex,
          key: {
            renderClass,
            programVariant: "sky",
            cullState: batch.material.cullState,
            meshBatch: index,
            material: item.meshResourceId,
            sampler: batch.material.samplerMode,
            parity: false,
          },
          instanceCount: 1,
          draw: (view, pass) => this.draw(view, item, batch, pass),
        });
      }
    }
  }

  particles(
    sky: EvaluatedRegionSky,
    cameraOrigin: [number, number, number],
  ): SkyParticleInput[] {
    if (!this.ready) {
      return [];
    }
    const result: SkyParticleInput[] = [];
    for (const item of sky.objects) {
      if (!item.visible) {
        continue;
      }
      if (
        item.object.defaultPesObjectId === null &&
        item.meshResourceId !== null
      ) {
        const batches = this.particleBatches.get(item.meshResourceId) ?? [];
        for (let index = 0; index < batches.length; index++) {
          const batch = batches[index];
          const offset = this.rotate([0, 0, -500], this.rotation(item));
          const origin: [number, number, number] = [
            cameraOrigin[0] + offset[0],
            cameraOrigin[1] + offset[1],
            cameraOrigin[2] + offset[2],
          ];
          result.push({
            key: `sky:${this.groupIndex}:${item.object.objectIndex}:setup:${item.meshResourceId}:${index}`,
            material: batch.material,
            particles: batch.particles,
            origin,
            rotation: this.rotation(item),
            scale: [1, 1, 1],
            emitting: true,
            skyPass:
              (item.object.properties & 1) !== 0 ? "foreground" : "background",
            objectIndex: item.object.objectIndex,
          });
        }
      }
      for (const active of this.effects.activeParticles(
        item.object.objectIndex,
      )) {
        const effect = item.object.effects.find(
          (value) => value.scriptId === active.scriptId,
        );
        if (!effect || effect.particleResourceId === null) {
          continue;
        }
        const batches =
          this.particleBatches.get(effect.particleResourceId) ?? [];
        for (let index = 0; index < batches.length; index++) {
          const batch = batches[index];
          const particles = batch.particles.filter(
            (particle) => particle.hookIndex === active.createIndex,
          );
          if (particles.length === 0) {
            continue;
          }
          const offset = this.rotate([0, 0, -500], this.rotation(item));
          const origin: [number, number, number] = [
            cameraOrigin[0] + offset[0],
            cameraOrigin[1] + offset[1],
            cameraOrigin[2] + offset[2],
          ];
          result.push({
            key: `sky:${this.groupIndex}:${active.invocation}:${index}`,
            material: batch.material,
            particles,
            origin,
            rotation: this.rotation(item),
            scale: [1, 1, 1],
            emitting: active.emitting,
            skyPass:
              (item.object.properties & 1) !== 0 ? "foreground" : "background",
            objectIndex: item.object.objectIndex,
          });
        }
      }
    }
    return result;
  }

  clear(): void {
    ++this.generation;
    this.effects.stop();
    this.ready = false;
    this.groupIndex = -1;
    this.requestedGroupIndex = -1;
    this.selectedSky = null;
    this.effectSeconds = 0;
    this.lastFrameTime = performance.now();
    for (const batches of this.batches.values()) {
      for (const batch of batches) {
        this.gl.deleteVertexArray(batch.vao);
      }
    }
    this.batches.clear();
    this.particleBatches.clear();
    for (const id of this.materialIds) {
      void this.dats.releaseMaterial(id);
    }
    this.materialIds.length = 0;
    for (const lease of this.meshLeases) {
      lease.release();
    }
    this.meshLeases.length = 0;
  }

  destroy(): void {
    this.destroyed = true;
    this.clear();
    this.gl.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.gl.canvas.removeEventListener(
      "webglcontextrestored",
      this.onContextRestored,
    );
    this.gl.deleteProgram(this.program);
  }

  private async loadGroup(
    sky: EvaluatedRegionSky,
    generation: number,
  ): Promise<void> {
    const loadedBatches = new Map<number, SkyBatch[]>();
    const loadedParticles = new Map<number, SkyParticleBatch[]>();
    const materialIds: number[] = [];
    const meshLeases: ReturnType<LegacyMeshGpuOwner["acquire"]>[] = [];
    let installed = false;
    try {
      const group =
        this.dats.getRegionSkyDescriptor()!.dayGroups[sky.groupIndex];
      const meshIds = new Set<number>();
      for (const object of group.objects) {
        if (object.defaultMeshResourceId !== null) {
          meshIds.add(object.defaultMeshResourceId);
        }
        for (const effect of object.effects) {
          if (effect.particleResourceId !== null) {
            meshIds.add(effect.particleResourceId);
          }
        }
      }
      for (const frame of group.keyframes) {
        for (const replacement of frame.replacements) {
          if (replacement.meshResourceId !== null) {
            meshIds.add(replacement.meshResourceId);
          }
        }
      }
      for (const id of meshIds) {
        const mesh = await this.dats.meshResource(id);
        const materials = await Promise.all(
          mesh.batches.map((batch) => {
            materialIds.push(batch.materialResourceId);
            return this.dats.material(batch.materialResourceId);
          }),
        );
        if (generation !== this.generation || this.destroyed) {
          return;
        }
        const batches: SkyBatch[] = [];
        loadedBatches.set(id, batches);
        loadedParticles.set(id, []);
        this.gl.bindVertexArray(null);
        const lease = this.meshOwner.acquire(id, mesh);
        meshLeases.push(lease);
        const gpu = lease.value.gpu!;
        for (let index = 0; index < mesh.batches.length; index++) {
          const source = mesh.batches[index];
          const material = {
            ...materials[index],
            // Follow the resource owner's handle when its texture is restored.
            get texture() {
              return materials[index].texture;
            },
            cullState: source.cullState ?? materials[index].cullState,
            // Preserve the batch's UV addressing mode. Non-tiled cube faces
            // need edge clamping, while clouds and other sky effects may use
            // tiled/out-of-range UVs.
            samplerMode:
              source.samplerMode ??
              (source.hasWrappingUVs === true ? "repeat" : "clamp"),
          };
          if (source.particles) {
            loadedParticles
              .get(id)!
              .push({ material, particles: source.particles });
          }
          if (!source.vertices || !source.indices) {
            continue;
          }
          const gl = this.gl;
          const vao = gl.createVertexArray();
          const vertexBuffer = gpu.batches[index].vertexBuffer;
          const indexBuffer = gpu.batches[index].indexBuffer;
          if (!vao || !vertexBuffer || !indexBuffer) {
            gl.deleteVertexArray(vao);
            throw new Error("Unable to allocate sky mesh");
          }
          batches.push({ vao, indexCount: source.indices.length, material });
          gl.bindVertexArray(vao);
          gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
          gl.enableVertexAttribArray(0);
          gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
          gl.enableVertexAttribArray(1);
          gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 12);
          gl.enableVertexAttribArray(2);
          gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 24);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
          gl.bindVertexArray(null);
        }
      }
      this.clear();
      for (const [id, batches] of loadedBatches) {
        this.batches.set(id, batches);
      }
      for (const [id, batches] of loadedParticles) {
        this.particleBatches.set(id, batches);
      }
      this.materialIds.push(...materialIds);
      this.meshLeases.push(...meshLeases);
      installed = true;
      this.groupIndex = sky.groupIndex;
      this.requestedGroupIndex = sky.groupIndex;
      this.selectedSky = sky;
      this.effects.setGroup(sky.groupIndex, group.objects);
      this.lastFrameTime = performance.now();
      this.ready = true;
      this.onReady?.();
    } catch (error) {
      if (generation === this.generation && !this.destroyed) {
        console.error("Unable to prepare sky group", error);
      }
    } finally {
      if (!installed) {
        for (const id of materialIds) {
          void this.dats.releaseMaterial(id);
        }
        for (const batches of loadedBatches.values()) {
          for (const batch of batches) {
            this.gl.deleteVertexArray(batch.vao);
          }
        }
        for (const lease of meshLeases) {
          lease.release();
        }
      }
    }
  }

  private rotation(item: EvaluatedSkyObject): [number, number, number, number] {
    // AC applies heading about negative Z, then global rotation about negative Y.
    const heading = (-item.heading * Math.PI) / 360;
    const rotation = (-item.angle * Math.PI) / 360;
    return [
      Math.sin(rotation) * Math.sin(heading),
      Math.sin(rotation) * Math.cos(heading),
      Math.cos(rotation) * Math.sin(heading),
      Math.cos(rotation) * Math.cos(heading),
    ];
  }

  private rotate(
    value: [number, number, number],
    quaternion: [number, number, number, number],
  ): [number, number, number] {
    const [x, y, z, w] = quaternion;
    const cross1: [number, number, number] = [
      y * value[2] - z * value[1],
      z * value[0] - x * value[2],
      x * value[1] - y * value[0],
    ];
    const cross2: [number, number, number] = [
      y * cross1[2] - z * cross1[1],
      z * cross1[0] - x * cross1[2],
      x * cross1[1] - y * cross1[0],
    ];
    return [
      value[0] + 2 * (w * cross1[0] + cross2[0]),
      value[1] + 2 * (w * cross1[1] + cross2[1]),
      value[2] + 2 * (w * cross1[2] + cross2[2]),
    ];
  }

  private draw(
    view: SceneView,
    item: EvaluatedSkyObject,
    batch: SkyBatch,
    pass: ScenePass,
  ): void {
    const gl = this.gl;
    const uniform = (name: string) => this.uniforms.get(name) ?? null;
    invalidateSceneDrawState(gl);
    gl.useProgram(this.program);
    gl.bindVertexArray(batch.vao);
    // Keep the camera's projection, mirrored axes and rotation intact. Composing
    // its position cancels view translation without editing a projected matrix.
    const matrix = view.viewProjection
      .clone()
      .translate([...view.cameraPosition]);
    gl.uniformMatrix4fv(uniform("xWorld"), false, matrix);
    gl.uniform3f(uniform("cameraPosition"), 0, 0, 0);
    gl.uniform3f(uniform("skyOrigin"), 0, 0, 0);
    gl.uniform4f(uniform("skyRotation"), ...this.rotation(item));
    const u = item.object.texVelocity[0] * this.effectSeconds;
    const v = item.object.texVelocity[1] * this.effectSeconds;
    gl.uniform2f(uniform("uvOffset"), u - Math.floor(u), v - Math.floor(v));
    gl.uniform1i(uniform("fogEnabled"), 0);
    gl.uniform3f(uniform("lightDirection"), ...view.lighting.direction);
    gl.uniform3f(uniform("sunlightColor"), ...view.lighting.sunlight);
    gl.uniform3f(uniform("ambientColor"), ...view.lighting.ambient);
    gl.uniform1i(uniform("buildingTexture"), 3);
    // Sky faces should have continuous brightness across their shared edges.
    // The regular building shader derives lighting from the face normal, which
    // makes the cube's directional-light discontinuities visible as seams.
    gl.uniform1f(uniform("diffuseAmount"), 0);
    gl.uniform1f(uniform("luminosity"), 1);
    gl.uniform1f(
      uniform("opacity"),
      batch.material.opacity *
        (item.transparent >= 0 ? 1 - item.transparent * 0.01 : 1),
    );
    gl.uniform1f(uniform("alphaCutoff"), batch.material.alphaCutoff);
    gl.uniform1i(
      uniform("alphaMode"),
      batch.material.alphaMode === "cutout"
        ? 1
        : batch.material.alphaMode === "blended"
          ? 2
          : batch.material.alphaMode === "additive"
            ? 3
            : 0,
    );
    gl.uniform1i(uniform("renderPass"), pass === "additive" ? 1 : 3);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, batch.material.texture);
    gl.drawElements(gl.TRIANGLES, batch.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  private compile(type: number, source: string): WebGLShader {
    const shader = this.gl.createShader(type);
    if (!shader) {
      throw new Error("Unable to allocate sky shader");
    }
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      const message = this.gl.getShaderInfoLog(shader);
      this.gl.deleteShader(shader);
      throw new Error(message ?? "Unable to compile sky shader");
    }
    return shader;
  }
}
