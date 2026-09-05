import {
  LAND_BLOCK_SIZE,
  TERRAIN_DATA_SIDE,
} from "../lib/worldgeometry";

export const TerrainFragSource = `#version 300 es

precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;

const int roadTextureIdx = 32;
const float dataWidth = ${TERRAIN_DATA_SIDE.toFixed(1)};

// Array indicating loaded terrain textures (0 = not loaded, 1 = loaded)
uniform float hasTerrainTexture[32];

// Terrain color lookup
uniform vec3 terrainColors[32];

// Minimum zoom level for texture rendering
uniform float minZoomForTextures;
uniform int terrainGridEnabled;

// Terrain data texture (stores height, terrain, road, scenery)
// RGBA: height (r), terrain type (g, 0-31), road code (b, 0-3), scenery (a)
uniform sampler2D terrainData;

// Texture atlas for terrain and road textures (indices 0-31, 32 = road)
uniform sampler2DArray terrainAtlas;

// Texture atlas for alpha overlays (indices 0-3 corner, 4 side, 5-7 road)
uniform sampler2DArray alphaAtlas;
uniform float terrainTiling[33];
uniform int cornerMaskCount;
uniform int sideMaskCount;
uniform int roadMaskCount;
uniform int cornerMaskCodes[32];
uniform int sideMaskCodes[32];
uniform int roadMaskCodes[32];
uniform int cornerMaskLayers[32];
uniform int sideMaskLayers[32];
uniform int roadMaskLayers[32];

// Current drawing scale
uniform float scale;
uniform int cameraMode; // 0 for Camera2D, 1 for CameraFlying
uniform vec3 cameraPosition;
uniform vec3 fogColor;
uniform float fogStart;
uniform float fogEnd;
uniform int fogEnabled;

in vec3 pos;  // Map coordinates (0.0-1.0, x right, y up)
in vec3 wpos; // World-space position
in vec2 cellUV; // local cell UV
flat in vec3 triangleShade;
flat in ivec2 terrainCell; // Lower-left terrain-data vertex for this cell
flat in ivec2 terrainCellIndex; // Global terrain cell index
  flat in uint paletteCode;
  flat in int baseTerrainCode;
  flat in ivec4 terrainLayers;
  flat in ivec3 terrainAlphaLayers;
flat in ivec3 terrainAlphaRotations;
flat in ivec4 roadAlpha;
flat in int allRoadCell;
flat in int terrainBlendMissing;
flat in int terrainMissingTCode;

out vec4 FragColor;

struct BaseData {
    vec3 TexUV;  // UV (xy) and texture index (z)
};

struct TerrainData {
    vec4 Overlay0;  // UV (xy), texture index (z), alpha index (w)
    vec4 Overlay1;
    vec4 Overlay2;
};

struct RoadData {
    vec4 Road0;  // UV (xy), texture index (z), alpha index (w)
    vec4 Road1;
};

vec3 saturate(vec3 value) {
    return clamp(value, 0.0, 1.0);
}

uint getPalCode(int r1, int r2, int r3, int r4, int t1, int t2, int t3, int t4) {
    int terrainBits = (t1 << 15) | (t2 << 10) | (t3 << 5) | t4;
    int roadBits = (r1 << 26) | (r2 << 24) | (r3 << 22) | (r4 << 20);
    int sizeBits = 1 << 28;
    return uint(sizeBits | roadBits | terrainBits);
}

ivec3 getRoadCode(uint pcode) {
    ivec3 rcode = ivec3(0, 0, 0);
    int mask = 0;

    if ((pcode & 0xC000000u) != 0u) mask |= 1;  // SouthWest
    if ((pcode & 0x3000000u) != 0u) mask |= 2;  // SouthEast
    if ((pcode & 0xC00000u) != 0u) mask |= 4;   // NorthEast
    if ((pcode & 0x300000u) != 0u) mask |= 8;   // NorthWest

    switch (mask) {
        case 0xF:  // All corners
            rcode.z = 1;
            break;
        case 0xE:  // 1 + 2 + 3
            rcode.x = 6;
            rcode.y = 12;
            break;
        case 0xD:  // 0 + 2 + 3
            rcode.x = 9;
            rcode.y = 12;
            break;
        case 0xB:  // 0 + 1 + 3
            rcode.x = 9;
            rcode.y = 3;
            break;
        case 0x7:  // 0 + 1 + 2
            rcode.x = 3;
            rcode.y = 6;
            break;
        case 0x0:
            break;
        default:
            rcode.x = mask;
            break;
    }
    return rcode;
}

ivec4 getTerrainCodes(uint pcode) {
    return ivec4((pcode >> 15) & 0x1Fu, (pcode >> 10) & 0x1Fu, (pcode >> 5) & 0x1Fu, pcode & 0x1Fu);
}

ivec3 buildTCodes(ivec4 pcodes, ivec3 tcodes, int i) {
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

ivec3 getTCodes(uint pcode) {
    ivec3 tcodes = ivec3(0, 0, 0);
    ivec4 pcodes = getTerrainCodes(pcode);

    for (int i = 0; i < 4; i++) {
        for (int j = i + 1; j < 4; j++) {
            if (pcodes[i] == pcodes[j]) {
                return buildTCodes(pcodes, tcodes, i);
            }
        }
    }

    for (int i = 0; i < 3; i++) {
        tcodes[i] = (1 << (i + 1));
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
    int alphaIdx = side ? sideMaskLayers[selected] : cornerMaskLayers[selected];
    int rot = 0;

    while (alphaCode != tcode) {
        alphaCode *= 2;
        if (alphaCode >= 16) alphaCode -= 15;
        if (++rot >= 4) {
            return ivec2(0, -1);
        }
    }
    return ivec2(rot, alphaIdx);
}

ivec2 getRoadAlpha(uint pcode, int rcode) {
    if (roadMaskCount <= 0) return ivec2(0, -1);
    uint random = 1379576222u * pcode - 1372186442u;
    int prng = int(highMultiplySmall(random, uint(roadMaskCount)));
    int rot = 0;
    int alphaIdx = -1;

    for (int i = 0; i < 32; i++) {
        if (i >= roadMaskCount) break;
        int idx = (i + prng) % roadMaskCount;
        rot = 0;
        int alphaCode = roadMaskCodes[idx];
        alphaIdx = roadMaskLayers[idx];

        for (int j = 0; j < 4; j++) {
            if (alphaCode == rcode) {
                return ivec2(j, alphaIdx);
            }
            alphaCode *= 2;
            if (alphaCode >= 16) alphaCode -= 15;
        }
    }
    return ivec2(0, -1);
}

vec2 getRot(int rot, vec2 cPos) {
    if (rot == 1) return vec2(1.0 - cPos.y, cPos.x); // 90 degrees clockwise
    if (rot == 2) return vec2(1.0 - cPos.x, 1.0 - cPos.y); // 180 degrees
    if (rot == 3) return vec2(cPos.y, 1.0 - cPos.x); // 270 degrees clockwise
    return cPos; // 0 degrees
}

vec4 maskBlend3(vec4 t0, vec4 t1, vec4 t2, float h0, float h1, float h2) {
    float a0 = h0 == 0. ? 1. : t0.a;
    float a1 = h1 == 0. ? 1. : t1.a;
    float a2 = h2 == 0. ? 1. : t2.a;
    float aR = 1. - (a0 * a1 * a2);

    a0 = 1. - a0;
    a1 = 1. - a1;
    a2 = 1. - a2;

    vec3 r0 = (a0 * t0.rgb + (1. - a0) * a1 * t1.rgb + (1. - a1) * a2 * t2.rgb);
    return vec4(r0 / max(aR, 0.0001), aR);
}

vec4 combineOverlays(BaseData base, TerrainData terrains) {
    float h0 = terrains.Overlay0.z >= 0. ? 1. : 0.;
    float h1 = terrains.Overlay1.z >= 0. ? 1. : 0.;
    float h2 = terrains.Overlay2.z >= 0. ? 1. : 0.;

    vec4 overlay0 = vec4(0, 0, 0, 0);
    vec4 overlay1 = vec4(0, 0, 0, 0);
    vec4 overlay2 = vec4(0, 0, 0, 0);

    if (h0 > 0.) {
        overlay0 = texture(terrainAtlas, vec3(base.TexUV.xy * terrainTiling[int(terrains.Overlay0.z)], terrains.Overlay0.z));
        overlay0.a = texture(alphaAtlas, vec3(terrains.Overlay0.xy, terrains.Overlay0.w)).a;
    }
    if (h1 > 0.) {
        overlay1 = texture(terrainAtlas, vec3(base.TexUV.xy * terrainTiling[int(terrains.Overlay1.z)], terrains.Overlay1.z));
        overlay1.a = texture(alphaAtlas, vec3(terrains.Overlay1.xy, terrains.Overlay1.w)).a;
    }
    if (h2 > 0.) {
        overlay2 = texture(terrainAtlas, vec3(base.TexUV.xy * terrainTiling[int(terrains.Overlay2.z)], terrains.Overlay2.z));
        overlay2.a = texture(alphaAtlas, vec3(terrains.Overlay2.xy, terrains.Overlay2.w)).a;
    }

    return maskBlend3(overlay0, overlay1, overlay2, h0, h1, h2);
}

vec4 combineRoad(BaseData base, RoadData roads) {
    float h0 = roads.Road0.z >= 0. ? 1. : 0.;
    float h1 = roads.Road1.z >= 0. ? 1. : 0.;

    vec4 result = vec4(0, 0, 0, 0);

    if (h0 > 0.) {
        result = texture(terrainAtlas, vec3(base.TexUV.xy * terrainTiling[roadTextureIdx], roads.Road0.z));
        vec4 roadAlpha0 = texture(alphaAtlas, vec3(roads.Road0.xy, roads.Road0.w));
        result.a = 1. - roadAlpha0.a;

        if (h1 > 0.) {
            vec4 roadAlpha1 = texture(alphaAtlas, vec3(roads.Road1.xy, roads.Road1.w));
            result.a = 1. - (roadAlpha0.a * roadAlpha1.a);
        }
    }
    return result;
}

ivec4 rot2(int rot, ivec4 t) {
    if (rot == 0) return t;                         // Identity: [SouthWest, SouthEast, NorthEast, NorthWest]
    if (rot == 1) return ivec4(t[1], t[2], t[3], t[0]); // 90° clockwise: [SouthEast, NorthEast, NorthWest, SouthWest]
    if (rot == 2) return ivec4(t[2], t[3], t[0], t[1]); // 180°: [NorthEast, NorthWest, SouthWest, SouthEast]
    if (rot == 3) return ivec4(t[3], t[0], t[1], t[2]); // 270° clockwise: [NorthWest, SouthWest, SouthEast, NorthEast]
    return t;
}

vec4 getSplattedTerrainColor(vec3 pos) {
    uint pcode = paletteCode;
    ivec4 terrainCodes = getTerrainCodes(pcode);
    int t1 = terrainCodes.x;
    int t2 = terrainCodes.y;
    int t3 = terrainCodes.z;
    int t4 = terrainCodes.w;
    int r1 = int((pcode >> 26) & 0x3u);
    int r2 = int((pcode >> 24) & 0x3u);
    int r3 = int((pcode >> 22) & 0x3u);
    int r4 = int((pcode >> 20) & 0x3u);
    ivec3 roadCode = getRoadCode(pcode);
    
    // Check for all-road case first
    if (roadCode.z > 0) {
        vec4 roadColor = texture(terrainAtlas, vec3(cellUV * terrainTiling[roadTextureIdx], roadTextureIdx));
        return vec4(roadColor.rgb, 1.0);
    }

    ivec3 tcodes;
    ivec4 terrainTexIndices; // This will hold the actual terrain texture indices to use
    
    // Check for duplicate terrain codes
    bool foundDuplicate = false;
    for (int i = 0; i < 4 && !foundDuplicate; i++) {
        for (int j = i + 1; j < 4; j++) {
            if (terrainCodes[i] == terrainCodes[j]) {
                tcodes = buildTCodes(terrainCodes, ivec3(0), i);
                // Base texture is the duplicate terrain type
                terrainTexIndices[0] = terrainCodes[i];
                
                // Find the other terrain types for overlays
                int overlayIdx = 1;
                for (int k = 0; k < 4; k++) {
                    if (terrainCodes[k] != terrainCodes[i] && overlayIdx <= 3) {
                        terrainTexIndices[overlayIdx] = terrainCodes[k];
                        overlayIdx++;
                    }
                }
                foundDuplicate = true;
                break;
            }
        }
    }
    
    if (!foundDuplicate) {
        // No duplicates found - use all 4 terrain types
        tcodes = ivec3(2, 4, 8); // tcodes: 2, 4, 8
        terrainTexIndices = terrainCodes; // Use all 4 terrain codes directly
    }

    // UV for texture sampling
    vec2 uv = cellUV;

    // Base terrain texture
    vec4 c1 = texture(terrainAtlas, vec3(uv * terrainTiling[terrainTexIndices[0]], terrainTexIndices[0]));

    // Check if we need overlays
    bool singleTypeCell = t1 == t2 && t1 == t3 && t1 == t4;
    bool hasRoads = r1 != 0 || r2 != 0 || r3 != 0 || r4 != 0;
    
    if (singleTypeCell && !hasRoads) {
        return vec4(c1.rgb, 1.0);
    }

    // Calculate terrain overlays
    ivec2 tAlpha0 = tcodes.x > 0 ? getTerrainAlpha(pcode, tcodes.x) : ivec2(0, -1);
    ivec2 tAlpha1 = tcodes.y > 0 ? getTerrainAlpha(pcode, tcodes.y) : ivec2(0, -1);
    ivec2 tAlpha2 = tcodes.z > 0 ? getTerrainAlpha(pcode, tcodes.z) : ivec2(0, -1);

    TerrainData terrains = TerrainData(
        vec4(getRot(tAlpha0.x, uv), tAlpha0.y >= 0 ? terrainTexIndices[1] : -1, tAlpha0.y),
        vec4(getRot(tAlpha1.x, uv), tAlpha1.y >= 0 ? terrainTexIndices[2] : -1, tAlpha1.y),
        vec4(getRot(tAlpha2.x, uv), tAlpha2.y >= 0 ? terrainTexIndices[3] : -1, tAlpha2.y)
    );

    // Calculate road overlays
    ivec2 rAlpha0 = roadCode.x > 0 ? getRoadAlpha(pcode, roadCode.x) : ivec2(0, -1);
    ivec2 rAlpha1 = roadCode.y > 0 ? getRoadAlpha(pcode, roadCode.y) : ivec2(0, -1);
    
    RoadData roads = RoadData(
        vec4(getRot(rAlpha0.x, uv), roadCode.x > 0 ? roadTextureIdx : -1, rAlpha0.y),
        vec4(getRot(rAlpha1.x, uv), roadCode.y > 0 ? roadTextureIdx : -1, rAlpha1.y)
    );

    // Combine overlays
    vec4 combinedOverlays = combineOverlays(BaseData(vec3(uv, terrainTexIndices[0])), terrains);
    vec4 combinedRoad = combineRoad(BaseData(vec3(uv, terrainTexIndices[0])), roads);

    // Final blending
    vec3 baseMasked = saturate(c1.rgb * (1. - combinedOverlays.a) * (1. - combinedRoad.a));
    vec3 overlaysMasked = saturate(combinedOverlays.rgb * combinedOverlays.a * (1. - combinedRoad.a));
    vec3 roadMasked = combinedRoad.rgb * combinedRoad.a;

    return vec4(baseMasked + overlaysMasked + roadMasked, 1.0);
}

vec4 getResolvedTerrainColor() {
    vec2 uv = cellUV;
    // Temporary diagnostic: expose cells whose expected blend mask could not
    // be resolved instead of silently rendering only their base texture.
    if (terrainBlendMissing == 1) {
        if (terrainMissingTCode == 1) return vec4(1.0, 0.0, 0.0, 1.0);
        if (terrainMissingTCode == 2) return vec4(1.0, 0.5, 0.0, 1.0);
        if (terrainMissingTCode == 4) return vec4(1.0, 1.0, 0.0, 1.0);
        if (terrainMissingTCode == 6) return vec4(0.0, 1.0, 0.0, 1.0);
        if (terrainMissingTCode == 8) return vec4(0.0, 1.0, 1.0, 1.0);
        if (terrainMissingTCode == 12) return vec4(0.0, 0.0, 1.0, 1.0);
        return vec4(1.0, 1.0, 1.0, 1.0);
    }
    if (terrainBlendMissing == 2) return vec4(0.0, 0.0, 1.0, 1.0);
    if (terrainBlendMissing == 3) return vec4(1.0, 0.0, 1.0, 1.0);
    if (allRoadCell > 0) {
        vec4 roadColor = texture(
            terrainAtlas,
            vec3(uv * terrainTiling[roadTextureIdx], roadTextureIdx));
        return vec4(roadColor.rgb, 1.0);
    }

    vec4 baseColor = texture(
        terrainAtlas,
        vec3(uv * terrainTiling[terrainLayers[0]], terrainLayers[0]));
    bool hasOverlays = any(greaterThanEqual(terrainAlphaLayers, ivec3(0)));
    bool hasRoads = roadAlpha.y >= 0 || roadAlpha.w >= 0;
    if (!hasOverlays && !hasRoads) {
        return vec4(baseColor.rgb, 1.0);
    }

    TerrainData terrains = TerrainData(
        vec4(
            getRot(terrainAlphaRotations.x, uv),
            terrainAlphaLayers.x >= 0 ? float(terrainLayers[1]) : -1.0,
            float(terrainAlphaLayers.x)),
        vec4(
            getRot(terrainAlphaRotations.y, uv),
            terrainAlphaLayers.y >= 0 ? float(terrainLayers[2]) : -1.0,
            float(terrainAlphaLayers.y)),
        vec4(
            getRot(terrainAlphaRotations.z, uv),
            terrainAlphaLayers.z >= 0 ? float(terrainLayers[3]) : -1.0,
            float(terrainAlphaLayers.z)));
    RoadData roads = RoadData(
        vec4(
            getRot(roadAlpha.x, uv),
            roadAlpha.y >= 0 ? float(roadTextureIdx) : -1.0,
            float(roadAlpha.y)),
        vec4(
            getRot(roadAlpha.z, uv),
            roadAlpha.w >= 0 ? float(roadTextureIdx) : -1.0,
            float(roadAlpha.w)));
    vec4 combinedOverlays = combineOverlays(
        BaseData(vec3(uv, terrainLayers[0])),
        terrains);
    vec4 combinedRoad = combineRoad(
        BaseData(vec3(uv, terrainLayers[0])),
        roads);
    vec3 baseMasked = saturate(
        baseColor.rgb * (1.0 - combinedOverlays.a) * (1.0 - combinedRoad.a));
    vec3 overlaysMasked = saturate(
        combinedOverlays.rgb * combinedOverlays.a * (1.0 - combinedRoad.a));
    vec3 roadMasked = combinedRoad.rgb * combinedRoad.a;
    return vec4(baseMasked + overlaysMasked + roadMasked, 1.0);
}

vec2 terrainGridEdges() {
    vec2 edgeDistance = min(cellUV, 1.0 - cellUV);
    float cellWidth = max(fwidth(cellUV.x), fwidth(cellUV.y)) * 1.5;
    float cellEdge = 1.0 - smoothstep(0.0, cellWidth, min(edgeDistance.x, edgeDistance.y));

    bool leftLandblockEdge = terrainCellIndex.x % 8 == 0;
    bool rightLandblockEdge = terrainCellIndex.x % 8 == 7;
    // Cell indices increase opposite to world Y and cellUV.y.
    bool bottomLandblockEdge = terrainCellIndex.y % 8 == 7;
    bool topLandblockEdge = terrainCellIndex.y % 8 == 0;
    float landblockDistance = 1.0;
    if (leftLandblockEdge) landblockDistance = min(landblockDistance, cellUV.x);
    if (rightLandblockEdge) landblockDistance = min(landblockDistance, 1.0 - cellUV.x);
    if (bottomLandblockEdge) landblockDistance = min(landblockDistance, cellUV.y);
    if (topLandblockEdge) landblockDistance = min(landblockDistance, 1.0 - cellUV.y);
    float landblockWidth = cellWidth * 1.75;
    float landblockEdge = landblockDistance < 1.0
        ? 1.0 - smoothstep(0.0, landblockWidth, landblockDistance)
        : 0.0;
    return vec2(cellEdge * 0.55, landblockEdge);
}

void main() {
    vec3 tColor = terrainColors[baseTerrainCode];

    vec4 finalColor;

    if (scale > minZoomForTextures && hasTerrainTexture[baseTerrainCode] >= 0.5) {
        finalColor = getResolvedTerrainColor();
    } else {
        finalColor = vec4(tColor, 1.0);
    }

    finalColor.rgb *= triangleShade;

    if (terrainGridEnabled != 0) {
        vec2 gridEdges = terrainGridEdges();
        finalColor.rgb = mix(finalColor.rgb, vec3(0.5, 0.5, 0.5), gridEdges.x);
        finalColor.rgb = mix(finalColor.rgb, vec3(1.0, 0.0, 1.0), gridEdges.y);
    }

    if (fogEnabled != 0) {
        float fogFactor = clamp((length(wpos - cameraPosition) - fogStart) /
            max(fogEnd - fogStart, 0.0001), 0.0, 1.0);
        finalColor.rgb = mix(finalColor.rgb, fogColor, fogFactor);
    }
    FragColor = finalColor;
}
`;
