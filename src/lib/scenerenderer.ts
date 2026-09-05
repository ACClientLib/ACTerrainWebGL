import type { SceneView } from "./sceneview";
import { createDepthBucketQueue, probeTransparency, type DepthBucketQueue, type TransparencyCapabilities, type TransparencyTier } from "./scenetransparency";
import type { ScenePass, SceneSubmission } from "./scenesubmission";
import { SourceOverVertSource } from "../shaders/sourceover.vert";
import { SceneCompositeFragSource } from "../shaders/scenecomposite.frag";
import { ScenePresentFragSource } from "../shaders/scenepresent.frag";
import { invalidateSceneDrawState } from "./scenedrawstate";

interface SceneTargets {
  width: number;
  height: number;
  opaque: WebGLTexture;
  composition: WebGLTexture;
  depth: WebGLRenderbuffer;
  framebuffer: WebGLFramebuffer;
  accumulation?: WebGLTexture;
  revealage?: WebGLTexture;
}

export class SceneRenderer {
  capabilities: TransparencyCapabilities;
  private readonly drawBuffersIndexed: {
    blendFuncSeparateiOES?(buf: number, srcRGB: number, dstRGB: number, srcAlpha: number, dstAlpha: number): void;
    blendFunciOES?(buf: number, src: number, dst: number): void;
  } | null;
  private targets: SceneTargets | undefined;
  private compositeProgram: WebGLProgram | undefined;
  private compositeVao: WebGLVertexArrayObject | undefined;
  private compositeBuffer: WebGLBuffer | undefined;
  private compositeOpaqueLoc: WebGLUniformLocation | null = null;
  private compositeAccumulationLoc: WebGLUniformLocation | null = null;
  private compositeRevealageLoc: WebGLUniformLocation | null = null;
  private presentProgram: WebGLProgram | undefined;
  private presentSceneLoc: WebGLUniformLocation | null = null;
  private clampSampler: WebGLSampler | undefined;
  private repeatSampler: WebGLSampler | undefined;
  private currentCullState: "none" | "front" | "back" | null = null;
  private currentSampler: "clamp" | "repeat" | null = null;
  private readonly tierCQueue: DepthBucketQueue<number> = createDepthBucketQueue(16);
  private readonly tierCSubmissionOrder: number[] = [];
  private readonly contextLostHandler = (event: Event) => {
    event.preventDefault();
    invalidateSceneDrawState(this.gl);
    this.targets = undefined;
    this.compositeProgram = undefined;
    this.compositeVao = undefined;
    this.compositeBuffer = undefined;
    this.compositeOpaqueLoc = null;
    this.compositeAccumulationLoc = null;
    this.compositeRevealageLoc = null;
    this.presentProgram = undefined;
    this.presentSceneLoc = null;
    this.clampSampler = undefined;
    this.repeatSampler = undefined;
  };
  private readonly contextRestoredHandler = () => {
    invalidateSceneDrawState(this.gl);
    this.capabilities = probeTransparency(this.gl);
    this.createCompositeResources();
    this.createSamplers();
    this.resize(this.gl.canvas.width, this.gl.canvas.height);
  };

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.capabilities = probeTransparency(gl);
    this.drawBuffersIndexed = gl.getExtension("OES_draw_buffers_indexed") as {
      blendFuncSeparateiOES?(buf: number, srcRGB: number, dstRGB: number, srcAlpha: number, dstAlpha: number): void;
    } | null;
    this.createCompositeResources();
    this.createSamplers();
    gl.frontFace(gl.CCW);
    gl.canvas.addEventListener("webglcontextlost", this.contextLostHandler, false);
    gl.canvas.addEventListener("webglcontextrestored", this.contextRestoredHandler, false);
    this.resize(gl.canvas.width, gl.canvas.height);
  }

  private createCompositeResources(): void {
    const gl = this.gl;
    const vertex = this.compile(gl.VERTEX_SHADER, SourceOverVertSource);
    const fragment = this.compile(gl.FRAGMENT_SHADER, SceneCompositeFragSource);
    this.compositeProgram = vertex && fragment ? this.link(vertex, fragment) : undefined;
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    this.compositeVao = gl.createVertexArray() ?? undefined;
    this.compositeBuffer = gl.createBuffer() ?? undefined;
    if (this.compositeVao && this.compositeBuffer) {
      gl.bindVertexArray(this.compositeVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.compositeBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    }
    this.compositeOpaqueLoc = this.compositeProgram ? gl.getUniformLocation(this.compositeProgram, "opaqueTexture") : null;
    this.compositeAccumulationLoc = this.compositeProgram ? gl.getUniformLocation(this.compositeProgram, "accumulationTexture") : null;
    this.compositeRevealageLoc = this.compositeProgram ? gl.getUniformLocation(this.compositeProgram, "revealageTexture") : null;
    const presentVertex = this.compile(gl.VERTEX_SHADER, SourceOverVertSource);
    const presentFragment = this.compile(gl.FRAGMENT_SHADER, ScenePresentFragSource);
    this.presentProgram = presentVertex && presentFragment ? this.link(presentVertex, presentFragment) : undefined;
    if (presentVertex) gl.deleteShader(presentVertex);
    if (presentFragment) gl.deleteShader(presentFragment);
    this.presentSceneLoc = this.presentProgram ? gl.getUniformLocation(this.presentProgram, "sceneTexture") : null;
  }

  private createSamplers(): void {
    const gl = this.gl;
    this.clampSampler = gl.createSampler() ?? undefined;
    this.repeatSampler = gl.createSampler() ?? undefined;
    if (!this.clampSampler || !this.repeatSampler) throw new Error("Unable to allocate scene samplers");
    for (const sampler of [this.clampSampler, this.repeatSampler]) {
      gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    gl.samplerParameteri(this.clampSampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(this.clampSampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(this.repeatSampler, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.samplerParameteri(this.repeatSampler, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }

  get tier(): TransparencyTier { return this.capabilities.tier; }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    if (this.targets?.width === width && this.targets.height === height) return;
    this.destroyTargets();
    const gl = this.gl;
    const framebuffer = gl.createFramebuffer();
    const opaque = this.createColorTexture(width, height, gl.RGBA8);
    const composition = this.createColorTexture(width, height, gl.RGBA8);
    const depth = gl.createRenderbuffer();
    if (!framebuffer || !opaque || !composition || !depth) throw new Error("Unable to allocate scene targets");
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, width, height);
    const targets: SceneTargets = { width, height, opaque, composition, depth, framebuffer };
    if (this.capabilities.tier !== "C") {
      targets.accumulation = this.createColorTexture(width, height, gl.RGBA16F);
      targets.revealage = this.createColorTexture(width, height, gl.R16F);
    }
    this.targets = targets;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    this.attachOpaque(targets);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      this.destroyTargets();
      throw new Error("Unable to complete scene framebuffer");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  render(
    view: SceneView,
    submissions: readonly SceneSubmission[],
  ): void {
    const targets = this.targets;
    if (!targets) return;
    const gl = this.gl;
    invalidateSceneDrawState(gl);
    const ordered = [...submissions].sort((a, b) => this.compareKeys(a.key, b.key));
    this.currentCullState = null;
    this.currentSampler = null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.framebuffer);
    gl.viewport(0, 0, targets.width, targets.height);
    this.attachOpaque(targets);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clearColor(view.fog.color[0], view.fog.color[1], view.fog.color[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    this.drawSubmissions(ordered, "opaque", view, "color");
    this.drawSubmissions(ordered, "masked", view, "color");
    // Foliage textures commonly contain opaque interiors with antialiased
    // translucent edges. Render the interiors into the depth buffer before
    // accumulating the translucent fringe. Particles stay in the translucent
    // pass so they never write depth.
    this.drawSubmissions(ordered, "sourceOver", view, "opaque", true);
    this.drawTransparency(view, ordered, targets);
    if (this.capabilities.tier === "C") this.attachOpaque(targets);
    else this.attachComposition(targets);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.drawSubmissions(ordered, "additive", view, "additive");
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    this.present(targets);
  }

  destroy(): void {
    this.gl.canvas.removeEventListener("webglcontextlost", this.contextLostHandler);
    this.gl.canvas.removeEventListener("webglcontextrestored", this.contextRestoredHandler);
    this.destroyTargets();
    if (this.compositeProgram) this.gl.deleteProgram(this.compositeProgram);
    if (this.compositeVao) this.gl.deleteVertexArray(this.compositeVao);
    if (this.compositeBuffer) this.gl.deleteBuffer(this.compositeBuffer);
    if (this.presentProgram) this.gl.deleteProgram(this.presentProgram);
    if (this.clampSampler) this.gl.deleteSampler(this.clampSampler);
    if (this.repeatSampler) this.gl.deleteSampler(this.repeatSampler);
    this.compositeProgram = undefined;
    this.compositeVao = undefined;
    this.compositeBuffer = undefined;
    this.presentProgram = undefined;
    this.clampSampler = undefined;
    this.repeatSampler = undefined;
  }

  private drawSubmissions(
    submissions: readonly SceneSubmission[],
    renderClass: SceneSubmission["key"]["renderClass"],
    view: SceneView,
    pass: ScenePass,
    excludeParticles = false,
  ): void {
    for (const submission of submissions) {
      if (submission.key.renderClass !== renderClass) continue;
      if (excludeParticles && submission.key.programVariant === "particle") continue;
      this.applyCullState(submission.key.cullState);
      this.applySampler(submission.key.sampler === "repeat" ? "repeat" : "clamp");
      submission.draw(view, pass);
    }
  }

  private compareKeys(a: SceneSubmission["key"], b: SceneSubmission["key"]): number {
    return (a.programVariant === "terrain" ? -1 : b.programVariant === "terrain" ? 1 : 0) ||
      a.programVariant.localeCompare(b.programVariant) ||
      a.cullState.localeCompare(b.cullState) ||
      a.meshBatch - b.meshBatch ||
      a.material - b.material ||
      a.sampler.localeCompare(b.sampler) ||
      Number(a.parity) - Number(b.parity);
  }

  private applyCullState(cullState: "none" | "front" | "back"): void {
    if (this.currentCullState === cullState) return;
    this.currentCullState = cullState;
    const gl = this.gl;
    if (cullState === "none") {
      gl.disable(gl.CULL_FACE);
      return;
    }
    gl.enable(gl.CULL_FACE);
    gl.cullFace(cullState === "front" ? gl.FRONT : gl.BACK);
  }

  private applySampler(sampler: "clamp" | "repeat"): void {
    if (this.currentSampler === sampler) return;
    this.currentSampler = sampler;
    this.gl.bindSampler(3, sampler === "repeat" ? this.repeatSampler ?? null : this.clampSampler ?? null);
  }

  private drawTransparency(
    view: SceneView,
    submissions: readonly SceneSubmission[],
    targets: SceneTargets,
  ): void {
    const gl = this.gl;
    if (this.capabilities.tier === "C") {
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.drawTierCSubmissions(submissions, view);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targets.accumulation!, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, targets.revealage!, 0);
    gl.drawBuffers(this.capabilities.tier === "A" ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1] : [gl.COLOR_ATTACHMENT0]);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    if (this.capabilities.tier === "A") gl.clearBufferfv(gl.COLOR, 1, [1, 1, 1, 1]);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    if (this.capabilities.tier === "A") {
      this.drawBuffersIndexed?.blendFuncSeparateiOES?.(0, gl.ONE, gl.ONE, gl.ONE, gl.ONE);
      this.drawBuffersIndexed?.blendFunciOES?.(1, gl.ZERO, gl.ONE_MINUS_SRC_COLOR);
    } else {
      gl.blendFunc(gl.ONE, gl.ONE);
    }
    this.drawSubmissions(submissions, "sourceOver", view, "color");
    if (this.capabilities.tier === "B") {
      gl.drawBuffers([gl.COLOR_ATTACHMENT1]);
      gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_COLOR);
      this.drawSubmissions(submissions, "sourceOver", view, "revealage");
    }
    gl.disable(gl.BLEND);
    this.attachComposition(targets);
    this.drawComposite(targets);
  }

  private drawTierCSubmissions(
    submissions: readonly SceneSubmission[],
    view: SceneView,
  ): void {
    this.tierCQueue.clear();
    this.tierCSubmissionOrder.length = 0;
    for (let index = 0; index < submissions.length; index++) {
      const submission = submissions[index];
      if (submission.key.renderClass !== "sourceOver") continue;
      const orderIndex = this.tierCSubmissionOrder.length;
      this.tierCSubmissionOrder.push(index);
      this.tierCQueue.add(submission.depthBucket ?? 0, orderIndex);
    }
    this.tierCQueue.finish();
    for (let bucket = this.tierCQueue.bucketCount - 1; bucket >= 0; bucket--) {
      const start = this.tierCQueue.offsets[bucket];
      const end = this.tierCQueue.offsets[bucket + 1];
      for (let offset = start; offset < end; offset++) {
        const submission = submissions[this.tierCSubmissionOrder[this.tierCQueue.values[offset]]];
        this.applyCullState(submission.key.cullState);
        this.applySampler(submission.key.sampler === "repeat" ? "repeat" : "clamp");
        submission.draw(view, "fallback");
      }
    }
  }

  private present(targets: SceneTargets): void {
    const gl = this.gl;
    if (!this.presentProgram || !this.compositeVao) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.presentProgram);
    gl.bindVertexArray(this.compositeVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.capabilities.tier === "C" ? targets.opaque : targets.composition);
    gl.uniform1i(this.presentSceneLoc, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
  }

  private drawComposite(targets: SceneTargets): void {
    const gl = this.gl;
    if (!this.compositeProgram || !this.compositeVao || !targets.accumulation || !targets.revealage) return;
    gl.useProgram(this.compositeProgram);
    gl.bindVertexArray(this.compositeVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targets.opaque);
    gl.uniform1i(this.compositeOpaqueLoc, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, targets.accumulation);
    gl.uniform1i(this.compositeAccumulationLoc, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, targets.revealage);
    gl.uniform1i(this.compositeRevealageLoc, 2);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  private attachOpaque(targets: SceneTargets): void {
    const gl = this.gl;
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targets.opaque, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, targets.depth);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  }

  private attachComposition(targets: SceneTargets): void {
    const gl = this.gl;
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targets.composition, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, targets.depth);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  }

  private createColorTexture(width: number, height: number, format: number): WebGLTexture | undefined {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) return undefined;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const floatingPoint = format === gl.RGBA16F || format === gl.R16F;
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      format,
      width,
      height,
      0,
      format === gl.R16F ? gl.RED : gl.RGBA,
      floatingPoint ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private destroyTargets(): void {
    const targets = this.targets;
    if (!targets) return;
    const gl = this.gl;
    gl.deleteTexture(targets.opaque); gl.deleteTexture(targets.composition);
    if (targets.accumulation) gl.deleteTexture(targets.accumulation);
    if (targets.revealage) gl.deleteTexture(targets.revealage);
    gl.deleteRenderbuffer(targets.depth); gl.deleteFramebuffer(targets.framebuffer);
    this.targets = undefined;
  }

  private compile(type: number, source: string): WebGLShader | undefined {
    const shader = this.gl.createShader(type);
    if (!shader) return undefined;
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      this.gl.deleteShader(shader);
      return undefined;
    }
    return shader;
  }

  private link(vertex: WebGLShader, fragment: WebGLShader): WebGLProgram | undefined {
    const program = this.gl.createProgram();
    if (!program) return undefined;
    this.gl.attachShader(program, vertex);
    this.gl.attachShader(program, fragment);
    this.gl.linkProgram(program);
    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      this.gl.deleteProgram(program);
      return undefined;
    }
    return program;
  }
}
