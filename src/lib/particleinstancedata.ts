import type { ParticleSimulationInstance } from "./particlesimulation";

export function appendParticleInstance(data: number[], instance: ParticleSimulationInstance): void {
  const fullBillboard = instance.billboard === 1;
  const cameraAligned = instance.billboard > 0.5;
  // planeSize is the rectangle occupied by the authored particle surface.
  // The source GfxObj is not guaranteed to lie in the XZ plane (torch flames
  // are a common XY/YZ case), so never infer billboard dimensions from X/Z.
  const sizeX = instance.planeSize[0];
  const sizeY = instance.planeSize[1];
  let centerX = instance.position[0];
  let centerY = instance.position[1];
  let centerZ = instance.position[2];
  if (fullBillboard) {
    centerZ += instance.centerOffset[2] * instance.scale;
  } else {
    const q = instance.rotation;
    const v0 = instance.centerOffset[0] * instance.scale;
    const v1 = instance.centerOffset[1] * instance.scale;
    const v2 = instance.centerOffset[2] * instance.scale;
    const tx = 2 * (q[1] * v2 - q[2] * v1);
    const ty = 2 * (q[2] * v0 - q[0] * v2);
    const tz = 2 * (q[0] * v1 - q[1] * v0);
    centerX += v0 + q[3] * tx + q[1] * tz - q[2] * ty;
    centerY += v1 + q[3] * ty + q[2] * tx - q[0] * tz;
    centerZ += v2 + q[3] * tz + q[0] * ty - q[1] * tx;
  }
  data.push(
    centerX, centerY, centerZ,
    instance.scale,
    instance.opacity, 0, 0,
    sizeX, 0, sizeY,
    instance.planeOrientation[0], instance.planeOrientation[1], instance.planeOrientation[2], instance.planeOrientation[3],
    instance.rotation[0], instance.rotation[1], instance.rotation[2], instance.rotation[3], cameraAligned ? instance.billboard : 0,
  );
}
