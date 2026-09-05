export type V3RenderClass = "opaque" | "masked" | "sourceOver" | "additive";
export type V3CullState = "none" | "front" | "back";
export type V3SamplerMode = "clamp" | "repeat";

export interface V3MaterialView {
  renderClass: V3RenderClass;
  cullState: V3CullState;
  samplerMode: V3SamplerMode;
  alphaCutoff: number;
  clipMap: boolean;
  opacity: number;
  luminosity: number;
  diffuse: number;
  color: [number, number, number, number];
  textureResourceId: number;
  indexedImageResourceId: number;
  basePaletteResourceId: number;
  palettePatches: V3PalettePatchView[];
}

export interface V3PalettePatchView {
  replacementPaletteResourceId: number;
  offset: number;
  length: number;
}

export interface V3MeshBatchView {
  materialResourceId: number;
  firstIndex: number;
  indexCount: number;
  cullState: V3CullState;
  samplerMode: V3SamplerMode;
}

export interface V3ParticleBatchView { materialResourceId: number; firstParticle: number; particleCount: number; }

export interface V3MeshView {
  bounds: { minimum: [number, number, number]; maximum: [number, number, number] };
  batches: V3MeshBatchView[];
  particleBatches: V3ParticleBatchView[];
  vertexData: Uint8Array;
  indexData: Uint8Array;
  particleData: Uint8Array;
}

export interface V3PlacementGroupView {
  modelIndex: number;
  category: number;
  negativeDeterminant: boolean;
  recordSize: 20 | 24;
  records: Uint8Array[];
}

export interface V3PlacementChunkView { chunkId: number; groups: V3PlacementGroupView[]; }

export interface V3SceneModelView {
  originalModelId: number;
  meshResourceId: number;
  dependencyStart: number;
  dependencyCount: number;
  bounds: { minimum: [number, number, number]; maximum: [number, number, number] };
}

export interface V3SceneChunkView {
  id: number;
  bounds: { minimum: [number, number, number]; maximum: [number, number, number] };
  placementResourceId: number;
  placementCount: number;
  rangeCount: number;
  bakedMeshCount: number;
}
