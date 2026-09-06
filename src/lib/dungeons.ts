import type { IndexedPlacement } from "./acdatclient";


export interface DungeonSelection {
  landblock: number;
  cellId?: number;
  name?: string;
}

export interface DungeonName {
  name: string;
  cellId: number;
}

const dungeonNamesByCell = new Map<number, string>();
const dungeonNamesByLandblock = new Map<number, string>();
let allDungeonNames: DungeonName[] = [];
const dungeonNamesStoragePrefix = "acterrain.dungeonNames.";

function storeDungeonNames(names: readonly DungeonName[]): void {
  allDungeonNames = [...names];
  dungeonNamesByCell.clear();
  dungeonNamesByLandblock.clear();
  for (const location of names) {
    dungeonNamesByCell.set(location.cellId, location.name);
    dungeonNamesByLandblock.set(location.cellId >>> 16, location.name);
  }
}

export async function loadDungeonNames(endpoint: string): Promise<void> {
  const storageKey = `${dungeonNamesStoragePrefix}${endpoint}`;
  try {
    const cached = window.localStorage.getItem(storageKey);
    if (cached) {
      storeDungeonNames(JSON.parse(cached) as DungeonName[]);
    }
  } catch {
    // A stale or unavailable local cache should not prevent the API request.
  }
  try {
    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`Dungeon names returned HTTP ${response.status}`);
    }
    const data = await response.json() as { locations?: DungeonName[] };
    const names = data.locations ?? [];
    storeDungeonNames(names);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(names));
    } catch {
      // Local storage is an optimization; the in-memory names remain available.
    }
  } catch (error) {
    if (dungeonNamesByCell.size === 0) {
      console.warn("Unable to load ACTerrain dungeon names", error);
    }
  }
}

export function dungeonName(landblock: number, cellId?: number): string | undefined {
  return (cellId === undefined ? undefined : dungeonNamesByCell.get(cellId))
    ?? dungeonNamesByLandblock.get(landblock);
}

export function getDungeonNames(): readonly DungeonName[] {
  return allDungeonNames;
}

export interface DungeonCell {
  id: number;
  groupId: number;
  planes: [number, number, number, number][] | null;
  bounds: { minimum: [number, number, number]; maximum: [number, number, number] };
  placements: IndexedPlacement[];
}

export interface DungeonData {
  cells: DungeonCell[];
}

export function hexId(id: number, digits = 8): string {
  return `0x${id.toString(16).toUpperCase().padStart(digits, "0")}`;
}

export function dungeonCoordinates(selection: DungeonSelection, cells: readonly DungeonCell[], position: { x: number; y: number; z: number }): string {
  const point = [position.x, -position.y, position.z];
  const cell = cells.find(cell => cell.planes !== null && cell.planes.every(
    plane => plane[0] * point[0] + plane[1] * point[1] + plane[2] * point[2] + plane[3] >= -0.0002,
  ));
  if (cell) {
    return `${selection.name ? `${selection.name} ` : ""}${hexId(cell.id)} ${point.map(value => value.toFixed(2)).join(" ")}`;
  }
  return `${selection.name ? `${selection.name} ` : ""}${hexId(selection.landblock, 4)} ${point.map(value => value.toFixed(2)).join(" ")}`;
}
