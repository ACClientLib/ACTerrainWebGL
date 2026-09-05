import type { Mesh } from "./acdatclient";

export interface EncodedDatResource {
  id: number;
  encoding: number;
  bytes: ArrayBuffer;
}

export type DatProcessorRequest =
  | { id: number; operation: "mesh"; resource: EncodedDatResource }
  | { id: number; operation: "cancel" };

export type DatProcessorResult = Mesh;

export interface DatProcessorResponse {
  id: number;
  result?: DatProcessorResult;
  error?: string;
}
