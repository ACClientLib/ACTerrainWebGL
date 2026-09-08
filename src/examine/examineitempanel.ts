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
  private readonly appraisalScrollbar: ExamineScrollbar;
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
      <div class="ac-examine-item-text" tabindex="0" aria-label="Item appraisal"></div>
    </section>`);
    this.title = this.root.querySelector<HTMLElement>(".ac-examine-title")!;
    this.description = this.root.querySelector<HTMLElement>(
      ".ac-examine-item-text",
    )!;
    this.appraisalScrollbar = new ExamineScrollbar(this.description, 0, 365);
    this.root.querySelector(".ac-examine-item")!.append(this.appraisalScrollbar.root);
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
    this.updateScrollbars();
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
  }

  close(): void {
    this.request++;
    this.root.hidden = true;
  }

  destroy(): void {
    this.close();
    this.appraisalScrollbar.destroy();
    this.root.remove();
  }
}
