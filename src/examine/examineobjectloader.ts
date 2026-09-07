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
    modelIndex?: number,
  ): Promise<LoadedServerObjectModel> {
    let model: LoadedServerObjectModel;
    try {
      model = await this.datClient.loadServerObjectModel(guid, signal, onPhase);
    } catch (error) {
      if (modelIndex === undefined || !(error instanceof Error) || !error.message.includes("unsupported")) throw error;
      onPhase?.("loading model resources");
      const object = await this.datClient.getServerObject(guid, signal);
      const mesh = await this.datClient.mesh(modelIndex, signal);
      const batches = await this.datClient.loadModelBatches(mesh, signal);
      model = {
        object,
        render: {
          status: "ready",
          sourceSetupId: object.render.sourceSetupId ?? 0,
          modelId: object.render.modelId ?? modelIndex,
          modelIndex,
          meshResourceId: 0,
          dependencyResourceIds: object.render.dependencyResourceIds,
          scale: object.render.scale ?? 1,
        },
        mesh,
        batches,
      };
    }
    const batches = model.batches.filter((batch) => !batch.mesh.particles?.length);
    for (const batch of model.batches) {
      if (!batches.includes(batch)) {
        this.datClient.releaseMaterial(batch.mesh.materialResourceId);
      }
    }
    const filteredModel = { ...model, batches };
    if (filteredModel.batches.length === 0) {
      this.release(filteredModel);
      throw new Error("This examine model contains no renderable geometry");
    }
    return filteredModel;
  }

  release(model: LoadedServerObjectModel): void {
    void Promise.all(model.batches.map((batch) =>
      this.datClient.releaseMaterial(batch.mesh.materialResourceId),
    )).then(() => this.datClient.beginFrame());
  }
}
