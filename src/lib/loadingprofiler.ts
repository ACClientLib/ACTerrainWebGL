export interface LoadingTimingSummary {
  count: number;
  last: number;
  average: number;
  p95: number;
  max: number;
}

export type LoadingTimingSnapshot = Record<string, LoadingTimingSummary>;

export class LoadingProfiler {
  private samples = new Map<string, number[]>();

  constructor(private sampleLimit = 120) {}

  record(name: string, duration: number): void {
    const samples = this.samples.get(name) ?? [];
    samples.push(duration);
    if (samples.length > this.sampleLimit)
      samples.splice(0, samples.length - this.sampleLimit);
    this.samples.set(name, samples);
  }

  async measure<T>(name: string, action: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await action();
    } finally {
      this.record(name, performance.now() - started);
    }
  }

  measureSync<T>(name: string, action: () => T): T {
    const started = performance.now();
    try {
      return action();
    } finally {
      this.record(name, performance.now() - started);
    }
  }

  snapshot(): LoadingTimingSnapshot {
    const result: LoadingTimingSnapshot = {};
    for (const [name, samples] of this.samples) {
      if (samples.length === 0) continue;
      const sorted = [...samples].sort((a, b) => a - b);
      result[name] = {
        count: samples.length,
        last: samples[samples.length - 1],
        average:
          samples.reduce((sum, value) => sum + value, 0) / samples.length,
        p95: sorted[
          Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
        ],
        max: sorted[sorted.length - 1],
      };
    }
    return result;
  }
}
