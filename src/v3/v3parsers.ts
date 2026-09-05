import type { V3CullState, V3MaterialView, V3MeshBatchView, V3MeshView, V3PalettePatchView, V3ParticleBatchView, V3PlacementChunkView, V3PlacementGroupView, V3RenderClass, V3SamplerMode } from "./v3types";

const VERSION = 16;
const ALIGNMENT = 16;
const enumValue = <T>(values: readonly T[], value: number, name: string): T => {
  const result = values[value];
  if (result === undefined) throw new Error(`Invalid v3 ${name}`);
  return result;
};
const renderClasses: V3RenderClass[] = ["opaque", "masked", "sourceOver", "additive"];
const cullStates: V3CullState[] = ["none", "front", "back"];
const samplerModes: V3SamplerMode[] = ["clamp", "repeat"];
const range = (bytes: ArrayBuffer, offset: number, length: number): Uint8Array => {
  if (offset % ALIGNMENT !== 0 || offset > bytes.byteLength || length > bytes.byteLength - offset) throw new Error("Invalid v3 section range");
  return new Uint8Array(bytes, offset, length);
};

export function parseV3Material(bytes: ArrayBuffer): V3MaterialView {
  const view = new DataView(bytes); if (view.getUint32(0, true) !== 0x334d4341 || view.getUint16(4, true) !== VERSION || view.getUint16(6, true) !== 64 || view.getUint32(8, true) !== bytes.byteLength) throw new Error("Invalid v3 material header");
  const renderClass = enumValue(renderClasses, view.getUint8(12), "render class"); const cullState = enumValue(cullStates, view.getUint8(13), "cull state"); const samplerMode = enumValue(samplerModes, view.getUint8(14), "sampler mode"); const clipMapByte = view.getUint8(15);
  if (clipMapByte > 1) throw new Error("Invalid v3 clip-map flag");
  const count = view.getUint32(60, true); if (!Number.isSafeInteger(count * 8) || bytes.byteLength !== 64 + count * 8) throw new Error("Invalid v3 material patch table");
  const alphaCutoff = view.getFloat32(16, true), opacity = view.getFloat32(20, true), luminosity = view.getFloat32(24, true), diffuse = view.getFloat32(28, true);
  const color = [view.getFloat32(32, true), view.getFloat32(36, true), view.getFloat32(40, true), view.getFloat32(44, true)] as [number, number, number, number];
  if (![alphaCutoff, opacity, luminosity, diffuse, ...color].every(Number.isFinite) || alphaCutoff < 0 || alphaCutoff > 1 || opacity < 0 || opacity > 1 || (renderClass === "masked" ? alphaCutoff <= 0 || alphaCutoff >= 1 : alphaCutoff !== 0)) throw new Error("Invalid v3 material values");
  const textureResourceId = view.getUint32(48, true), indexedImageResourceId = view.getUint32(52, true);
  if (textureResourceId !== 0 && indexedImageResourceId !== 0 || indexedImageResourceId === 0 && (view.getUint32(56, true) !== 0 || count !== 0)) throw new Error("Invalid v3 material dependencies");
  const palettePatches: V3PalettePatchView[] = [];
  for (let index = 0; index < count; index++) {
    const offset = 64 + index * 8;
    const patchOffset = view.getUint16(offset + 4, true);
    const length = view.getUint16(offset + 6, true);
    if (length === 0 || patchOffset + length > 0xffff) throw new Error("Invalid v3 palette patch range");
    palettePatches.push({ replacementPaletteResourceId: view.getUint32(offset, true), offset: patchOffset, length });
  }
  return { renderClass, cullState, samplerMode, clipMap: clipMapByte !== 0, alphaCutoff, opacity, luminosity, diffuse, color, textureResourceId, indexedImageResourceId, basePaletteResourceId: view.getUint32(56, true), palettePatches };
}

