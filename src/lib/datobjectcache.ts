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
  queuedBytes: 0,
  cacheLimitBytes: 0,
  evictionCount: 0,
  hits: 0,
  pendingHits: 0,
  misses: 0,
  reinitializations: 0,
  lifecycleFlushesRequested: 0,
  lifecycleFlushesCompleted: 0,
  lifecycleFlushesFailed: 0,
  lifecycleFlushesInterrupted: 0,
  lifecycleFlushBytesDrained: 0,
  lifecycleFlushWritesDrained: 0,
  lifecycleFlushDurationMs: 0,
  lifecycleWritesRemainingAtShutdown: 0,
};

interface PendingRequest {
  resolve: (values?: (CachedResource | null)[]) => void;
  reject: (error: Error) => void;
}

interface QueuedRead {
  namespace: CacheNamespace;
  keys: string[];
  signal?: AbortSignal;
  aborted: boolean;
  cancel?: () => void;
  resolve: (values: (CachedResource | null)[]) => void;
  reject: (error: Error) => void;
}

type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;
type AwaitedCacheRequest = WithoutId<CacheWorkerRequest>;

class OpfsCacheWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private queuedReads: QueuedRead[] = [];
  private readBatchScheduled = false;
  private ready: Promise<boolean>;
  private resolveReady!: (enabled: boolean) => void;
  private initialized = false;
  private readonly lifecycleController = new AbortController();
  private initializationTimer: ReturnType<typeof setTimeout> | undefined;
  private readBatchTimer: ReturnType<typeof setTimeout> | undefined;
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
      addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden")
          void this.flush().catch(() => undefined);
      }, { signal: this.lifecycleController.signal });
      addEventListener("pagehide", () => this.shutdown(), { once: true, signal: this.lifecycleController.signal });
      this.initializationTimer = setTimeout(() => {
        if (!this.initialized) this.disable("initialization timed out");
      }, 5000);
    } catch (error) {
      this.disable(error instanceof Error ? error.message : String(error));
    }
  }


  async getMany(
    namespace: CacheNamespace,
    keys: string[],
    signal?: AbortSignal,
  ): Promise<(CachedResource | null)[]> {
    if (keys.length === 0) return [];
    if (!(await this.ready) || !this.worker) return keys.map(() => null);
    return new Promise((resolve, reject) => {
      const queued: QueuedRead = {
        namespace,
        keys,
        signal,
        aborted: false,
        resolve,
        reject,
      };
      const cancel = () => {
        if (queued.aborted) return;
        queued.aborted = true;
        resolve(keys.map(() => null));
      };
      queued.cancel = cancel;
      if (signal?.aborted) {
        cancel();
        return;
      }
      signal?.addEventListener("abort", cancel, { once: true });
      this.queuedReads.push(queued);
      if (this.readBatchScheduled) return;
      this.readBatchScheduled = true;
      this.readBatchTimer = setTimeout(() => this.flushReadBatch(), 0);
    });
  }

  setMany(
    namespace: CacheNamespace,
    entries: readonly (readonly [string, CachedResource])[],
  ): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    return this.ready.then(async (enabled) => {
      if (!enabled || !this.worker) return;
      const request: CacheWorkerRequest = {
        id: this.nextId++,
        operation: "setMany",
        namespace,
        entries,
      };
      await new Promise<void>((resolve, reject) => {
        this.pending.set(request.id, {
          resolve: () => resolve(),
          reject,
        });
        this.worker!.postMessage(request);
      });
    });
  }

  flush(): Promise<void> {
    if (!this.worker || !this.initialized) return Promise.resolve();
    return this.request({ operation: "flush", queuedAt: Date.now() }).then(
      () => undefined,
    );
  }

  async configure(
    namespace: CacheNamespace,
    formatVersion: number,
    datasetVersion: string,
    textureProfile: string,
    cacheFootprintBytes: number,
  ): Promise<void> {
    if (!(await this.ready) || !this.worker) return;
    await this.request({
      operation: "configure",
      namespace,
      formatVersion,
      datasetVersion,
      textureProfile,
      cacheFootprintBytes,
      queuedAt: Date.now(),
    });
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
    signal?: AbortSignal,
  ): Promise<(CachedResource | null)[] | undefined> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.worker || signal?.aborted) {
        resolve(undefined);
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...request, id } as CacheWorkerRequest);
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.pending.delete(id)) return;
          this.worker?.postMessage({ operation: "cancel", id });
          resolve(undefined);
        },
        { once: true },
      );
    });
  }

  private flushReadBatch(): void {
    this.readBatchScheduled = false;
    const queued = this.queuedReads.splice(0);
    const active = queued.filter((request) => !request.aborted);
    if (active.length === 0) return;
    for (const namespace of ["dat", "server"] as const) {
      const requests = active.filter(
        (request) => request.namespace === namespace,
      );
      if (requests.length > 0) this.flushNamespaceReads(namespace, requests);
    }
  }

  private flushNamespaceReads(
    namespace: CacheNamespace,
    active: QueuedRead[],
  ): void {
    const keys = active.flatMap((request) => request.keys);
    void this.request({
      operation: "getMany",
      namespace,
      keys,
      queuedAt: Date.now(),
    }).then(
      (values) => {
        let offset = 0;
        for (const request of active) {
          const result =
            values?.slice(offset, offset + request.keys.length) ??
            request.keys.map(() => null);
          offset += request.keys.length;
          request.signal?.removeEventListener("abort", request.cancel!);
          if (!request.aborted) request.resolve(result);
        }
      },
      (error) => {
        for (const request of active) {
          request.signal?.removeEventListener("abort", request.cancel!);
          if (!request.aborted) request.reject(error);
        }
      },
    );
  }

  private handleMessage(message: CacheWorkerMessage): void {
    if (message.type === "ready") {
      clearTimeout(this.initializationTimer);
      this.diagnostics = message.diagnostics;
      if (!this.initialized) {
        this.initialized = true;
        this.resolveReady(true);
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
    if (message.type === "timing") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.type === "error") pending.reject(new Error(message.message));
    else pending.resolve(message.values);
  }

  private disable(reason: string): void {
    this.lifecycleController.abort();
    clearTimeout(this.initializationTimer);
    clearTimeout(this.readBatchTimer);
    this.readBatchScheduled = false;
    this.diagnostics = { ...this.diagnostics, enabled: false };
    this.worker?.terminate();
    this.worker = null;
    if (!this.initialized) {
      this.initialized = true;
      this.resolveReady(false);
    }
    for (const pending of this.pending.values()) pending.resolve();
    this.pending.clear();
    for (const request of this.queuedReads) {
      request.signal?.removeEventListener("abort", request.cancel!);
      if (!request.aborted) request.resolve(request.keys.map(() => null));
    }
    this.queuedReads = [];
  }

  shutdown(): void {
    // The persistent cache is disposable. Do not drain queued writes while
    // navigation is tearing down the document and starting another worker.
    this.disable("shutdown");
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
  static shutdown(): void {
    sharedWorker.shutdown();
  }

  constructor(private readonly namespace: CacheNamespace) {}

  get diagnostics(): CacheDiagnostics {
    return { ...sharedWorker.diagnostics };
  }

  configure(
    formatVersion: number,
    datasetVersion: string,
    textureProfile: string,
    cacheFootprintBytes: number,
  ): Promise<void> {
    return sharedWorker.configure(
      this.namespace,
      formatVersion,
      datasetVersion,
      textureProfile,
      cacheFootprintBytes,
    );
  }

  async get(key: string): Promise<CachedResource | null> {
    return (await sharedWorker.getMany(this.namespace, [key]))[0];
  }

  getMany(
    keys: string[],
    signal?: AbortSignal,
  ): Promise<(CachedResource | null)[]> {
    return sharedWorker.getMany(this.namespace, keys, signal);
  }

  set(key: string, value: CachedResource): Promise<void> {
    return sharedWorker.setMany(this.namespace, [[key, value]]);
  }

  setMany(
    entries: readonly (readonly [string, CachedResource])[],
  ): Promise<void> {
    return sharedWorker.setMany(this.namespace, entries);
  }

  flush(): Promise<void> {
    return sharedWorker.flush();
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

  async removeLegacyCaches(): Promise<void> {
    await sharedWorker.flush();
    if ("indexedDB" in globalThis) {
      for (const name of DATABASE_NAMES) {
        try {
          const request = indexedDB.deleteDatabase(name);
          request.onerror = () => undefined;
          request.onblocked = () => undefined;
        } catch {
          // Legacy cache deletion is best effort after v3 initialization.
        }
      }
    }
    try {
      const root = await navigator.storage.getDirectory();
      for (const name of [
        "acterrain-format10",
        "acterrain-format13",
        "acterrain-format15",
      ]) {
        await root.removeEntry(name, { recursive: true }).catch(() => undefined);
      }
    } catch {
      // The legacy OPFS namespace may not exist.
    }
  }
}
