import type { TextureProfile } from "./lib/formatcontract";

export type TextureProfilePreference = "auto" | TextureProfile;

export interface SettingsData {
  minZoom: number;
  maxZoom: number;
  minZoomForTextures: number;
  minZoomFor3DObjects: number;
  maxRenderQuality: number;
  minRenderQuality: number;
  renderQuality: number;
  distanceLandblocks: number;
  textureProfile: TextureProfilePreference;
  showLabels: boolean;
  terrainGridEnabled: boolean;
  moveSpeed: number;
  mobileMoveSensitivity: number;
  mobileLookSensitivity: number;
  mobileLookInvertY: boolean;
  fov: number;
  directionX: number;
  directionY: number;
  directionZ: number;
  lightIntensity: number;
  dataset: string | null;
  readonly renderScale: number;
}

export function parseTextureProfilePreference(value: unknown): TextureProfilePreference {
  switch (String(value).trim().toLowerCase()) {
    case "bc":
    case "bc / s3tc":
      return "bc";
    case "etc2":
      return "etc2";
    case "rgba8":
      return "rgba8";
    default:
      return "auto";
  }
}

const storageKey = "acterrain.settings";
const defaults = {
  minZoom: 0.002,
  maxZoom: 1000,
  minZoomForTextures: 0.02,
  minZoomFor3DObjects: 0.25,
  maxRenderQuality: 10,
  minRenderQuality: 1,
  renderQuality: 10,
  distanceLandblocks: 8,
  textureProfile: "auto" as TextureProfilePreference,
  showLabels: true,
  terrainGridEnabled: false,
  moveSpeed: 60,
  mobileMoveSensitivity: 85,
  mobileLookSensitivity: 1.5,
  mobileLookInvertY: false,
  fov: 45,
  directionX: 0.38,
  directionY: -0.15,
  directionZ: -1,
  lightIntensity: 1,
  dataset: null as string | null,
};

function load(): typeof defaults {
  let saved: Partial<typeof defaults> = {};
  let legacyFogDistance: unknown;
  let legacyObjectDistance: unknown;
  try {
    const serialized = window.localStorage.getItem(storageKey);
    const parsed = serialized ? JSON.parse(serialized) : null;
    saved = parsed && typeof parsed === "object"
      ? parsed
      : { textureProfile: window.localStorage.getItem("acterrain.textureProfile") };
    if (parsed && typeof parsed === "object") {
      const legacy = parsed as Record<string, unknown>;
      legacyFogDistance = legacy.fogDistanceLandblocks;
      legacyObjectDistance = legacy.objectLoadDistance;
    }
  } catch {
    saved = {};
  }

  const result = { ...defaults };
  if (typeof saved.distanceLandblocks !== "number") {
    if (typeof legacyFogDistance === "number") result.distanceLandblocks = legacyFogDistance;
    else if (typeof legacyObjectDistance === "number") result.distanceLandblocks = legacyObjectDistance;
  }
  for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
    const value = saved[key];
    if (typeof value === typeof defaults[key] || (value === null && defaults[key] === null)) {
      (result[key] as typeof value) = value;
    }
  }
  result.textureProfile = parseTextureProfilePreference(saved.textureProfile);
  return result;
}

type SettingsListener = (settings: SettingsData) => void;
const listeners = new Set<SettingsListener>();
let batchDepth = 0;
let dirty = false;

function persistAndNotify(): void {
  try {
    const saved = Object.fromEntries(
      Object.keys(defaults).map((key) => [key, data[key as keyof typeof defaults]]),
    );
    window.localStorage.setItem(storageKey, JSON.stringify(saved));
  } catch {
    // Settings still apply for this session when storage is unavailable.
  }
  for (const listener of listeners) listener(data);
}

const data = new Proxy({ ...load() } as SettingsData, {
  set(target, property: string | symbol, value: unknown): boolean {
    if (typeof property !== "string" || target[property as keyof SettingsData] === value) {
      return Reflect.set(target, property, value);
    }
    Reflect.set(target, property, value);
    dirty = true;
    if (batchDepth === 0) {
      dirty = false;
      persistAndNotify();
    }
    return true;
  },
  get(target, property: string | symbol, receiver: object): unknown {
    if (property === "renderScale") {
      return target.maxRenderQuality + 1 - target.renderQuality;
    }
    return Reflect.get(target, property, receiver);
  },
});

export function subscribe(listener: SettingsListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetSettings(): void {
  batchDepth++;
  try {
    for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
      Reflect.set(data, key, defaults[key]);
    }
  } finally {
    batchDepth--;
    if (batchDepth === 0 && dirty) {
      dirty = false;
      persistAndNotify();
    }
  }
  try {
    window.localStorage.removeItem("acterrain.textureProfile");
  } catch {
    // Settings have already been reset for this session.
  }
}

export const labels = {
  minZoom: "minZoom",
  maxZoom: "maxZoom",
  minZoomForTextures: "minZoomForTextures",
  minZoomFor3DObjects: "minZoomFor3DObjects",
  renderQuality: "renderQuality",
  distanceLandblocks: "distanceLandblocks",
  textureProfile: "textureProfile",
};

export { data };
