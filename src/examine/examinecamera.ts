export interface ExamineCamera {
  projection: Float32Array;
  view: Float32Array;
}

function perspective(fov: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fov / 2);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]);
}

export function createExamineCamera(
  bounds: { minimum: [number, number, number]; maximum: [number, number, number] },
  width: number,
  height: number,
  scale: number,
): ExamineCamera {
  const extent = bounds.maximum.map((value, index) =>
    Math.abs(value - bounds.minimum[index]) * scale * 0.5,
  );
  const radius = Math.max(Math.hypot(extent[0], extent[1], extent[2]), 0.01);
  const distance = radius * 0.9 / Math.sin((35 * Math.PI) / 360);
  const near = Math.max(0.01, distance - radius * 2);
  const far = distance + radius * 2;
  const view = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, -distance, 1,
  ]);
  return {
    projection: perspective((35 * Math.PI) / 180, Math.max(width / height, 0.01), near, far),
    view,
  };
}
