import type { ParticleEmitterDescriptor } from "./acdatclient";

export interface ParticleSimulationInstance {
  position: [number, number, number];
  scale: number;
  opacity: number;
  dimensions: [number, number, number];
  planeSize: [number, number];
  centerOffset: [number, number, number];
  planeOrientation: [number, number, number, number];
  rotation: [number, number, number, number];
  billboard: number;
}

interface ParticleState {
  worldOffset: [number, number, number];
  worldA: [number, number, number];
  worldB: [number, number, number];
  worldC: [number, number, number];
  lifetime: number;
  maxLifetime: number;
  startScale: number;
  finalScale: number;
  startTranslucency: number;
  finalTranslucency: number;
  emissionOrigin: [number, number, number];
  orientation: [number, number, number, number];
}

export class ParticleSimulation {
  private readonly particles: ParticleState[] = [];
  private readonly instanceResults: ParticleSimulationInstance[] = [];
  private readonly random = new Float32Array(32);
  private randomCursor = 0;
  private emissionTimer = 0;
  private totalEmitted = 0;
  private timeRunning = 0;

  constructor(private readonly descriptor: ParticleEmitterDescriptor) {}

  update(
    deltaTime: number,
    placementOrigin: [number, number, number],
    placementRotation: [number, number, number, number],
    placementScale: [number, number, number],
    maxInstances = Number.POSITIVE_INFINITY,
  ): ParticleSimulationInstance[] {
    const p = this.descriptor;
    const dt = Math.max(0, Math.min(deltaTime, 0.25));
    const persistent = p.totalParticles === 0 && p.totalSeconds === 0;
    const persistentStill = persistent && p.particleType === 1;

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i];
      particle.lifetime = persistentStill ? 0 : particle.lifetime + dt;
      if (!persistentStill && particle.lifetime >= particle.maxLifetime) {
        const last = this.particles.length - 1;
        if (i !== last) this.particles[i] = this.particles[last];
        this.particles.pop();
        continue;
      }
    }

    this.timeRunning += dt;
    const withinTime = p.totalSeconds === 0 || this.timeRunning < p.totalSeconds;
    const withinCount = p.totalParticles === 0 || this.totalEmitted < p.totalParticles;
    const canEmit = withinTime && withinCount;

    if (canEmit) {
      if (this.totalEmitted === 0 && p.initialParticles > 0) {
        for (let i = 0; i < p.initialParticles && this.particles.length < p.maxParticles; i++) this.emit(placementOrigin, placementRotation, placementScale);
      }

      if (p.emitterType === 1 || p.emitterType === 0) {
        this.emissionTimer += dt;
        const interval = p.birthrate;
        const intervalElapsed = interval <= 0.001 || this.emissionTimer > interval;
        if (intervalElapsed && this.particles.length < Math.max(1, p.maxParticles)) {
          if (p.totalParticles === 0 || this.totalEmitted < p.totalParticles) {
            this.emit(placementOrigin, placementRotation, placementScale);
            this.emissionTimer = 0;
          }
        }
      }
    }

    return this.instances(placementOrigin, placementRotation, placementScale, maxInstances);
  }

  private emit(
    placementOrigin: [number, number, number],
    placementRotation: [number, number, number, number],
    placementScale: [number, number, number],
  ): void {
    const p = this.descriptor;
    this.randomize(this.totalEmitted);
    const maxLifetime = Math.max(0.001, p.lifespan + (this.randomValue() * 2 - 1) * p.lifespanRandom);
    const frameRotation = this.mulQuat(placementRotation, p.parentOrientation);
    const offset = this.randomOffset();
    const worldOffset = this.rotate(frameRotation, this.scaleVector(offset, placementScale));
    const parentOrigin = this.add(placementOrigin, this.rotate(placementRotation, this.scaleVector(p.parentOrigin, placementScale)));
    const emissionOrigin = this.add(parentOrigin, this.rotate(frameRotation, this.scaleVector(p.offset, placementScale)));
    const localA = this.randomVector(p.a, p.minA, p.maxA);
    const localB = this.randomVector(p.b, p.minB, p.maxB);
    const localC = this.randomVector(p.c, p.minC, p.maxC);
    const scaledA = this.scaleVector(localA, placementScale);
    const scaledB = this.scaleVector(localB, placementScale);
    const scaledC = this.scaleVector(localC, placementScale);
    const particle: ParticleState = {
      worldOffset,
      worldA: localA,
      worldB: localB,
      worldC: localC,
      lifetime: 0,
      maxLifetime,
      startScale: this.clamp(p.startScale + (this.randomValue() * 2 - 1) * p.scaleRandom, 0.1, 10),
      finalScale: this.clamp(p.finalScale + (this.randomValue() * 2 - 1) * p.scaleRandom, 0.1, 10),
      startTranslucency: this.clamp(p.startTranslucency + (this.randomValue() * 2 - 1) * p.translucencyRandom, 0, 1),
      finalTranslucency: this.clamp(p.finalTranslucency + (this.randomValue() * 2 - 1) * p.translucencyRandom, 0, 1),
      emissionOrigin,
      orientation: frameRotation,
    };

    switch (p.particleType) {
      case 2:
      case 3:
        particle.worldA = this.rotate(frameRotation, scaledA);
        break;
      case 4:
        particle.worldA = this.rotate(frameRotation, scaledA);
        particle.worldC = localC;
        break;
      case 5:
        particle.worldA = this.rotate(frameRotation, scaledA);
        break;
      case 6: {
        const angleA = this.randomValue() * 2 * Math.PI - Math.PI;
        const angleB = this.randomValue() * 2 * Math.PI - Math.PI;
        const cosB = Math.cos(angleB);
        particle.worldC = this.normalize([
          Math.cos(angleA) * localC[0] * cosB,
          Math.sin(angleA) * localC[1] * cosB,
          Math.sin(angleB) * localC[2],
        ]);
        particle.worldA = localA;
        particle.worldB = localB;
        break;
      }
      case 7:
        particle.worldOffset = this.mul(worldOffset, localC[0]);
        particle.worldC = particle.worldOffset;
        break;
      case 8:
        particle.worldA = this.rotate(frameRotation, scaledA);
        particle.worldB = this.rotate(frameRotation, scaledB);
        break;
      case 9:
        particle.worldA = this.rotate(frameRotation, scaledA);
        particle.worldC = this.rotate(frameRotation, scaledC);
        break;
      case 11:
        particle.worldC = localC;
        break;
    }

    this.particles.push(particle);
    this.totalEmitted++;
  }

  private instances(
    placementOrigin: [number, number, number],
    placementRotation: [number, number, number, number],
    placementScale: [number, number, number],
    maxInstances: number,
  ): ParticleSimulationInstance[] {
    const p = this.descriptor;
    const result = this.instanceResults;
    result.length = 0;
    for (let index = 0; index < this.particles.length && index < maxInstances; index++) {
      const particle = this.particles[index];
      const parentOrigin = p.parentLocal
        ? this.add(placementOrigin, this.rotate(placementRotation, this.scaleVector(p.parentOrigin, placementScale)))
        : particle.emissionOrigin;
      const position = this.calculatePosition(particle, parentOrigin);
      const life = this.clamp(particle.lifetime / particle.maxLifetime, 0, 1);
      const scale = this.lerp(particle.startScale, particle.finalScale, life);
      const opacity = 1 - this.lerp(particle.startTranslucency, particle.finalTranslucency, life);
      let rotation = particle.orientation;
      if (p.particleType === 4 || p.particleType === 9 || p.particleType === 11) {
        const angular = this.mul(particle.worldC, particle.lifetime);
        const magnitude = Math.hypot(angular[0], angular[1], angular[2]);
        if (magnitude > 0.0001) {
          const spin = this.fromAxisAngle(
            [angular[0] / magnitude, angular[1] / magnitude, angular[2] / magnitude],
            magnitude,
          );
          // WorldC is world-space for every rotating particle type. Apply its
          // spin before the particle frame so the placement orientation does
          // not rotate the axis a second time.
          rotation = this.mulQuat(spin, rotation);
        }
      }
      result.push({
        position,
        scale,
        opacity,
        dimensions: [Math.abs(p.dimensions[0] * placementScale[0]), Math.abs(p.dimensions[1] * placementScale[1]), Math.abs(p.dimensions[2] * placementScale[2])],
        planeSize: this.planeSize(p.dimensions, placementScale),
        centerOffset: [p.centerOffset[0] * placementScale[0], p.centerOffset[1] * placementScale[1], p.centerOffset[2] * placementScale[2]],
        planeOrientation: p.planeOrientation,
        rotation,
        billboard: p.representation === 2 ? 1 : p.representation >= 3 ? p.representation : 0,
      });
    }
    return result;
  }

  private calculatePosition(particle: ParticleState, parentOrigin: [number, number, number]): [number, number, number] {
    const t = particle.lifetime;
    const base = this.add(parentOrigin, particle.worldOffset);
    switch (this.descriptor.particleType) {
      case 1: return base;
      case 2:
      case 12: return this.add(base, this.mul(particle.worldA, t));
      case 3:
      case 4:
      case 8:
      case 9:
      case 10:
      case 11: return this.add(base, this.add(this.mul(particle.worldA, t), this.mul(particle.worldB, 0.5 * t * t)));
      case 5: {
        const swarm = this.add(base, this.mul(particle.worldA, t));
        return [Math.cos(t * this.descriptor.b[0]) * particle.worldC[0] + swarm[0], Math.sin(t * this.descriptor.b[1]) * particle.worldC[1] + swarm[1], Math.cos(t * this.descriptor.b[2]) * particle.worldC[2] + swarm[2]];
      }
      case 6: return [
        (t * particle.worldB[0] + particle.worldC[0] * particle.worldA[0]) * t + base[0],
        (t * particle.worldB[1] + particle.worldC[1] * particle.worldA[0]) * t + base[1],
        (t * particle.worldB[2] + particle.worldC[2] * particle.worldA[0] + particle.worldA[2]) * t + base[2],
      ];
      case 7: return this.add(this.add(base, this.mul(particle.worldC, Math.cos(particle.worldA[0] * t))), this.mul(particle.worldB, t * t));
      default: return this.add(base, this.mul(particle.worldA, t));
    }
  }

  private randomize(slot: number): void { let x = (this.descriptor.seed ^ Math.imul(slot + 1, 668265263)) >>> 0; for (let i = 0; i < this.random.length; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; this.random[i] = (x >>> 8) / 16777216; } this.randomCursor = 0; }
  private randomValue(): number { return this.random[this.randomCursor++]; }
  private randomVector(v: [number, number, number], min: number, max: number): [number, number, number] { const m = min + (max - min) * this.randomValue(); return this.mul(v, m); }
  private randomOffset(): [number, number, number] { const v: [number, number, number] = [this.randomValue() * 2 - 1, this.randomValue() * 2 - 1, this.randomValue() * 2 - 1]; const d = this.descriptor.offsetDirection; const dot = v[0] * d[0] + v[1] * d[1] + v[2] * d[2]; return this.mul(this.normalize([v[0] - d[0] * dot, v[1] - d[1] * dot, v[2] - d[2] * dot]), this.descriptor.minOffset + (this.descriptor.maxOffset - this.descriptor.minOffset) * this.randomValue()); }
  private normalize(v: [number, number, number]): [number, number, number] { const n = Math.hypot(v[0], v[1], v[2]); return n < 0.0002 ? [0, 0, 0] : [v[0] / n, v[1] / n, v[2] / n]; }
  private rotate(q: [number, number, number, number], v: [number, number, number]): [number, number, number] { const t = [2 * (q[1] * v[2] - q[2] * v[1]), 2 * (q[2] * v[0] - q[0] * v[2]), 2 * (q[0] * v[1] - q[1] * v[0])]; return [v[0] + q[3] * t[0] + q[1] * t[2] - q[2] * t[1], v[1] + q[3] * t[1] + q[2] * t[0] - q[0] * t[2], v[2] + q[3] * t[2] + q[0] * t[1] - q[1] * t[0]]; }
  private mulQuat(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] { return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]]; }
  private fromAxisAngle(axis: [number, number, number], angle: number): [number, number, number, number] { const half = angle * 0.5, s = Math.sin(half); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)]; }
  private add(a: [number, number, number], b: [number, number, number]): [number, number, number] { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  private mul(a: [number, number, number], s: number): [number, number, number] { return [a[0] * s, a[1] * s, a[2] * s]; }
  private scaleVector(v: [number, number, number], scale: [number, number, number]): [number, number, number] { return [v[0] * scale[0], v[1] * scale[1], v[2] * scale[2]]; }
  private planeSize(dimensions: [number, number, number], scale: [number, number, number]): [number, number] {
    const [x, y, z] = dimensions;
    if (y > x && y > z) return x > z ? [Math.abs(x * scale[0]), Math.abs(y * scale[1])] : [Math.abs(y * scale[1]), Math.abs(z * scale[2])];
    if (x > y && x > z) return z > y ? [Math.abs(x * scale[0]), Math.abs(z * scale[2])] : [Math.abs(x * scale[0]), Math.abs(y * scale[1])];
    return x > y ? [Math.abs(x * scale[0]), Math.abs(z * scale[2])] : [Math.abs(y * scale[1]), Math.abs(z * scale[2])];
  }
  private lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
  private clamp(a: number, min: number, max: number): number { return Math.max(min, Math.min(max, a)); }
}
