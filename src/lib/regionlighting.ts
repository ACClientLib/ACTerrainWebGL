import type { SceneLighting } from "./sceneview";

export interface RegionLightingKeyframe {
  readonly begin: number;
  readonly dirBright: number;
  readonly dirHeading: number;
  readonly dirPitch: number;
  readonly dirColor: readonly [number, number, number];
  readonly ambBright: number;
  readonly ambColor: readonly [number, number, number];
}

export interface RegionLightingDescriptor {
  readonly keyframes: readonly RegionLightingKeyframe[];
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function parseRegionLighting(value: unknown): RegionLightingDescriptor {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { keyframes?: unknown }).keyframes) ||
    (value as { keyframes: unknown[] }).keyframes.length === 0
  )
    throw new Error("Invalid ACTerrain regionLighting descriptor");
  const keyframes = (value as { keyframes: unknown[] }).keyframes.map(
    (item) => {
      if (!item || typeof item !== "object")
        throw new Error("Invalid ACTerrain regionLighting keyframe");
      const source = item as Record<string, unknown>;
      const color = (name: string): readonly [number, number, number] => {
        const values = source[name];
        if (
          !Array.isArray(values) ||
          values.length !== 3 ||
          !values.every(
            (component) =>
              Number.isInteger(component) && component >= 0 && component <= 255,
          )
        )
          throw new Error(`Invalid ACTerrain regionLighting ${name}`);
        return Object.freeze(values as [number, number, number]);
      };
      const numbers = [
        "begin",
        "dirBright",
        "dirHeading",
        "dirPitch",
        "ambBright",
      ];
      if (numbers.some((name) => !finite(source[name])))
        throw new Error("Invalid ACTerrain regionLighting keyframe values");
      return Object.freeze({
        begin: source.begin as number,
        dirBright: source.dirBright as number,
        dirHeading: source.dirHeading as number,
        dirPitch: source.dirPitch as number,
        dirColor: color("dirColor"),
        ambBright: source.ambBright as number,
        ambColor: color("ambColor"),
      });
    },
  );
  return Object.freeze({ keyframes: Object.freeze(keyframes) });
}

const lerpAngle = (start: number, end: number, amount: number): number => {
  let difference = end - start;
  while (difference < -180) difference += 360;
  while (difference > 180) difference -= 360;
  return start + difference * amount;
};

const color = (
  value: readonly [number, number, number],
): [number, number, number] => [value[0] / 255, value[1] / 255, value[2] / 255];

export function interpolateRegionLighting(
  descriptor: RegionLightingDescriptor,
  timeOfDay: number,
): SceneLighting {
  const keyframes = [...descriptor.keyframes].sort((a, b) => a.begin - b.begin);
  let first = keyframes[keyframes.length - 1];
  let second = keyframes[0];
  for (let i = 0; i < keyframes.length; i++) {
    if (keyframes[i].begin <= timeOfDay) {
      first = keyframes[i];
      second = keyframes[(i + 1) % keyframes.length];
    }
  }
  const duration =
    second.begin > first.begin
      ? second.begin - first.begin
      : 1 - first.begin + second.begin;
  const amount =
    timeOfDay >= first.begin
      ? (timeOfDay - first.begin) / duration
      : (timeOfDay + 1 - first.begin) / duration;
  const sunlight1 = color(first.dirColor);
  const sunlight2 = color(second.dirColor);
  const ambient1 = color(first.ambColor);
  const ambient2 = color(second.ambColor);
  const sunlight = sunlight1.map(
    (value, i) =>
      (value + (sunlight2[i] - value) * amount) *
      (first.dirBright + (second.dirBright - first.dirBright) * amount),
  ) as [number, number, number];
  const ambient = ambient1.map(
    (value, i) =>
      (value + (ambient2[i] - value) * amount) *
      (first.ambBright + (second.ambBright - first.ambBright) * amount),
  ) as [number, number, number];
  const pitch =
    (lerpAngle(first.dirPitch, second.dirPitch, amount) * Math.PI) / 180;
  const heading =
    (lerpAngle(first.dirHeading, second.dirHeading, amount) * Math.PI) / 180;
  const direction: [number, number, number] = [
    Math.cos(pitch) * Math.cos(heading),
    Math.cos(pitch) * Math.sin(heading),
    Math.sin(pitch),
  ];
  const length = Math.hypot(...direction);
  return {
    direction: direction.map((value) => value / length) as [
      number,
      number,
      number,
    ],
    sunlight,
    ambient,
  };
}
