import { AcDatClient, type WorldObjectData } from "../lib/acdatclient";
import { ExamineObjectRenderer } from "./examineobjectrenderer";

export type ExamineWindowState =
  | "loading object"
  | "loading model resources"
  | "rendering"
  | "unavailable"
  | "unsupported"
  | "failed";

export interface ExamineWindowOptions {
  apiBase: string;
  serverDescriptorPath: string;
  serverId: string;
  parent?: HTMLElement;
}

const style = `
.ac-examine-window { position: fixed; left: 20px; top: 20px; z-index: 2100; width: 310px; height: 400px; overflow: hidden; isolation: isolate; color: white; font: 13px "Times New Roman", serif; background: #202a29; box-shadow: 0 2px 12px #000; }
.ac-examine-title { position: absolute; left: 5px; top: 5px; width: 300px; height: 20px; padding: 0 5px; border: 1px solid #b5c8bb; background: #42635e; color: white; text-align: center; }
.ac-examine-close { position: absolute; right: 12px; top: 8px; z-index: 4; width: 14px; height: 14px; padding: 0; border: 1px solid #c6d7ca; background: #57736c; color: white; cursor: pointer; line-height: 11px; }
.ac-examine-frame { position: absolute; inset: 0; border: 5px solid #617c74; pointer-events: none; }
.ac-examine-creature { position: absolute; left: 5px; top: 30px; width: 300px; height: 365px; border: 1px solid #77918a; background: #344a47; }
.ac-examine-media { position: absolute; pointer-events: none; background-repeat: repeat; background-position: 0 0; }
.ac-examine-canvas { position: absolute; left: 0; top: 68px; width: 300px; height: 182px; display: block; opacity: 1; pointer-events: none; }
.ac-examine-state { position: absolute; left: 0; top: 145px; z-index: 2; width: 300px; color: #d6e7df; text-align: center; text-shadow: 1px 1px #000; pointer-events: none; }
.ac-examine-attributes { position: absolute; left: 0; top: 250px; width: 300px; padding: 4px; border-top: 1px solid #77918a; }
.ac-examine-row { display: flex; justify-content: space-between; height: 20px; padding: 0 8px; }
.ac-examine-label { color: #dce9df; }.ac-examine-value { color: white; }
.ac-examine-info { position: absolute; left: 10px; top: 38px; width: 220px; height: 24px; overflow: hidden; white-space: nowrap; }
.ac-examine-allegiance { position: absolute; left: 5px; bottom: 10px; width: 292px; text-align: center; }
.ac-examine-window[data-state="rendering"] .ac-examine-state { display: none; }
`;

let styleInstalled = false;

function installStyle(): void {
  if (styleInstalled) return;
  const element = document.createElement("style");
  element.textContent = style;
  document.head.append(element);
  styleInstalled = true;
}

function text(element: HTMLElement, value: unknown): void {
  element.textContent = value == null || value === "" ? "???" : String(value);
}

function primaryValue(object: WorldObjectData, id: number): number | null {
  const entry = object.attributes[String(id)] as Record<string, number | null> | undefined;
  if (!entry) return null;
  return (entry.init_Level ?? entry.initLevel ?? 0) +
    (entry.level_From_C_P ?? entry.levelFromCP ?? 0);
}

export class ExamineWindow {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly info: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly state: HTMLElement;
  private readonly attributes: HTMLElement;
  private readonly allegiance: HTMLElement;
  private renderer: ExamineObjectRenderer;
  private readonly datClient: AcDatClient;
  private controller: AbortController | null = null;
  private request = 0;
  private closed = false;
  private rendererDestroyed = false;

