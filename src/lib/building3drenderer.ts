import { Camera2D } from "./cameras/camera2d";
import { CameraFlying } from "./cameras/cameryflying";
import { BaseCamera } from "./cameras/basecamera";
import { CameraMode } from "./cameras/cameramode";
import { Vector3 } from "@math.gl/core";
import * as glhelpers from "./glhelpers";
import { AcDatClient, IndexedPlacement, ObjectMaterial } from "./acdatclient";
import { Building3DVertSource } from "../shaders/building3d.vert";
import { Building3DFragSource } from "../shaders/building3d.frag";
import { BUILDING_TEXTURE_UNIT } from "./dattexture";
import {
  LAND_BLOCK_SIZE,
  MAP_SIZE,
  MAX_LAND_BLOCK_INDEX,
  OBJECT_Z_BIAS,
  mapXToLandBlock,
  mapYToLandBlock,
} from "./worldgeometry";
interface LoadedLandblock {
  x: number;
  y: number;
  buildings: IndexedPlacement[];
}

interface GpuBatch {
  buffer: WebGLBuffer;
  count: number;
  materialResourceId: number;
  material?: ObjectMaterial;
  materialError?: string;
}

interface GpuMesh {
  batches: GpuBatch[];
}

interface Building3DUniforms {
  xWorld: WebGLUniformLocation | null;
  cameraMode: WebGLUniformLocation | null;
  buildingTexture: WebGLUniformLocation | null;
  placementOrigin: WebGLUniformLocation | null;
  placementRotation: WebGLUniformLocation | null;
  diffuseAmount: WebGLUniformLocation | null;
  luminosity: WebGLUniformLocation | null;
  opacity: WebGLUniformLocation | null;
}

export class Building3DRenderer {
  loadDistance = 8;

  private program: WebGLProgram | null;
  private vao: WebGLVertexArrayObject | null;
  private uniforms: Building3DUniforms | null;
  private dats: AcDatClient;
  private landblocks = new Map<string, LoadedLandblock | null>();
  private pendingLandblocks = new Set<string>();
  private meshes = new Map<number, GpuMesh | null>();
  private pendingMeshes = new Set<number>();
  private hasBuildings: ((x: number, y: number) => boolean) | null = null;
  private loadStateChanged: (() => void) | null = null;
  private reportedBuildingFailures = new Set<string>();

  constructor(private gl: WebGL2RenderingContext) {
    const vertex = glhelpers.createShader(
      gl,
      gl.VERTEX_SHADER,
      Building3DVertSource,
    );
    const fragment = glhelpers.createShader(
      gl,
      gl.FRAGMENT_SHADER,
      Building3DFragSource,
    );
    this.program =
      vertex && fragment ? glhelpers.createProgram(gl, vertex, fragment) : null;
    this.uniforms = this.program
      ? {
          xWorld: gl.getUniformLocation(this.program, "xWorld"),
          cameraMode: gl.getUniformLocation(this.program, "cameraMode"),
          buildingTexture: gl.getUniformLocation(
            this.program,
            "buildingTexture",
          ),
          placementOrigin: gl.getUniformLocation(
            this.program,
            "placementOrigin",
          ),
          placementRotation: gl.getUniformLocation(
            this.program,
            "placementRotation",
          ),
          diffuseAmount: gl.getUniformLocation(this.program, "diffuseAmount"),
          luminosity: gl.getUniformLocation(this.program, "luminosity"),
          opacity: gl.getUniformLocation(this.program, "opacity"),
        }
      : null;
    this.vao = gl.createVertexArray();
    this.dats = new AcDatClient(gl);
  }

  isCloseEnough(
    camera: BaseCamera,
    mode: CameraMode,
    minimumZoom: number,
  ): boolean {
    return mode === CameraMode.Camera2D
      ? (camera as Camera2D).Zoom >= minimumZoom
      : true;
  }

  setLandblockFilter(hasBuildings: (x: number, y: number) => boolean): void {
    this.hasBuildings = hasBuildings;
  }

  setLoadStateChanged(handler: () => void): void {
    this.loadStateChanged = handler;
  }

  isBuildingLoaded(
    landblockX: number,
    landblockY: number,
    mapX: number,
    mapY: number,
  ): boolean {
    const matchDistance = LAND_BLOCK_SIZE * 0.75;
    for (const landblock of this.landblocks.values()) {
      if (!landblock) continue;
      for (const building of landblock.buildings) {
        const buildingMapX = landblock.x * LAND_BLOCK_SIZE + building.origin[0];
        const buildingMapY =
          MAP_SIZE - (landblock.y * LAND_BLOCK_SIZE + building.origin[1]);
        const mesh = this.meshes.get(building.modelIndex);
        if (
          Math.abs(buildingMapX - mapX) <= matchDistance &&
          Math.abs(buildingMapY - mapY) <= matchDistance &&
          !!mesh
        ) {
          return true;
        }
      }
    }
    return false;
  }

  clearCache(): Promise<void> {
    return this.dats.clearCache();
  }

