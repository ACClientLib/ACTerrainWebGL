import { SUPPORTED_FORMAT_VERSION } from "./formatcontract";
import { TERRAIN_DATA_SIDE } from "./worldgeometry";

const ACTD_MAGIC = 0x44544341;
const ACTB_MAGIC = 0x42544341;

export interface TerrainSurfaceRecord {
  terrainType: number;
  textureTiling: number;
  textureId: number;
}

export interface TerrainMaskRecord {
  kind: number;
  code: number;
  textureId: number;
}

export interface TerrainBlendCatalog {
  heightTable: number[];
  colors: [number, number, number][];
  surfaces: TerrainSurfaceRecord[];
  cornerMasks: TerrainMaskRecord[];
  sideMasks: TerrainMaskRecord[];
  roadMasks: TerrainMaskRecord[];
}

export class TerrainDataClient {
  readonly texture: WebGLTexture;
  pixels: Uint8ClampedArray | null = null;
  catalog: TerrainBlendCatalog | null = null;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly textureUnit: number,
  ) {
    const texture = gl.createTexture();
    if (!texture) throw new Error("Unable to create terrain control texture");
    this.texture = texture;
  }

  async load(source: Promise<ArrayBuffer>): Promise<void> {
    const bytes = await source;
    const view = new DataView(bytes);
    if (
      bytes.byteLength < 24 ||
      view.getUint32(0, true) !== ACTD_MAGIC ||
      view.getUint16(4, true) !== SUPPORTED_FORMAT_VERSION ||
      view.getUint16(6, true) !== 16
    )
      throw new Error("Invalid ACTerrain terrain-data header");
    const blendLength = view.getUint32(8, true);
    const pngLength = view.getUint32(12, true);
    if (16 + blendLength + pngLength !== bytes.byteLength)
      throw new Error("Invalid ACTerrain terrain-data lengths");
    this.catalog = this.parseCatalog(bytes.slice(16, 16 + blendLength));
    const png = new Blob([bytes.slice(16 + blendLength)], {
      type: "image/png",
    });
    const image = new Image();
    const imageUrl = URL.createObjectURL(png);
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () =>
          reject(new Error("Unable to decode terrain control PNG"));
        image.src = imageUrl;
      });
      if (
        image.naturalWidth !== TERRAIN_DATA_SIDE ||
        image.naturalHeight !== TERRAIN_DATA_SIDE
      )
        throw new Error(
          `Invalid terrain control dimensions ${image.naturalWidth}x${image.naturalHeight}`,
        );
      const canvas = new OffscreenCanvas(
        image.naturalWidth,
        image.naturalHeight,
      );
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Unable to decode terrain control pixels");
      context.drawImage(image, 0, 0);
      this.pixels = context.getImageData(
        0,
        0,
        image.naturalWidth,
        image.naturalHeight,
      ).data;
      const gl = this.gl;
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.activeTexture(gl.TEXTURE0 + this.textureUnit);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } finally {
      URL.revokeObjectURL(imageUrl);
    }
  }

  private parseCatalog(bytes: ArrayBuffer): TerrainBlendCatalog {
    const view = new DataView(bytes);
    if (
      bytes.byteLength < 16 ||
      view.getUint32(0, true) !== ACTB_MAGIC ||
      view.getUint16(4, true) !== SUPPORTED_FORMAT_VERSION
    )
      throw new Error("Invalid ACTerrain terrain blend catalog");
    const terrainCount = view.getUint16(6, true);
    const counts = [
      view.getUint16(8, true),
      view.getUint16(10, true),
      view.getUint16(12, true),
    ];
    const heightCount = view.getUint16(14, true);
    const colorCount = view.getUint16(16, true);
    if (
      terrainCount !== 33 ||
      heightCount !== 256 ||
      colorCount !== 32 ||
      view.getUint16(18, true) !== 0 ||
      view.getUint32(20, true) !== 0 ||
      24 +
        heightCount * 4 +
        colorCount * 4 +
        (terrainCount + counts[0] + counts[1] + counts[2]) * 8 !==
        bytes.byteLength
    )
      throw new Error("Invalid ACTerrain terrain blend catalog counts");
    let offset = 24;
    const heightTable = Array.from({ length: heightCount }, () => {
      const value = view.getFloat32(offset, true);
      offset += 4;
      return value;
    });
    const colors = Array.from({ length: colorCount }, () => {
      const color: [number, number, number] = [
        view.getUint8(offset) / 255,
        view.getUint8(offset + 1) / 255,
        view.getUint8(offset + 2) / 255,
      ];
      offset += 4;
      return color;
    });
    const surfaces: TerrainSurfaceRecord[] = [];
    for (let index = 0; index < terrainCount; index++, offset += 8) {
      if (view.getUint8(offset + 1) !== 0)
        throw new Error("Invalid terrain surface record");
      surfaces.push({
        terrainType: view.getUint8(offset),
        textureTiling: view.getUint16(offset + 2, true),
        textureId: view.getUint32(offset + 4, true),
      });
    }
    const masks: TerrainMaskRecord[][] = [[], [], []];
    for (let kind = 0; kind < masks.length; kind++) {
      for (let index = 0; index < counts[kind]; index++, offset += 8) {
        if (view.getUint8(offset) !== kind || view.getUint8(offset + 1) !== 0)
          throw new Error("Invalid terrain mask record");
        masks[kind].push({
          kind,
          code: view.getUint16(offset + 2, true),
          textureId: view.getUint32(offset + 4, true),
        });
      }
    }
    return {
      heightTable,
      colors,
      surfaces,
      cornerMasks: masks[0],
      sideMasks: masks[1],
      roadMasks: masks[2],
    };
  }
}
