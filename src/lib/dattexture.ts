import { TEXTURE_PROFILE, type TextureProfile } from "./formatcontract";
import type { TextureExtensions } from "./textureprofile";
import { ResourceRegistry } from "./resourceRegistry";

export const BUILDING_TEXTURE_UNIT = 3;

interface TextureResource {
  id: number;
  encoding: number;
  bytes: ArrayBuffer;
}
export interface TextureResourceEntry {
  id: number;
  kind: number;
  encoding: number;
  bytes: ArrayBuffer;
}

export interface IndexedMaterialDefinition {
  imageResourceId: number;
  basePaletteResourceId: number;
  patches: readonly { replacementPaletteResourceId: number; offset: number; length: number }[];
  clipMap: boolean;
}

export type ResourceLoader = (id: number, kind: number) => Promise<TextureResourceEntry>;

interface IndexedImage {
  width: number;
  height: number;
  componentType: number;
  pixels: Uint8Array | Uint16Array;
  mapping: Uint16Array;
}

interface Palette {
  colors: Uint8Array;
}

interface IndexedFinalTexture {
  promise: Promise<WebGLTexture>;
  references: number;
  imageKey: string;
}

interface IndexedPlane {
  promise: Promise<WebGLTexture>;
  references: number;
}

interface IndexedGpuCpu {
  image?: IndexedImage;
  palette?: Uint8Array;
  planeId?: number;
}

const PAL8_MAGIC = 0x384c4150;
const MATERIALIZATION_BUDGET_MS = 10;

