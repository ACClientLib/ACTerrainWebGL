export const TerrainPaletteSource = `
uint makeTerrainPalette(
    int r1, int r2, int r3, int r4,
    int t1, int t2, int t3, int t4
) {
  int terrainBits = (t1 << 15) | (t2 << 10) | (t3 << 5) | t4;
  int roadBits = (r1 << 26) | (r2 << 24) | (r3 << 22) | (r4 << 20);
  return uint((1 << 28) | roadBits | terrainBits);
}
`;
