export interface DatImageDescriptor {
  imagesUrl?: string | null;
}

const FALLBACK_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' fill='%23333'/%3E%3Cpath d='M4 4l24 24M28 4L4 28' stroke='%23d88' stroke-width='3'/%3E%3C/svg%3E";

export class DatImageClient {
  private readonly baseUrl: string;

  constructor(baseUrl = import.meta.env.VITE_ACTERRAIN_API_URL ?? "") {
    this.baseUrl = baseUrl.endsWith("/") || baseUrl.length === 0 ? baseUrl : `${baseUrl}/`;
  }

  url(descriptor: DatImageDescriptor, imageId: number | string, layers: {
    underlay?: number | string;
    overlay?: number | string;
    overlaySecondary?: number | string;
  } = {}): string {
    const template = descriptor.imagesUrl ?? "";
    if (!template) return FALLBACK_IMAGE;
    const canonicalImage = this.canonical(imageId);
    if (canonicalImage === "invalid") return FALLBACK_IMAGE;
    const path = template.replace("{imageId}", canonicalImage);
    const url = new URL(path.replace(/^\//, ""), new URL(this.baseUrl || window.location.origin + "/"));
    for (const [name, value] of Object.entries(layers))
      if (value !== undefined) {
        const canonical = this.canonical(value);
        if (canonical === "invalid") return FALLBACK_IMAGE;
        url.searchParams.set(name, canonical);
      }
    return url.toString();
  }

  async load(descriptor: DatImageDescriptor, imageId: number | string, layers?: Parameters<DatImageClient["url"]>[2]): Promise<HTMLImageElement> {
    const image = new Image();
    image.decoding = "async";
    image.src = this.url(descriptor, imageId, layers);
    try {
      await image.decode();
      return image;
    } catch {
      const fallback = new Image();
      fallback.src = FALLBACK_IMAGE;
      await fallback.decode();
      return fallback;
    }
  }

  private canonical(value: number | string): string {
    let parsed: bigint;
    if (typeof value === "number") {
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return "invalid";
      parsed = BigInt(value);
    } else {
      if (value.length === 0 || value.trim() !== value || !/^(?:\d+|0[xX][0-9a-fA-F]+)$/.test(value)) return "invalid";
      try {
        parsed = BigInt(value);
      } catch {
        return "invalid";
      }
      if (parsed < 0n || parsed > 0xffffffffn) return "invalid";
    }
    return `0x${parsed.toString(16).padStart(8, "0")}`;
  }
}