async function decodeTextureBytes(resource: TextureResourceEntry): Promise<ArrayBuffer> {
  if (resource.encoding === 0) return resource.bytes;
  if (resource.encoding !== 1) throw new Error(`Unsupported resource encoding ${resource.encoding}`);
  return new Response(new Blob([resource.bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

function readIndexed(bytes: ArrayBuffer): IndexedImage {
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== ATX8_MAGIC || view.getUint8(4) !== 2 || view.getUint8(5) !== 0 || view.getUint16(6, true) !== 0)
    throw new Error("Invalid indexed ATX8 resource");
  const width = view.getUint16(8, true), height = view.getUint16(10, true);
  const componentType = view.getUint8(12), mappingCount = view.getUint16(14, true);
  const pixelLength = view.getUint32(16, true), pixelOffset = 20;
  const expected = componentType === 1 ? width * height : componentType === 2 ? width * height * 2 : 0;
  if (!width || !height || pixelLength !== expected || pixelOffset + pixelLength + mappingCount * 2 !== bytes.byteLength || (componentType === 1 && (mappingCount < 1 || mappingCount > 256)) || (componentType === 2 && mappingCount !== 0))
    throw new Error("Invalid indexed ATX8 body");
  const mapping = new Uint16Array(mappingCount);
  for (let i = 0; i < mappingCount; i++) mapping[i] = view.getUint16(pixelOffset + pixelLength + i * 2, true);
  const pixels = componentType === 1
    ? new Uint8Array(bytes, pixelOffset, pixelLength)
    : new Uint16Array(bytes, pixelOffset, pixelLength / 2);
  return { width, height, componentType, pixels, mapping };
}

function readPalette(bytes: ArrayBuffer): Palette {
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== PAL8_MAGIC || view.getUint16(6, true) !== 0) throw new Error("Invalid PAL8 resource");
  const count = view.getUint16(4, true);
  if (8 + count * 4 !== bytes.byteLength) throw new Error("Invalid PAL8 body");
  return { colors: new Uint8Array(bytes, 8, count * 4) };
}

class PaletteTextureMaterializer {
  private framebuffer: WebGLFramebuffer | null = null;
  private framebufferValidated = false;
  private vao: WebGLVertexArrayObject | null = null;
  private program: WebGLProgram | null = null;
  private indexLocation: WebGLUniformLocation | null = null;
  private paletteLocation: WebGLUniformLocation | null = null;
  private pending: {
    image: IndexedImage;
    plane: WebGLTexture;
    palette: WebGLTexture;
    resolve: (texture: WebGLTexture) => void;
    reject: (error: unknown) => void;
  }[] = [];
  private scheduled = false;

  constructor(private gl: WebGL2RenderingContext) {}

  contextLost(): void {
    this.framebuffer = null;
    this.framebufferValidated = false;
    this.vao = null;
    this.program = null;
    this.indexLocation = null;
    this.paletteLocation = null;
  }

  clear(): void {
    const error = new DOMException("Indexed texture materialization was cleared", "AbortError");
    for (const request of this.pending) request.reject(error);
    this.pending = [];
  }

  materializeAsync(image: IndexedImage, plane: WebGLTexture, palette: WebGLTexture): Promise<WebGLTexture> {
    return new Promise((resolve, reject) => {
      this.pending.push({ image, plane, palette, resolve, reject });
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      const started = performance.now();
      while (this.pending.length > 0) {
        const request = this.pending.shift()!;
        try {
          request.resolve(this.materialize(request.image, request.plane, request.palette));
        } catch (error) {
          request.reject(error);
        }
        if (performance.now() - started >= MATERIALIZATION_BUDGET_MS) break;
      }
      if (this.pending.length > 0) this.schedule();
    }, 0);
  }

  private initialize(): void {
    if (this.program) return;
    const compile = (type: number, source: string) => {
      const shader = this.gl.createShader(type)!;
      this.gl.shaderSource(shader, source); this.gl.compileShader(shader);
      if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) throw new Error(this.gl.getShaderInfoLog(shader) || "Palette shader compilation failed");
      return shader;
    };
    const program = this.gl.createProgram()!;
    const vertex = compile(this.gl.VERTEX_SHADER, "#version 300 es\nconst vec2 p[3]=vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3)); void main(){gl_Position=vec4(p[gl_VertexID],0,1);}");
    const fragment = compile(this.gl.FRAGMENT_SHADER, "#version 300 es\nprecision highp float; precision highp usampler2D; uniform usampler2D indexPlane; uniform sampler2D palette; out vec4 color; void main(){uint index=texelFetch(indexPlane, ivec2(gl_FragCoord.xy), 0).r; color=texelFetch(palette, ivec2(int(index),0), 0);}");
    this.gl.attachShader(program, vertex); this.gl.attachShader(program, fragment); this.gl.linkProgram(program);
    this.gl.deleteShader(vertex); this.gl.deleteShader(fragment);
    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) throw new Error(this.gl.getProgramInfoLog(program) || "Palette shader link failed");
    this.program = program; this.indexLocation = this.gl.getUniformLocation(program, "indexPlane"); this.paletteLocation = this.gl.getUniformLocation(program, "palette");
    this.framebuffer = this.gl.createFramebuffer(); this.vao = this.gl.createVertexArray();
  }

  materialize(image: IndexedImage, plane: WebGLTexture, palette: WebGLTexture): WebGLTexture {
    this.initialize();
    const gl = this.gl, result = gl.createTexture();
    if (!result) throw new Error("Unable to create materialized texture");
    const oldFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const oldViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const oldProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const oldVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const oldBlend = gl.isEnabled(gl.BLEND);
    const oldDepthTest = gl.isEnabled(gl.DEPTH_TEST);
    const oldActive = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    const oldUnpack = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
    gl.activeTexture(gl.TEXTURE0); const oldTexture0 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    gl.activeTexture(gl.TEXTURE1); const oldTexture1 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    gl.activeTexture(oldActive);
    try {
      const mipLevels = Math.floor(Math.log2(Math.max(image.width, image.height))) + 1;
      gl.bindTexture(gl.TEXTURE_2D, result); gl.texStorage2D(gl.TEXTURE_2D, mipLevels, gl.RGBA8, image.width, image.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, result, 0);
      if (!this.framebufferValidated) {
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
          throw new Error("Palette framebuffer is incomplete");
        this.framebufferValidated = true;
      }
      gl.viewport(0, 0, image.width, image.height); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.useProgram(this.program); gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, plane); gl.uniform1i(this.indexLocation, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, palette); gl.uniform1i(this.paletteLocation, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindTexture(gl.TEXTURE_2D, result); gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return result;
    } catch (error) { gl.deleteTexture(result); throw error; }
    finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, oldFramebuffer); gl.viewport(oldViewport[0], oldViewport[1], oldViewport[2], oldViewport[3]); gl.useProgram(oldProgram); gl.bindVertexArray(oldVao); if (oldBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND); if (oldDepthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST); gl.pixelStorei(gl.UNPACK_ALIGNMENT, oldUnpack); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, oldTexture0); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, oldTexture1); gl.activeTexture(oldActive);
    }
  }
}