  get apiRequestCount(): number {
    return this.dats.totalRequestCount;
  }

  render(
    camera: BaseCamera,
    mode: CameraMode,
    enabled: boolean,
    minimumZoom: number,
  ): void {
    if (
      !enabled ||
      !this.program ||
      !this.uniforms ||
      !this.vao ||
      !this.hasBuildings ||
      !this.isCloseEnough(camera, mode, minimumZoom)
    )
      return;
    const visible =
      mode === CameraMode.Camera2D
        ? this.visible2D(camera as Camera2D)
        : this.visible3D(camera as CameraFlying);
    const populated = visible.filter(([x, y]) => this.hasBuildings!(x, y));
    this.requestLandblocks(populated);

    const gl = this.gl;
    const previousProgram = gl.getParameter(
      gl.CURRENT_PROGRAM,
    ) as WebGLProgram | null;
    const previousVao = gl.getParameter(
      gl.VERTEX_ARRAY_BINDING,
    ) as WebGLVertexArrayObject | null;
    const previousArrayBuffer = gl.getParameter(
      gl.ARRAY_BUFFER_BINDING,
    ) as WebGLBuffer | null;
    const previousActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    const depthTestEnabled = gl.isEnabled(gl.DEPTH_TEST);
    const cullFaceEnabled = gl.isEnabled(gl.CULL_FACE);
    const blendEnabled = gl.isEnabled(gl.BLEND);
    const depthWriteEnabled = gl.getParameter(gl.DEPTH_WRITEMASK) as boolean;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(this.uniforms.xWorld, false, camera.Transform);
    gl.uniform1i(
      this.uniforms.cameraMode,
      mode === CameraMode.Camera2D ? 0 : 1,
    );
    gl.uniform1i(this.uniforms.buildingTexture, BUILDING_TEXTURE_UNIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    try {
      for (const [x, y] of populated) {
        const landblock = this.landblocks.get(`${x},${y}`);
        if (!landblock) continue;
        for (const building of landblock.buildings)
          this.drawBuilding(landblock, building);
      }
    } finally {
      gl.depthMask(depthWriteEnabled);
      depthTestEnabled ? gl.enable(gl.DEPTH_TEST) : gl.disable(gl.DEPTH_TEST);
      cullFaceEnabled ? gl.enable(gl.CULL_FACE) : gl.disable(gl.CULL_FACE);
      blendEnabled ? gl.enable(gl.BLEND) : gl.disable(gl.BLEND);
      gl.activeTexture(previousActiveTexture);
      gl.bindVertexArray(previousVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, previousArrayBuffer);
      gl.useProgram(previousProgram);
    }
  }

  private drawBuilding(
    landblock: LoadedLandblock,
    building: IndexedPlacement,
  ): void {
    const mesh = this.meshes.get(building.modelIndex);
    if (mesh === undefined) {
      this.requestMesh(building.modelIndex);
      return;
    }
    if (!mesh) {
      this.reportBuildingFailure(
        landblock,
        building,
        "model could not be loaded",
      );
      return;
    }
    if (mesh.batches.length === 0) {
      this.reportBuildingFailure(
        landblock,
        building,
        "model has no drawable mesh batches",
      );
      return;
    }
    const gl = this.gl;
    const uniforms = this.uniforms!;
    gl.uniform3f(
      uniforms.placementOrigin,
      landblock.x * LAND_BLOCK_SIZE + building.origin[0],
      landblock.y * LAND_BLOCK_SIZE + building.origin[1],
      building.origin[2] + OBJECT_Z_BIAS,
    );
    gl.uniform4f(uniforms.placementRotation, ...building.rotation);
    for (const batch of mesh.batches) {
      if (batch.count === 0) {
        this.reportBuildingFailure(
          landblock,
          building,
          "model contains an empty mesh batch",
        );
        continue;
      }
      if (batch.materialError) {
        this.reportBuildingFailure(landblock, building, batch.materialError);
        continue;
      }
      if (!batch.material) continue;
      gl.activeTexture(gl.TEXTURE0 + BUILDING_TEXTURE_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, batch.material.texture);
      gl.uniform1f(uniforms.diffuseAmount, batch.material.diffuse);
      gl.uniform1f(uniforms.luminosity, batch.material.luminosity);
      gl.uniform1f(uniforms.opacity, batch.material.opacity);
      if (batch.material.translucent) {
        gl.enable(gl.BLEND);
        gl.blendFunc(
          gl.SRC_ALPHA,
          batch.material.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA,
        );
        gl.depthMask(false);
      } else {
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 12);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 24);
      gl.enableVertexAttribArray(0);
      gl.enableVertexAttribArray(1);
      gl.enableVertexAttribArray(2);
      gl.drawArrays(gl.TRIANGLES, 0, batch.count);
    }
    gl.depthMask(true);
  }

