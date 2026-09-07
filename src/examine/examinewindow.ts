import { ExamineCreaturePanel, type ExamineWindowOptions } from "./examinecreaturepanel";
import { ExamineItemPanel } from "./examineitempanel";
import { ExamineDataClient } from "./examinedataclient";

export class ExamineWindow {
  private creature?: ExamineCreaturePanel;
  private readonly data: ExamineDataClient;
  private readonly item: ExamineItemPanel;
  private controller: AbortController | null = null;
  private destroyed = false;

  constructor(private readonly options: ExamineWindowOptions) {
    this.data = new ExamineDataClient(options);
    this.item = new ExamineItemPanel(options, this.data, () => this.close());
  }

  open(guid: number | string, modelIndex?: number, placement?: { rotation: [number, number, number, number]; scale: [number, number, number] }): void {
    if (this.destroyed) {
      return;
    }
    this.close();
    const controller = new AbortController();
    this.controller = controller;
    this.item.showLoading();
    void this.data.getServerObject(guid, controller.signal).then((object) => {
      if (controller.signal.aborted) {
        return;
      }
      // The dataset contains raw weenie properties, not a network appraisal.
      // Attribute records are the available creature evidence; object-like NPCs
      // explicitly suppress their creature appraisal in ACE.
      const creature = !object.bool.NpcLooksLikeObject && Object.keys(object.attributes).length > 0;
      if (creature) {
        this.item.close();
        this.creature ??= new ExamineCreaturePanel(this.options);
        this.creature.open(guid, modelIndex, placement);
      } else {
        this.item.open(object);
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        this.item.showError(error instanceof Error ? error.message : String(error));
      }
    });
  }

  close(): void {
    this.controller?.abort();
    this.controller = null;
    this.creature?.close();
    this.item.close();
  }

  destroy(): void {
    this.close();
    this.destroyed = true;
    this.item.destroy();
    this.creature?.destroy();
  }
}

export function setupExamineWindow(options: ExamineWindowOptions): ExamineWindow {
  return new ExamineWindow(options);
}
