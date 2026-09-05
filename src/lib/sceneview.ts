import { Matrix4, Vector3 } from "@math.gl/core";
import type { CameraMode } from "./cameras/cameramode";

export interface SceneFog {
  readonly color: readonly [number, number, number];
  readonly start: number;
  readonly end: number;
  readonly enabled: boolean;
}

export interface SceneLighting {
  readonly direction: readonly [number, number, number];
  readonly sunlight: readonly [number, number, number];
  readonly ambient: readonly [number, number, number];
}

export interface SceneView {
  readonly view: Matrix4;
  readonly projection: Matrix4;
  readonly viewProjection: Matrix4;
  readonly cameraPosition: readonly [number, number, number];
  readonly particleRight: readonly [number, number, number];
  readonly particleUp: readonly [number, number, number];
  readonly viewport: readonly [number, number];
  readonly fog: SceneFog;
  readonly lighting: SceneLighting;
  readonly cameraMode: CameraMode;
}

export function createSceneView(camera: {
  readonly FrameTransform: Matrix4;
  readonly Position: Vector3;
  readonly ViewportSize: Vector3;
  readonly ParticleRight: Vector3;
  readonly ParticleUp: Vector3;
  readonly ViewProjection: Matrix4;
  readonly FrameInverseTransform: Matrix4;
  readonly Transform: Matrix4;
}, cameraMode: CameraMode, fog: SceneFog, lighting: SceneLighting): SceneView {
  const viewProjection = camera.FrameTransform.clone();
  const view = camera.FrameInverseTransform.clone();
  const projection = camera.ViewProjection.clone();
  const snapshot: SceneView = {
    view,
    projection,
    viewProjection,
    cameraPosition: Object.freeze([camera.Position.x, camera.Position.y, camera.Position.z]) as readonly [number, number, number],
    particleRight: Object.freeze([camera.ParticleRight.x, camera.ParticleRight.y, camera.ParticleRight.z]) as readonly [number, number, number],
    particleUp: Object.freeze([camera.ParticleUp.x, camera.ParticleUp.y, camera.ParticleUp.z]) as readonly [number, number, number],
    viewport: Object.freeze([camera.ViewportSize.x, camera.ViewportSize.y]) as readonly [number, number],
    fog: Object.freeze({ ...fog, color: Object.freeze([...fog.color]) as readonly [number, number, number] }),
    lighting: Object.freeze({ ...lighting, direction: Object.freeze([...lighting.direction]) as readonly [number, number, number], sunlight: Object.freeze([...lighting.sunlight]) as readonly [number, number, number], ambient: Object.freeze([...lighting.ambient]) as readonly [number, number, number] }),
    cameraMode,
  };
  return Object.freeze(snapshot);
}

export function normalMatrix(transform: Matrix4): Matrix4 {
  return transform.clone().invert().transpose();
}
