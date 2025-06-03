export const TerrainVertSource = `#version 300 es

precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;

uniform sampler2D terrainData;
uniform mat4 xWorld; // Combined transformation matrix (CameraFlying.Transform or Camera2D.Transform)
uniform vec4 renderView; // Used for 2D camera landblock culling
uniform float heightTable[255];
uniform vec4 someColor;
uniform int cameraMode; // 0 for Camera2D, 1 for CameraFlying

out vec3 pos;   // Normalized position (0 to 1, for texture lookup)
out vec3 wpos;  // World-space position
out vec4 color;

const int sideCount = 8;
const int numVertsPerCell = 6;
const float cellSize = 24.0;
const float maxHeight = 700.0;
const float mapSize = 255.0 * 192.0; // Total map size

float getHeight(vec2 pos) {
  int heightIdx = int(texelFetch(terrainData, ivec2(pos.xy * 255. * 8.), 0).r * 255.);
  return heightTable[heightIdx] / maxHeight;
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
    // CameraFlying: Assume full 255x255 grid
    int lbid = gl_InstanceID;
    lbx = lbid % 255;
    lby = lbid / 255;
  }

  // Add landblock offsets
  cellX = cellX + (float(lbx) * 192.0);
  cellY = mapSize - (cellY + cellSize + (float(lby) * 192.0)); // Flip Y to match original orientation

  // Triangle splitting logic
  uint seedA = uint((lbx * 8 + cellIdxD) * 214614067);
  uint seedB = uint((lbx * 8 + cellIdxD) * 1109124029);
  uint magicA = seedA + 1813693831u;
  uint magicB = seedB;
  float splitDir = float(uint(lby * 8 + cellIdyD) * magicA - magicB - 1369149221u);
  float split = step(splitDir * 0.00000000023283064, 0.5);
  int vIdm = gl_VertexID % 6;

  // Vertex position based on split direction
  vec2 v = vec2(0.0, 0.0);
  if (splitDir * 2.3283064e-10 >= 0.5) {
    if (vIdm == 0) {
      v = vec2(cellX, cellY);
    } else if (vIdm == 1) {
      v = vec2(cellX + cellSize, cellY);
    } else if (vIdm == 2) {
      v = vec2(cellX, cellY + cellSize);
    } else if (vIdm == 3) {
      v = vec2(cellX + cellSize, cellY + cellSize);
    } else if (vIdm == 4) {
      v = vec2(cellX, cellY + cellSize);
    } else if (vIdm == 5) {
      v = vec2(cellX + cellSize, cellY);
    }
  } else {
    if (vIdm == 0) {
      v = vec2(cellX, cellY);
    } else if (vIdm == 1) {
      v = vec2(cellX + cellSize, cellY);
    } else if (vIdm == 2) {
      v = vec2(cellX + cellSize, cellY + cellSize);
    } else if (vIdm == 3) {
      v = vec2(cellX, cellY);
    } else if (vIdm == 4) {
      v = vec2(cellX + cellSize, cellY + cellSize);
    } else if (vIdm == 5) {
      v = vec2(cellX, cellY + cellSize);
    }
  }

  // Calculate height and positions
  vec2 xy = v / mapSize; // Normalize for texture lookup
  float h = getHeight(xy);
  pos = vec3(xy, h); // Normalized position for fragment shader

  // World-space position: adjust for 2D or 3D
  if (cameraMode == 0) {
    // Camera2D: Z is 0, height is not scaled
    wpos = vec3(v.x, v.y, h * maxHeight);
    gl_Position = xWorld * vec4(v.x, v.y, h * maxHeight, 1.0);
  } else {
    // CameraFlying: Y is height, Z is former Y
    wpos = vec3(v.x, h * maxHeight, v.y);
    gl_Position = xWorld * vec4(v.x, h * maxHeight, v.y, 1.0);
  }
}
`;