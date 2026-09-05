export interface ResourceGeneration<TCpu, TGpu = unknown> {
  readonly id: number;
  readonly generation: number;
  readonly cpuEncodedBytes: number;
  readonly cpuDecodedBytes: number;
  gpuBytes: number;
  readonly cpu: TCpu;
  gpu?: TGpu;
}

interface Entry<TCpu, TGpu> {
  generation: ResourceGeneration<TCpu, TGpu>;
  references: number;
  lastUsed: number;
  uploadPending: boolean;
  retired: boolean;
  collected: boolean;
}

export interface ResourceRegistryBudgets {
  encodedBytes: number;
  decodedBytes: number;
  gpuBytes: number;
  uploadBytesPerFrame: number;
}

export interface ResourceRegistryOptions<TCpu, TGpu> {
  budgets: ResourceRegistryBudgets;
  destroyGpu?: (gpu: TGpu) => void;
  destroyCpu?: (cpu: TCpu) => void;
  contextRestored?: (generation: ResourceGeneration<TCpu, TGpu>) => void;
}

export interface ResourceLease<TCpu, TGpu> {
  readonly value: ResourceGeneration<TCpu, TGpu>;
  release(): void;
}

export interface UploadReservation {
  readonly bytes: number;
  release(): void;
}

export class ResourceRegistry<TCpu, TGpu = unknown> {
  private readonly entries = new Map<number, Entry<TCpu, TGpu>>();
  private readonly retired = new Set<Entry<TCpu, TGpu>>();
  private readonly options: ResourceRegistryOptions<TCpu, TGpu>;
  private encodedBytes = 0;
  private decodedBytes = 0;
  private gpuBytes = 0;
  private nextGeneration = 1;
  private clock = 0;
  private contextAvailable = true;
  private uploadBytesThisFrame = 0;
  private restorationQueue = new Set<ResourceGeneration<TCpu, TGpu>>();
  private readonly pendingGpuDestructions: TGpu[] = [];

  constructor(options: ResourceRegistryOptions<TCpu, TGpu>) {
    this.options = options;
  }

  get usage(): ResourceRegistryBudgets {
    return { encodedBytes: this.encodedBytes, decodedBytes: this.decodedBytes, gpuBytes: this.gpuBytes, uploadBytesPerFrame: this.uploadBytesThisFrame };
  }

