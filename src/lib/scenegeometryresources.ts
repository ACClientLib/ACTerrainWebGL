import * as glhelpers from "./glhelpers";
import { Building3DFragSource } from "../shaders/building3d.frag";
import { Building3DVertSource } from "../shaders/building3d.vert";
import { ParticleFragSource } from "../shaders/particle.frag";
import { ParticleVertSource } from "../shaders/particle.vert";

export interface SceneGeometryUniforms {
  xWorld: WebGLUniformLocation | null;
  acYOrigin: WebGLUniformLocation | null;
  cameraMode: WebGLUniformLocation | null;
  texture: WebGLUniformLocation | null;
  diffuse: WebGLUniformLocation | null;
  luminosity: WebGLUniformLocation | null;
  opacity: WebGLUniformLocation | null;
  alphaMode: WebGLUniformLocation | null;
  alphaCutoff: WebGLUniformLocation | null;
  renderPass: WebGLUniformLocation | null;
  cameraPosition: WebGLUniformLocation | null;
  fogColor: WebGLUniformLocation | null;
  fogStart: WebGLUniformLocation | null;
  fogEnd: WebGLUniformLocation | null;
  fogEnabled: WebGLUniformLocation | null;
  lightDirection: WebGLUniformLocation | null;
  sunlightColor: WebGLUniformLocation | null;
  ambientColor: WebGLUniformLocation | null;
}

export interface SceneParticleUniforms {
  xWorld: WebGLUniformLocation | null;
  acYOrigin: WebGLUniformLocation | null;
  texture: WebGLUniformLocation | null;
  cameraRight: WebGLUniformLocation | null;
  cameraUp: WebGLUniformLocation | null;
  opacity: WebGLUniformLocation | null;
  alphaMode: WebGLUniformLocation | null;
  alphaCutoff: WebGLUniformLocation | null;
  renderPass: WebGLUniformLocation | null;
  cameraPosition: WebGLUniformLocation | null;
  fogColor: WebGLUniformLocation | null;
  fogStart: WebGLUniformLocation | null;
  fogEnd: WebGLUniformLocation | null;
  fogEnabled: WebGLUniformLocation | null;
}

export class SceneGeometryResources {
  program: WebGLProgram | null = null;
  particleProgram: WebGLProgram | null = null;
  uniforms!: SceneGeometryUniforms;
  particleUniforms!: SceneParticleUniforms;

  private readonly contextLostHandler = (event: Event) => {
    event.preventDefault();
    this.program = null;
    this.particleProgram = null;
  };
  private readonly contextRestoredHandler = () => this.createPrograms();

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.createPrograms();
    gl.canvas.addEventListener("webglcontextlost", this.contextLostHandler, false);
    gl.canvas.addEventListener("webglcontextrestored", this.contextRestoredHandler, false);
  }

  dispose(): void {
    this.gl.canvas.removeEventListener("webglcontextlost", this.contextLostHandler);
    this.gl.canvas.removeEventListener("webglcontextrestored", this.contextRestoredHandler);
    this.gl.deleteProgram(this.program);
    this.gl.deleteProgram(this.particleProgram);
    this.program = null;
    this.particleProgram = null;
  }

  private createPrograms(): void {
    const gl = this.gl;
    const vertex = glhelpers.createShader(gl, gl.VERTEX_SHADER, Building3DVertSource);
    const fragment = glhelpers.createShader(gl, gl.FRAGMENT_SHADER, Building3DFragSource);
    this.program = vertex && fragment ? glhelpers.createProgram(gl, vertex, fragment) : null;
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);

    const particleVertex = glhelpers.createShader(gl, gl.VERTEX_SHADER, ParticleVertSource);
    const particleFragment = glhelpers.createShader(gl, gl.FRAGMENT_SHADER, ParticleFragSource);
    this.particleProgram = particleVertex && particleFragment ? glhelpers.createProgram(gl, particleVertex, particleFragment) : null;
    if (particleVertex) gl.deleteShader(particleVertex);
    if (particleFragment) gl.deleteShader(particleFragment);

    const uniform = (program: WebGLProgram | null, name: string) => program ? gl.getUniformLocation(program, name) : null;
    this.uniforms = {
      acYOrigin: uniform(this.program, "acYOrigin"), xWorld: uniform(this.program, "xWorld"), cameraMode: uniform(this.program, "cameraMode"), texture: uniform(this.program, "buildingTexture"),
      diffuse: uniform(this.program, "diffuseAmount"), luminosity: uniform(this.program, "luminosity"), opacity: uniform(this.program, "opacity"),
      alphaMode: uniform(this.program, "alphaMode"), alphaCutoff: uniform(this.program, "alphaCutoff"), renderPass: uniform(this.program, "renderPass"),
      cameraPosition: uniform(this.program, "cameraPosition"), fogColor: uniform(this.program, "fogColor"), fogStart: uniform(this.program, "fogStart"),
      fogEnd: uniform(this.program, "fogEnd"), fogEnabled: uniform(this.program, "fogEnabled"), lightDirection: uniform(this.program, "lightDirection"),
      sunlightColor: uniform(this.program, "sunlightColor"), ambientColor: uniform(this.program, "ambientColor"),
    };
    this.particleUniforms = {
      acYOrigin: uniform(this.particleProgram, "acYOrigin"), xWorld: uniform(this.particleProgram, "xWorld"), texture: uniform(this.particleProgram, "particleTexture"), cameraRight: uniform(this.particleProgram, "cameraRight"),
      cameraUp: uniform(this.particleProgram, "cameraUp"), opacity: uniform(this.particleProgram, "materialOpacity"), alphaMode: uniform(this.particleProgram, "alphaMode"), alphaCutoff: uniform(this.particleProgram, "alphaCutoff"), renderPass: uniform(this.particleProgram, "renderPass"),
      cameraPosition: uniform(this.particleProgram, "cameraPosition"), fogColor: uniform(this.particleProgram, "fogColor"), fogStart: uniform(this.particleProgram, "fogStart"),
      fogEnd: uniform(this.particleProgram, "fogEnd"), fogEnabled: uniform(this.particleProgram, "fogEnabled"),
    };
  }
}
