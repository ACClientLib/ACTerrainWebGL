import { debounce } from "lodash";
import Coordinates, {
  mapCoordinatesToWorld,
  worldToMapCoordinates,
} from "./coordinates";

export type CameraRoute = {
  mode: "2d" | "3d";
  position: { x: number; y: number; z: number };
  zoom?: number;
  yaw?: number;
  pitch?: number;
  roll?: number;
  fov?: number;
};

let currentRoute = "";

const updateHash = debounce(
  (newRoute: string) => {
    location.hash = newRoute;
  },
  300,
  {
    trailing: true,
  },
);

function formatAngle(value: number) {
  return ((value * 180) / Math.PI).toFixed(1);
}

function formatFov(value: number) {
  return value.toFixed(1);
}

function formatCoordinate(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(3)}${value >= 0 ? positive : negative}`;
}

function makeRoute(route: CameraRoute) {
  const coords = worldToMapCoordinates({
    x: route.position.x,
    y: route.position.y,
    z: route.mode === "2d" ? 0 : route.position.z,
  });
  const mapPosition = [
    formatCoordinate(coords.NS, "N", "S"),
    formatCoordinate(coords.EW, "E", "W"),
    `${(coords.LocalZ / 240).toFixed(3)}Z`,
  ];

  if (route.mode === "2d") {
    return `2d,${mapPosition[0]},${mapPosition[1]},${mapPosition[2]},${route.zoom!.toFixed(4)}`;
  }

  return (
    `3d,${mapPosition.join(",")},${formatAngle(route.yaw!)},${formatAngle(route.pitch!)},` +
    `${formatAngle(route.roll!)},${formatFov(route.fov!)}`
  );
}

export function updateCameraRoute(route: CameraRoute) {
  const newRoute = makeRoute(route);
  if (currentRoute != newRoute) {
    currentRoute = newRoute;
    updateHash(newRoute);
  }
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

function parseAngle(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? (parsed * Math.PI) / 180 : undefined;
}

export function parseRoute(route: string): CameraRoute | undefined {
  const parts = route.replace(/^#+/, "").split(",");

  if (parts[0] === "2d" && parts.length === 5) {
    const northSouth = parseMapCoordinate(parts[1], "N", "S");
    const eastWest = parseMapCoordinate(parts[2], "E", "W");
    const z = parseZ(parts[3]);
    const zoom = Number(parts[4]);
    if (
      northSouth === undefined ||
      eastWest === undefined ||
      z === undefined ||
      !Number.isFinite(zoom)
    )
      return undefined;
    const position = mapCoordinatesToWorld(
      Coordinates.FromCoordinates(northSouth, eastWest, z),
    );
    return {
      mode: "2d",
      position: { ...position, z: 1 },
      zoom,
    };
  }

  if (parts[0] === "3d" && parts.length === 8) {
    const northSouth = parseMapCoordinate(parts[1], "N", "S");
    const eastWest = parseMapCoordinate(parts[2], "E", "W");
    const z = parseZ(parts[3]);
    const yaw = parseAngle(parts[4]);
    const pitch = parseAngle(parts[5]);
    const roll = parseAngle(parts[6]);
    const fov = Number(parts[7]);
    if (
      [northSouth, eastWest, z, yaw, pitch, roll].some(
        (value) => value === undefined,
      ) ||
      !Number.isFinite(fov)
    )
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
      fov,
    };
  }

  return undefined;
}
