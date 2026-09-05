import type { Mesh, MeshBatch } from "../lib/acdatclient";
import type {
  DatProcessorRequest,
  DatProcessorResponse,
  EncodedDatResource,
} from "../lib/datprocessorprotocol";
import { parseV3Mesh } from "../v3/v3parsers";

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<DatProcessorRequest>) => void) | null;
  postMessage: (
    message: DatProcessorResponse,
    transfer: Transferable[],
  ) => void;
};

const cancelled = new Set<number>();
const processing = new Set<number>();

workerScope.onmessage = (event) => {
  if (event.data.operation === "cancel") {
    if (processing.has(event.data.id)) cancelled.add(event.data.id);
    return;
  }
  processing.add(event.data.id);
  void processRequest(event.data);
};

async function processRequest(request: DatProcessorRequest): Promise<void> {
  try {
    if (request.operation === "cancel") return;
    if (cancelled.delete(request.id)) return;
    if (request.operation === "mesh") {
      const mesh = await decodeMesh(request.resource);
      if (cancelled.delete(request.id)) return;
      const transfer: Transferable[] = [];
      const transferred = new Set<ArrayBuffer>();
      for (const batch of mesh.batches) {
        if (batch.vertices && batch.indices) {
          const vertexBuffer = batch.vertices.buffer as ArrayBuffer;
          const indexBuffer = batch.indices.buffer as ArrayBuffer;
          if (!transferred.has(vertexBuffer)) {
            transferred.add(vertexBuffer);
            transfer.push(vertexBuffer);
          }
          if (!transferred.has(indexBuffer)) {
            transferred.add(indexBuffer);
            transfer.push(indexBuffer);
          }
        }
      }
      workerScope.postMessage({ id: request.id, result: mesh }, transfer);
      return;
    }
  } catch (error) {
    workerScope.postMessage(
      {
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      },
      [],
    );
  } finally {
    processing.delete(request.id);
    cancelled.delete(request.id);
  }
}