export class IndexedTextureLoader {
  private finals = new Map<number, IndexedFinalTexture>();
  private planes = new Map<number, IndexedPlane>();
  private palettes = new Map<number, Promise<Palette>>();
  private materializer: PaletteTextureMaterializer;
  private readonly gpuRegistry: ResourceRegistry<IndexedGpuCpu, WebGLTexture>;
  private readonly restoreQueue = new Set<import("./resourceRegistry").ResourceGeneration<IndexedGpuCpu, WebGLTexture>>();
  private readonly contextLostHandler = (event: Event) => { event.preventDefault(); this.materializer.contextLost(); this.restoreQueue.clear(); this.gpuRegistry.contextLost(); };
  private readonly contextRestoredHandler = () => this.gpuRegistry.contextRestored();

  constructor(private gl: WebGL2RenderingContext) {
    this.materializer = new PaletteTextureMaterializer(gl);
    this.gpuRegistry = new ResourceRegistry({ budgets: { encodedBytes: 0, decodedBytes: 256 * 1024 * 1024, gpuBytes: 256 * 1024 * 1024, uploadBytesPerFrame: 8 * 1024 * 1024 }, destroyGpu: (texture) => gl.deleteTexture(texture), contextRestored: (generation) => this.restoreQueue.add(generation) });
    gl.canvas.addEventListener("webglcontextlost", this.contextLostHandler, false);
    gl.canvas.addEventListener("webglcontextrestored", this.contextRestoredHandler, false);
  }

  beginFrame(): void {
    this.gpuRegistry.beginFrame();
    for (const generation of [...this.restoreQueue]) {
      this.restoreQueue.delete(generation);
      void this.restore(generation);
    }
  }

  get pendingGpuUploadCount(): number {
    return this.gpuRegistry.pendingUploadCount + this.restoreQueue.size;
  }

  clear(): void {
    this.finals.clear();
    this.planes.clear();
    this.palettes.clear();
    this.restoreQueue.clear();
    this.materializer.clear();
    this.gpuRegistry.replaceDataset();
  }

  current(materialId: number): WebGLTexture | undefined {
    return this.gpuRegistry.current(this.finalKey(materialId))?.gpu;
  }

  acquire(materialId: number, definition: IndexedMaterialDefinition, load: ResourceLoader): Promise<WebGLTexture> {
    let cached = this.finals.get(materialId);
    if (!cached) {
      const imageKey = String(definition.imageResourceId);
      let created!: IndexedFinalTexture;
      const promise = this.create(materialId, definition, load).catch(error => { if (this.finals.get(materialId) === created) this.finals.delete(materialId); throw error; });
      created = { promise, references: 0, imageKey }; cached = created; this.finals.set(materialId, cached);
    }
    cached.references++; return cached.promise;
  }

  release(materialId: number): void {
    const cached = this.finals.get(materialId); if (!cached || --cached.references > 0) return;
      void cached.promise.then(() => { if (cached.references || this.finals.get(materialId) !== cached) return; this.finals.delete(materialId); this.gpuRegistry.remove(this.finalKey(materialId)); this.releasePlane(Number(cached.imageKey)); }).catch(() => undefined);
  }

