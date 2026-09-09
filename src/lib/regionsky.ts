import type { SceneLighting } from "./sceneview";

type Color = readonly [number, number, number];

export interface RegionSkyDescriptor {
  regionId: number;
  dayLengthSeconds: number;
  timesOfDay: readonly RegionSkyTimeOfDay[];
  dayGroups: readonly RegionSkyDayGroup[];
}
export interface RegionSkyTimeOfDay {
  start: number;
  name: string;
  isNight: boolean;
}
export interface RegionSkyDayGroup {
  name: string;
  objects: readonly RegionSkyObject[];
  keyframes: readonly RegionSkyKeyframe[];
  resourceIds: readonly number[];
}
export interface RegionSkyObject {
  objectIndex: number;
  beginTime: number;
  endTime: number;
  beginAngle: number;
  endAngle: number;
  texVelocity: readonly [number, number];
  defaultMeshResourceId: number | null;
  defaultPesObjectId: number | null;
  properties: number;
  effects: readonly RegionSkyEffect[];
}
export interface RegionSkyEffect {
  scriptId: number;
  classification: "persistent-create" | "timed" | "chained";
  hooks: readonly RegionSkyHook[];
  particleResourceId: number | null;
}
export interface RegionSkyHook {
  startTime: number;
  type: "create" | "call" | "stop" | "destroy" | string;
  emitterId: number | null;
  calledScriptId: number | null;
}
export interface RegionSkyReplacement {
  objectIndex: number;
  meshResourceId: number | null;
  rotate: number;
  luminosity: number;
  maxBright: number;
  transparent: number;
}
export interface RegionSkyKeyframe {
  replacementByObject: ReadonlyMap<number, RegionSkyReplacement>;
  begin: number;
  dirBright: number;
  dirHeading: number;
  dirPitch: number;
  dirColor: Color;
  ambBright: number;
  ambColor: Color;
  worldFog: boolean;
  minWorldFog: number;
  maxWorldFog: number;
  worldFogColor: Color;
  replacements: readonly RegionSkyReplacement[];
}
export interface EvaluatedSkyObject {
  object: RegionSkyObject;
  meshResourceId: number | null;
  angle: number;
  heading: number;
  luminosity: number;
  maxBright: number;
  transparent: number;
  visible: boolean;
}
export interface EvaluatedRegionSky {
  groupIndex: number;
  timeOfDay: number;
  objects: readonly EvaluatedSkyObject[];
  lighting: SceneLighting;
  worldFog: { enabled: boolean; min: number; max: number; color: Color };
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const color = (value: unknown, name: string): Color => {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)
  )
    throw new Error(`Invalid regionSky ${name}`);
  return Object.freeze(value.map((x) => x / 255) as [number, number, number]);
};