  private requestLandblocks(visible: [number, number][]): void {
    const pending: [number, number][] = [];
    for (const [x, y] of visible) {
      const key = `${x},${y}`;
      if (this.landblocks.has(key) || this.pendingLandblocks.has(key)) continue;
      this.pendingLandblocks.add(key);
      pending.push([x, y]);
    }
    if (pending.length === 0) return;
    this.dats
      .loadVisible(visible)
      .then(() => {
        for (const [x, y] of pending) {
          const chunk = this.dats.chunk(x, y);
          this.landblocks.set(`${x},${y}`, {
            x,
            y,
            buildings: chunk ? this.dats.placementsForChunk(chunk, 0) : [],
          });
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        console.error("Unable to load ACTerrain building resources", error);
        for (const [x, y] of pending) this.landblocks.set(`${x},${y}`, null);
      })
      .finally(() => {
        for (const [x, y] of pending)
          this.pendingLandblocks.delete(`${x},${y}`);
        this.loadStateChanged?.();
      });
  }

  private requestMesh(modelIndex: number): void {
    if (this.pendingMeshes.has(modelIndex)) return;
    this.pendingMeshes.add(modelIndex);
    this.dats
      .mesh(modelIndex)
      .then((mesh) => {
        this.meshes.set(modelIndex, this.uploadMesh(mesh.batches));
      })
      .catch((error) => {
        console.error(
          `Unable to load ACTerrain building model index ${modelIndex}`,
          error,
        );
        this.meshes.set(modelIndex, null);
      })
      .finally(() => {
        this.pendingMeshes.delete(modelIndex);
        this.loadStateChanged?.();
      });
  }

  private uploadMesh(
    source: { materialResourceId: number; vertices?: Float32Array }[],
  ): GpuMesh {
    const batches: GpuBatch[] = source
      .filter((item) => item.vertices)
      .map((item) => {
        const vertices = item.vertices!;
        const buffer = this.gl.createBuffer()!;
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STATIC_DRAW);
        const batch: GpuBatch = {
          buffer,
          count: vertices.length / 8,
          materialResourceId: item.materialResourceId,
        };
        this.dats
          .material(item.materialResourceId)
          .then((material) => (batch.material = material))
          .catch((error) => {
            const message =
              error instanceof Error ? error.message : String(error);
            batch.materialError = `material ${item.materialResourceId} could not be loaded: ${message}`;
          })
          .finally(() => this.loadStateChanged?.());
        return batch;
      });
    return { batches };
  }

  private reportBuildingFailure(
    landblock: LoadedLandblock,
    building: IndexedPlacement,
    reason: string,
  ): void {
    const key = `${landblock.x},${landblock.y}:${building.modelIndex}:${reason}`;
    if (this.reportedBuildingFailures.has(key)) return;
    this.reportedBuildingFailures.add(key);
    console.error(
      `Unable to render building model index ${building.modelIndex} ` +
        `in landblock ${landblock.x.toString(16).padStart(2, "0")}${landblock.y.toString(16).padStart(2, "0")}: ${reason}`,
    );
  }

  private visible2D(camera: Camera2D): [number, number][] {
    const topLeft = camera.ScreenToWorld(new Vector3(0, 0, 1));
    const bottomRight = camera.ScreenToWorld(
      new Vector3(camera.ViewportSize.x, camera.ViewportSize.y, 1),
    );
    const minX = Math.max(
      0,
      Math.floor(Math.min(topLeft.x, bottomRight.x) / LAND_BLOCK_SIZE),
    );
    const maxX = Math.min(
      MAX_LAND_BLOCK_INDEX,
      Math.floor(Math.max(topLeft.x, bottomRight.x) / LAND_BLOCK_SIZE),
    );
    const minY = Math.max(
      0,
      Math.floor(
        (MAP_SIZE - Math.max(topLeft.y, bottomRight.y)) / LAND_BLOCK_SIZE,
      ),
    );
    const maxY = Math.min(
      MAX_LAND_BLOCK_INDEX,
      Math.floor(
        (MAP_SIZE - Math.min(topLeft.y, bottomRight.y)) / LAND_BLOCK_SIZE,
      ),
    );
    return this.range(minX, maxX, minY, maxY);
  }

  private visible3D(camera: CameraFlying): [number, number][] {
    const positions = [camera.Position, camera.GetMapPosition()];
    const visible = new Map<string, [number, number]>();
    for (const position of positions) {
      const centerX = mapXToLandBlock(position.x);
      const centerY = mapYToLandBlock(position.y);
      for (const landblock of this.range(
        Math.max(0, centerX - this.loadDistance),
        Math.min(MAX_LAND_BLOCK_INDEX, centerX + this.loadDistance),
        Math.max(0, centerY - this.loadDistance),
        Math.min(MAX_LAND_BLOCK_INDEX, centerY + this.loadDistance),
      )) {
        visible.set(`${landblock[0]},${landblock[1]}`, landblock);
      }
    }
    return [...visible.values()];
  }

  private range(
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
  ): [number, number][] {
    const result: [number, number][] = [];
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) result.push([x, y]);
    return result;
  }
}
