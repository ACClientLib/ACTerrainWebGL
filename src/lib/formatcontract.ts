export const SUPPORTED_FORMAT_VERSION = 16;

export const RESOURCE_KIND = {
  mesh: 1,
  material: 2,
  texture: 3,
  bakedChunkMesh: 4,
  palette: 5,
  placementChunk: 6,
} as const;

export const TEXTURE_PROFILE = {
  bc: "bc",
  etc2: "etc2",
  rgba8: "rgba8",
} as const;

export type TextureProfile =
  (typeof TEXTURE_PROFILE)[keyof typeof TEXTURE_PROFILE];

export interface ResourceBatchRequest {
  ResourceIds: number[];
}