  private async create(materialId: number, definition: IndexedMaterialDefinition, load: ResourceLoader): Promise<WebGLTexture> {
    const imageResource = await load(definition.imageResourceId, 3), image = readIndexed(await decodeTextureBytes(imageResource));
    const plane = await this.acquirePlane(definition.imageResourceId, image, load);
    try {
      const base = await this.palette(definition.basePaletteResourceId, load);
      const replacements = await Promise.all(definition.patches.map(p => this.palette(p.replacementPaletteResourceId, load)));
      const count = image.componentType === 1 ? image.mapping.length : base.colors.length / 4;
      const colors = new Uint8Array(count * 4);
      for (let local = 0; local < count; local++) {
        const source = image.componentType === 1 ? image.mapping[local] : local, color = source * 4;
        if (color + 3 >= base.colors.length) throw new Error(`Palette index ${source} is out of range`);
        let chosen = base.colors.subarray(color, color + 4);
        definition.patches.forEach((patch, index) => { if (source >= patch.offset && source < patch.offset + patch.length) { const replacement = replacements[index].colors; if (color + 3 < replacement.length) chosen = replacement.subarray(color, color + 4); } });
        colors.set(chosen, local * 4);
        if (definition.clipMap && source < 8) colors.fill(0, local * 4, local * 4 + 4);
      }
      const paletteKey = this.paletteKey(materialId);
      const palette = this.uploadPalette(paletteKey, colors);
      try {
        const texture = await this.materializer.materializeAsync(image, plane, palette);
        this.gpuRegistry.publish(this.finalKey(materialId), { image, palette: colors.slice(), planeId: definition.imageResourceId }, { encodedBytes: 0, decodedBytes: image.width * image.height * 4 }, texture, this.materializedBytes(image));
        return texture;
      } finally {
        this.gpuRegistry.remove(paletteKey);
      }
    } catch (error) { this.releasePlane(definition.imageResourceId); throw error; }
  }

  private palette(id: number, load: ResourceLoader): Promise<Palette> {
    let cached = this.palettes.get(id);
    if (!cached) {
      cached = load(id, 5).then(decodeTextureBytes).then(readPalette);
      this.palettes.set(id, cached);
    }
    return cached;
  }

  private async acquirePlane(id: number, image: IndexedImage, load: ResourceLoader): Promise<WebGLTexture> {
    let cached = this.planes.get(id); if (!cached) { let created!: IndexedPlane; const promise = Promise.resolve().then(() => { const texture = this.uploadPlane(image); this.gpuRegistry.publish(this.planeKey(id), { image, planeId: id }, { encodedBytes: 0, decodedBytes: image.pixels.byteLength }, texture, image.pixels.byteLength); return texture; }); created = { promise, references: 0 }; cached = created; this.planes.set(id, cached); } cached.references++; return cached.promise;
  }

  private releasePlane(id: number): void { const cached = this.planes.get(id); if (!cached || --cached.references > 0) return; void cached.promise.then(() => { if (cached.references || this.planes.get(id) !== cached) return; this.planes.delete(id); this.gpuRegistry.remove(this.planeKey(id)); }).catch(() => undefined); }

  private finalKey(id: number): number { return -1 - id * 2; }
  private planeKey(id: number): number { return -2 - id * 2; }
  private paletteKey(id: number): number { return -3000000000 - id; }
  private materializedBytes(image: IndexedImage): number {
    let bytes = 0;
    for (let width = image.width, height = image.height; ; width = Math.max(1, width >> 1), height = Math.max(1, height >> 1)) {
      bytes += width * height * 4;
      if (width === 1 && height === 1) return bytes;
    }
  }

