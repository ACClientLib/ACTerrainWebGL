import {
  LAND_BLOCK_SIDE,
  LAND_BLOCK_SIZE,
  MAP_SIZE,
  TERRAIN_CELLS_PER_LAND_BLOCK,
  TERRAIN_CELL_SIZE,
  TERRAIN_DATA_SIDE,
} from "../lib/worldgeometry";
import { TerrainPaletteSource } from "./terrainpalette";

export const TerrainVertSource = `#version 300 es

precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;

layout(location = 0) in vec2 terrainLandblock;

uniform sampler2D terrainData;
uniform mat4 xWorld; // Combined transformation matrix (CameraFlying.Transform or Camera2D.Transform)
uniform vec4 renderView; // Used for 2D camera landblock culling
uniform float heightTable[256];
uniform float maxTerrainHeight;
uniform vec4 someColor;
uniform int cameraMode; // 0 for Camera2D, 1 for CameraFlying
uniform float scale;
uniform float minZoomForTextures;
uniform vec3 lightDirection;
uniform vec3 sunlightColor;
uniform vec3 ambientColor;
uniform int cornerMaskCount;
uniform int sideMaskCount;
uniform int roadMaskCount;
uniform int cornerMaskCodes[32];
uniform int sideMaskCodes[32];
uniform int roadMaskCodes[32];
uniform int cornerMaskLayers[32];
uniform int sideMaskLayers[32];
uniform int roadMaskLayers[32];

out vec3 pos;   // Normalized position (0 to 1, for texture lookup)
out vec3 wpos;  // World-space position
out vec4 color;
out vec2 cellUV; // local cell UV
flat out vec3 triangleShade;
flat out ivec2 terrainCell; // Lower-left terrain-data vertex for this cell
flat out ivec2 terrainCellIndex; // Global terrain cell index
flat out uint paletteCode;
flat out int baseTerrainCode;
flat out ivec4 terrainLayers;
flat out ivec3 terrainAlphaLayers;
flat out ivec3 terrainAlphaRotations;
flat out ivec4 roadAlpha;
flat out int allRoadCell;
flat out int terrainBlendMissing;
flat out int terrainMissingTCode;

const int sideCount = ${TERRAIN_CELLS_PER_LAND_BLOCK};
const int numVertsPerCell = 6;
const float cellSize = ${TERRAIN_CELL_SIZE.toFixed(1)};
const float mapSize = ${MAP_SIZE.toFixed(1)};

float sampleHeight(vec4 terrainSample) {
  int heightIdx = clamp(int(round(terrainSample.r * 255.0)), 0, 255);
  return heightTable[heightIdx] / maxTerrainHeight;
}

${TerrainPaletteSource}

ivec3 getRoadCode(uint pcode) {
  ivec3 rcode = ivec3(0);
  int mask = 0;
  if ((pcode & 0xC000000u) != 0u) mask |= 1;
  if ((pcode & 0x3000000u) != 0u) mask |= 2;
  if ((pcode & 0xC00000u) != 0u) mask |= 4;
  if ((pcode & 0x300000u) != 0u) mask |= 8;
  switch (mask) {
    case 0xF: rcode.z = 1; break;
    case 0xE: rcode.xy = ivec2(6, 12); break;
    case 0xD: rcode.xy = ivec2(9, 12); break;
    case 0xB: rcode.xy = ivec2(9, 3); break;
    case 0x7: rcode.xy = ivec2(3, 6); break;
    case 0x0: break;
    default: rcode.x = mask; break;
  }
  return rcode;
}

ivec4 getTerrainCodes(uint pcode) {
  return ivec4(
      (pcode >> 15) & 0x1Fu,
      (pcode >> 10) & 0x1Fu,
      (pcode >> 5) & 0x1Fu,
      pcode & 0x1Fu);
}

ivec3 buildTCodes(ivec4 pcodes, int i) {
  ivec3 tcodes = ivec3(0);
  int t1 = pcodes[i];
  int t2 = 0;
  for (int k = 0; k < 4; k++) {
    if (t1 == pcodes[k]) continue;
    if (tcodes[0] == 0) {
      tcodes[0] = 1 << k;
      t2 = pcodes[k];
    } else {
      if (t2 == pcodes[k] && tcodes[0] == (1 << (k - 1))) {
        tcodes[0] += 1 << k;
      } else {
        tcodes[1] = 1 << k;
      }
      break;
    }
  }
  return tcodes;
}

uint highMultiplySmall(uint value, uint count) {
  return (((value >> 16) * count + (((value & 0xffffu) * count) >> 16)) >> 16);
}

ivec2 getTerrainAlpha(uint pcode, int tcode) {
  bool side = tcode != 1 && tcode != 2 && tcode != 4 && tcode != 8;
  int count = side ? sideMaskCount : cornerMaskCount;
  if (count <= 0) return ivec2(0, -1);
  uint random = 1379576222u * pcode - 1372186442u;
  int selected = int(highMultiplySmall(random, uint(count)));
  int alphaCode = side ? sideMaskCodes[selected] : cornerMaskCodes[selected];
  int alphaLayer = side ? sideMaskLayers[selected] : cornerMaskLayers[selected];
  for (int rotation = 0; rotation < 4; rotation++) {
    if (alphaCode == tcode) return ivec2(rotation, alphaLayer);
    alphaCode *= 2;
    if (alphaCode >= 16) alphaCode -= 15;
  }
  return ivec2(0, -1);
}

ivec2 getRoadAlpha(uint pcode, int rcode) {
  if (roadMaskCount <= 0) return ivec2(0, -1);
  uint random = 1379576222u * pcode - 1372186442u;
  int prng = int(highMultiplySmall(random, uint(roadMaskCount)));
  for (int i = 0; i < 32; i++) {
    if (i >= roadMaskCount) break;
    int idx = (i + prng) % roadMaskCount;
    int alphaCode = roadMaskCodes[idx];
    for (int rotation = 0; rotation < 4; rotation++) {
      if (alphaCode == rcode) {
        return ivec2(rotation, roadMaskLayers[idx]);
      }
      alphaCode *= 2;
      if (alphaCode >= 16) alphaCode -= 15;
    }
  }
  return ivec2(0, -1);
}

void resolveTerrainMaterial(uint pcode) {
  ivec4 terrainCodes = getTerrainCodes(pcode);
  ivec3 tcodes = ivec3(0);
  terrainLayers = ivec4(0);

  int duplicate = -1;
  for (int i = 0; i < 4 && duplicate < 0; i++) {
    for (int j = i + 1; j < 4; j++) {
      if (terrainCodes[i] == terrainCodes[j]) {
        duplicate = i;
        break;
      }
    }
  }

  if (duplicate < 0) {
    tcodes = ivec3(2, 4, 8);
    terrainLayers = terrainCodes;
  } else {
    // Match ACViewer's BuildTCodes exactly. In particular, repeated
    // non-base terrain codes are not always merged: alternating patterns
    // such as A,B,A,B become two separate masks (2 and 8), not mask 10.
    terrainLayers[0] = terrainCodes[duplicate];
    int t2 = 0;
    for (int k = 0; k < 4; k++) {
      if (terrainLayers[0] == terrainCodes[k]) continue;
      if (tcodes[0] == 0) {
        tcodes[0] = 1 << k;
        t2 = terrainCodes[k];
        terrainLayers[1] = t2;
      } else {
        if (t2 == terrainCodes[k] && tcodes[0] == (1 << (k - 1))) {
          tcodes[0] += 1 << k;
        } else {
          tcodes[1] = 1 << k;
          terrainLayers[2] = terrainCodes[k];
        }
        break;
      }
    }
  }

  ivec2 alpha0 = tcodes.x > 0
      ? getTerrainAlpha(pcode, tcodes.x)
      : ivec2(0, -1);
  ivec2 alpha1 = tcodes.y > 0
      ? getTerrainAlpha(pcode, tcodes.y)
      : ivec2(0, -1);
  ivec2 alpha2 = tcodes.z > 0
      ? getTerrainAlpha(pcode, tcodes.z)
      : ivec2(0, -1);
  terrainAlphaRotations = ivec3(alpha0.x, alpha1.x, alpha2.x);
  terrainAlphaLayers = ivec3(alpha0.y, alpha1.y, alpha2.y);
  terrainBlendMissing = 0;
  terrainMissingTCode = 0;
  if ((tcodes.x > 0 && alpha0.y < 0) ||
      (tcodes.y > 0 && alpha1.y < 0) ||
      (tcodes.z > 0 && alpha2.y < 0)) {
    terrainBlendMissing = 1;
    if (tcodes.x > 0 && alpha0.y < 0) terrainMissingTCode = tcodes.x;
    else if (tcodes.y > 0 && alpha1.y < 0) terrainMissingTCode = tcodes.y;
    else terrainMissingTCode = tcodes.z;
  }

  ivec3 roadCode = getRoadCode(pcode);
  allRoadCell = roadCode.z;
  ivec2 road0 = roadCode.x > 0
      ? getRoadAlpha(pcode, roadCode.x)
      : ivec2(0, -1);
  ivec2 road1 = roadCode.y > 0
      ? getRoadAlpha(pcode, roadCode.y)
      : ivec2(0, -1);
  roadAlpha = ivec4(road0.x, road0.y, road1.x, road1.y);
  if ((roadCode.x > 0 && road0.y < 0) ||
      (roadCode.y > 0 && road1.y < 0)) {
    terrainBlendMissing = terrainBlendMissing == 0 ? 2 : 3;
  }
}

vec3 getTriangleShade(
    vec2 p0,
    vec2 p1,
    vec2 p2,
    float h0,
    float h1,
    float h2) {
  vec3 v0 = vec3(p0, h0 * maxTerrainHeight);
  vec3 v1 = vec3(p1, h1 * maxTerrainHeight);
  vec3 v2 = vec3(p2, h2 * maxTerrainHeight);
  vec3 normal = normalize(cross(v1 - v0, v2 - v0));

  if (normal.z < 0.0) {
    normal = -normal;
  }

  // lightDirection describes the direction light travels. Lighting is
  // evaluated against the direction from the surface toward the light.
  float diffuse = max(dot(normal, -normalize(lightDirection)), 0.0);
  return clamp(
      ambientColor + sunlightColor * mix(0.0, 1.0, diffuse),
      vec3(0.0),
      vec3(1.0));
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

  terrainCell = ivec2(lbx * sideCount + cellIdxD,
      ${TERRAIN_DATA_SIDE - 1} - (lby * sideCount + cellIdyD + 1));
  terrainCellIndex = ivec2(globalCellX, globalCellY);
  vec4 p1 = texelFetch(terrainData, terrainCell + ivec2(0, 1), 0);
  vec4 p2 = texelFetch(terrainData, terrainCell + ivec2(1, 1), 0);
  vec4 p3 = texelFetch(terrainData, terrainCell + ivec2(1, 0), 0);
  vec4 p4 = texelFetch(terrainData, terrainCell + ivec2(0, 0), 0);
  float h00 = sampleHeight(p4);
  float h10 = sampleHeight(p3);
  float h11 = sampleHeight(p2);
  float h01 = sampleHeight(p1);

  vec2 triangle0;
  vec2 triangle1;
  vec2 triangle2;
  if (useSwToNeCut) {
    if (vIdm < 3) {
      triangle0 = vec2(cellX, cellY);
      triangle1 = vec2(cellX + cellSize, cellY);
      triangle2 = vec2(cellX, cellY + cellSize);
      triangleShade = getTriangleShade(
          triangle0, triangle1, triangle2, h00, h10, h01);
    } else {
      triangle0 = vec2(cellX + cellSize, cellY + cellSize);
      triangle1 = vec2(cellX, cellY + cellSize);
      triangle2 = vec2(cellX + cellSize, cellY);
      triangleShade = getTriangleShade(
          triangle0, triangle1, triangle2, h11, h01, h10);
    }
  } else {
    if (vIdm < 3) {
      triangle0 = vec2(cellX, cellY);
      triangle1 = vec2(cellX + cellSize, cellY);
      triangle2 = vec2(cellX + cellSize, cellY + cellSize);
      triangleShade = getTriangleShade(
          triangle0, triangle1, triangle2, h00, h10, h11);
    } else {
      triangle0 = vec2(cellX, cellY);
      triangle1 = vec2(cellX + cellSize, cellY + cellSize);
      triangle2 = vec2(cellX, cellY + cellSize);
      triangleShade = getTriangleShade(
          triangle0, triangle1, triangle2, h00, h11, h01);
    }
  }

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
  float h = uv.x < 0.5
      ? (uv.y < 0.5 ? h00 : h01)
      : (uv.y < 0.5 ? h10 : h11);
  pos = vec3(xy, h); // Normalized position for fragment shader
  cellUV = uv;
  paletteCode = makeTerrainPalette(
      int(p1.b * 255.0), int(p2.b * 255.0), int(p3.b * 255.0), int(p4.b * 255.0),
      int(p1.g * 255.0), int(p2.g * 255.0), int(p3.g * 255.0), int(p4.g * 255.0));
  baseTerrainCode = int(p1.g * 255.0);
  if (cameraMode != 0 || scale > minZoomForTextures) {
    resolveTerrainMaterial(paletteCode);
  } else {
    terrainLayers = ivec4(0);
    terrainAlphaLayers = ivec3(-1);
    terrainAlphaRotations = ivec3(0);
    roadAlpha = ivec4(-1);
    allRoadCell = 0;
    terrainBlendMissing = 0;
    terrainMissingTCode = 0;
  }

  // World-space position: adjust for 2D or 3D
  if (cameraMode == 0) {
    // Put the map inside the camera's negative-Z clip range while preserving
    // AC's ordering, where larger elevations are closer to the viewer.
    wpos = vec3(v.x, v.y, h * maxTerrainHeight);
    gl_Position = xWorld * vec4(v.x, v.y, h * maxTerrainHeight, 1.0);
  } else {
    // Flying world space uses the same map X/Y convention as the 2D view.
    wpos = vec3(v.x, v.y, h * maxTerrainHeight);
    gl_Position = xWorld * vec4(wpos, 1.0);
  }
}
`;
