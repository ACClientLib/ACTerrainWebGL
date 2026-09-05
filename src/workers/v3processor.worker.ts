import { parseV3Material, parseV3Mesh, parseV3PlacementChunk } from "../v3/v3parsers";

self.onmessage = (event: MessageEvent<{ id: number; kind: "mesh" | "material" | "placement"; bytes: ArrayBuffer }>) => {
  try {
    const { id, kind, bytes } = event.data;
    const result = kind === "mesh" ? parseV3Mesh(bytes) : kind === "material" ? parseV3Material(bytes) : parseV3PlacementChunk(bytes);
    (self as unknown as Worker).postMessage({ id, result }, [bytes]);
  } catch (error) {
    (self as unknown as Worker).postMessage({ id: event.data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
