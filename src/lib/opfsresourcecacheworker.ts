import type { CachedResource } from "./datobjectcache";
import type {
  CacheDiagnostics,
  CacheNamespace,
  CacheTiming,
  CacheWorkerMessage,
  CacheWorkerRequest,
} from "./opfsresourcecacheprotocol";

const FORMAT_VERSION = 1;
const PACK_MAGIC = 0x4b504f41;
const RECORD_MAGIC = 0x44524f41;
const INDEX_MAGIC = 0x58494f41;
const PACK_HEADER_BYTES = 16;
const RECORD_HEADER_BYTES = 16;
const INDEX_HEADER_BYTES = 32;
const WRITE_INTERVAL_MS = 250;
const WRITE_BATCH_BYTES = 8 * 1024 * 1024;
const WRITE_CHUNK_BYTES = 1024 * 1024;
const configuredMaxBytes = Number(
  import.meta.env.VITE_ACTERRAIN_CACHE_MAX_BYTES,
);
const MAX_CACHE_BYTES =
  Number.isFinite(configuredMaxBytes) && configuredMaxBytes > 0
    ? configuredMaxBytes
    : 384 * 1024 * 1024;
const EVICTION_TARGET_BYTES = Math.floor(MAX_CACHE_BYTES * 0.85);
const COMPACTION_PHYSICAL_FACTOR = 1.75;
const COMPACTION_SLICE_MS = 3;
const QUOTA_RESERVE_BYTES = 32 * 1024 * 1024;
const ESTIMATE_INTERVAL_MS = 30_000;

interface SyncAccessHandle {
  close(): void;
  flush(): void;
  getSize(): number;
  read(buffer: Uint8Array, options?: { at: number }): number;
  truncate(size: number): void;
  write(buffer: Uint8Array, options?: { at: number }): number;
}

interface SyncFileHandle extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<CacheWorkerRequest>) => void) | null;
  postMessage(message: CacheWorkerMessage, transfer?: Transferable[]): void;
}

interface IndexEntry {
  key: string;
  offset: number;
  length: number;
  formatVersion: number;
  datasetVersion: string;
  resourceId: number;
  kind: number;
  encoding: number;
  lastAccess: number;
  checksum: number;
}

interface NamespaceState {
  namespace: CacheNamespace;
  slot: number;
  generation: number;
  packHandle: SyncAccessHandle;
  indexHandle: SyncAccessHandle;
  entries: Map<string, IndexEntry>;
  packSize: number;
  activeBytes: number;
}

interface ReadTask {
  id: number;
  namespace: CacheNamespace;
  keys: string[];
  queuedAt: number;
}

interface ControlTask {
  id: number;
  namespace: CacheNamespace;
  operation: "removeOtherVersions" | "clear";
  formatVersion?: number;
  datasetVersion?: string;
  queuedAt: number;
}

const scope = self as unknown as WorkerScope;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const states = new Map<CacheNamespace, NamespaceState>();
const readQueue: ReadTask[] = [];
const cancelledReads = new Set<number>();
const controlQueue: ControlTask[] = [];
const pendingWrites = new Map<CacheNamespace, Map<string, CachedResource>>([
  ["terrain", new Map()],
  ["scenery", new Map()],
]);
let root: FileSystemDirectoryHandle | null = null;
let enabled = false;
let processing = false;
let flushDue = false;
let compactionDue = false;
let flushTimer: number | undefined;
let estimatedUsage = 0;
let estimatedQuota = 0;
let lastEstimate = 0;

function post(message: CacheWorkerMessage, transfer?: Transferable[]): void {
  scope.postMessage(message, transfer);
}

function timing(name: CacheTiming["name"], duration: number): void {
  post({ type: "timing", timing: { name, duration } });
}

function namespaceCode(namespace: CacheNamespace): number {
  return namespace === "terrain" ? 1 : 2;
}

function cacheBytes(): number {
  let total = 0;
  for (const state of states.values()) total += state.packSize;
  return total;
}

function diagnostics(): CacheDiagnostics {
  return {
    enabled,
    usageBytes: estimatedUsage,
    quotaBytes: estimatedQuota,
    cacheBytes: cacheBytes(),
  };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readExact(
  handle: SyncAccessHandle,
  length: number,
  at: number,
): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(new ArrayBuffer(length));
  if (handle.read(result, { at }) !== length)
    throw new Error("Unexpected end of OPFS cache file");
  return result;
}