  private uploadPalette(id: number, colors: Uint8Array): WebGLTexture {
    const texture = this.gl.createTexture(); if (!texture) throw new Error("Unable to create palette texture");
    try { this.gl.activeTexture(this.gl.TEXTURE1); this.gl.bindTexture(this.gl.TEXTURE_2D, texture); this.gl.pixelStorei(this.gl.UNPACK_ALIGNMENT, 1); this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA8, colors.length / 4, 1, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, colors); this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST); this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST); this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE); this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE); this.gpuRegistry.publish(id, { palette: colors.slice() }, { encodedBytes: 0, decodedBytes: colors.byteLength }, texture, colors.byteLength); return texture; } catch (error) { this.gl.deleteTexture(texture); throw error; }
  }

  private uploadPlane(image: IndexedImage): WebGLTexture {
    const texture = this.gl.createTexture(); if (!texture) throw new Error("Unable to create indexed plane");
    try { this.gl.activeTexture(this.gl.TEXTURE0); this.gl.bindTexture(this.gl.TEXTURE_2D, texture); this.gl.pixelStorei(this.gl.UNPACK_ALIGNMENT, 1); const format = this.gl.RED_INTEGER; const type = image.componentType === 1 ? this.gl.UNSIGNED_BYTE : this.gl.UNSIGNED_SHORT; this.gl.texImage2D(this.gl.TEXTURE_2D, 0, image.componentType === 1 ? this.gl.R8UI : this.gl.R16UI, image.width, image.height, 0, format, type, image.pixels); this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST); this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST); this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE); this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE); return texture; } catch (error) { this.gl.deleteTexture(texture); throw error; }
  }

  private async restore(generation: import("./resourceRegistry").ResourceGeneration<IndexedGpuCpu, WebGLTexture>): Promise<void> {
    try {
      if (generation.cpu.image && generation.id % 2 === 0) {
        const texture = this.uploadPlane(generation.cpu.image);
        if (!this.gpuRegistry.attachGpu(generation, texture, generation.cpu.image.pixels.byteLength)) this.gl.deleteTexture(texture);
      } else if (generation.cpu.image) {
          const planeLease = this.gpuRegistry.acquire(this.planeKey(generation.cpu.planeId!));
          const plane = planeLease?.value.gpu;
          if (!plane) throw new Error("Indexed plane is not restored");
          const palette = this.uploadPalette(this.paletteKey(generation.id), generation.cpu.palette!);
          try {
            const texture = this.materializer.materialize(generation.cpu.image, plane, palette);
            if (!this.gpuRegistry.attachGpu(generation, texture, this.materializedBytes(generation.cpu.image))) this.gl.deleteTexture(texture);
          } finally {
            this.gpuRegistry.remove(this.paletteKey(generation.id));
            planeLease?.release();
          }
      }
      this.gpuRegistry.markUploadPending(generation.id, false);
    } catch { this.gpuRegistry.markUploadPending(generation.id, true); }
  }
}
const ATX8_MAGIC = 0x38585441;

async function decodeResource(resource: TextureResource): Promise<ArrayBuffer> {
  if (resource.encoding === 0) return resource.bytes;
  if (resource.encoding !== 1)
    throw new Error(`Texture resource ${resource.id} has unsupported encoding`);
  return new Response(
    new Blob([resource.bytes])
      .stream()
      .pipeThrough(new DecompressionStream("gzip")),
  ).arrayBuffer();
}

function compressedFormat(
  format: number,
  extensions: TextureExtensions,
): number {
  if (format === 1) {
    if (!extensions.s3tc)
      throw new Error("S3TC texture extension is unavailable");
    return extensions.s3tc.COMPRESSED_RGBA_S3TC_DXT1_EXT;
  }
  if (format === 2) {
    if (!extensions.s3tc)
      throw new Error("S3TC texture extension is unavailable");
    return extensions.s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT;
  }
  if (!extensions.etc) throw new Error("ETC2 texture extension is unavailable");
  if (format === 3) return extensions.etc.COMPRESSED_RGB8_ETC2;
  if (format === 4)
    return extensions.etc.COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2;
  if (format === 5) return extensions.etc.COMPRESSED_RGBA8_ETC2_EAC;
  throw new Error(`Invalid ATX8 native format ${format}`);
}

