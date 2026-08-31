import type { Mesh } from './acdatclient'

export interface EncodedDatResource {
  id: number
  encoding: number
  bytes: ArrayBuffer
}

export interface ProcessedResourceTexture {
  width: number
  height: number
  bitmap?: ImageBitmap
  pixels?: Uint8Array
}

export type DatProcessorRequest =
  | { id: number; operation: 'mesh'; resource: EncodedDatResource }
  | { id: number; operation: 'texture'; resource: EncodedDatResource }
  | { id: number; operation: 'cancel' }

export type DatProcessorResult = Mesh | ProcessedResourceTexture

export interface DatProcessorResponse {
  id: number
  result?: DatProcessorResult
  error?: string
}
