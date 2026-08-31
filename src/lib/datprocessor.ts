import type { Mesh } from './acdatclient'
import type {
  DatProcessorRequest,
  DatProcessorResponse,
  DatProcessorResult,
  EncodedDatResource,
  ProcessedResourceTexture
} from './datprocessorprotocol'
import { LoadingProfiler, type LoadingTimingSnapshot } from './loadingprofiler'

interface PendingRequest {
  resolve: (result: DatProcessorResult) => void
  reject: (error: Error) => void
  message: DatProcessorRequest
  transfer: Transferable[]
  started: boolean
  signal?: AbortSignal
  cancel?: () => void
  queuedAt: number
  startedAt: number
}

const MAX_REQUESTS_IN_FLIGHT = 2

function abortError(): DOMException {
  return new DOMException('ACTerrain data processing was cancelled', 'AbortError')
}

export class DatProcessor {
  private worker = new Worker(new URL('../workers/datprocessor.worker.ts', import.meta.url), { type: 'module' })
  private nextRequestId = 1
  private pending = new Map<number, PendingRequest>()
  private queue: number[] = []
  private activeRequests = 0
  private profiler = new LoadingProfiler()

  constructor() {
    this.worker.addEventListener('message', event => this.handleMessage(event.data as DatProcessorResponse))
    this.worker.addEventListener('error', event => this.failAll(new Error(event.message || 'ACTerrain data worker failed')))
    this.worker.addEventListener('messageerror', () => this.failAll(new Error('Unable to read ACTerrain data worker response')))
  }

  get pendingRequestCount(): number { return this.pending.size }
  get loadTimings(): LoadingTimingSnapshot { return this.profiler.snapshot() }

  decodeMesh(resource: EncodedDatResource, signal?: AbortSignal): Promise<Mesh> {
    return this.request<Mesh>('mesh', resource, signal)
  }

  decodeTexture(resource: EncodedDatResource, signal?: AbortSignal): Promise<ProcessedResourceTexture> {
    return this.request<ProcessedResourceTexture>('texture', resource, signal)
  }

  private request<T extends DatProcessorResult>(operation: 'mesh' | 'texture', resource: EncodedDatResource, signal?: AbortSignal): Promise<T> {
    const id = this.nextRequestId++
    if (signal?.aborted) return Promise.reject(abortError())
    const workerResource = { ...resource, bytes: resource.bytes.slice(0) }
    const message = { id, operation, resource: workerResource } as DatProcessorRequest
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const request = this.pending.get(id)
        if (!request || !this.pending.delete(id)) return
        if (request.started) {
          this.activeRequests--
          this.profiler.record('canceled work', performance.now() - request.startedAt)
          this.worker.postMessage({ id, operation: 'cancel' })
        } else {
          this.profiler.record('canceled queue', performance.now() - request.queuedAt)
        }
        reject(abortError())
        this.pump()
      }
      this.pending.set(id, {
        resolve: result => resolve(result as T),
        reject,
        message,
        transfer: [workerResource.bytes],
        started: false,
        signal,
        cancel,
        queuedAt: performance.now(),
        startedAt: 0
      })
      signal?.addEventListener('abort', cancel, { once: true })
      this.queue.push(id)
      this.pump()
    })
  }

  private handleMessage(response: DatProcessorResponse): void {
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    pending.signal?.removeEventListener('abort', pending.cancel!)
    if (pending.started) {
      this.activeRequests--
      this.profiler.record('work', performance.now() - pending.startedAt)
    }
    if (response.error) pending.reject(new Error(response.error))
    else if (response.result) pending.resolve(response.result)
    else pending.reject(new Error('ACTerrain data worker returned no result'))
    this.pump()
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      request.signal?.removeEventListener('abort', request.cancel!)
      request.reject(error)
    }
    this.pending.clear()
    this.queue = []
    this.activeRequests = 0
  }

  private pump(): void {
    while (this.activeRequests < MAX_REQUESTS_IN_FLIGHT && this.queue.length > 0) {
      const id = this.queue.shift()!
      const pending = this.pending.get(id)
      if (!pending || pending.started) continue
      pending.started = true
      pending.startedAt = performance.now()
      this.profiler.record('queue', pending.startedAt - pending.queuedAt)
      this.activeRequests++
      this.worker.postMessage(pending.message, pending.transfer)
      pending.transfer = []
    }
  }
}