export async function uploadResourceTexture(
  gl: WebGL2RenderingContext,
  resource: TextureResource,
  profile: TextureProfile,
  extensions: TextureExtensions,
): Promise<{ texture: WebGLTexture; decodedBytes: number; gpuBytes: number }> {
  const bytes = await decodeResource(resource);
  const view = new DataView(bytes);
  if (bytes.byteLength < 16 || view.getUint32(0, true) !== ATX8_MAGIC)
    throw new Error(`Invalid ATX8 texture resource ${resource.id}`);
  if (
    view.getUint8(4) !== 1 ||
    view.getUint8(5) !== 0 ||
    view.getUint16(6, true) !== 0
  )
    throw new Error(
      `Texture resource ${resource.id} is not a native mip chain`,
    );
  const width = view.getUint16(8, true),
    height = view.getUint16(10, true);
  const format = view.getUint8(12),
    levelCount = view.getUint8(13);
  if (
    width === 0 ||
    height === 0 ||
    view.getUint16(14, true) !== 0 ||
    levelCount === 0
  )
    throw new Error(`Invalid ATX8 header ${resource.id}`);
  const expectedLevels = Math.ceil(Math.log2(Math.max(width, height))) + 1;
  if (levelCount !== expectedLevels)
    throw new Error(`Invalid ATX8 mip count ${resource.id}`);
  const expectedProfile =
    format === 6
      ? profile
      : format <= 2
      ? TEXTURE_PROFILE.bc
      : format <= 5
        ? TEXTURE_PROFILE.etc2
        : null;
  if (expectedProfile !== profile)
    throw new Error(
      `Texture resource ${resource.id} does not match profile ${profile}`,
    );
  const lengthsOffset = 16,
    dataOffset = lengthsOffset + levelCount * 4;
  if (dataOffset > bytes.byteLength)
    throw new Error(`Truncated ATX8 texture ${resource.id}`);
  const texture = gl.createTexture();
  if (!texture) throw new Error("Unable to create object texture");
  const previousActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  gl.activeTexture(gl.TEXTURE0 + BUILDING_TEXTURE_UNIT);
  const previousTexture = gl.getParameter(
    gl.TEXTURE_BINDING_2D,
  ) as WebGLTexture | null;
  let gpuBytes = 0;
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    let offset = dataOffset;
    for (let level = 0; level < levelCount; level++) {
      const length = view.getUint32(lengthsOffset + level * 4, true);
      if (offset + length > bytes.byteLength)
        throw new Error(`Truncated ATX8 mip ${resource.id}`);
      const levelWidth = Math.max(1, width >> level),
        levelHeight = Math.max(1, height >> level);
      const data = new Uint8Array(bytes, offset, length);
      if (format === 6)
        gl.texImage2D(
          gl.TEXTURE_2D,
          level,
          gl.RGBA8,
          levelWidth,
          levelHeight,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          data,
        );
      else
        gl.compressedTexImage2D(
          gl.TEXTURE_2D,
          level,
          compressedFormat(format, extensions),
          levelWidth,
          levelHeight,
          0,
          data,
        );
      offset += length;
      gpuBytes += length;
    }
    if (offset !== bytes.byteLength)
      throw new Error(`ATX8 texture has trailing bytes ${resource.id}`);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levelCount - 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  } catch (error) {
    gl.deleteTexture(texture);
    throw error;
  } finally {
    gl.bindTexture(gl.TEXTURE_2D, previousTexture);
    gl.activeTexture(previousActiveTexture);
  }
  return { texture, decodedBytes: bytes.byteLength, gpuBytes };
}
