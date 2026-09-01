// nothing here is good... but it works so..
// todo: rewrite and clean up

import {
  LAND_BLOCK_SIDE,
  LAND_BLOCK_SIZE,
  MAP_SIZE,
  TERRAIN_CELLS_PER_LAND_BLOCK,
  TERRAIN_CELL_SIZE,
  landBlockId
} from './worldgeometry';

const minCoord = -101.95;
const maxCoord = 102.05;

function GetLandblockFromCoordinates(EW: number, NS: number) {
   const lbX = Math.floor((EW + Math.abs(minCoord)) / (maxCoord - minCoord) * LAND_BLOCK_SIDE);
   const lbY = Math.floor((NS + Math.abs(minCoord)) / (maxCoord - minCoord) * LAND_BLOCK_SIDE);

   return landBlockId(lbX, lbY)
}

function LandblockToNS(landcell: number, yOffset: number) {
  const num = ((landcell & 0x00FF0000) >>> 0)  / 8192;
  const num2 = ((yOffset / TERRAIN_CELL_SIZE + num) - 1019.5) / 10.0;
  return num2;
}

function LandblockToEW(landcell: number, xOffset: number) {
  const num = ((landcell & 0xFF000000) >>> 0) / 2097152;
  const num2 = ((xOffset / TERRAIN_CELL_SIZE + num) - 1019.5) / 10.0;
  return num2;
}

function NSToLandblock(landcell: number, ns: number) {
  const num = ((landcell & 0x00FF0000) >>> 0)  / 8192;
  const num2 = ((ns * 10.0 - num) + 1019.5) * TERRAIN_CELL_SIZE;
  return num2;
}

function EWToLandblock(landcell: number, ew: number) {
    const num = ((landcell & 0xFF000000) >>> 0) / 2097152;
    const num2 = ((ew * 10.0 - num) + 1019.5) * TERRAIN_CELL_SIZE;
    return num2;
}


export default class Coordinates {
  readonly CoordinateRegex : RegExp = /(?<NSval>[0-9]{1,3}(?:\\.[0-9]{1,3})?)(?<NSchr>(?:[ns]))(?:[,\\s]+)?(?<EWval>[0-9]{1,3}(?:\\.[0-9]{1,3})?)(?<EWchr>(?:[ew]))?(,?\\s*(?<Zval>\\-?\\d+.?\\d+)z)?/i

  LandCell: number = 0
  LocalX: number = 0
  LocalY: number = 0
  LocalZ: number = 0

  get NS() { return LandblockToNS(this.LandCell, this.LocalY); }
  get EW() { return LandblockToEW(this.LandCell, this.LocalX); }

  public static FromCoordinates(northSouth: number, eastWeast: number, z: number) {
      const landcell = GetLandblockFromCoordinates(eastWeast, northSouth);
      const localX = EWToLandblock(landcell, eastWeast);
      const localY = NSToLandblock(landcell, northSouth);
      const localZ = z;
      return new Coordinates(landcell, localX, localY, localZ);
  }

  public FromLocation(landcell: number, localX: number, localY: number, localZ: number) {
    return new Coordinates(landcell, localX, localY, localZ);
  }

  constructor(landCell: number, localX: number, localY: number, localZ: number) {
    this.LandCell = landCell;
    this.LocalX = localX;
    this.LocalY = localY;
    this.LocalZ = localZ;
    if ((this.LandCell & 0xFFFF) == 0) {
      this.#CalculateOutdoorLandcell();
    }
  }

  #CalculateOutdoorLandcell() {
      this.LandCell = (this.LandCell |
        (Math.floor(this.LocalX / TERRAIN_CELL_SIZE) * TERRAIN_CELLS_PER_LAND_BLOCK) +
        Math.ceil(this.LocalY / TERRAIN_CELL_SIZE)) >>> 0;
  }
  
  LBX() {
      return this.LandCell >> 24 & 0xFF;
  }

  LBY() {
      return this.LandCell >> 16 & 0xFF;
  }

  IsOutside() {
      return (this.LandCell & 0xFFFF) < 0x100;
  }
}

Coordinates.prototype.toString = function() {
  return formatMapCoordinates(this)
}

export function formatMapCoordinates(coords: Coordinates): string {
  return `${Math.abs(coords.NS).toFixed(3)}${coords.NS >= 0 ? 'N' : 'S'}, ${Math.abs(coords.EW).toFixed(3)}${coords.EW >= 0 ? 'E' : 'W'}, ${(coords.LocalZ / 240).toFixed(3)}Z`
}

export function worldToMapCoordinates(position: { x: number, y: number, z: number }): Coordinates {
  const eastWest = position.x / MAP_SIZE * 204.0 - 101.95
  const northSouth = (MAP_SIZE - position.y) / MAP_SIZE * 204.0 - 101.95
  return Coordinates.FromCoordinates(northSouth, eastWest, position.z)
}

export function mapCoordinatesToWorld(coords: Coordinates): { x: number, y: number, z: number } {
  return {
    x: coords.LBX() * LAND_BLOCK_SIZE + coords.LocalX,
    y: MAP_SIZE - (coords.LBY() * LAND_BLOCK_SIZE + coords.LocalY),
    z: coords.LocalZ
  }
}
