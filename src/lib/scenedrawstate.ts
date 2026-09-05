import type { ScenePass } from "./scenesubmission";

export interface SceneDrawState {
  valid: boolean;
  program: WebGLProgram | null;
  meshPass: ScenePass | null;
  meshBatch: object | null;
  meshMaterial: object | null;
  meshInstanceOffset: number;
  particlePass: ScenePass | null;
  particleMaterial: object | null;
  particleOffset: number;
}

const states = new WeakMap<WebGL2RenderingContext, SceneDrawState>();

function createState(): SceneDrawState {
  return {
    valid: false,
    program: null,
    meshPass: null,
    meshBatch: null,
    meshMaterial: null,
    meshInstanceOffset: -1,
    particlePass: null,
    particleMaterial: null,
    particleOffset: -1,
  };
}

export function getSceneDrawState(gl: WebGL2RenderingContext): SceneDrawState {
  let state = states.get(gl);
  if (!state) {
    state = createState();
    states.set(gl, state);
  }
  return state;
}

export function invalidateSceneDrawState(gl: WebGL2RenderingContext): void {
  const state = getSceneDrawState(gl);
  state.valid = false;
  state.program = null;
  state.meshPass = null;
  state.meshBatch = null;
  state.meshMaterial = null;
  state.meshInstanceOffset = -1;
  state.particlePass = null;
  state.particleMaterial = null;
  state.particleOffset = -1;
}
