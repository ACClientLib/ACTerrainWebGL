import { Matrix4, Vector3 } from "@math.gl/core";

export interface Bounds3 {
  minimum: [number, number, number];
  maximum: [number, number, number];
}

export type FrustumPlanes = Float32Array;

export function extractFrustumPlanes(transform: Matrix4): FrustumPlanes {
  const matrix = transform as unknown as ArrayLike<number>;
  return new Float32Array([
    matrix[3] + matrix[0],
    matrix[7] + matrix[4],
    matrix[11] + matrix[8],
    matrix[15] + matrix[12],
    matrix[3] - matrix[0],
    matrix[7] - matrix[4],
    matrix[11] - matrix[8],
    matrix[15] - matrix[12],
    matrix[3] + matrix[1],
    matrix[7] + matrix[5],
    matrix[11] + matrix[9],
    matrix[15] + matrix[13],
    matrix[3] - matrix[1],
    matrix[7] - matrix[5],
    matrix[11] - matrix[9],
    matrix[15] - matrix[13],
    matrix[3] + matrix[2],
    matrix[7] + matrix[6],
    matrix[11] + matrix[10],
    matrix[15] + matrix[14],
    matrix[3] - matrix[2],
    matrix[7] - matrix[6],
    matrix[11] - matrix[10],
    matrix[15] - matrix[14],
  ]);
}

export function transformBounds(
  bounds: Bounds3,
  transform: (point: Vector3) => Vector3,
): Bounds3 {
  const minimum = new Vector3(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  const maximum = new Vector3(
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  );
  for (let x = 0; x < 2; x++) {
    for (let y = 0; y < 2; y++) {
      for (let z = 0; z < 2; z++) {
        const point = transform(
          new Vector3(
            x === 0 ? bounds.minimum[0] : bounds.maximum[0],
            y === 0 ? bounds.minimum[1] : bounds.maximum[1],
            z === 0 ? bounds.minimum[2] : bounds.maximum[2],
          ),
        );
        minimum.min(point);
        maximum.max(point);
      }
    }
  }
  return {
    minimum: [minimum.x, minimum.y, minimum.z],
    maximum: [maximum.x, maximum.y, maximum.z],
  };
}

export function intersectsCamera(bounds: Bounds3, transform: Matrix4): boolean {
  return intersectsFrustum(bounds, extractFrustumPlanes(transform));
}

export function intersectsFrustum(
  bounds: Bounds3,
  planes: FrustumPlanes,
): boolean {
  for (let offset = 0; offset < planes.length; offset += 4) {
    const x = planes[offset];
    const y = planes[offset + 1];
    const z = planes[offset + 2];
    const distance = planes[offset + 3];
    const px = x >= 0 ? bounds.maximum[0] : bounds.minimum[0];
    const py = y >= 0 ? bounds.maximum[1] : bounds.minimum[1];
    const pz = z >= 0 ? bounds.maximum[2] : bounds.minimum[2];
    if (x * px + y * py + z * pz + distance < 0) return false;
  }
  return true;
}

export function intersectsRectangle(
  bounds: Bounds3,
  minimum: ArrayLike<number>,
  maximum: ArrayLike<number>,
): boolean {
  return (
    bounds.maximum[0] >= minimum[0] &&
    bounds.minimum[0] <= maximum[0] &&
    bounds.maximum[1] >= minimum[1] &&
    bounds.minimum[1] <= maximum[1] &&
    bounds.maximum[2] >= minimum[2] &&
    bounds.minimum[2] <= maximum[2]
  );
}
