import { debounce } from "lodash";

import Coordinates, {
  mapCoordinatesToWorld,
  worldToMapCoordinates,
} from "./coordinates";

export type CameraRoute = {
  dungeon?: import("./dungeons").DungeonSelection;
  mode: "2d" | "3d";
  position: { x: number; y: number; z: number };
  zoom?: number;
  yaw?: number;
  pitch?: number;
  roll?: number;
};

let currentRoute = "";

const updateHash = debounce(
  (newRoute: string) => {
    history.replaceState(null, "", `${location.pathname}${location.search}#${newRoute}`);
  },
  300,
  {
    trailing: true,
  },
);

function formatAngle(value: number) {
  return ((value * 180) / Math.PI).toFixed(1);
}

function formatCoordinate(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(3)}${value >= 0 ? positive : negative}`;
}

function makeRoute(route: CameraRoute) {
  if (route.dungeon) {
    const selection = route.dungeon;
    const location = selection.cellId?.toString(16).padStart(8, "0")
      ?? selection.landblock.toString(16).padStart(4, "0");
    return [route.mode, location,
      route.position.x.toFixed(3), (-route.position.y).toFixed(3),
      ...(route.mode === "2d" ? [route.zoom!.toFixed(4)] :
        [route.position.z.toFixed(3), formatAngle(route.yaw!), formatAngle(route.pitch!), formatAngle(route.roll!)])].join(",");
  }
  const coords = worldToMapCoordinates({
    x: route.position.x,
    y: route.position.y,
    z: route.mode === "2d" ? 0 : route.position.z,
  });

  if (route.mode === "2d") {
    return `2d,${formatCoordinate(coords.NS, "N", "S")},${formatCoordinate(coords.EW, "E", "W")},${route.zoom!.toFixed(4)}`;
  }

  return (
    `3d,${formatCoordinate(coords.NS, "N", "S")},${formatCoordinate(coords.EW, "E", "W")},` +
    `${(coords.LocalZ / 240).toFixed(3)}Z,${formatAngle(route.yaw!)},${formatAngle(route.pitch!)},${formatAngle(route.roll!)}`
  );
}

export function updateCameraRoute(route: CameraRoute) {
  const newRoute = makeRoute(route);
  if (currentRoute != newRoute) {
    currentRoute = newRoute;
    updateHash(newRoute);
  }
}

export function pushCameraRoute(route: CameraRoute) {
  const newRoute = makeRoute(route);
  if (currentRoute == newRoute) return;
  updateHash.cancel();
  currentRoute = newRoute;
  history.pushState(null, "", `${location.pathname}${location.search}#${newRoute}`);
}

export function cancelCameraRouteUpdate(): void {
  updateHash.cancel();
  currentRoute = "";
}

function parseMapCoordinate(value: string, positive: string, negative: string) {
  const match = value.match(
    new RegExp(`^(\\d+(?:\\.\\d+)?)([${positive}${negative}])$`, "i"),
  );
  if (!match) return undefined;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return undefined;
  return match[2].toUpperCase() === positive ? parsed : -parsed;
}

function parseZ(value: string) {
  const match = value.match(/^(-?\d+(?:\.\d+)?)Z$/i);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed * 240 : undefined;
}

function parseDungeonLocation(value: string) {
  if (/^[0-9a-f]{8}$/i.test(value)) {
    const cellId = parseInt(value, 16);
    const landblock = cellId >>> 16;
    const cell = cellId & 0xffff;
    return cell >= 0x100 && cell < 0xfffe
      ? { landblock, cellId }
      : undefined;
  }
  return /^[0-9a-f]{4}$/i.test(value)
    ? { landblock: parseInt(value, 16) }
    : undefined;
}

function parseAngle(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? (parsed * Math.PI) / 180 : undefined;
}

export function parseRoute(route: string): CameraRoute | undefined {
  const parts = route.replace(/^#+/, "").split(",");
  if (parts[0] === "2d" && parts.length === 5 && parseDungeonLocation(parts[1])) {
    const location = parseDungeonLocation(parts[1])!;
    const values = parts.slice(2).map(Number);
    if (parts.slice(2).some(value => !value.trim()) || values.some(value => !Number.isFinite(value)) || values[2] <= 0) {
      return undefined;
    }
    return { dungeon: location, mode: "2d", position: { x: values[0], y: -values[1], z: 1 }, zoom: values[2] };
  }

  if (parts[0] === "3d" && parts.length === 8 && parseDungeonLocation(parts[1])) {
    const location = parseDungeonLocation(parts[1])!;
    const values = parts.slice(2).map(Number);
    if (parts.slice(2).some(value => !value.trim()) || values.some(value => !Number.isFinite(value))) {
      return undefined;
    }
    return { dungeon: location, mode: "3d", position: { x: values[0], y: -values[1], z: values[2] },
      yaw: values[3] * Math.PI / 180, pitch: values[4] * Math.PI / 180, roll: values[5] * Math.PI / 180 };
  }

  if (parts[0] === "2d" && parts.length === 4) {
    const northSouth = parseMapCoordinate(parts[1], "N", "S");
    const eastWest = parseMapCoordinate(parts[2], "E", "W");
    const zoom = Number(parts[3]);
    if (
      northSouth === undefined ||
      eastWest === undefined ||
      !Number.isFinite(zoom)
    )
      return undefined;
    const position = mapCoordinatesToWorld(
      Coordinates.FromCoordinates(northSouth, eastWest, 0),
    );
    return {
      mode: "2d",
      position: { ...position, z: 1 },
      zoom,
    };
  }

  if (parts[0] === "3d" && parts.length === 7) {
    const northSouth = parseMapCoordinate(parts[1], "N", "S");
    const eastWest = parseMapCoordinate(parts[2], "E", "W");
    const z = parseZ(parts[3]);
    const yaw = parseAngle(parts[4]);
    const pitch = parseAngle(parts[5]);
    const roll = parseAngle(parts[6]);
    if ([northSouth, eastWest, z, yaw, pitch, roll].some((value) => value === undefined))
      return undefined;
    const position = mapCoordinatesToWorld(
      Coordinates.FromCoordinates(northSouth!, eastWest!, z!),
    );
    return {
      mode: "3d",
      position,
      yaw,
      pitch,
      roll,
    };
  }

  return undefined;
}
