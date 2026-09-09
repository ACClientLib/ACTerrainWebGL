import { LAND_BLOCK_SIZE, MAP_SIZE } from "./worldgeometry";
import { hexId } from "./dungeons";

export interface LocationResult {
  type: "poi" | "npc" | "vendor" | "portal" | "dungeon";
  id: string;
  text: string;
  x: number;
  y: number;
  z: number;
  cellId: number;
  seenOutside: boolean;
}

export interface LocationTarget {
  text: string;
  landblock?: number;
  cellId?: number;
  position?: { x: number; y: number; z: number };
  rotation?: { yaw: number; pitch: number; roll: number };
  zoom?: number;
  type?: "poi" | "npc" | "vendor" | "portal";
}

// AC quaternions are W/X/Y/Z; the renderer reflects AC's north axis.
export function rotation(values: number[]): LocationTarget["rotation"] {
  const length = Math.hypot(...values);
  const [w, x, y, z] = values.map((value) => value / length);
  return {
    yaw: Math.atan2(-2 * (x * y - w * z), -(1 - 2 * (x * x + z * z))),
    pitch: Math.asin(Math.max(-1, Math.min(1, 2 * (y * z + w * x)))),
    roll: Math.atan2(2 * (x * z - w * y), 1 - 2 * (x * x + y * y)),
  };
}

export function parseLocationTargets(query: string): LocationTarget[] {
  const map = query.match(
    /^(\d+(?:\.\d+)?)\s*([NS])\s*[,\s]\s*(\d+(?:\.\d+)?)\s*([EW])$/i,
  );
  if (map) {
    const ns = Number(map[1]) * (map[2].toUpperCase() === "N" ? 1 : -1);
    const ew = Number(map[3]) * (map[4].toUpperCase() === "E" ? 1 : -1);
    const x = (ew + 101.95) * 240;
    const y = MAP_SIZE - (ns + 101.95) * 240;
    return x >= 0 && x <= MAP_SIZE && y >= 0 && y <= MAP_SIZE
      ? [{ text: `Go to ${query}`, position: { x, y, z: 0 }, zoom: 2 }]
      : [];
  }
  const location = query.match(
    /^(?:0x)?([0-9a-f]{8})\s*\[([^\]]+)\](?:\s+(.+))?$/i,
  );
  if (location) {
    const coordinates = location[2].trim().split(/\s+/).map(Number);
    const quaternion = location[3]?.trim().split(/\s+/).map(Number);
    if (
      coordinates.length !== 3 ||
      !coordinates.every(Number.isFinite) ||
      (quaternion &&
        (quaternion.length !== 4 ||
          !quaternion.every(Number.isFinite) ||
          Math.hypot(...quaternion) === 0))
    ) {
      return [];
    }
    const cellId = parseInt(location[1], 16);
    const landblock = cellId >>> 16;
    const interior = (cellId & 0xffff) >= 0x100 && (cellId & 0xffff) < 0xfffe;
    const [x, y, z] = coordinates;
    return [
      {
        text: `Go to ${query}`,
        landblock: interior ? landblock : undefined,
        cellId: interior ? cellId : undefined,
        position: {
          x: x + (interior ? 0 : (landblock >>> 8) * LAND_BLOCK_SIZE),
          y: interior
            ? -y
            : MAP_SIZE - y - (landblock & 0xff) * LAND_BLOCK_SIZE,
          z,
        },
        rotation: quaternion ? rotation(quaternion) : undefined,
      },
    ];
  }
  const block = query.match(/^(?:0x)?([0-9a-f]{1,4}|[0-9a-f]{8})$/i);
  if (!block) {
    return [];
  }
  const id = parseInt(block[1], 16);
  const landblock = block[1].length === 8 ? id >>> 16 : id;
  const cell = block[1].length === 8 ? id & 0xffff : 0;
  return [
    {
      text: `Open dungeon ${hexId(landblock, 4)}`,
      landblock,
      cellId: cell >= 0x100 && cell < 0xfffe ? id : undefined,
    },
    {
      text: `View landscape ${hexId(landblock, 4)}`,
      zoom: 1,
      position: {
        x: (landblock >>> 8) * LAND_BLOCK_SIZE + LAND_BLOCK_SIZE / 2,
        y:
          MAP_SIZE -
          ((landblock & 0xff) * LAND_BLOCK_SIZE + LAND_BLOCK_SIZE / 2),
        z: 0,
      },
    },
  ];
}

export function locationTarget(result: LocationResult): LocationTarget {
  const dungeon = result.type === "dungeon" || !result.seenOutside;
  return {
    text: result.text,
    landblock: dungeon ? result.cellId >>> 16 : undefined,
    cellId: dungeon ? result.cellId : undefined,
    position:
      result.type === "dungeon"
        ? undefined
        : {
            x: result.x,
            y: dungeon ? result.y - MAP_SIZE : result.y,
            z: result.z,
          },
    type: result.type === "dungeon" ? undefined : result.type,
  };
}
