import { examineFrame, loadExamineMedia, setupExamineDragging } from "./examineframe";
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
.ac-examine-window{position:fixed;left:20px;top:20px;z-index:2100;width:310px;height:400px;overflow:hidden;isolation:isolate;color:#fff;font:13px "Times New Roman",serif;background:#202a29;box-shadow:0 2px 12px #000}
.ac-examine-title{position:absolute;left:5px;top:5px;z-index:3;width:300px;height:20px;cursor:move;touch-action:none;pointer-events:auto}.ac-examine-title span{display:flex;align-items:center;justify-content:center;width:100%;height:100%;padding:0 5px}
.ac-examine-close{position:absolute;left:284px;top:8px;z-index:10;width:14px;height:14px;padding:0;border:0;background:transparent 0 0 no-repeat;color:transparent;cursor:pointer}
.ac-examine-creature{position:absolute;left:5px;top:30px;width:300px;height:365px;isolation:isolate}.ac-examine-media{position:absolute;overflow:hidden;pointer-events:none;background-repeat:repeat;background-position:0 0}.ac-examine-canvas{position:absolute;left:0;top:68px;z-index:1;width:300px;height:265px;display:block;pointer-events:none}
.ac-examine-state{position:absolute;left:0;top:145px;z-index:11;width:300px;color:#d6e7df;text-align:center;text-shadow:1px 1px #000;pointer-events:none}.ac-examine-info,.ac-examine-character-meta{position:absolute;left:4px;top:0;z-index:12;width:226px;height:60px;overflow:hidden}.ac-examine-info{padding:2px 6px;white-space:nowrap}.ac-examine-character-meta>div{position:absolute;left:6px;width:222px;height:18px;overflow:hidden;white-space:nowrap}.ac-examine-character-meta>div:nth-child(1){top:2px}.ac-examine-character-meta>div:nth-child(2){top:20px}.ac-examine-character-meta>div:nth-child(3){top:38px}
.ac-examine-character-label,.ac-examine-level-label,.ac-examine-level{position:absolute;left:237px;z-index:12;width:56px;text-align:center;white-space:nowrap}.ac-examine-character-label{top:2px;height:14px;font-size:11px}.ac-examine-level-label{top:16px;height:14px;font-size:11px}.ac-examine-level{top:30px;height:28px;font-size:20px}.ac-examine-attributes{position:absolute;left:0;top:68px;z-index:12;width:300px;pointer-events:none}.ac-examine-row{position:relative;width:292px;height:20px}.ac-examine-label,.ac-examine-value{position:absolute;top:0;height:20px;color:#fff}.ac-examine-label{left:0;width:128px;padding-left:9px;text-align:left}.ac-examine-value{left:27px;width:256px;padding-right:9px;text-align:right}.ac-examine-allegiance{position:absolute;left:0;top:258px;z-index:12;width:292px;height:20px;text-align:center}.ac-examine-misc{position:absolute;left:0;top:278px;z-index:12;width:292px;height:87px;overflow:hidden}.ac-examine-misc .ac-examine-label{width:125px}.ac-examine-misc .ac-examine-value{left:128px;width:162px}.ac-examine-window[data-state="rendering"] .ac-examine-state{display:none}`;
let styleInstalled = false;
export function installExamineStyle(): void {
  if (styleInstalled) return;
  const element = document.createElement("style");
  element.textContent = style;
  document.head.append(element);
  styleInstalled = true;
}
function text(element: HTMLElement, value: unknown): void {
  element.textContent = value == null || value === "" ? "???" : String(value);
}
function primaryValue(object: WorldObjectData, key: string): number | null {
  const entry = object.attributes[key] as
    Record<string, number | null> | undefined;
  if (!entry) return null;
  return (
    (entry.init_Level ?? entry.initLevel ?? 0) +
    (entry.level_From_C_P ?? entry.levelFromCP ?? 0)
  );
}

export class ExamineCreaturePanel {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly info: HTMLElement;
  private readonly characterMeta: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly state: HTMLElement;
  private readonly attributes: HTMLElement;
  private readonly allegiance: HTMLElement;
  private readonly misc: HTMLElement;
  readonly datClient: AcDatClient;
  private renderer: ExamineObjectRenderer;
  private readonly resizeObserver: ResizeObserver;
  private controller: AbortController | null = null;
  private request = 0;
  private closed = false;
  private rendererDestroyed = false;
  constructor(private readonly options: ExamineWindowOptions) {
    installExamineStyle();
    this.root = document.createElement("main");
    this.root.className = "ac-examine-window";
    this.root.setAttribute("aria-label", "AC creature examine window");
    this.root.hidden = true;
    this.root.innerHTML = examineFrame(`<section class="ac-examine-creature"><div class="ac-examine-media" data-media="06004CC2" style="inset:0"></div><div class="ac-examine-media" data-media="060012C6" style="left:230px;top:0;width:7px;height:60px"></div><div class="ac-examine-media" data-media="0600612C" style="left:0;top:60px;width:300px;height:5px"></div><div class="ac-examine-media" data-media="0600612C" style="left:0;top:250px;width:300px;height:5px"></div><canvas class="ac-examine-canvas"></canvas><div class="ac-examine-state" role="status"></div><div class="ac-examine-info"></div><div class="ac-examine-character-meta"><div></div><div></div><div></div></div><div class="ac-examine-character-label"></div><div class="ac-examine-level-label"></div><div class="ac-examine-level"></div><div class="ac-examine-attributes" role="list" aria-label="Attributes"></div><div class="ac-examine-allegiance"></div><div class="ac-examine-misc" role="list" aria-label="Miscellaneous information"></div></section>`);
    (options.parent ?? document.body).append(this.root);
    this.title = this.root.querySelector<HTMLElement>(".ac-examine-title")!;
    this.info = this.root.querySelector<HTMLElement>(".ac-examine-info")!;
    this.characterMeta = this.root.querySelector<HTMLElement>(
      ".ac-examine-character-meta",
    )!;
    this.canvas =
      this.root.querySelector<HTMLCanvasElement>(".ac-examine-canvas")!;
    this.state = this.root.querySelector<HTMLElement>(".ac-examine-state")!;
    this.attributes = this.root.querySelector<HTMLElement>(
      ".ac-examine-attributes",
    )!;
    this.allegiance = this.root.querySelector<HTMLElement>(
      ".ac-examine-allegiance",
    )!;
    this.misc = this.root.querySelector<HTMLElement>(".ac-examine-misc")!;
    this.root
      .querySelector<HTMLButtonElement>(".ac-examine-close")!
      .addEventListener("click", () => this.close());
    setupExamineDragging(this.root, this.title);
    const gl = this.canvas.getContext("webgl2", { alpha: true });
    if (!gl) throw new Error("Examine rendering requires WebGL2");
    this.datClient = new AcDatClient(
      gl,
      options.apiBase,
      options.serverDescriptorPath,
      "server",
      options.serverId,
    );
    this.renderer = this.createRenderer();
    void loadExamineMedia(this.root, this.datClient);
    const resize = () => {
      this.renderer.resize();
      this.renderer.render();
    };
    this.resizeObserver = new ResizeObserver(resize);
    this.resizeObserver.observe(this.canvas);
  }
  open(guid: number | string, modelIndex?: number, placement?: { rotation: [number, number, number, number]; scale: [number, number, number] }): void {
    if (this.closed) return;
    if (this.rendererDestroyed) this.renderer = this.createRenderer();
    const request = ++this.request;
    this.controller?.abort();
    this.controller = new AbortController();
    this.root.hidden = false;
    this.setState("loading object");
    void this.renderer
      .loadObject(guid, this.controller.signal, modelIndex, placement)
      .then(() => {
        if (request !== this.request || this.closed) return;
        this.setState("rendering");
        this.renderer.render();
        this.updateObjectInfo(this.renderer.loadedObject);
      })
      .catch((error: unknown) => {
        if (
          request !== this.request ||
          this.controller?.signal.aborted ||
          this.closed
        )
          return;
        const message = error instanceof Error ? error.message : String(error);
        this.setState(
          message.includes("unavailable")
            ? "unavailable"
            : message.includes("unsupported")
              ? "unsupported"
              : "failed",
          message,
        );
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
    this.resizeObserver.disconnect();
    this.root.remove();
  }
  private setState(state: ExamineWindowState, message: string = state): void {
    this.root.dataset.state = state;
    this.state.textContent = message;
  }
  private createRenderer(): ExamineObjectRenderer {
    this.rendererDestroyed = false;
    return new ExamineObjectRenderer(this.canvas, this.datClient, (phase) =>
      this.setState(phase),
    );
  }
  private updateObjectInfo(object: WorldObjectData): void {
    const isCharacter = object.string.Template != null || object.int.CharacterTitleId != null;
    text(
      this.title.querySelector("span") as HTMLElement,
      object.name ?? "Object",
    );
    this.info.hidden = isCharacter;
    this.characterMeta.hidden = !isCharacter;
    this.info.textContent = object.name ?? "Object";
    const meta = this.characterMeta.children;
    meta[0].textContent = Number(object.int.CreatureType) === 5 ? "Lugian" : "???";
    meta[1].textContent =
      object.string.Template == null ? "" : String(object.string.Template);
    meta[2].textContent =
      Number(object.int.PlayerKillerStatus) & 4
        ? "Player Killer"
        : Number(object.int.PlayerKillerStatus) & 64
          ? "Player Killer Lite"
          : "Non-Player Killer";
    (
      this.root.querySelector(".ac-examine-character-label") as HTMLElement
    ).textContent = isCharacter ? "Character" : "";
    (
      this.root.querySelector(".ac-examine-level-label") as HTMLElement
    ).textContent = isCharacter ? "Level" : "";
    (this.root.querySelector(".ac-examine-level") as HTMLElement).textContent =
      isCharacter && Number(object.int.Level) > 0
        ? String(object.int.Level)
        : "???";
    this.allegiance.textContent =
      Number(object.int.AllegianceRank) > 0 && object.string.AllegianceName
        ? String(object.string.AllegianceName)
        : "";
    this.attributes.replaceChildren();
    const values: [string, unknown][] = [
      ["Strength", primaryValue(object, "Strength")],
      ["Endurance", primaryValue(object, "Endurance")],
      ["Coordination", primaryValue(object, "Coordination")],
      ["Quickness", primaryValue(object, "Quickness")],
      ["Focus", primaryValue(object, "Focus")],
      ["Self", primaryValue(object, "Self")],
    ];
    for (const [label, id, primaryId, divisor] of [
      ["Health", "MaxHealth", "Endurance", 2],
      ["Stamina", "MaxStamina", "Endurance", 1],
      ["Mana", "MaxMana", "Self", 1],
    ] as const) {
      const entry = object.attributes2nd[id];
      const current = entry?.current_Level ?? entry?.currentLevel;
      const primary = primaryValue(object, primaryId);
      const maximum =
        entry && primary != null
          ? Number(entry.init_Level ?? entry.initLevel ?? 0) +
            Number(entry.level_From_C_P ?? entry.levelFromCP ?? 0) +
            Math.round(primary / divisor)
          : null;
      values.push([
        label,
        current == null || maximum == null
          ? "???"
          : `${current}/${maximum}${id === "MaxHealth" ? ` (${maximum ? Math.round((100 * Number(current)) / maximum) : -1} %)` : ""}`,
      ]);
    }
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
    this.misc.replaceChildren();
    if (isCharacter) {
      const row = document.createElement("div");
      row.className = "ac-examine-row";
      row.innerHTML = `<span class="ac-examine-label">* = Unenchantable</span><span class="ac-examine-value"></span>`;
      this.misc.append(row);
    }
  }
}

