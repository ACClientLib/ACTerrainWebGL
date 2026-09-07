import type { WorldObjectData } from "../lib/acdatclient";
import { DatImageClient, type DatImageDescriptor } from "../lib/datimageclient";
import type { ExamineWindowOptions } from "./examinecreaturepanel";

// Examination of items needs only the dataset descriptor, object properties and UI images.
export class ExamineDataClient {
  private readonly baseUrl: URL;
  private readonly images: DatImageClient;
  private descriptor?: Promise<DatImageDescriptor & { version: string }>;

  constructor(private readonly options: ExamineWindowOptions) {
    this.baseUrl = new URL(options.apiBase.endsWith("/") ? options.apiBase : `${options.apiBase}/`, window.location.href);
    this.images = new DatImageClient(this.baseUrl.href);
  }

  private getDescriptor(): Promise<DatImageDescriptor & { version: string }> {
    this.descriptor ??= this.read(this.options.serverDescriptorPath).catch((error) => {
      this.descriptor = undefined;
      throw error;
    });
    return this.descriptor;
  }

  async getServerObject(guid: number | string, signal?: AbortSignal): Promise<WorldObjectData> {
    const descriptor = await this.getDescriptor();
    signal?.throwIfAborted();
    return this.read(`v3/servers/${encodeURIComponent(this.options.serverId)}/${encodeURIComponent(descriptor.version)}/objects/${encodeURIComponent(String(guid))}`, signal);
  }

  async image(id: number): Promise<HTMLImageElement> {
    return this.images.load(await this.getDescriptor(), id);
  }

  private async read(path: string, signal?: AbortSignal): Promise<any> {
    const response = await fetch(new URL(path.replace(/^\//, ""), this.baseUrl), { signal });
    if (!response.ok) {
      throw new Error(`Examine request failed (${response.status})`);
    }
    return response.json();
  }
}
