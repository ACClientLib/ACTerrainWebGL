import type { Mesh } from "./acdatclient";
import type {
  DatProcessorRequest,
  DatProcessorResponse,
  DatProcessorResult,
  EncodedDatResource,
} from "./datprocessorprotocol";

interface PendingRequest {
  resolve: (result: DatProcessorResult) => void;
  reject: (error: Error) => void;
  message: DatProcessorRequest;
  transfer: Transferable[];
  started: boolean;
  signal?: AbortSignal;
  cancel?: () => void;
  queuedAt: number;
  startedAt: number;
  workerIndex?: number;
}

const MAX_DECODER_WORKERS = Math.min(
  4,
  Math.max(2, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1),
);

function abortError(): DOMException {
  return new DOMException(
    "ACTerrain data processing was cancelled",
    "AbortError",
  );
}

export class DatProcessor {
  private workers: Worker[] = [];
  private busyWorkers = new Set<number>();
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private queue: number[] = [];
  private activeRequests = 0;
  private stopped = false;

  constructor() {
    for (let index = 0; index < MAX_DECODER_WORKERS; index++) {
      const worker = new Worker(
        new URL("../workers/datprocessor.worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.addEventListener("message", (event) =>
        this.handleMessage(index, event.data as DatProcessorResponse),
      );
      worker.addEventListener("error", (event) =>
        this.failAll(new Error(event.message || "ACTerrain data worker failed")),
      );
      worker.addEventListener("messageerror", () =>
        this.failAll(new Error("Unable to read ACTerrain data worker response")),
      );
      this.workers.push(worker);
    }
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  decodeMesh(
    resource: EncodedDatResource,
    signal?: AbortSignal,
  ): Promise<Mesh> {
    if (this.stopped) return Promise.reject(abortError());
    return this.request<Mesh>("mesh", resource, signal);
  }

  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.failAll(abortError());
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
  }

  private request<T extends DatProcessorResult>(
    operation: "mesh",
    resource: EncodedDatResource,
    signal?: AbortSignal,
  ): Promise<T> {
    const id = this.nextRequestId++;
    if (signal?.aborted) return Promise.reject(abortError());
    const workerResource = { ...resource, bytes: resource.bytes.slice(0) };
    const message = {
      id,
      operation,
      resource: workerResource,
    } as DatProcessorRequest;
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const request = this.pending.get(id);
        if (!request || !this.pending.delete(id)) return;
        if (request.started) {
          this.activeRequests--;
          if (request.workerIndex !== undefined) {
            this.busyWorkers.delete(request.workerIndex);
            this.workers[request.workerIndex].postMessage({ id, operation: "cancel" });
          }
        } else {
        }
        reject(abortError());
        this.pump();
      };
      this.pending.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
        message,
        transfer: [workerResource.bytes],
        started: false,
        signal,
        cancel,
        queuedAt: performance.now(),
        startedAt: 0,
      });
      signal?.addEventListener("abort", cancel, { once: true });
      this.queue.push(id);
      this.pump();
    });
  }

  private handleMessage(workerIndex: number, response: DatProcessorResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    pending.signal?.removeEventListener("abort", pending.cancel!);
    if (pending.started) {
      this.activeRequests--;
      this.busyWorkers.delete(workerIndex);
    }
    if (response.error) pending.reject(new Error(response.error));
    else if (response.result) pending.resolve(response.result);
    else pending.reject(new Error("ACTerrain data worker returned no result"));
    this.pump();
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      request.signal?.removeEventListener("abort", request.cancel!);
      request.reject(error);
    }
    this.pending.clear();
    this.queue = [];
    this.activeRequests = 0;
    this.busyWorkers.clear();
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.queue.length > 0) {
      const workerIndex = this.workers.findIndex(
        (_, index) => !this.busyWorkers.has(index),
      );
      if (workerIndex < 0) return;
      const id = this.queue.shift()!;
      const pending = this.pending.get(id);
      if (!pending || pending.started) continue;
      pending.started = true;
      pending.startedAt = performance.now();
      pending.workerIndex = workerIndex;
      this.activeRequests++;
      this.busyWorkers.add(workerIndex);
      this.workers[workerIndex].postMessage(pending.message, pending.transfer);
      pending.transfer = [];
    }
  }
}
