export const LAND_BLOCK_SIZE = 192;
export const LAND_BLOCK_SIDE = 255;
export const MAX_LAND_BLOCK_INDEX = LAND_BLOCK_SIDE - 1;
export const MAP_SIZE = LAND_BLOCK_SIDE * LAND_BLOCK_SIZE;
export const TERRAIN_CELLS_PER_LAND_BLOCK = 8;
export const TERRAIN_CELL_SIZE = LAND_BLOCK_SIZE / TERRAIN_CELLS_PER_LAND_BLOCK;
export const TERRAIN_DATA_SIDE =
  LAND_BLOCK_SIDE * TERRAIN_CELLS_PER_LAND_BLOCK + 1;
export const OBJECT_Z_BIAS = 0.05;

export function clampLandBlockIndex(index: number): number {
  return Math.max(0, Math.min(MAX_LAND_BLOCK_INDEX, index));
}

export function mapXToLandBlock(worldX: number): number {
  return clampLandBlockIndex(Math.floor(worldX / LAND_BLOCK_SIZE));
}

export function mapYToLandBlock(worldY: number): number {
  return clampLandBlockIndex(Math.floor((MAP_SIZE - worldY) / LAND_BLOCK_SIZE));
}

export function landBlockId(x: number, y: number): number {
  return (
    ((clampLandBlockIndex(x) << 24) | (clampLandBlockIndex(y) << 16)) >>> 0
  );
}