  constructor(private readonly options: ExamineWindowOptions) {
    installStyle();
    this.root = document.createElement("main");
    this.root.className = "ac-examine-window";
    this.root.setAttribute("aria-label", "AC creature examine window");
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="ac-examine-media" data-media="060074BF" style="left:5px;top:0;width:300px;height:5px"></div>
      <div class="ac-examine-media" data-media="060074C0" style="left:0;top:5px;width:5px;height:390px"></div>
      <div class="ac-examine-media" data-media="060074C2" style="right:0;top:5px;width:5px;height:390px"></div>
      <div class="ac-examine-media" data-media="060074C1" style="left:5px;bottom:0;width:300px;height:5px"></div>
      <div class="ac-examine-frame"></div>
      <div class="ac-examine-title"></div>
      <button class="ac-examine-close" type="button" aria-label="Close">×</button>
      <section class="ac-examine-creature">
        <canvas class="ac-examine-canvas"></canvas>
        <div class="ac-examine-state" role="status"></div>
        <div class="ac-examine-info"></div>
        <div class="ac-examine-attributes" role="list" aria-label="Attributes"></div>
        <div class="ac-examine-allegiance"></div>
      </section>`;
    (options.parent ?? document.body).append(this.root);
    this.title = this.root.querySelector<HTMLElement>(".ac-examine-title")!;
    this.info = this.root.querySelector<HTMLElement>(".ac-examine-info")!;
    this.canvas = this.root.querySelector<HTMLCanvasElement>(".ac-examine-canvas")!;
    this.state = this.root.querySelector<HTMLElement>(".ac-examine-state")!;
    this.attributes = this.root.querySelector<HTMLElement>(".ac-examine-attributes")!;
    this.allegiance = this.root.querySelector<HTMLElement>(".ac-examine-allegiance")!;
    this.root.querySelector<HTMLButtonElement>(".ac-examine-close")!.addEventListener("click", () => this.close());
    const gl = this.canvas.getContext("webgl2", { alpha: true });
    if (!gl) throw new Error("Examine rendering requires WebGL2");
    this.datClient = new AcDatClient(gl, options.apiBase, options.serverDescriptorPath, "server", options.serverId);
    this.renderer = this.createRenderer();
    void this.loadMediaBackgrounds();
    const resize = () => { this.renderer.resize(); this.renderer.render(); };
    new ResizeObserver(resize).observe(this.canvas);
  }

  open(guid: number | string): void {
    if (this.closed) return;
    if (this.rendererDestroyed) this.renderer = this.createRenderer();
    const request = ++this.request;
    this.controller?.abort();
    this.controller = new AbortController();
    this.root.hidden = false;
    this.setState("loading object");
    void this.renderer.loadObject(guid, this.controller.signal).then(() => {
      if (request !== this.request || this.closed) return;
      this.setState("rendering");
      this.renderer.render();
      this.updateObjectInfo(this.renderer.loadedObject);
    }).catch((error: unknown) => {
      if (request !== this.request || this.controller?.signal.aborted || this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      const state: ExamineWindowState = message.includes("unavailable")
        ? "unavailable"
        : message.includes("unsupported")
          ? "unsupported"
          : "failed";
      this.setState(state, message);
    });
  }

  close(): void {
    if (this.closed) return;
    this.request++;
    this.controller?.abort();
    this.controller = null;
    this.renderer.clear();
    this.renderer.destroy();
    this.rendererDestroyed = true;
    this.root.hidden = true;
  }

  destroy(): void {
    this.closed = true;
    this.request++;
    this.controller?.abort();
    this.renderer.destroy();
    this.datClient.shutdown();
    this.root.remove();
  }

  private setState(state: ExamineWindowState, message: string = state): void {
    this.root.dataset.state = state;
    this.state.textContent = message;
  }

  private createRenderer(): ExamineObjectRenderer {
    this.rendererDestroyed = false;
    return new ExamineObjectRenderer(this.canvas, this.datClient, (phase) => this.setState(phase));
  }

  private async loadMediaBackgrounds(): Promise<void> {
    await Promise.all([...this.root.querySelectorAll<HTMLElement>("[data-media]")].map(async (element) => {
      const image = await this.datClient.image(parseInt(element.dataset.media!, 16));
      element.style.backgroundImage = `url("${image.src}")`;
    })).catch(() => undefined);
  }

  private updateObjectInfo(object: WorldObjectData): void {
    text(this.title, object.name ?? "Object");
    text(this.info, object.name ?? "Object");
    this.allegiance.textContent = object.int[30] && object.string[47]
      ? String(object.string[47])
      : "";
    this.attributes.replaceChildren();
    const values: [string, unknown][] = [
      ["Strength", primaryValue(object, 1)], ["Endurance", primaryValue(object, 2)],
      ["Coordination", primaryValue(object, 4)], ["Quickness", primaryValue(object, 3)],
      ["Focus", primaryValue(object, 5)], ["Self", primaryValue(object, 6)],
    ];
    for (const [label, value] of values) {
      const row = document.createElement("div");
      row.className = "ac-examine-row";
      const labelElement = document.createElement("span");
      labelElement.className = "ac-examine-label";
      labelElement.textContent = label;
      const valueElement = document.createElement("span");
      valueElement.className = "ac-examine-value";
      text(valueElement, value);
      row.append(labelElement, valueElement);
      this.attributes.append(row);
    }
  }
}

export function setupExamineWindow(options: ExamineWindowOptions): ExamineWindow {
  return new ExamineWindow(options);
}