function writeExact(
  handle: SyncAccessHandle,
  bytes: Uint8Array,
  at: number,
): void {
  if (handle.write(bytes, { at }) !== bytes.byteLength)
    throw new Error("Incomplete OPFS cache write");
}

function packHeader(namespace: CacheNamespace): Uint8Array {
  const bytes = new Uint8Array(PACK_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, PACK_MAGIC, true);
  view.setUint16(4, FORMAT_VERSION, true);
  view.setUint8(6, namespaceCode(namespace));
  view.setUint16(8, PACK_HEADER_BYTES, true);
  view.setUint32(12, crc32(bytes.subarray(0, 12)), true);
  return bytes;
}

function validatePack(
  handle: SyncAccessHandle,
  namespace: CacheNamespace,
): number {
  const size = handle.getSize();
  if (size < PACK_HEADER_BYTES) throw new Error("Missing OPFS pack header");
  const bytes = readExact(handle, PACK_HEADER_BYTES, 0);
  const view = new DataView(bytes.buffer);
  if (
    view.getUint32(0, true) !== PACK_MAGIC ||
    view.getUint16(4, true) !== FORMAT_VERSION ||
    view.getUint8(6) !== namespaceCode(namespace) ||
    view.getUint16(8, true) !== PACK_HEADER_BYTES ||
    view.getUint32(12, true) !== crc32(bytes.subarray(0, 12))
  ) {
    throw new Error("Invalid OPFS pack header");
  }
  return size;
}

function serializeIndex(state: NamespaceState): Uint8Array {
  let payloadLength = 0;
  const strings = [...state.entries.values()].map((entry) => {
    const key = encoder.encode(entry.key);
    const dataset = encoder.encode(entry.datasetVersion);
    if (key.byteLength > 0xffff || dataset.byteLength > 0xffff)
      throw new Error("OPFS cache index string is too long");
    payloadLength += 44 + key.byteLength + dataset.byteLength;
    return { entry, key, dataset };
  });
  const bytes = new Uint8Array(INDEX_HEADER_BYTES + payloadLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, INDEX_MAGIC, true);
  view.setUint16(4, FORMAT_VERSION, true);
  view.setUint8(6, namespaceCode(state.namespace));
  view.setUint32(8, state.generation, true);
  view.setUint32(12, strings.length, true);
  view.setFloat64(16, state.packSize, true);
  view.setUint32(24, payloadLength, true);
  let offset = INDEX_HEADER_BYTES;
  for (const { entry, key, dataset } of strings) {
    view.setUint16(offset, key.byteLength, true);
    view.setUint16(offset + 2, dataset.byteLength, true);
    view.setFloat64(offset + 4, entry.offset, true);
    view.setUint32(offset + 12, entry.length, true);
    view.setUint32(offset + 16, entry.formatVersion, true);
    view.setUint32(offset + 20, entry.resourceId, true);
    view.setUint8(offset + 24, entry.kind);
    view.setUint8(offset + 25, entry.encoding);
    view.setFloat64(offset + 28, entry.lastAccess, true);
    view.setUint32(offset + 36, entry.checksum, true);
    view.setUint32(offset + 40, 0, true);
    offset += 44;
    bytes.set(key, offset);
    offset += key.byteLength;
    bytes.set(dataset, offset);
    offset += dataset.byteLength;
  }
  view.setUint32(28, crc32(bytes.subarray(INDEX_HEADER_BYTES)), true);
  return bytes;
}