export function parseRegionSky(value: unknown): RegionSkyDescriptor {
  if (!value || typeof value !== "object")
    throw new Error("Invalid ACTerrain regionSky descriptor");
  const source = value as Record<string, unknown>;
  if (
    !finite(source.regionId) ||
    !finite(source.dayLengthSeconds) ||
    !Array.isArray(source.timesOfDay) ||
    !Array.isArray(source.dayGroups) ||
    source.dayGroups.length === 0
  )
    throw new Error("Invalid ACTerrain regionSky descriptor");
  const timesOfDay = source.timesOfDay
    .map((item) => {
      const x = item as Record<string, unknown>;
      if (!finite(x.start) || typeof x.name !== "string")
        throw new Error("Invalid regionSky time of day");
      return Object.freeze({
        start: x.start as number,
        name: x.name,
        isNight: Boolean(x.isNight),
      });
    })
    .sort((a, b) => a.start - b.start);
  const dayGroups = source.dayGroups.map((raw) => {
    if (!raw || typeof raw !== "object")
      throw new Error("Invalid regionSky day group");
    const group = raw as Record<string, unknown>;
    if (
      typeof group.name !== "string" ||
      !Array.isArray(group.objects) ||
      !Array.isArray(group.keyframes) ||
      !Array.isArray(group.resourceIds)
    )
      throw new Error("Invalid regionSky day group");
    const objects = group.objects.map((item) => {
      const x = item as Record<string, unknown>;
      if (
        !finite(x.objectIndex) ||
        !finite(x.beginTime) ||
        !finite(x.endTime) ||
        !finite(x.beginAngle) ||
        !finite(x.endAngle) ||
        !Array.isArray(x.texVelocity)
      )
        throw new Error("Invalid regionSky object");
      const effects = ((x.effects ?? []) as RegionSkyEffect[]).map((effect) =>
        Object.freeze({
          ...effect,
          particleResourceId: (effect.particleResourceId ?? null) as
            number | null,
        }),
      );
      return Object.freeze({
        objectIndex: x.objectIndex as number,
        beginTime: x.beginTime as number,
        endTime: x.endTime as number,
        beginAngle: x.beginAngle as number,
        endAngle: x.endAngle as number,
        texVelocity: x.texVelocity as [number, number],
        defaultMeshResourceId: (x.defaultMeshResourceId ?? null) as
          number | null,
        defaultPesObjectId: (x.defaultPesObjectId ?? null) as number | null,
        properties: x.properties as number,
        effects: Object.freeze(effects),
      });
    });
    const keyframes = group.keyframes
      .map((item) => {
        const x = item as Record<string, unknown>;
        if (
          !finite(x.begin) ||
          !finite(x.dirBright) ||
          !finite(x.dirHeading) ||
          !finite(x.dirPitch) ||
          !finite(x.ambBright)
        )
          throw new Error("Invalid regionSky keyframe");
        return Object.freeze({
          begin: x.begin as number,
          dirBright: x.dirBright as number,
          dirHeading: x.dirHeading as number,
          dirPitch: x.dirPitch as number,
          dirColor: color(x.dirColor, "dirColor"),
          ambBright: x.ambBright as number,
          ambColor: color(x.ambColor, "ambColor"),
          worldFog: Boolean(x.worldFog),
          minWorldFog: x.minWorldFog as number,
          maxWorldFog: x.maxWorldFog as number,
          worldFogColor: color(x.worldFogColor, "worldFogColor"),
          replacements: (x.replacements as RegionSkyReplacement[]) ?? [],
        });
      })
      .sort((a, b) => a.begin - b.begin)
      .map((keyframe) => ({
        ...keyframe,
        replacementByObject: new Map(
          keyframe.replacements.map((replacement) => [
            replacement.objectIndex,
            replacement,
          ]),
        ),
      }));
    if (keyframes.length === 0) {
      throw new Error("Invalid regionSky day group: no keyframes");
    }
    return Object.freeze({
      name: group.name,
      objects: Object.freeze(objects),
      keyframes: Object.freeze(keyframes),
      resourceIds: Object.freeze(group.resourceIds as number[]),
    });
  });
  return Object.freeze({
    regionId: source.regionId as number,
    dayLengthSeconds: source.dayLengthSeconds as number,
    timesOfDay: Object.freeze(timesOfDay),
    dayGroups: Object.freeze(dayGroups),
  });
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mixColor = (a: Color, b: Color, t: number): Color => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];
export function evaluateRegionSky(
  descriptor: RegionSkyDescriptor,
  groupIndex: number,
  timeOfDay: number,
): EvaluatedRegionSky {
  const group = descriptor.dayGroups[groupIndex];
  if (!group) throw new Error(`Unknown ACTerrain sky group ${groupIndex}`);
  const t = ((timeOfDay % 1) + 1) % 1;
  let first = group.keyframes[group.keyframes.length - 1];
  let second = group.keyframes[0];
  for (let i = 0; i < group.keyframes.length; i++) {
    if (group.keyframes[i].begin <= t) {
      first = group.keyframes[i];
      second = group.keyframes[(i + 1) % group.keyframes.length];
    }
  }
  const duration =
    second.begin > first.begin
      ? second.begin - first.begin
      : 1 - first.begin + second.begin;
  const amount =
    first === second
      ? 0
      : (t >= first.begin ? t - first.begin : t + 1 - first.begin) / duration;
  const heading =
    (lerp(first.dirHeading, second.dirHeading, amount) * Math.PI) / 180;
  const pitch = (lerp(first.dirPitch, second.dirPitch, amount) * Math.PI) / 180;
  const dirBright = lerp(first.dirBright, second.dirBright, amount);
  const ambBright = lerp(first.ambBright, second.ambBright, amount);
  const lighting: SceneLighting = {
    direction: [
      Math.sin(heading) * Math.cos(pitch),
      Math.cos(heading) * Math.cos(pitch),
      Math.sin(pitch),
    ],
    sunlight: mixColor(first.dirColor, second.dirColor, amount).map(
      (value) => value * dirBright,
    ) as [number, number, number],
    ambient: mixColor(first.ambColor, second.ambColor, amount).map(
      (value) => value * ambBright,
    ) as [number, number, number],
  };
  const objects = group.objects.map((object) => {
    const before = first.replacementByObject.get(object.objectIndex);
    const after = second.replacementByObject.get(object.objectIndex);
    const inWindow =
      object.beginTime === object.endTime ||
      (object.beginTime < object.endTime
        ? t > object.beginTime && t < object.endTime
        : t > object.beginTime || t < object.endTime);
    const meshResourceId =
      before?.meshResourceId ??
      (inWindow ? object.defaultMeshResourceId : null);
    const modulation = (field: "luminosity" | "maxBright" | "transparent") => {
      const a = before?.[field] ?? -1;
      const b = after?.[field] ?? -1;
      const valid = field === "transparent" ? a >= 0 && b >= 0 : a > 0 && b > 0;
      return valid ? lerp(a, b, amount) : -1;
    };
    const angleAmount =
      object.beginTime === object.endTime
        ? 0
        : object.beginTime < object.endTime
          ? (t - object.beginTime) / (object.endTime - object.beginTime)
          : (t >= object.beginTime
              ? t - object.beginTime
              : t + 1 - object.beginTime) /
            (1 - object.beginTime + object.endTime);
    return {
      object,
      meshResourceId,
      angle:
        object.beginTime === object.endTime
          ? object.beginAngle
          : object.beginAngle +
            (object.endAngle - object.beginAngle) * angleAmount,
      heading: before?.rotate ?? 0,
      luminosity: modulation("luminosity"),
      maxBright: modulation("maxBright"),
      transparent: modulation("transparent"),
      visible:
        meshResourceId !== null || (inWindow && object.effects.length > 0),
    };
  });
  return {
    groupIndex,
    timeOfDay: t,
    objects,
    lighting,
    worldFog: {
      enabled: first.worldFog && second.worldFog,
      min: lerp(first.minWorldFog, second.minWorldFog, amount),
      max: lerp(first.maxWorldFog, second.maxWorldFog, amount),
      color: mixColor(first.worldFogColor, second.worldFogColor, amount),
    },
  };
}
