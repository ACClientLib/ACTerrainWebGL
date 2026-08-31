import type { CachedResource } from './datobjectcache'

export type CacheNamespace = 'terrain' | 'scenery'

export interface CacheDiagnostics {
  enabled: boolean
  usageBytes: number
  quotaBytes: number
  cacheBytes: number
}

export interface CacheTiming {
  name: 'OPFS cache queue' | 'OPFS read' | 'OPFS flush' | 'OPFS compaction'
  duration: number
}

export type CacheWorkerRequest =
  | { id: number; operation: 'getMany'; namespace: CacheNamespace; keys: string[]; queuedAt: number }
  | { operation: 'setMany'; namespace: CacheNamespace; entries: readonly (readonly [string, CachedResource])[] }
  | { id: number; operation: 'removeOtherVersions'; namespace: CacheNamespace; formatVersion: number; datasetVersion: string; queuedAt: number }
  | { id: number; operation: 'clear'; namespace: CacheNamespace; queuedAt: number }
  | { operation: 'shutdown' }

export type CacheWorkerMessage =
  | { type: 'ready'; diagnostics: CacheDiagnostics }
  | { type: 'disabled'; reason: string; diagnostics: CacheDiagnostics }
  | { type: 'result'; id: number; values?: (CachedResource | null)[] }
  | { type: 'error'; id: number; message: string }
  | { type: 'timing'; timing: CacheTiming }
  | { type: 'diagnostics'; diagnostics: CacheDiagnostics }
