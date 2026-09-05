import type { V3CullState, V3RenderClass } from "../v3/v3types";
import type { SceneView } from "./sceneview";

export interface SceneRenderKey {
  readonly renderClass: V3RenderClass;
  readonly programVariant: string;
  readonly cullState: V3CullState;
  readonly meshBatch: number;
  readonly material: number;
  readonly sampler: string;
  readonly parity: boolean;
}

export function cullForTransform(cullState: V3CullState, negativeDeterminant: boolean): V3CullState {
  return negativeDeterminant
    ? cullState === "front"
      ? "back"
      : cullState === "back"
        ? "front"
        : "none"
    : cullState;
}

export type ScenePass = "opaque" | "color" | "revealage" | "additive" | "fallback";

/** A draw owned by a producer but ordered and state-managed by SceneRenderer. */
export interface SceneSubmission {
  readonly key: SceneRenderKey;
  readonly instanceCount: number;
  /** Optional far-to-near fallback bucket for one already-batched draw. */
  readonly depthBucket?: number;
  draw(view: SceneView, pass: ScenePass): void;
}

export type SceneSubmissionSink = (submission: SceneSubmission) => void;
