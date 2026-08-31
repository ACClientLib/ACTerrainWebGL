const times: number[] = [];
const frameTimes: { timestamp: number; value: number }[] = [];
const cpuFrameTimes: { timestamp: number; value: number }[] = [];
const gpuFrameTimes: { timestamp: number; value: number }[] = [];
let fps = 0;
let lastFrameTime = 0;

export interface FrameStats {
  fps: number
  frameMs: number
  frameP95Ms: number
  frameP99Ms: number
  cpuMs: number
  cpuP95Ms: number
  cpuP99Ms: number
  gpuMs: number
  gpuP95Ms: number
  gpuP99Ms: number
}

function percentile(values: number[], percentile: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)]
}

function average(values: number[]) {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function removeExpiredTimes(values: number[], now: number) {
  while (values.length > 0 && values[0] <= now - 1000) {
    values.shift();
  }
}

function removeExpiredSamples(values: { timestamp: number; value: number }[], now: number) {
  while (values.length > 0 && values[0].timestamp <= now - 1000) {
    values.shift();
  }
}

export function updateFrameRate(now = performance.now()) {
  removeExpiredTimes(times, now)
  removeExpiredSamples(frameTimes, now)
  removeExpiredSamples(cpuFrameTimes, now)
  removeExpiredSamples(gpuFrameTimes, now)

  if (lastFrameTime > 0) {
    frameTimes.push({ timestamp: now, value: now - lastFrameTime })
  }
  lastFrameTime = now
  times.push(now);
  fps = times.length;
  return fps
}

export function recordCpuFrameTime(cpuMs: number, now = performance.now()) {
  removeExpiredSamples(cpuFrameTimes, now)
  cpuFrameTimes.push({ timestamp: now, value: cpuMs })
}

export function recordGpuFrameTime(gpuMs: number, now = performance.now()) {
  removeExpiredSamples(gpuFrameTimes, now)
  gpuFrameTimes.push({ timestamp: now, value: gpuMs })
}

export function getFrameStats(): FrameStats {
  const frameValues = frameTimes.map(sample => sample.value)
  const cpuValues = cpuFrameTimes.map(sample => sample.value)
  const gpuValues = gpuFrameTimes.map(sample => sample.value)
  return {
    fps,
    frameMs: average(frameValues),
    frameP95Ms: percentile(frameValues, 0.95),
    frameP99Ms: percentile(frameValues, 0.99),
    cpuMs: average(cpuValues),
    cpuP95Ms: percentile(cpuValues, 0.95),
    cpuP99Ms: percentile(cpuValues, 0.99),
    gpuMs: average(gpuValues),
    gpuP95Ms: percentile(gpuValues, 0.95),
    gpuP99Ms: percentile(gpuValues, 0.99)
  }
}
