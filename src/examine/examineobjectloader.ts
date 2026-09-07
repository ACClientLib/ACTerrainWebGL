import {
  type AcDatClient,
  type LoadedServerObjectModel,
  type ServerObjectModelLoadPhase,
} from "../lib/acdatclient";

export class ExamineObjectLoader {
  constructor(private readonly datClient: AcDatClient) {}

  async load(
    guid: number | string,
    signal?: AbortSignal,
    onPhase?: (phase: ServerObjectModelLoadPhase) => void,
  ): Promise<LoadedServerObjectModel> {
    const model = await this.datClient.loadServerObjectModel(guid, signal, onPhase);
    if (model.mesh.batches.some((batch) => batch.particles?.length)) {
      this.release(model);
      throw new Error("This examine model contains unsupported particle content");
    }
    if (model.batches.length === 0) {
      this.release(model);
      throw new Error("This examine model contains no renderable geometry");
    }
    return model;
  }

  release(model: LoadedServerObjectModel): void {
    for (const batch of model.batches)
      this.datClient.releaseMaterial(batch.mesh.materialResourceId);
  }
}
