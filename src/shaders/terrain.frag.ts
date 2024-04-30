export const TerrainFragSource = `#version 300 es

precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;

// the height lookup table from dat region file
uniform float heightTable[255];

// terrain color lookup
uniform vec3 terrainColors[32];

// texture with all the terrain data needed for rendering
//
// this is how the terrain data is stored in the texture:
// There are 2041 * 2041 vertice datas stored
//
// var height = lbInfo.Height[(vx * 9) + vy];
// var terrain = (lbInfo.Terrain[(vx * 9) + vy] & 0x7C) >> 2;
// var road = (lbInfo.Terrain[(vx * 9) + vy] & 0x3);
// var scenery = (lbInfo.Terrain[(vx * 9) + vy] & 0xF800) >> 11;
// bmp.SetPixel(verticeX, verticeY, Color.FromArgb(scenery, height, terrain, road));
uniform sampler2D terrainData;

// texture array of all the terrain textures from the dat
uniform sampler2DArray terrainAtlas;

// current drawing scale
uniform float scale;

in vec4 someColor;
in vec3 pos;
in vec3 wpos;

out vec4 FragColor;

void highlightLandcells() {
  float ep = 0.2;
  if (fract(wpos.x / 192.0) < ep / 3. || fract(wpos.y / 192.0) < ep / 3.) {
    FragColor = vec4(1.0, 0.0, 0.0, 1.0);
  }
  else if (fract(wpos.x / 24.0) < ep || fract(wpos.y / 24.0) < ep) {
    FragColor = vec4(1.0, 0.0, 1.0, 1.0);
  }
}

void main() {
  vec2 cPos = pos.xy * (255. * 8.0);

  int tCode = int(texelFetch(terrainData, ivec2(cPos + vec2(0, 0)), 0).g * 255.0);
  vec3 tColor = terrainColors[tCode];

  if (scale > 0.2) {
    FragColor = texture(terrainAtlas, vec3(cPos.xy, tCode));
  }
  else {
    FragColor = vec4(tColor, 1);
  }

  //highlightLandcells();
}
`;