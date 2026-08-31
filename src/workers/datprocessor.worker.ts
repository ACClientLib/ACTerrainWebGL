import type { Mesh, MeshBatch } from '../lib/acdatclient'
import type {
  DatProcessorRequest,
  DatProcessorResponse,
  EncodedDatResource,
  ProcessedResourceTexture
} from '../lib/datprocessorprotocol'

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<DatProcessorRequest>) => void) | null
  postMessage: (message: DatProcessorResponse, transfer: Transferable[]) => void
}

const cancelled = new Set<number>()
const processing = new Set<number>()

workerScope.onmessage = event => {
  if (event.data.operation === 'cancel') {
    if (processing.has(event.data.id)) cancelled.add(event.data.id)
    return
  }
  processing.add(event.data.id)
  void processRequest(event.data)
}

async function processRequest(request: DatProcessorRequest): Promise<void> {
  try {
    if (request.operation === 'cancel') return
    if (cancelled.delete(request.id)) return
    if (request.operation === 'mesh') {
      const mesh = await decodeMesh(request.resource)
      if (cancelled.delete(request.id)) return
      const transfer: Transferable[] = []
      for (const batch of mesh.batches) {
        if (batch.vertices && batch.indices) transfer.push(batch.vertices.buffer as ArrayBuffer, batch.indices.buffer as ArrayBuffer)
      }
      workerScope.postMessage({ id: request.id, result: mesh }, transfer)
      return
    }

    const texture = await decodeTexture(request.resource)
    if (cancelled.delete(request.id)) return
    const transfer: Transferable[] = texture.bitmap
      ? [texture.bitmap]
      : texture.pixels
        ? [texture.pixels.buffer as ArrayBuffer]
        : []
    workerScope.postMessage({ id: request.id, result: texture }, transfer)
  } catch (error) {
    workerScope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }, [])
  } finally {
    processing.delete(request.id)
    cancelled.delete(request.id)
  }
}

