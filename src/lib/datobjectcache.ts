import { LoadingProfiler, type LoadingTimingSnapshot } from "./loadingprofiler";
import type {
  CacheDiagnostics,
  CacheNamespace,
  CacheWorkerMessage,
  CacheWorkerRequest,
} from "./opfsresourcecacheprotocol";
import CacheWorker from "./opfsresourcecacheworker?worker";

export interface CachedResource {
  formatVersion: number;
  datasetVersion: string;
  resourceId: number;
  kind: number;
  encoding: number;
  bytes: ArrayBuffer;
}

const DATABASE_NAMES = ["ac-terrain-resource-cache", "ac-dat-object-cache"];
const EMPTY_DIAGNOSTICS: CacheDiagnostics = {
  enabled: false,
  usageBytes: 0,
  quotaBytes: 0,
  cacheBytes: 0,
};

interface PendingRequest {
  resolve: (values?: (CachedResource | null)[]) => void;
  reject: (error: Error) => void;
}

type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;
type AwaitedCacheRequest = WithoutId<CacheWorkerRequest>;

class OpfsCacheWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private profiler = new LoadingProfiler();
  private ready: Promise<boolean>;
  private resolveReady!: (enabled: boolean) => void;
  private initialized = false;
  diagnostics: CacheDiagnostics = { ...EMPTY_DIAGNOSTICS };

  constructor() {
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    try {
      this.worker = new CacheWorker();
      this.worker.onmessage = (event) =>
        this.handleMessage(event.data as CacheWorkerMessage);
      this.worker.onerror = (event) =>
        this.disable(event.message || "OPFS cache worker failed");
      addEventListener("pagehide", () => this.shutdown(), { once: true });
      setTimeout(() => {
        if (!this.initialized) this.disable("initialization timed out");
      }, 5000);
    } catch (error) {
      this.disable(error instanceof Error ? error.message : String(error));
    }
  }

  get loadTimings(): LoadingTimingSnapshot {
    return this.profiler.snapshot();
  }

  async getMany(
    namespace: CacheNamespace,
    keys: string[],
  ): Promise<(CachedResource | null)[]> {
    if (keys.length === 0) return [];
    if (!(await this.ready) || !this.worker) return keys.map(() => null);
    const values = await this.request({
      operation: "getMany",
      namespace,
      keys,
      queuedAt: Date.now(),
    });
    return values ?? keys.map(() => null);
  }

  setMany(
    namespace: CacheNamespace,
    entries: readonly (readonly [string, CachedResource])[],
  ): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    void this.ready.then((enabled) => {
      if (!enabled || !this.worker) return;
      const request: CacheWorkerRequest = {
        operation: "setMany",
        namespace,
        entries,
      };
      this.worker.postMessage(request);
    });
    return Promise.resolve();
  }

  async removeOtherVersions(
    namespace: CacheNamespace,
    formatVersion: number,
    datasetVersion: string,
  ): Promise<void> {
    if (!(await this.ready) || !this.worker) return;
    await this.request({
      operation: "removeOtherVersions",
      namespace,
      formatVersion,
      datasetVersion,
      queuedAt: Date.now(),
    });
  }

  async clear(namespace: CacheNamespace): Promise<void> {
    if (!(await this.ready) || !this.worker) return;
    await this.request({ operation: "clear", namespace, queuedAt: Date.now() });
  }

  private request(
    request: AwaitedCacheRequest,
  ): Promise<(CachedResource | null)[] | undefined> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...request, id } as CacheWorkerRequest);
    });
  }

  private handleMessage(message: CacheWorkerMessage): void {
    if (message.type === "ready") {
      this.diagnostics = message.diagnostics;
      if (!this.initialized) {
        this.initialized = true;
        this.resolveReady(true);
        if ("requestIdleCallback" in globalThis)
          requestIdleCallback(() => this.deleteIndexedDbCaches(), {
            timeout: 5000,
          });
        else setTimeout(() => this.deleteIndexedDbCaches(), 1000);
      }
      return;
    }
    if (message.type === "disabled") {
      this.diagnostics = message.diagnostics;
      this.disable(message.reason);
      return;
    }
    if (message.type === "diagnostics") {
      this.diagnostics = message.diagnostics;
      return;
    }
    if (message.type === "timing") {
      this.profiler.record(message.timing.name, message.timing.duration);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.type === "error") pending.reject(new Error(message.message));
    else pending.resolve(message.values);
  }

  private disable(reason: string): void {
    this.diagnostics = { ...this.diagnostics, enabled: false };
    this.worker?.terminate();
    this.worker = null;
    if (!this.initialized) {
      this.initialized = true;
      this.resolveReady(false);
      console.info(
        `OPFS resource cache disabled; using network-only loading: ${reason}`,
      );
    }
    for (const pending of this.pending.values()) pending.resolve();
    this.pending.clear();
  }

  private shutdown(): void {
    if (!this.worker) return;
    const request: CacheWorkerRequest = { operation: "shutdown" };
    this.worker.postMessage(request);
    this.worker = null;
  }

  private deleteIndexedDbCaches(): void {
    if (!("indexedDB" in globalThis)) return;
    for (const name of DATABASE_NAMES) {
      try {
        const request = indexedDB.deleteDatabase(name);
        request.onerror = () => undefined;
        request.onblocked = () => undefined;
      } catch {
        // The old cache is disposable and deletion is best effort.
      }
    }
  }
}

const sharedWorker = new OpfsCacheWorkerClient();

export class DatObjectCache {
  constructor(private namespace: CacheNamespace = "terrain") {}

  get loadTimings(): LoadingTimingSnapshot {
    return sharedWorker.loadTimings;
  }
  get diagnostics(): CacheDiagnostics {
    return { ...sharedWorker.diagnostics };
  }

  async get(key: string): Promise<CachedResource | null> {
    return (await sharedWorker.getMany(this.namespace, [key]))[0];
  }

  getMany(keys: string[]): Promise<(CachedResource | null)[]> {
    return sharedWorker.getMany(this.namespace, keys);
  }

  set(key: string, value: CachedResource): Promise<void> {
    return sharedWorker.setMany(this.namespace, [[key, value]]);
  }

  setMany(
    entries: readonly (readonly [string, CachedResource])[],
  ): Promise<void> {
    return sharedWorker.setMany(this.namespace, entries);
  }

  removeOtherVersions(
    formatVersion: number,
    datasetVersion: string,
  ): Promise<void> {
    return sharedWorker.removeOtherVersions(
      this.namespace,
      formatVersion,
      datasetVersion,
    );
  }

  clear(): Promise<void> {
    return sharedWorker.clear(this.namespace);
  }
}