async function decodeBytes(resource: EncodedDatResource): Promise<ArrayBuffer> {
  if (resource.encoding === 0) return resource.bytes;
  if (resource.encoding === 1) {
    return new Response(
      new Blob([resource.bytes])
        .stream()
        .pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer();
  }
  throw new Error(
    `ACTerrain resource ${resource.id} has unsupported encoding ${resource.encoding}`,
  );
}

async function decodeMesh(resource: EncodedDatResource): Promise<Mesh> {
  const buffer = await decodeBytes(resource);
  if (new DataView(buffer).getUint32(0, true) === 0x4853334d)
    return decodeV3Mesh(buffer, resource.id);
  const view = new DataView(buffer);
  let offset = 0;
  const u32 = () => {
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const f32 = () => {
    const value = view.getFloat32(offset, true);
    offset += 4;
    return value;
  };
  if (
    u32() !== 0x3248534d ||
    view.getUint8(offset++) !== 0 ||
    view.getUint8(offset++) !== 0 ||
    view.getUint8(offset++) !== 0 ||
    view.getUint8(offset++) !== 0
  ) {
    throw new Error(`Invalid ACTerrain mesh resource ${resource.id}`);
  }
  const bounds = {
    minimum: [f32(), f32(), f32()] as [number, number, number],
    maximum: [f32(), f32(), f32()] as [number, number, number],
  };
  const batches: MeshBatch[] = [];
  let vertexCountTotal = 0;
  let indexCountTotal = 0;
  for (let i = 0, count = u32(); i < count; i++) {
    const materialResourceId = u32();
    const batchKind = view.getUint8(offset++);
    const batchFlags = view.getUint8(offset++);
    offset += 2;
    if (batchKind === 0) {
      const vertexCount = u32();
      const indexCount = u32();
      const vertexBytes = vertexCount * 32;
      const indexBytes = indexCount * 4;
      if (offset + vertexBytes + indexBytes > buffer.byteLength)
        throw new Error(`Invalid ACTerrain mesh resource ${resource.id}`);
      const vertices = new Float32Array(
        buffer.slice(offset, offset + vertexBytes),
      );
      offset += vertexBytes;
      const indices = new Uint32Array(
        buffer.slice(offset, offset + indexBytes),
      );
      offset += indexBytes;
      batches.push({ materialResourceId, hasWrappingUVs: (batchFlags & 0x01) !== 0, vertices, indices });
      vertexCountTotal += vertexCount;
      indexCountTotal += indexCount;
    } else if (batchKind === 1) {
      throw new Error(`Legacy sampled particle resources are unsupported; repack resource ${resource.id} as v3.16`);
    } else throw new Error(`Invalid ACTerrain mesh batch kind ${batchKind}`);
  }
  if (offset !== buffer.byteLength)
    throw new Error(`Invalid ACTerrain mesh resource ${resource.id}`);
  return {
    bounds,
    batches,
    vertexCount: vertexCountTotal,
    indexCount: indexCountTotal,
  };
}

function decodeV3Mesh(buffer: ArrayBuffer, resourceId: number): Mesh {
  try {
    const source = parseV3Mesh(buffer);
    const vertexView = new DataView(source.vertexData.buffer, source.vertexData.byteOffset, source.vertexData.byteLength);
    const vertexCount = source.vertexData.byteLength / 24;
    const vertices = new Float32Array(vertexCount * 8);
    for (let i = 0; i < vertexCount; i++) {
      const input = i * 24;
      const output = i * 8;
      vertices[output] = vertexView.getFloat32(input, true);
      vertices[output + 1] = vertexView.getFloat32(input + 4, true);
      vertices[output + 2] = vertexView.getFloat32(input + 8, true);
      vertices[output + 3] = vertexView.getInt16(input + 12, true) / 32767;
      vertices[output + 4] = vertexView.getInt16(input + 14, true) / 32767;
      vertices[output + 5] = vertexView.getInt16(input + 16, true) / 32767;
      vertices[output + 6] = readFloat16(vertexView.getUint16(input + 20, true));
      vertices[output + 7] = readFloat16(vertexView.getUint16(input + 22, true));
    }
    const indexView = new DataView(source.indexData.buffer, source.indexData.byteOffset, source.indexData.byteLength);
    const allIndices = new Uint32Array(source.indexData.byteLength / 4);
    for (let i = 0; i < allIndices.length; i++) allIndices[i] = indexView.getUint32(i * 4, true);
    const batches: MeshBatch[] = source.batches.map((batch) => ({
      materialResourceId: batch.materialResourceId,
      vertices,
      indices: allIndices.slice(batch.firstIndex / 4, batch.firstIndex / 4 + batch.indexCount),
      hasWrappingUVs: batch.samplerMode === "repeat",
      cullState: batch.cullState,
      samplerMode: batch.samplerMode,
    }));
    for (const batch of source.particleBatches) {
      const particles = [];
      for (let i = 0; i < batch.particleCount; i++) {
        const offset = (batch.firstParticle + i) * 240;
        const view = new DataView(source.particleData.buffer, source.particleData.byteOffset + offset, 240);
        const vector = (at: number) => [view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)] as [number, number, number];
        const quaternion = (at: number) => [view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true), view.getFloat32(at + 12, true)] as [number, number, number, number];
        particles.push({ emitterType: view.getInt32(0, true), particleType: view.getInt32(4, true), parentLocal: view.getUint8(8) !== 0, representation: view.getUint8(9), seed: view.getUint32(12, true), hookIndex: view.getInt32(16, true), parentOrigin: vector(20), parentOrientation: quaternion(32), offset: vector(48), offsetDirection: vector(60), minOffset: view.getFloat32(72, true), maxOffset: view.getFloat32(76, true), a: vector(80), minA: view.getFloat32(92, true), maxA: view.getFloat32(96, true), b: vector(100), minB: view.getFloat32(112, true), maxB: view.getFloat32(116, true), c: vector(120), minC: view.getFloat32(132, true), maxC: view.getFloat32(136, true), birthrate: view.getFloat32(140, true), maxParticles: view.getInt32(144, true), initialParticles: view.getInt32(148, true), totalParticles: view.getInt32(152, true), totalSeconds: view.getFloat32(156, true), lifespan: view.getFloat32(160, true), lifespanRandom: view.getFloat32(164, true), startScale: view.getFloat32(168, true), finalScale: view.getFloat32(172, true), scaleRandom: view.getFloat32(176, true), startTranslucency: view.getFloat32(180, true), finalTranslucency: view.getFloat32(184, true), translucencyRandom: view.getFloat32(188, true), dimensions: vector(192), centerOffset: vector(204), planeOrientation: quaternion(216) });
      }
      batches.push({ materialResourceId: batch.materialResourceId, particles });
    }
    return { bounds: source.bounds, batches, vertexCount, indexCount: allIndices.length };
  } catch (error) {
    throw new Error(`Invalid ACTerrain mesh resource ${resourceId}`);
  }
}

function readFloat16(value: number): number {
  const sign = value & 0x8000 ? -1 : 1;
  const exponent = (value >>> 10) & 0x1f;
  const fraction = value & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}