function parseIndex(
  handle: SyncAccessHandle,
  packHandle: SyncAccessHandle,
  namespace: CacheNamespace,
): Omit<NamespaceState, "slot" | "packHandle" | "indexHandle"> {
  const size = handle.getSize();
  if (size < INDEX_HEADER_BYTES) throw new Error("Missing OPFS index header");
  const header = readExact(handle, INDEX_HEADER_BYTES, 0);
  const headerView = new DataView(header.buffer);
  const payloadLength = headerView.getUint32(24, true);
  if (
    headerView.getUint32(0, true) !== INDEX_MAGIC ||
    headerView.getUint16(4, true) !== FORMAT_VERSION ||
    headerView.getUint8(6) !== namespaceCode(namespace) ||
    size !== INDEX_HEADER_BYTES + payloadLength
  ) {
    throw new Error("Invalid OPFS index header");
  }
  const packSize = validatePack(packHandle, namespace);
  if (headerView.getFloat64(16, true) !== packSize)
    throw new Error("OPFS index and pack lengths do not match");
  const payload = readExact(handle, payloadLength, INDEX_HEADER_BYTES);
  if (headerView.getUint32(28, true) !== crc32(payload))
    throw new Error("Invalid OPFS index checksum");
  const bytes = new Uint8Array(INDEX_HEADER_BYTES + payloadLength);
  bytes.set(header);
  bytes.set(payload, INDEX_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  const entries = new Map<string, IndexEntry>();
  let activeBytes = 0;
  let offset = INDEX_HEADER_BYTES;
  for (let index = 0; index < headerView.getUint32(12, true); index++) {
    if (offset + 44 > bytes.byteLength)
      throw new Error("Truncated OPFS index entry");
    const keyLength = view.getUint16(offset, true);
    const datasetLength = view.getUint16(offset + 2, true);
    const entry: IndexEntry = {
      key: "",
      datasetVersion: "",
      offset: view.getFloat64(offset + 4, true),
      length: view.getUint32(offset + 12, true),
      formatVersion: view.getUint32(offset + 16, true),
      resourceId: view.getUint32(offset + 20, true),
      kind: view.getUint8(offset + 24),
      encoding: view.getUint8(offset + 25),
      lastAccess: view.getFloat64(offset + 28, true),
      checksum: view.getUint32(offset + 36, true),
    };
    offset += 44;
    if (
      offset + keyLength + datasetLength > bytes.byteLength ||
      entry.offset < PACK_HEADER_BYTES + RECORD_HEADER_BYTES ||
      entry.offset + entry.length > packSize
    )
      throw new Error("Invalid OPFS index entry");
    entry.key = decoder.decode(bytes.subarray(offset, offset + keyLength));
    offset += keyLength;
    entry.datasetVersion = decoder.decode(
      bytes.subarray(offset, offset + datasetLength),
    );
    offset += datasetLength;
    if (entries.has(entry.key)) throw new Error("Duplicate OPFS index key");
    entries.set(entry.key, entry);
    activeBytes += RECORD_HEADER_BYTES + entry.length;
  }
  if (offset !== bytes.byteLength)
    throw new Error("OPFS index has trailing bytes");
  return {
    namespace,
    generation: headerView.getUint32(8, true),
    entries,
    packSize,
    activeBytes,
  };
}

async function openHandle(name: string): Promise<SyncAccessHandle> {
  const file = (await root!.getFileHandle(name, {
    create: true,
  })) as SyncFileHandle;
  return file.createSyncAccessHandle();
}

function names(
  namespace: CacheNamespace,
  slot: number,
): { pack: string; index: string } {
  return {
    pack: `${namespace}-${slot}.pack`,
    index: `${namespace}-${slot}.index`,
  };
}

async function openSlot(
  namespace: CacheNamespace,
  slot: number,
): Promise<NamespaceState | null> {
  const files = names(namespace, slot);
  let packHandle: SyncAccessHandle | null = null;
  let indexHandle: SyncAccessHandle | null = null;
  try {
    packHandle = await openHandle(files.pack);
    indexHandle = await openHandle(files.index);
  } catch (error) {
    packHandle?.close();
    indexHandle?.close();
    throw error;
  }
  if (!packHandle || !indexHandle)
    throw new Error("Unable to open OPFS cache files");
  try {
    const parsed = parseIndex(indexHandle, packHandle, namespace);
    return { ...parsed, slot, packHandle, indexHandle };
  } catch {
    packHandle.close();
    indexHandle.close();
    return null;
  }
}

async function createSlot(
  namespace: CacheNamespace,
  slot: number,
  generation: number,
): Promise<NamespaceState> {
  const files = names(namespace, slot);
  let packHandle: SyncAccessHandle | null = null;
  let indexHandle: SyncAccessHandle | null = null;
  try {
    packHandle = await openHandle(files.pack);
    indexHandle = await openHandle(files.index);
  } catch (error) {
    packHandle?.close();
    indexHandle?.close();
    throw error;
  }
  if (!packHandle || !indexHandle)
    throw new Error("Unable to create OPFS cache files");
  packHandle.truncate(0);
  const header = packHeader(namespace);
  writeExact(packHandle, header, 0);
  packHandle.flush();
  const state: NamespaceState = {
    namespace,
    slot,
    generation,
    packHandle,
    indexHandle,
    entries: new Map(),
    packSize: header.byteLength,
    activeBytes: 0,
  };
  persistIndex(state);
  return state;
}

async function removeSlot(
  namespace: CacheNamespace,
  slot: number,
): Promise<void> {
  const files = names(namespace, slot);
  await root!.removeEntry(files.pack).catch(() => undefined);
  await root!.removeEntry(files.index).catch(() => undefined);
}

async function openNamespace(
  namespace: CacheNamespace,
): Promise<NamespaceState> {
  const candidates: NamespaceState[] = [];
  for (let slot = 0; slot < 2; slot++) {
    const state = await openSlot(namespace, slot);
    if (state) candidates.push(state);
  }
  candidates.sort((left, right) => right.generation - left.generation);
  const selected = candidates.shift();
  for (const unused of candidates) {
    unused.packHandle.close();
    unused.indexHandle.close();
  }
  if (selected) return selected;
  await removeSlot(namespace, 0);
  await removeSlot(namespace, 1);
  return createSlot(namespace, 0, 1);
}

function persistIndex(state: NamespaceState): void {
  const bytes = serializeIndex(state);
  writeExact(state.indexHandle, bytes, 0);
  state.indexHandle.truncate(bytes.byteLength);
  state.indexHandle.flush();
}

async function updateEstimate(force = false): Promise<void> {
  if (!force && performance.now() - lastEstimate < ESTIMATE_INTERVAL_MS) return;
  lastEstimate = performance.now();
  try {
    const estimate = await navigator.storage.estimate();
    estimatedUsage = estimate.usage ?? 0;
    estimatedQuota = estimate.quota ?? 0;
    post({ type: "diagnostics", diagnostics: diagnostics() });
  } catch {
    // Storage estimates are diagnostic and must never disable cache reads.
  }
}

function recordHeader(length: number): Uint8Array {
  const bytes = new Uint8Array(RECORD_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, RECORD_MAGIC, true);
  view.setUint16(4, FORMAT_VERSION, true);
  view.setUint16(6, RECORD_HEADER_BYTES, true);
  view.setUint32(8, length, true);
  view.setUint32(12, 0);
  return bytes;
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

function readRecord(state: NamespaceState, entry: IndexEntry): Uint8Array {
  return readExact(state.packHandle, entry.length, entry.offset);
}

async function readValues(task: ReadTask): Promise<void> {
  timing("OPFS cache queue", Date.now() - task.queuedAt);
  const state = states.get(task.namespace)!;
  const started = performance.now();
  const values: (CachedResource | null)[] = [];
  const transfers: Transferable[] = [];
  let indexDirty = false;
  for (const key of task.keys) {
    if (cancelledReads.delete(task.id)) {
      if (indexDirty) persistIndex(state);
      return;
    }
    const entry = state.entries.get(key);
    if (!entry) {
      values.push(null);
      continue;
    }
    try {
      const bytes = readRecord(state, entry);
      const buffer = bytes.buffer as ArrayBuffer;
      entry.lastAccess = Date.now();
      values.push({
        formatVersion: entry.formatVersion,
        datasetVersion: entry.datasetVersion,
        resourceId: entry.resourceId,
        kind: entry.kind,
        encoding: entry.encoding,
        bytes: buffer,
      });
      transfers.push(buffer);
    } catch {
      state.entries.delete(key);
      state.activeBytes -= RECORD_HEADER_BYTES + entry.length;
      indexDirty = true;
      values.push(null);
      compactionDue = true;
    }
  }
  if (indexDirty) persistIndex(state);
  timing("OPFS read", performance.now() - started);
  post({ type: "result", id: task.id, values }, transfers);
}

function queueFlush(): void {
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flushDue = true;
    void pump();
  }, WRITE_INTERVAL_MS) as unknown as number;
}