export function parseV3Mesh(bytes: ArrayBuffer): V3MeshView {
  const view = new DataView(bytes); if (view.getUint32(0, true) !== 0x4853334d || view.getUint16(4, true) !== VERSION || view.getUint16(6, true) !== 80 || view.getUint32(8, true) !== bytes.byteLength || view.getUint32(12, true) !== 0) throw new Error("Invalid v3 mesh header");
  const bounds = { minimum: [view.getFloat32(16, true), view.getFloat32(20, true), view.getFloat32(24, true)] as [number, number, number], maximum: [view.getFloat32(28, true), view.getFloat32(32, true), view.getFloat32(36, true)] as [number, number, number] };
  if (!bounds.minimum.every(Number.isFinite) || !bounds.maximum.every(Number.isFinite) || bounds.minimum.some((value, index) => value > bounds.maximum[index])) throw new Error("Invalid v3 mesh bounds");
  if (view.getUint8(40) !== 1 || view.getUint8(41) !== 4 || view.getUint16(42, true) !== 0 || view.getUint32(76, true) !== 0) throw new Error("Unsupported v3 mesh encoding");
  const batches: V3MeshBatchView[] = []; const count = view.getUint32(44, true); const particleCount = view.getUint32(48, true); if (count > 0x7fffffff || particleCount > 0x7fffffff) throw new Error("Invalid v3 mesh batch count");
  const directoryEnd = 80 + count * 16 + particleCount * 16; if (directoryEnd > bytes.byteLength) throw new Error("Invalid v3 mesh directories");
  for (let i = 0; i < count; i++) { const offset = 80 + i * 16; batches.push({ materialResourceId: view.getUint32(offset, true), firstIndex: view.getUint32(offset + 4, true), indexCount: view.getUint32(offset + 8, true), cullState: enumValue(cullStates, view.getUint8(offset + 12), "cull state"), samplerMode: enumValue(samplerModes, view.getUint8(offset + 13), "sampler mode") }); if (view.getUint16(offset + 14, true) !== 0) throw new Error("Invalid v3 mesh batch reserved bytes"); }
  const particleBatches: V3ParticleBatchView[] = []; const particleOffset = 80 + count * 16;
  for (let i = 0; i < particleCount; i++) { const offset = particleOffset + i * 16; if (view.getUint32(offset + 12, true) !== 0) throw new Error("Invalid v3 particle batch reserved bytes"); particleBatches.push({ materialResourceId: view.getUint32(offset, true), firstParticle: view.getUint32(offset + 4, true), particleCount: view.getUint32(offset + 8, true) }); }
  const sections = [[view.getUint32(52, true), view.getUint32(56, true)], [view.getUint32(60, true), view.getUint32(64, true)], [view.getUint32(68, true), view.getUint32(72, true)]];
  for (const [offset, length] of sections) if (offset < directoryEnd || offset % ALIGNMENT !== 0 || offset > bytes.byteLength || length > bytes.byteLength - offset) throw new Error("Invalid v3 mesh section range");
  for (let i = 0; i < sections.length; i++) for (let j = i + 1; j < sections.length; j++) if (sections[i][0] < sections[j][0] + sections[j][1] && sections[j][0] < sections[i][0] + sections[i][1]) throw new Error("Overlapping v3 mesh sections");
  if (sections[0][1] % 24 !== 0 || sections[1][1] % 4 !== 0 || sections[2][1] % 240 !== 0) throw new Error("Invalid v3 mesh section lengths");
  for (const batch of batches) if (batch.firstIndex % 4 !== 0 || batch.firstIndex > sections[1][1] - batch.indexCount * 4) throw new Error("Invalid v3 mesh batch range");
  for (const batch of particleBatches) if (batch.firstParticle > sections[2][1] / 240 || batch.particleCount > sections[2][1] / 240 - batch.firstParticle) throw new Error("Invalid v3 particle batch range");
  const particleBytes = new DataView(bytes, sections[2][0], sections[2][1]);
  for (let i = 0; i < sections[2][1] / 240; i++) {
    const base = i * 240;
    if (particleBytes.getUint8(base + 8) > 1 || particleBytes.getUint8(base + 9) > 5 || particleBytes.getUint16(base + 10, true) !== 0) throw new Error("Invalid v3 particle descriptor flags");
    if (particleBytes.getInt32(base, true) < 0 || particleBytes.getInt32(base, true) > 2 || particleBytes.getInt32(base + 4, true) < 1 || particleBytes.getInt32(base + 4, true) > 12) throw new Error("Invalid v3 particle descriptor type");
    if (particleBytes.getInt32(base + 144, true) < 0 || particleBytes.getInt32(base + 148, true) < 0 || particleBytes.getInt32(base + 152, true) < 0) throw new Error("Invalid v3 particle descriptor limits");
    for (let j = 20; j < 232; j += 4) if (!Number.isFinite(particleBytes.getFloat32(base + j, true))) throw new Error("Invalid v3 particle descriptor value");
    for (let j = 232; j < 240; j += 4) if (particleBytes.getUint32(base + j, true) !== 0) throw new Error("Invalid v3 particle descriptor padding");
  }
  return { bounds, batches, particleBatches, vertexData: range(bytes, sections[0][0], sections[0][1]), indexData: range(bytes, sections[1][0], sections[1][1]), particleData: range(bytes, sections[2][0], sections[2][1]) };
}

export function parseV3PlacementChunk(bytes: ArrayBuffer): V3PlacementChunkView {
  const view = new DataView(bytes); if (view.getUint32(0, true) !== 0x4c504341 || view.getUint16(4, true) !== VERSION || view.getUint16(6, true) !== 32 || view.getUint32(8, true) !== bytes.byteLength) throw new Error("Invalid v3 placement header");
  const groupCount = view.getUint32(16, true); if (groupCount > 0x7fffffff || 32 + groupCount * 16 > bytes.byteLength || view.getUint32(20, true) !== 0 || view.getUint32(24, true) !== 0 || view.getUint32(28, true) !== 0) throw new Error("Invalid v3 placement reserved fields");
  const groups: V3PlacementGroupView[] = []; let offset = 32; const counts: number[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < groupCount; i++) { const modelIndex = view.getUint32(offset, true); const category = view.getUint8(offset + 4); const parity = view.getUint8(offset + 5); const recordSize = view.getUint32(offset + 12, true); if (parity > 1 || view.getUint16(offset + 6, true) !== 0 || (recordSize !== 20 && recordSize !== 24)) throw new Error("Invalid v3 placement group"); counts.push(view.getUint32(offset + 8, true)); sizes.push(recordSize); groups.push({ modelIndex, category, negativeDeterminant: parity !== 0, recordSize: recordSize as 20 | 24, records: [] }); offset += 16; }
  for (let i = 0; i < groups.length; i++) { const records: Uint8Array[] = []; for (let j = 0; j < counts[i]; j++) { if (offset > bytes.byteLength || sizes[i] > bytes.byteLength - offset) throw new Error("Truncated v3 placement record"); if (view.getUint16(offset + sizes[i] - 2, true) !== 0) throw new Error("Invalid v3 placement reserved bytes"); records.push(new Uint8Array(bytes, offset, sizes[i])); offset += sizes[i]; } groups[i].records = records; }
  if (offset !== bytes.byteLength) throw new Error("v3 placement has trailing bytes"); return { chunkId: view.getUint32(12, true), groups };
}