async function decodeBytes(resource: EncodedDatResource): Promise<ArrayBuffer> {
  if (resource.encoding === 0) return resource.bytes
  if (resource.encoding === 1) {
    return new Response(new Blob([resource.bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
  }
  throw new Error(`ACTerrain resource ${resource.id} has unsupported encoding ${resource.encoding}`)
}

async function decodeMesh(resource: EncodedDatResource): Promise<Mesh> {
  const buffer = await decodeBytes(resource)
  const view = new DataView(buffer)
  let offset = 0
  const u32 = () => { const value = view.getUint32(offset, true); offset += 4; return value }
  const f32 = () => { const value = view.getFloat32(offset, true); offset += 4; return value }
  if (u32() !== 0x3248534d || view.getUint8(offset++) !== 0 || view.getUint8(offset++) !== 0 ||
    view.getUint8(offset++) !== 0 || view.getUint8(offset++) !== 0) {
    throw new Error(`Invalid ACTerrain mesh resource ${resource.id}`)
  }
  const bounds = {
    minimum: [f32(), f32(), f32()] as [number, number, number],
    maximum: [f32(), f32(), f32()] as [number, number, number]
  }
  const batches: MeshBatch[] = []
  let vertexCountTotal = 0
  let indexCountTotal = 0
  for (let i = 0, count = u32(); i < count; i++) {
    const materialResourceId = u32()
    const batchKind = view.getUint8(offset++); offset += 3
    if (batchKind === 0) {
      const vertexCount = u32(); const indexCount = u32()
      const vertexBytes = vertexCount * 32; const indexBytes = indexCount * 4
      if (offset + vertexBytes + indexBytes > buffer.byteLength) throw new Error(`Invalid ACTerrain mesh resource ${resource.id}`)
      const vertices = new Float32Array(buffer.slice(offset, offset + vertexBytes)); offset += vertexBytes
      const indices = new Uint32Array(buffer.slice(offset, offset + indexBytes)); offset += indexBytes
      batches.push({ materialResourceId, vertices, indices }); vertexCountTotal += vertexCount; indexCountTotal += indexCount
    } else if (batchKind === 1) {
      const particles = []; const count = u32()
      for (let p = 0; p < count; p++) {
        const vector = () => [f32(), f32(), f32()] as [number, number, number]
        const quat = () => [f32(), f32(), f32(), f32()] as [number, number, number, number]
        const center = vector(); const scale = f32(); const opacity = f32(); const dimensions = vector(); const centerOffset = vector()
        const planeOrientation = quat(); const rotation = quat(); const billboard = view.getUint8(offset++) !== 0; offset += 3
        particles.push({ center, scale, opacity, dimensions, centerOffset, planeOrientation, rotation, billboard })
      }
      batches.push({ materialResourceId, particles })
    } else throw new Error(`Invalid ACTerrain mesh batch kind ${batchKind}`)
  }
  if (offset !== buffer.byteLength) throw new Error(`Invalid ACTerrain mesh resource ${resource.id}`)
  return { bounds, batches, vertexCount: vertexCountTotal, indexCount: indexCountTotal }
}

async function decodeTexture(resource: EncodedDatResource): Promise<ProcessedResourceTexture> {
  const buffer = await decodeBytes(resource)
  const view = new DataView(buffer)
  let offset = 0
  const width = view.getUint16(offset, true); offset += 2
  const height = view.getUint16(offset, true); offset += 2
  const format = view.getUint32(offset, true); offset += 4
  const flags = view.getUint8(offset++)
  const reservedFlags = view.getUint8(offset++) | view.getUint8(offset++) | view.getUint8(offset++)
  const length = view.getUint32(offset, true); offset += 4
  if (reservedFlags !== 0 || offset + length + 4 > buffer.byteLength) throw new Error(`Invalid ACTerrain texture resource ${resource.id}`)
  const pixels = new Uint8Array(buffer.slice(offset, offset + length)); offset += length
  const paletteCount = view.getUint16(offset, true); offset += 2
  const reserved = view.getUint16(offset, true); offset += 2
  const paletteLength = paletteCount * 4
  if ((flags & ~3) !== 0 || reserved !== 0 || ((flags & 2) !== 0) !== (paletteCount > 0) || offset + paletteLength !== buffer.byteLength) {
    throw new Error(`Invalid ACTerrain texture resource ${resource.id}`)
  }
  const verticalFlip = (flags & 1) !== 0
  if (format === 0x1f4) {
    const bitmap = await createImageBitmap(new Blob([pixels], { type: 'image/jpeg' }), {
      imageOrientation: verticalFlip ? 'flipY' : 'none'
    })
    return { width, height, bitmap }
  }
  const palette = paletteCount ? new Uint8Array(buffer.slice(offset, offset + paletteLength)) : null
  const rgba = decodePixels(width, height, format, pixels, palette)
  if (verticalFlip) flipRows(rgba, width, height)
  return { width, height, pixels: rgba }
}

function flipRows(pixels: Uint8Array, width: number, height: number): void {
  const rowSize = width * 4
  const swap = new Uint8Array(rowSize)
  for (let y = 0; y < height / 2; y++) {
    const other = height - y - 1
    swap.set(pixels.subarray(y * rowSize, (y + 1) * rowSize))
    pixels.copyWithin(y * rowSize, other * rowSize, (other + 1) * rowSize)
    pixels.set(swap, other * rowSize)
  }
}

function decodePixels(width: number, height: number, format: number, pixels: Uint8Array, palette: Uint8Array | null): Uint8Array {
  if (format === 0x31545844) return decodeBc(width, height, pixels, 1)
  if (format === 0x33545844) return decodeBc(width, height, pixels, 2)
  if (format === 0x35545844) return decodeBc(width, height, pixels, 3)
  const output = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const target = i * 4
    if (format === 0x14 || format === 0xf2 || format === 0xf3) {
      const source = i * 3
      output[target] = format === 0xf3 ? pixels[source] : pixels[source + 2]
      output[target + 1] = pixels[source + 1]
      output[target + 2] = format === 0xf3 ? pixels[source + 2] : pixels[source]
      output[target + 3] = 255
    } else if (format === 0x15 || format === 0x16) {
      const source = i * 4
      output[target] = pixels[source + 2]
      output[target + 1] = pixels[source + 1]
      output[target + 2] = pixels[source]
      output[target + 3] = format === 0x15 ? pixels[source + 3] : 255
    } else if (format === 0x17 || format === 0x18 || format === 0x19 || format === 0x1a || format === 0x1e) {
      decode16(format, pixels[i * 2] | (pixels[i * 2 + 1] << 8), output, target)
    } else if (format === 0x29 || format === 0x65) {
      const index = format === 0x29 ? pixels[i] : pixels[i * 2] | (pixels[i * 2 + 1] << 8)
      if (palette && index * 4 + 3 < palette.length) {
        output.set(palette.subarray(index * 4, index * 4 + 4), target)
      } else {
        const value = format === 0x29 ? index : (index >> 8) & 0xff
        output[target] = value
        output[target + 1] = value
        output[target + 2] = value
        output[target + 3] = 255
      }
    } else if (format === 0x1c || format === 0x32 || format === 0xf4) {
      output[target] = format === 0x1c || format === 0xf4 ? 255 : pixels[i]
      output[target + 1] = output[target]
      output[target + 2] = output[target]
      output[target + 3] = format === 0x1c || format === 0xf4 ? pixels[i] : 255
    } else {
      throw new Error(`Unsupported DAT pixel format 0x${format.toString(16)}`)
    }
  }
  return output
}

function decode16(format: number, value: number, output: Uint8Array, offset: number): void {
  if (format === 0x17) {
    output[offset] = expand5(value >> 11)
    output[offset + 1] = expand6(value >> 5)
    output[offset + 2] = expand5(value)
    output[offset + 3] = 255
  } else if (format === 0x1a || format === 0x1e) {
    output[offset] = ((value >> 8) & 15) * 17
    output[offset + 1] = ((value >> 4) & 15) * 17
    output[offset + 2] = (value & 15) * 17
    output[offset + 3] = format === 0x1a ? ((value >> 12) & 15) * 17 : 255
  } else {
    output[offset] = expand5(value >> 10)
    output[offset + 1] = expand5(value >> 5)
    output[offset + 2] = expand5(value)
    output[offset + 3] = format === 0x19 && (value & 0x8000) === 0 ? 0 : 255
  }
}

function decodeBc(width: number, height: number, source: Uint8Array, kind: 1 | 2 | 3): Uint8Array {
  const output = new Uint8Array(width * height * 4)
  const blockSize = kind === 1 ? 8 : 16
  let offset = 0
  for (let blockY = 0; blockY < Math.ceil(height / 4); blockY++) {
    for (let blockX = 0; blockX < Math.ceil(width / 4); blockX++, offset += blockSize) {
      const alpha = kind === 1 ? null : kind === 2 ? bc2Alpha(source, offset) : bc3Alpha(source, offset)
      const colorOffset = offset + (kind === 1 ? 0 : 8)
      const color0 = source[colorOffset] | (source[colorOffset + 1] << 8)
      const color1 = source[colorOffset + 2] | (source[colorOffset + 3] << 8)
      const colors = bcColors(color0, color1, kind !== 1 || color0 > color1)
      const indices = source[colorOffset + 4] | (source[colorOffset + 5] << 8) |
        (source[colorOffset + 6] << 16) | (source[colorOffset + 7] << 24)
      for (let pixel = 0; pixel < 16; pixel++) {
        const x = blockX * 4 + pixel % 4
        const y = blockY * 4 + Math.floor(pixel / 4)
        if (x >= width || y >= height) continue
        const target = (y * width + x) * 4
        output.set(colors[(indices >>> (pixel * 2)) & 3], target)
        if (alpha) output[target + 3] = alpha[pixel]
      }
    }
  }
  return output
}

function bcColors(a: number, b: number, fourColors: boolean): Uint8Array[] {
  const first = new Uint8Array([expand5(a >> 11), expand6(a >> 5), expand5(a), 255])
  const second = new Uint8Array([expand5(b >> 11), expand6(b >> 5), expand5(b), 255])
  if (fourColors) return [first, second, mix(first, second, 2, 1, 3), mix(first, second, 1, 2, 3)]
  return [first, second, mix(first, second, 1, 1, 2), new Uint8Array([0, 0, 0, 0])]
}

function bc2Alpha(source: Uint8Array, offset: number): Uint8Array {
  const alpha = new Uint8Array(16)
  for (let i = 0; i < 16; i++) alpha[i] = ((source[offset + Math.floor(i / 2)] >> ((i & 1) * 4)) & 15) * 17
  return alpha
}

function bc3Alpha(source: Uint8Array, offset: number): Uint8Array {
  const table = new Uint8Array(8)
  table[0] = source[offset]
  table[1] = source[offset + 1]
  if (table[0] > table[1]) {
    for (let i = 1; i <= 6; i++) table[i + 1] = Math.round(((7 - i) * table[0] + i * table[1]) / 7)
  } else {
    for (let i = 1; i <= 4; i++) table[i + 1] = Math.round(((5 - i) * table[0] + i * table[1]) / 5)
    table[6] = 0
    table[7] = 255
  }
  let bits = 0n
  for (let i = 0; i < 6; i++) bits |= BigInt(source[offset + 2 + i]) << BigInt(i * 8)
  const alpha = new Uint8Array(16)
  for (let i = 0; i < 16; i++) alpha[i] = table[Number((bits >> BigInt(i * 3)) & 7n)]
  return alpha
}

function mix(a: Uint8Array, b: Uint8Array, aw: number, bw: number, divisor: number): Uint8Array {
  return new Uint8Array([
    Math.round((a[0] * aw + b[0] * bw) / divisor),
    Math.round((a[1] * aw + b[1] * bw) / divisor),
    Math.round((a[2] * aw + b[2] * bw) / divisor),
    255
  ])
}

function expand5(value: number): number { value &= 31; return (value << 3) | (value >> 2) }
function expand6(value: number): number { value &= 63; return (value << 2) | (value >> 4) }