function totalActiveBytes(): number {
  let result = 0;
  for (const state of states.values()) result += state.activeBytes;
  return result;
}

function evictIfNeeded(): void {
  if (totalActiveBytes() <= MAX_CACHE_BYTES) return;
  evictToTarget();
}

function evictToTarget(): void {
  const entries = [...states.values()]
    .flatMap((state) =>
      [...state.entries.values()].map((entry) => ({ state, entry })),
    )
    .sort((left, right) => left.entry.lastAccess - right.entry.lastAccess);
  for (const { state, entry } of entries) {
    if (totalActiveBytes() <= EVICTION_TARGET_BYTES) break;
    if (!state.entries.delete(entry.key)) continue;
    state.activeBytes -= RECORD_HEADER_BYTES + entry.length;
  }
  compactionDue = true;
}

async function writeBytes(
  handle: SyncAccessHandle,
  bytes: Uint8Array,
  at: number,
): Promise<void> {
  for (let offset = 0; offset < bytes.byteLength; offset += WRITE_CHUNK_BYTES) {
    writeExact(
      handle,
      bytes.subarray(
        offset,
        Math.min(bytes.byteLength, offset + WRITE_CHUNK_BYTES),
      ),
      at + offset,
    );
    if (offset + WRITE_CHUNK_BYTES < bytes.byteLength)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function flushWrites(): Promise<void> {
  flushDue = false;
  await updateEstimate();
  if (cacheBytes() >= MAX_CACHE_BYTES * COMPACTION_PHYSICAL_FACTOR) {
    evictToTarget();
    compactionDue = true;
    return;
  }
  let quotaBudget =
    estimatedQuota > 0
      ? estimatedQuota - estimatedUsage - QUOTA_RESERVE_BYTES
      : Number.POSITIVE_INFINITY;
  let budget = WRITE_BATCH_BYTES;
  const batches = new Map<CacheNamespace, [string, CachedResource][]>([
    ["terrain", []],
    ["scenery", []],
  ]);
  for (const namespace of ["terrain", "scenery"] as const) {
    const writes = pendingWrites.get(namespace)!;
    for (const [key, value] of writes) {
      const bytes = value.bytes.byteLength + RECORD_HEADER_BYTES;
      if (budget < WRITE_BATCH_BYTES && bytes > budget) break;
      writes.delete(key);
      if (bytes > quotaBudget) {
        compactionDue = true;
        continue;
      }
      batches.get(namespace)!.push([key, value]);
      quotaBudget -= bytes;
      budget -= Math.min(bytes, budget);
      if (budget === 0) break;
    }
    if (budget === 0) break;
  }
  const started = performance.now();
  for (const namespace of ["terrain", "scenery"] as const) {
    const state = states.get(namespace)!;
    const batch = batches.get(namespace)!;
    if (readQueue.length > 0) {
      for (const [key, value] of batch)
        pendingWrites.get(namespace)!.set(key, value);
      batch.length = 0;
      flushDue = true;
      continue;
    }
    for (let batchIndex = 0; batchIndex < batch.length; batchIndex++) {
      const [key, value] = batch[batchIndex];
      const bytes = new Uint8Array(value.bytes);
      const header = recordHeader(bytes.byteLength);
      const previous = state.entries.get(key);
      const recordOffset = state.packSize;
      const payloadOffset = recordOffset + RECORD_HEADER_BYTES;
      try {
        writeExact(state.packHandle, header, recordOffset);
        await writeBytes(state.packHandle, bytes, payloadOffset);
      } catch (error) {
        state.packHandle.truncate(recordOffset);
        state.packHandle.flush();
        if (isQuotaError(error)) {
          compactionDue = true;
          continue;
        }
        throw error;
      }
      if (previous) state.activeBytes -= RECORD_HEADER_BYTES + previous.length;
      state.packSize = payloadOffset + bytes.byteLength;
      state.activeBytes += RECORD_HEADER_BYTES + bytes.byteLength;
      state.entries.set(key, {
        key,
        offset: payloadOffset,
        length: bytes.byteLength,
        formatVersion: value.formatVersion,
        datasetVersion: value.datasetVersion,
        resourceId: value.resourceId,
        kind: value.kind,
        encoding: value.encoding,
        lastAccess: Date.now(),
        checksum: 0,
      });
      if (batchIndex + 1 < batch.length) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (readQueue.length > 0) {
          for (const [remainingKey, remainingValue] of batch.slice(
            batchIndex + 1,
          ))
            pendingWrites.get(namespace)!.set(remainingKey, remainingValue);
          batch.splice(batchIndex + 1);
          flushDue = true;
          break;
        }
      }
    }
    if (batches.get(namespace)!.length > 0) state.packHandle.flush();
  }
  evictIfNeeded();
  for (const namespace of ["terrain", "scenery"] as const) {
    if (batches.get(namespace)!.length > 0)
      persistIndex(states.get(namespace)!);
  }
  timing("OPFS flush", performance.now() - started);
  if ([...pendingWrites.values()].some((writes) => writes.size > 0)) {
    flushDue = true;
  }
  if (
    [...states.values()].some(
      (state) =>
        state.packSize >
        state.activeBytes * COMPACTION_PHYSICAL_FACTOR + PACK_HEADER_BYTES,
    )
  )
    compactionDue = true;
}

async function handleControl(task: ControlTask): Promise<void> {
  timing("OPFS cache queue", Date.now() - task.queuedAt);
  try {
    if (task.operation === "clear") {
      await clearNamespace(task.namespace);
    } else {
      const state = states.get(task.namespace)!;
      let changed = false;
      for (const entry of [...state.entries.values()]) {
        if (
          entry.formatVersion === task.formatVersion &&
          entry.datasetVersion === task.datasetVersion
        )
          continue;
        state.entries.delete(entry.key);
        state.activeBytes -= RECORD_HEADER_BYTES + entry.length;
        changed = true;
      }
      if (changed) {
        const started = performance.now();
        persistIndex(state);
        timing("OPFS flush", performance.now() - started);
        compactionDue = true;
      }
    }
    post({ type: "result", id: task.id });
  } catch (error) {
    post({
      type: "error",
      id: task.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function clearNamespace(namespace: CacheNamespace): Promise<void> {
  const state = states.get(namespace);
  if (state) {
    state.packHandle.close();
    state.indexHandle.close();
  }
  pendingWrites.get(namespace)!.clear();
  await removeSlot(namespace, 0);
  await removeSlot(namespace, 1);
  states.set(
    namespace,
    await createSlot(namespace, 0, (state?.generation ?? 0) + 1),
  );
  post({ type: "diagnostics", diagnostics: diagnostics() });
}

async function drainReads(): Promise<void> {
  while (readQueue.length > 0) {
    const task = readQueue.shift()!;
    try {
      await readValues(task);
    } catch (error) {
      post({
        type: "error",
        id: task.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function compactNamespace(namespace: CacheNamespace): Promise<void> {
  const source = states.get(namespace)!;
  if (
    source.packSize <=
    source.activeBytes * COMPACTION_PHYSICAL_FACTOR + PACK_HEADER_BYTES
  )
    return;
  const started = performance.now();
  const targetSlot = source.slot === 0 ? 1 : 0;
  await removeSlot(namespace, targetSlot);
  const target = await createSlot(namespace, targetSlot, source.generation + 1);
  try {
    let copiedSinceYield = 0;
    let sliceStarted = performance.now();
    for (const entry of source.entries.values()) {
      const bytes = readRecord(source, entry);
      const header = recordHeader(entry.length);
      writeExact(target.packHandle, header, target.packSize);
      const offset = target.packSize + RECORD_HEADER_BYTES;
      await writeBytes(target.packHandle, bytes, offset);
      target.entries.set(entry.key, { ...entry, offset });
      target.packSize = offset + entry.length;
      target.activeBytes += RECORD_HEADER_BYTES + entry.length;
      copiedSinceYield += RECORD_HEADER_BYTES + entry.length;
      if (
        copiedSinceYield >= WRITE_CHUNK_BYTES ||
        performance.now() - sliceStarted >= COMPACTION_SLICE_MS
      ) {
        copiedSinceYield = 0;
        await drainReads();
        await new Promise((resolve) => setTimeout(resolve, 0));
        sliceStarted = performance.now();
      }
    }
    target.packHandle.flush();
    persistIndex(target);
    states.set(namespace, target);
    source.packHandle.close();
    source.indexHandle.close();
    await removeSlot(namespace, source.slot);
    timing("OPFS compaction", performance.now() - started);
    post({ type: "diagnostics", diagnostics: diagnostics() });
  } catch (error) {
    target.packHandle.close();
    target.indexHandle.close();
    await removeSlot(namespace, targetSlot);
    throw error;
  }
}

async function compact(): Promise<void> {
  compactionDue = false;
  for (const namespace of ["terrain", "scenery"] as const) {
    await compactNamespace(namespace);
    if (readQueue.length > 0) await drainReads();
  }
  if ([...pendingWrites.values()].some((writes) => writes.size > 0))
    flushDue = true;
}

async function pump(): Promise<void> {
  if (!enabled || processing) return;
  processing = true;
  try {
    while (enabled) {
      if (readQueue.length > 0) {
        await drainReads();
        continue;
      }
      if (controlQueue.length > 0) {
        await handleControl(controlQueue.shift()!);
        continue;
      }
      if (flushDue) {
        await flushWrites();
        continue;
      }
      if (compactionDue) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (readQueue.length === 0 && !flushDue) await compact();
        continue;
      }
      break;
    }
  } catch (error) {
    disable(error instanceof Error ? error.message : String(error));
  } finally {
    processing = false;
    if (
      enabled &&
      (readQueue.length > 0 ||
        controlQueue.length > 0 ||
        flushDue ||
        compactionDue)
    )
      void pump();
  }
}

function disable(reason: string): void {
  enabled = false;
  for (const state of states.values()) {
    try {
      state.packHandle.close();
    } catch {
      /* already closed */
    }
    try {
      state.indexHandle.close();
    } catch {
      /* already closed */
    }
  }
  states.clear();
  for (const task of readQueue.splice(0))
    post({ type: "result", id: task.id, values: task.keys.map(() => null) });
  for (const task of controlQueue.splice(0))
    post({ type: "result", id: task.id });
  post({ type: "disabled", reason, diagnostics: diagnostics() });
}

async function initialize(): Promise<void> {
  try {
    if (!navigator.storage?.getDirectory)
      throw new Error("OPFS is unavailable");
    root = await navigator.storage.getDirectory();
    states.set("terrain", await openNamespace("terrain"));
    states.set("scenery", await openNamespace("scenery"));
    enabled = true;
    try {
      await navigator.storage.persist();
    } catch {
      /* Persistence is optional. */
    }
    await updateEstimate(true);
    post({ type: "ready", diagnostics: diagnostics() });
  } catch (error) {
    disable(error instanceof Error ? error.message : String(error));
  }
}

scope.onmessage = (event) => {
  const request = event.data;
  if (request.operation === "shutdown") {
    enabled = false;
    for (const state of states.values()) {
      try {
        persistIndex(state);
      } catch {
        /* Cache is disposable. */
      }
      try {
        state.packHandle.close();
      } catch {
        /* already closed */
      }
      try {
        state.indexHandle.close();
      } catch {
        /* already closed */
      }
    }
    states.clear();
    return;
  }
  if (!enabled) {
    if ("id" in request) {
      if (request.operation === "getMany")
        post({
          type: "result",
          id: request.id,
          values: request.keys.map(() => null),
        });
      else post({ type: "result", id: request.id });
    }
    return;
  }
  if (request.operation === "getMany") {
    readQueue.push(request);
    void pump();
    return;
  }
  if (request.operation === "cancel") {
    cancelledReads.add(request.id);
    const index = readQueue.findIndex((task) => task.id === request.id);
    if (index >= 0) {
      readQueue.splice(index, 1);
      cancelledReads.delete(request.id);
    }
    return;
  }
  if (request.operation === "setMany") {
    const writes = pendingWrites.get(request.namespace)!;
    for (const [key, value] of request.entries) writes.set(key, value);
    let queuedBytes = 0;
    for (const value of writes.values()) queuedBytes += value.bytes.byteLength;
    if (queuedBytes >= WRITE_BATCH_BYTES) {
      flushDue = true;
      void pump();
    } else {
      queueFlush();
    }
    return;
  }
  controlQueue.push(request);
  void pump();
};

void initialize();
