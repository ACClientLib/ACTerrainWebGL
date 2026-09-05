import type { V3SceneChunkView, V3SceneModelView } from "./v3types";

const MAGIC = 0x49534341;
const VERSION = 16;
const HEADER_SIZE = 40;
const MODEL_SIZE = 40;
const CHUNK_SIZE = 44;

const bounds = (view: DataView, offset: number) => ({
  minimum: [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)] as [number, number, number],
  maximum: [view.getFloat32(offset + 12, true), view.getFloat32(offset + 16, true), view.getFloat32(offset + 20, true)] as [number, number, number],
});

function validBounds(value: ReturnType<typeof bounds>): boolean {
  return value.minimum.every(Number.isFinite) && value.maximum.every(Number.isFinite) &&
    value.minimum.every((minimum, index) => minimum <= value.maximum[index]);
}

export interface V3SceneIndexView {
  models: V3SceneModelView[];
  chunks: V3SceneChunkView[];
  dependencies: Uint32Array;
}

export function parseV3SceneIndex(bytes: ArrayBuffer): V3SceneIndexView {
  const view = new DataView(bytes);
  if (bytes.byteLength < HEADER_SIZE || view.getUint32(0, true) !== MAGIC ||
    view.getUint16(4, true) !== VERSION || view.getUint16(6, true) !== HEADER_SIZE ||
    view.getUint32(8, true) !== bytes.byteLength || view.getUint32(36, true) !== 0)
    throw new Error("Invalid v3 scene index header");
  const modelCount = view.getUint32(12, true);
  const chunkCount = view.getUint32(16, true);
  const dependencyCount = view.getUint32(20, true);
  if (view.getUint32(24, true) !== 0 || view.getUint32(28, true) !== 0 ||
    view.getUint32(32, true) !== 0 || view.getUint32(36, true) !== 0)
    throw new Error("Invalid v3 scene index reserved fields");
  const modelBytes = modelCount * MODEL_SIZE;
  const dependencyBytes = dependencyCount * 4;
  const modelEnd = ((HEADER_SIZE + 15) & ~15) + modelBytes;
  const chunkStart = (modelEnd + 15) & ~15;
  let chunkEnd = chunkStart;
  for (let i = 0; i < chunkCount; i++) {
    if (chunkEnd + CHUNK_SIZE > bytes.byteLength) throw new Error("Invalid v3 scene index length");
    chunkEnd += CHUNK_SIZE + view.getUint32(chunkEnd + 40, true) * 4;
  }
  const dependencyStart = (chunkEnd + 15) & ~15;
  if (!Number.isSafeInteger(modelBytes + chunkEnd - chunkStart + dependencyBytes) ||
    dependencyStart + dependencyBytes !== bytes.byteLength)
    throw new Error("Invalid v3 scene index length");
  let offset = (HEADER_SIZE + 15) & ~15;
  const models: V3SceneModelView[] = [];
  for (let i = 0; i < modelCount; i++) {
    const modelBounds = bounds(view, offset + 16);
    if (!validBounds(modelBounds) || view.getUint16(offset + 14, true) !== 0)
      throw new Error("Invalid v3 scene model");
    models.push({
      originalModelId: view.getUint32(offset, true),
      meshResourceId: view.getUint32(offset + 4, true),
      dependencyStart: view.getUint32(offset + 8, true),
      dependencyCount: view.getUint16(offset + 12, true),
      bounds: modelBounds,
    });
    offset += MODEL_SIZE;
  }
  offset = (offset + 15) & ~15;
  const chunks: V3SceneChunkView[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const chunkBounds = bounds(view, offset + 4);
    if (!validBounds(chunkBounds))
      throw new Error("Invalid v3 scene chunk");
    chunks.push({
      id: view.getUint32(offset, true),
      bounds: chunkBounds,
      placementResourceId: view.getUint32(offset + 28, true),
      placementCount: view.getUint32(offset + 32, true),
      rangeCount: view.getUint32(offset + 36, true),
      bakedMeshCount: view.getUint32(offset + 40, true),
    });
    offset += CHUNK_SIZE + chunks[chunks.length - 1].bakedMeshCount * 4;
  }
  offset = (offset + 15) & ~15;
  const dependencies = new Uint32Array(bytes, offset, dependencyCount);
  for (const model of models) {
    if (model.dependencyStart > dependencies.length || model.dependencyCount > dependencies.length - model.dependencyStart)
      throw new Error("Invalid v3 scene dependency range");
  }
  return { models, chunks, dependencies };
}
