import "./examine.css";
import type { WorldObjectData } from "../lib/acdatclient";
import { type ExamineWindowOptions } from "./examinecreaturepanel";
import { examineFrame, setupExamineDragging } from "./examineframe";
import { itemAppraisalText, type ItemSpellText } from "./itemappraisal";
import { ExamineScrollbar } from "./examinescrollbar";

let spellText: Promise<ItemSpellText> | undefined;

export class ExamineItemPanel {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly description: HTMLElement;
  private readonly inscription: HTMLElement;
  private readonly signature: HTMLElement;
  private readonly inscriptionMedia: HTMLElement[];
  private readonly appraisalScrollbar: ExamineScrollbar;
  private readonly inscriptionScrollbar: ExamineScrollbar;
  private request = 0;

  constructor(
    options: ExamineWindowOptions,
    datClient: { image(id: number): Promise<HTMLImageElement> },
    onClose: () => void,
  ) {
    this.root = document.createElement("main");
    this.root.className = "ac-examine-window";
    this.root.setAttribute("aria-label", "AC item examine window");
    this.root.hidden = true;
    // LayoutDesc 0x2100006B, item subpanel 0x1000012E.
    this.root.innerHTML = examineFrame(`<section class="ac-examine-item">
      <div class="ac-examine-surface" style="inset:0"></div>
      <div class="ac-examine-content-divider ac-examine-inscription-media" style="left:0;top:286px;width:300px;height:5px"></div>
      <div class="ac-examine-inscription-surface ac-examine-inscription-media" style="left:0;top:291px;width:300px;height:74px"></div>
      <div class="ac-examine-item-text" tabindex="0" aria-label="Item appraisal"></div>
      <div class="ac-examine-item-inscription" tabindex="0" aria-label="Inscription"></div>
      <div class="ac-examine-item-signature"></div>
    </section>`);
    this.title = this.root.querySelector<HTMLElement>(".ac-examine-title")!;
    this.description = this.root.querySelector<HTMLElement>(
      ".ac-examine-item-text",
    )!;
    this.inscription = this.root.querySelector<HTMLElement>(
      ".ac-examine-item-inscription",
    )!;
    this.signature = this.root.querySelector<HTMLElement>(
      ".ac-examine-item-signature",
    )!;
    this.inscriptionMedia = [
      ...this.root.querySelectorAll<HTMLElement>(
        ".ac-examine-inscription-media",
      ),
    ];
    this.appraisalScrollbar = new ExamineScrollbar(this.description, 0, 286);
    this.inscriptionScrollbar = new ExamineScrollbar(this.inscription, 291, 57);
    this.root
      .querySelector(".ac-examine-item")!
      .append(this.appraisalScrollbar.root, this.inscriptionScrollbar.root);
    this.root
      .querySelector(".ac-examine-close")!
      .addEventListener("click", onClose);
    setupExamineDragging(this.root, this.title);
    (options.parent ?? document.body).append(this.root);
  }

  showLoading(): void {
    this.request++;
    this.root.hidden = false;
    this.title.querySelector("span")!.textContent = "Examine";
    this.description.textContent = "Loading object…";
    this.description.scrollTop = 0;
    this.inscription.hidden = true;
    this.signature.hidden = true;
    for (const media of this.inscriptionMedia) {
      media.hidden = true;
    }
    this.updateScrollbars();
  }

  open(object: WorldObjectData): void {
    const request = ++this.request;
    this.root.hidden = false;
    const name = object.string.DisplayName ?? object.name ?? "Object";
    const stack = Number(object.int.StackSize ?? 1);
    this.title.querySelector("span")!.textContent =
      stack > 1 ? `${name} (${stack})` : String(name);
    this.description.textContent = itemAppraisalText(object);
    this.description.scrollTop = 0;
    const inscribable = Boolean(object.bool.Inscribable);
    this.inscription.hidden = !inscribable;
    this.signature.hidden = !inscribable;
    for (const media of this.inscriptionMedia) {
      media.hidden = !inscribable;
    }
    this.inscription.textContent = String(object.string.Inscription ?? "");
    this.inscription.scrollTop = 0;
    this.signature.textContent = object.string.ScribeName
      ? `--${object.string.ScribeName}`
      : "";
    this.updateScrollbars();
    // This viewer has no inscription-write endpoint; existing inscriptions remain selectable.
    if (Object.keys(object.spells).length > 0 || object.did.Spell != null) {
      spellText ??= import("./itemspells.json").then(
        (module) => module.default,
      );
      void spellText
        .then((spells) => {
          if (request === this.request) {
            this.description.textContent = itemAppraisalText(object, spells);
            this.updateScrollbars();
          }
        })
        .catch(() => {
          spellText = undefined;
        });
    }
  }

  showError(message: string): void {
    this.description.textContent = message;
    this.updateScrollbars();
  }

  private updateScrollbars(): void {
    this.appraisalScrollbar.update();
    this.inscriptionScrollbar.update();
  }

  close(): void {
    this.request++;
    this.root.hidden = true;
  }

  destroy(): void {
    this.close();
    this.appraisalScrollbar.destroy();
    this.inscriptionScrollbar.destroy();
    this.root.remove();
  }
}
