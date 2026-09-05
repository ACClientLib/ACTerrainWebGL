import type { CachedResource } from "./datobjectcache";

export type CacheNamespace = "dat" | "server";

export interface CacheDiagnostics {
  enabled: boolean;
  usageBytes: number;
  quotaBytes: number;
  cacheBytes: number;
  queuedBytes: number;
  cacheLimitBytes: number;
  evictionCount: number;
  hits: number;
  pendingHits: number;
  misses: number;
  reinitializations: number;
  lifecycleFlushesRequested: number;
  lifecycleFlushesCompleted: number;
  lifecycleFlushesFailed: number;
  lifecycleFlushesInterrupted: number;
  lifecycleFlushBytesDrained: number;
  lifecycleFlushWritesDrained: number;
  lifecycleFlushDurationMs: number;
  lifecycleWritesRemainingAtShutdown: number;
}

export interface CacheTiming {
  name: "OPFS cache queue" | "OPFS read" | "OPFS flush" | "OPFS compaction";
  duration: number;
}

export type CacheWorkerRequest =
  | {
      id: number;
      operation: "getMany";
      namespace: CacheNamespace;
      keys: string[];
      queuedAt: number;
    }
  | { operation: "cancel"; id: number }
  | { id: number; operation: "flush"; queuedAt: number }
  | {
      id: number;
      operation: "configure";
      namespace: CacheNamespace;
      formatVersion: number;
      datasetVersion: string;
      textureProfile: string;
      cacheFootprintBytes: number;
      queuedAt: number;
    }
  | {
      id: number;
      operation: "setMany";
      namespace: CacheNamespace;
      entries: readonly (readonly [string, CachedResource])[];
    }
  | {
      id: number;
      operation: "removeOtherVersions";
      namespace: CacheNamespace;
      formatVersion: number;
      datasetVersion: string;
      queuedAt: number;
    }
  | {
      id: number;
      operation: "clear";
      namespace: CacheNamespace;
      queuedAt: number;
    }
  | { operation: "shutdown" };

export type CacheWorkerMessage =
  | { type: "ready"; diagnostics: CacheDiagnostics }
  | { type: "disabled"; reason: string; diagnostics: CacheDiagnostics }
  | {
      type: "result";
      id: number;
      values?: (CachedResource | null)[];
      accepted?: boolean;
    }
  | { type: "error"; id: number; message: string }
  | { type: "timing"; timing: CacheTiming }
  | { type: "diagnostics"; diagnostics: CacheDiagnostics };
