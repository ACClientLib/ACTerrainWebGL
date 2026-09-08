import type { ScenePass } from "./scenesubmission";
import type { ObjectMaterial } from "./acdatclient";

export interface SceneDrawState {
  valid: boolean;
  program: WebGLProgram | null;
  meshPass: ScenePass | null;
  meshBatch: object | null;
  meshMaterial: ObjectMaterial | null;
  particlePass: ScenePass | null;
  particleMaterial: object | null;
  particleOffset: number;
  particleVao: WebGLVertexArrayObject | null;
  producerOrigin: number | null;
}

const states = new WeakMap<WebGL2RenderingContext, SceneDrawState>();

function createState(): SceneDrawState {
  return {
    valid: false,
    program: null,
    meshPass: null,
    meshBatch: null,
    meshMaterial: null,
    particlePass: null,
    particleMaterial: null,
    particleOffset: -1,
    particleVao: null,
    producerOrigin: null,
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
  state.particlePass = null;
  state.particleMaterial = null;
  state.particleOffset = -1;
  state.particleVao = null;
  state.producerOrigin = null;
}