  get pendingUploadCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.uploadPending && entry.generation.gpu === undefined) count++;
    }
    return count;
  }

  beginFrame(): void {
    this.uploadBytesThisFrame = 0;
    if (this.contextAvailable) {
      for (const gpu of this.pendingGpuDestructions.splice(0))
        this.options.destroyGpu?.(gpu);
    } else {
      this.pendingGpuDestructions.length = 0;
    }
    if (!this.contextAvailable) return;
    for (const entry of this.entries.values()) {
      if (!entry.uploadPending || entry.generation.gpu !== undefined) continue;
      if (this.restorationQueue.has(entry.generation)) continue;
      this.restorationQueue.add(entry.generation);
      this.restorationQueue.delete(entry.generation);
      this.options.contextRestored?.(entry.generation);
    }
  }

  reserveUpload(bytes: number): UploadReservation | undefined {
    if (bytes < 0 || bytes > this.options.budgets.uploadBytesPerFrame - this.uploadBytesThisFrame) return undefined;
    this.uploadBytesThisFrame += bytes;
    let released = false;
    return { bytes, release: () => { if (released) return; released = true; this.uploadBytesThisFrame -= bytes; } };
  }

  publish(id: number, cpu: TCpu, sizes: { encodedBytes: number; decodedBytes: number }, gpu?: TGpu, gpuBytes = 0): ResourceGeneration<TCpu, TGpu> {
    const previous = this.entries.get(id);
    const generation: ResourceGeneration<TCpu, TGpu> = { id, generation: this.nextGeneration++, cpuEncodedBytes: sizes.encodedBytes, cpuDecodedBytes: sizes.decodedBytes, gpuBytes, cpu, gpu };
    if (previous) {
      previous.retired = true;
      this.retired.add(previous);
      this.collect(previous);
    }
    const entry: Entry<TCpu, TGpu> = { generation, references: 0, lastUsed: ++this.clock, uploadPending: false, retired: false, collected: false };
    this.entries.set(id, entry);
    this.encodedBytes += sizes.encodedBytes;
    this.decodedBytes += sizes.decodedBytes;
    this.gpuBytes += gpuBytes;
    this.evict();
    return generation;
  }

  attachGpu(generation: ResourceGeneration<TCpu, TGpu>, gpu: TGpu, gpuBytes: number): boolean {
    const entry = this.findEntry(generation);
    if (!entry || entry.generation !== generation || !this.contextAvailable || gpuBytes < 0) return false;
    if (generation.gpu !== undefined) this.deferGpuDestruction(generation.gpu);
    this.gpuBytes -= generation.gpuBytes;
    generation.gpu = gpu;
    generation.gpuBytes = gpuBytes;
    this.gpuBytes += gpuBytes;
    entry.uploadPending = false;
    this.collect(entry);
    this.evict();
    return true;
  }

  detachGpu(generation: ResourceGeneration<TCpu, TGpu>): void {
    const entry = this.findEntry(generation);
    if (!entry || entry.generation !== generation || generation.gpu === undefined) return;
    this.deferGpuDestruction(generation.gpu);
    generation.gpu = undefined;
    this.gpuBytes -= generation.gpuBytes;
    generation.gpuBytes = 0;
  }

  acquire(id: number): ResourceLease<TCpu, TGpu> | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.references++;
    entry.lastUsed = ++this.clock;
    let released = false;
    return { value: entry.generation, release: () => { if (released) return; released = true; entry.references--; entry.lastUsed = ++this.clock; this.collect(entry); this.evict(); } };
  }

  current(id: number): ResourceGeneration<TCpu, TGpu> | undefined {
    return this.entries.get(id)?.generation;
  }

  markUploadPending(id: number, pending: boolean): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.uploadPending = pending;
      if (!pending) this.restorationQueue.delete(entry.generation);
    }
  }

  remove(id: number): void {
    const entry = this.entries.get(id);
    if (entry && entry.references === 0) this.removeEntry(id, entry);
  }

  replaceDataset(): void {
    for (const [id, entry] of [...this.entries]) {
      this.entries.delete(id);
      entry.retired = true;
      entry.uploadPending = false;
      this.retired.add(entry);
      this.collect(entry);
    }
  }

  contextLost(): void {
    this.contextAvailable = false;
    this.restorationQueue.clear();
    for (const entry of [...this.entries.values(), ...this.retired]) {
      if (entry.generation.gpu !== undefined) {
        this.options.destroyGpu?.(entry.generation.gpu);
        entry.generation.gpu = undefined;
      }
      entry.generation.gpuBytes = 0;
    }
    this.gpuBytes = 0;
  }

  contextRestored(): void {
    this.contextAvailable = true;
    for (const entry of this.entries.values()) if (entry.generation.gpu === undefined) entry.uploadPending = true;
  }

  canUpload(): boolean {
    return this.contextAvailable;
  }

  private evict(): void {
    while (this.encodedBytes > this.options.budgets.encodedBytes || this.decodedBytes > this.options.budgets.decodedBytes || this.gpuBytes > this.options.budgets.gpuBytes) {
      const candidate = [...this.entries].filter(([, entry]) => entry.references === 0 && !entry.uploadPending).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!candidate) return;
      this.removeEntry(candidate[0], candidate[1]);
    }
  }

  private removeEntry(id: number, entry: Entry<TCpu, TGpu>): void {
    if (this.entries.get(id) !== entry) return;
    this.entries.delete(id);
    this.dispose(entry);
  }

  private dispose(entry: Entry<TCpu, TGpu>): void {
    if (entry.collected) return;
    entry.collected = true;
    this.encodedBytes -= entry.generation.cpuEncodedBytes;
    this.decodedBytes -= entry.generation.cpuDecodedBytes;
    this.gpuBytes -= entry.generation.gpuBytes;
    if (entry.generation.gpu !== undefined) {
      this.deferGpuDestruction(entry.generation.gpu);
      entry.generation.gpu = undefined;
      entry.generation.gpuBytes = 0;
    }
    this.options.destroyCpu?.(entry.generation.cpu);
  }

  private deferGpuDestruction(gpu: TGpu): void {
    this.pendingGpuDestructions.push(gpu);
  }

  private collect(entry: Entry<TCpu, TGpu>): void {
    if (!entry.retired || entry.references !== 0 || entry.uploadPending) return;
    this.retired.delete(entry);
    this.dispose(entry);
  }

  private findEntry(generation: ResourceGeneration<TCpu, TGpu>): Entry<TCpu, TGpu> | undefined {
    const active = this.entries.get(generation.id);
    if (active?.generation === generation) return active;
    for (const entry of this.retired) if (entry.generation === generation) return entry;
    return undefined;
  }
}
