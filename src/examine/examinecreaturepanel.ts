import "./examine.css";
import { examineFrame, setupExamineDragging } from "./examineframe";
import { AcDatClient, type WorldObjectData } from "../lib/acdatclient";
import { ExamineObjectRenderer } from "./examineobjectrenderer";
import names from "./itemnames.json";

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

function text(element: HTMLElement, value: unknown): void {
  element.textContent = value == null || value === "" ? "???" : String(value);
}
function appendRow(container: HTMLElement, label: string, value: unknown): void {
  const row = document.createElement("div");
  row.className = "ac-examine-row";
  const labelElement = document.createElement("span");
  labelElement.className = "ac-examine-label";
  labelElement.textContent = label;
  const valueElement = document.createElement("span");
  valueElement.className = "ac-examine-value";
  text(valueElement, value);
  row.append(labelElement, valueElement);
  container.append(row);
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
  private readonly renderer: ExamineObjectRenderer;
  private readonly resizeObserver: ResizeObserver;
  private controller: AbortController | null = null;
  private request = 0;
  private closed = false;
  constructor(private readonly options: ExamineWindowOptions) {
    this.root = document.createElement("main");
    this.root.className = "ac-examine-window";
    this.root.setAttribute("aria-label", "AC creature examine window");
    this.root.hidden = true;
    this.root.innerHTML = examineFrame(
      `<section class="ac-examine-creature"><div class="ac-examine-surface"></div><div class="ac-examine-character-divider"></div><div class="ac-examine-content-divider ac-examine-content-divider-top"></div><div class="ac-examine-content-divider ac-examine-content-divider-bottom"></div><canvas class="ac-examine-canvas"></canvas><div class="ac-examine-state" role="status"><span class="ac-examine-spinner" aria-hidden="true"></span><span class="ac-examine-state-label"></span></div><div class="ac-examine-info"></div><div class="ac-examine-character-meta"><div></div><div></div><div></div></div><div class="ac-examine-character-label"></div><div class="ac-examine-level-label"></div><div class="ac-examine-level"></div><div class="ac-examine-attributes" role="list" aria-label="Attributes"></div><div class="ac-examine-allegiance"></div><div class="ac-examine-misc" role="list" aria-label="Miscellaneous information"></div></section>`,
    );
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
    const resize = () => {
      this.renderer.resize();
      this.renderer.render();
    };
    this.resizeObserver = new ResizeObserver(resize);
    this.resizeObserver.observe(this.canvas);
  }
  open(
    object: WorldObjectData,
    guid: number | string,
    modelIndex?: number,
    placement?: {
      rotation: [number, number, number, number];
      scale: [number, number, number];
    },
  ): void {
    if (this.closed) return;
    const request = ++this.request;
    this.controller?.abort();
    this.controller = new AbortController();
    this.root.hidden = false;
    this.setState("loading object");
    this.updateObjectInfo(object);
    void this.renderer
      .loadObject(guid, this.controller.signal, modelIndex, placement)
      .then(() => {
        if (request !== this.request || this.closed) return;
        this.setState("rendering");
        this.renderer.render();
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
    const loading =
      state === "loading object" || state === "loading model resources";
    this.state.querySelector<HTMLElement>(
      ".ac-examine-state-label",
    )!.textContent = loading ? "Loading" : message;
    this.state.dataset.loading = loading ? "true" : "false";
  }
  private createRenderer(): ExamineObjectRenderer {
    return new ExamineObjectRenderer(this.canvas, this.datClient, (phase) =>
      this.setState(phase),
    );
  }
  private updateObjectInfo(object: WorldObjectData): void {
    const isCharacter =
      object.string.Template != null || object.int.CharacterTitleId != null;
    text(
      this.title.querySelector("span") as HTMLElement,
      object.string.DisplayName ?? object.name ?? "Object",
    );
    this.info.hidden = isCharacter;
    this.characterMeta.hidden = !isCharacter;
    const creatureType = (names.CreatureType as Record<string, string>)[String(object.int.CreatureType)];
    this.info.textContent = creatureType ?? object.name ?? "Object";
    const meta = this.characterMeta.children;
    // CharExamineUI::SetAppraiseInfo / InqGenderHeritageDisplay.
    const gender = (names.Gender as Record<string, string>)[String(object.int.Gender)];
    const heritage = Number(object.int.HeritageGroup)
      ? (names.HeritageGroup as Record<string, string>)[String(object.int.HeritageGroup)]
      : creatureType;
    meta[0].textContent = [gender, heritage].filter(Boolean).join(" ");
    meta[1].textContent =
      (names.CharacterTitle as Record<string, string>)[String(object.int.CharacterTitleId)]
      ?? String(object.string.Template ?? "");
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
    ).textContent = "Level";
    (this.root.querySelector(".ac-examine-level") as HTMLElement).textContent =
      Number(object.int.Level) > 0
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
      appendRow(this.attributes, label, value);
    }
    this.misc.replaceChildren();
    this.misc.scrollTop = 0;
    const addMisc = (label: string, value: string) => appendRow(this.misc, label, value);
    // CreatureExamineUI::SetAppraiseInfo includes these ratings when nonzero.
    const rating = (key: string) => Number(object.int[key] ?? 0);
    for (const [label, first, second, extra, format] of [
      ["Dmg/CritDmg", "DamageRating", "CritDamageRating", "CritRating", "%Rating: "],
      ["Dmg/CritDmg", "DamageResistRating", "CritDamageResistRating", "CritResistRating", "%Resist: "],
      ["Overpower %", "Overpower", "OverpowerResist", "", ""],
      ["PK Dmg/Res", "PKDamageRating", "PKDamageResistRating", "", "%Rating: "],
      ["DoT/Life:", "DotResistRating", "LifeResistRating", "", "%Resist: "],
    ]) {
      if (rating(first) > 0 || rating(second) > 0 || rating(extra) > 0) {
        addMisc(label, first === "Overpower"
          ? `+${rating(first)}/-${rating(second)}`
          : `${format}${rating(first)}/${rating(second)}`);
      }
    }
    if (isCharacter) {
      for (const [key, label] of Object.entries({ MonarchsTitle: "Monarch:", PatronsTitle: "Patron:", Fellowship: "Fellowship:", DateOfBirth: "Arrived in Dereth:" })) {
        if (object.string[key] != null) {
          addMisc(label, String(object.string[key]));
        }
      }
      for (const [key, label] of Object.entries({ AllegianceFollowers: "Followers:", ChessRank: "Chess Rank:", FakeFishingSkill: "Fishing Skill:", NumDeaths: "Deaths:", NumCharacterTitles: "Titles Earned:", Enlightenment: "Enlightenment:" })) {
        if (object.int[key] != null) {
          addMisc(label, key === "NumDeaths" && Number(object.int[key]) === 0
            ? "Has never died"
            : String(object.int[key]));
        }
      }
    }
  }
}
