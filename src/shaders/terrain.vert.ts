import {
  LAND_BLOCK_SIDE,
  LAND_BLOCK_SIZE,
  MAP_SIZE,
  MAX_TERRAIN_HEIGHT,
  TERRAIN_CELLS_PER_LAND_BLOCK,
  TERRAIN_CELL_SIZE,
  TERRAIN_DATA_SIDE
} from '../lib/worldgeometry'
import { terrainHeightTable } from '../data/heighttable'

export const TerrainVertSource = `#version 300 es

precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;

layout(location = 0) in vec2 terrainLandblock;

uniform sampler2D terrainData;
uniform mat4 xWorld; // Combined transformation matrix (CameraFlying.Transform or Camera2D.Transform)
uniform vec4 renderView; // Used for 2D camera landblock culling
uniform float heightTable[${terrainHeightTable.length}];
uniform vec4 someColor;
uniform int cameraMode; // 0 for Camera2D, 1 for CameraFlying

out vec3 pos;   // Normalized position (0 to 1, for texture lookup)
out vec3 wpos;  // World-space position
out vec4 color;
out vec2 cellUV; // local cell UV
flat out float triangleShade;
flat out ivec2 terrainCell; // Lower-left terrain-data vertex for this cell
flat out uint paletteCode;
flat out int baseTerrainCode;

const int sideCount = ${TERRAIN_CELLS_PER_LAND_BLOCK};
const int numVertsPerCell = 6;
const float cellSize = ${TERRAIN_CELL_SIZE.toFixed(1)};
const float maxHeight = ${MAX_TERRAIN_HEIGHT.toFixed(1)};
const float mapSize = ${MAP_SIZE.toFixed(1)};

float getHeight(vec2 pos) {
  int heightIdx = clamp(int(round(texelFetch(terrainData, ivec2(pos.xy * ${LAND_BLOCK_SIDE.toFixed(1)} *
    ${TERRAIN_CELLS_PER_LAND_BLOCK.toFixed(1)}), 0).r * 255.0)), 0, ${terrainHeightTable.length - 1});
  return heightTable[heightIdx] / maxHeight;
}

uint getPalCode(int r1, int r2, int r3, int r4, int t1, int t2, int t3, int t4) {
  int terrainBits = (t1 << 15) | (t2 << 10) | (t3 << 5) | t4;
  int roadBits = (r1 << 26) | (r2 << 24) | (r3 << 22) | (r4 << 20);
  return uint((1 << 28) | roadBits | terrainBits);
}

float getTriangleShade(vec2 p0, vec2 p1, vec2 p2) {
  vec3 v0 = vec3(p0, getHeight(p0 / mapSize) * maxHeight);
  vec3 v1 = vec3(p1, getHeight(p1 / mapSize) * maxHeight);
  vec3 v2 = vec3(p2, getHeight(p2 / mapSize) * maxHeight);
  vec3 normal = normalize(cross(v1 - v0, v2 - v0));

  if (normal.z < 0.0) {
    normal = -normal;
  }

  vec3 lightDirection = normalize(vec3(-0.45, 0.55, 0.85));
  float diffuse = max(dot(normal, lightDirection), 0.0);
  return mix(0.72, 1.12, diffuse);
}

void main() {
  color = someColor;

  // Calculate vertex index and instance ID
  int numVertsPerBlock = sideCount * sideCount * numVertsPerCell;
  int cellIdx = (gl_VertexID % numVertsPerBlock) / numVertsPerCell;
  int cellIdxD = cellIdx / sideCount;
  int cellIdyD = cellIdx % sideCount;

  // Calculate cell position
  float cellX = float(cellIdxD) * cellSize;
  float cellY = float(cellIdyD) * cellSize;

  // Landblock position
  int lbx, lby;
  if (cameraMode == 0) {
    // Camera2D: Use renderView for landblock culling
    int numLandblocksX = int(renderView.z);
    int numLandblocksY = int(renderView.w);
    int lbid = gl_InstanceID;
    lbx = (lbid % numLandblocksX) + int(renderView.x);
    lby = ((lbid / numLandblocksX) + int(renderView.y));
  } else {
    // CameraFlying: use the CPU-generated visible landblock list.
    lbx = int(terrainLandblock.x + 0.5);
    lby = int(terrainLandblock.y + 0.5);
  }

  // Add landblock offsets
  cellX = cellX + (float(lbx) * ${LAND_BLOCK_SIZE.toFixed(1)});
  cellY = mapSize - (cellY + cellSize + (float(lby) * ${LAND_BLOCK_SIZE.toFixed(1)}));

  uint globalCellX = uint(lbx * sideCount + cellIdxD);
  uint globalCellY = uint(lby * sideCount + cellIdyD);
  uint splitDir = globalCellX * globalCellY * 0x0CCAC033u
      - globalCellX * 0x421BE3BDu
      + globalCellY * 0x6C1AC587u
      - 0x519B8F25u;

  bool useSwToNeCut = (splitDir & 0x80000000u) != 0u;
  int vIdm = gl_VertexID % 6;

  vec2 triangle0;
  vec2 triangle1;
  vec2 triangle2;
  if (useSwToNeCut) {
    if (vIdm < 3) {
      triangle0 = vec2(cellX, cellY);
      triangle1 = vec2(cellX + cellSize, cellY);
      triangle2 = vec2(cellX, cellY + cellSize);
    } else {
      triangle0 = vec2(cellX + cellSize, cellY + cellSize);
      triangle1 = vec2(cellX, cellY + cellSize);
      triangle2 = vec2(cellX + cellSize, cellY);
    }
  } else {
    if (vIdm < 3) {
      triangle0 = vec2(cellX, cellY);
      triangle1 = vec2(cellX + cellSize, cellY);
      triangle2 = vec2(cellX + cellSize, cellY + cellSize);
    } else {
      triangle0 = vec2(cellX, cellY);
      triangle1 = vec2(cellX + cellSize, cellY + cellSize);
      triangle2 = vec2(cellX, cellY + cellSize);
    }
  }
  triangleShade = getTriangleShade(triangle0, triangle1, triangle2);

  vec2 v = vec2(0.0, 0.0);
  vec2 uv = vec2(0.0, 0.0);
  if (useSwToNeCut) {
    if (vIdm == 0) {
      v = vec2(cellX, cellY);
      uv = vec2(0.0, 0.0);
    } else if (vIdm == 1) {
      v = vec2(cellX + cellSize, cellY);
      uv = vec2(1.0, 0.0);
    } else if (vIdm == 2) {
      v = vec2(cellX, cellY + cellSize);
      uv = vec2(0.0, 1.0);
    } else if (vIdm == 3) {
      v = vec2(cellX + cellSize, cellY + cellSize);
      uv = vec2(1.0, 1.0);
    } else if (vIdm == 4) {
      v = vec2(cellX, cellY + cellSize);
      uv = vec2(0.0, 1.0);
    } else if (vIdm == 5) {
      v = vec2(cellX + cellSize, cellY);
      uv = vec2(1.0, 0.0);
    }
  } else {
    if (vIdm == 0) {
      v = vec2(cellX, cellY);
      uv = vec2(0.0, 0.0);
    } else if (vIdm == 1) {
      v = vec2(cellX + cellSize, cellY);
      uv = vec2(1.0, 0.0);
    } else if (vIdm == 2) {
      v = vec2(cellX + cellSize, cellY + cellSize);
      uv = vec2(1.0, 1.0);
    } else if (vIdm == 3) {
      v = vec2(cellX, cellY);
      uv = vec2(0.0, 0.0);
    } else if (vIdm == 4) {
      v = vec2(cellX + cellSize, cellY + cellSize);
      uv = vec2(1.0, 1.0);
    } else if (vIdm == 5) {
      v = vec2(cellX, cellY + cellSize);
      uv = vec2(0.0, 1.0);
    }
  }

  // Calculate height and positions
  vec2 xy = v / mapSize; // Normalize for texture lookup
  float h = getHeight(xy);
  pos = vec3(xy, h); // Normalized position for fragment shader
  cellUV = uv;
  terrainCell = ivec2(lbx * sideCount + cellIdxD,
      ${TERRAIN_DATA_SIDE - 1} - (lby * sideCount + cellIdyD + 1));

  vec4 p1 = texelFetch(terrainData, terrainCell + ivec2(0, 1), 0);
  vec4 p2 = texelFetch(terrainData, terrainCell + ivec2(1, 1), 0);
  vec4 p3 = texelFetch(terrainData, terrainCell + ivec2(1, 0), 0);
  vec4 p4 = texelFetch(terrainData, terrainCell + ivec2(0, 0), 0);
  paletteCode = getPalCode(
      int(p1.b * 255.0), int(p2.b * 255.0), int(p3.b * 255.0), int(p4.b * 255.0),
      int(p1.g * 255.0), int(p2.g * 255.0), int(p3.g * 255.0), int(p4.g * 255.0));
  baseTerrainCode = int(p1.g * 255.0);

  // World-space position: adjust for 2D or 3D
  if (cameraMode == 0) {
    // Put the map inside the camera's negative-Z clip range while preserving
    // AC's ordering, where larger elevations are closer to the viewer.
    wpos = vec3(v.x, v.y, h * maxHeight);
    gl_Position = xWorld * vec4(v.x, v.y, h * maxHeight, 1.0);
  } else {
    // Flying world space follows AC: map X/Y with elevation on Z.
    wpos = vec3(v.x, v.y, h * maxHeight);
    gl_Position = xWorld * vec4(wpos, 1.0);
  }
}
`;
