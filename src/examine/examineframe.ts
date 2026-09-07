import type { AcDatClient } from "../lib/acdatclient";
export function examineFrame(body: string): string {
  return `<div class="ac-examine-title ac-examine-media" data-media="06004CC2"><span></span></div><button class="ac-examine-close" type="button" aria-label="Close"></button>${body}<div class="ac-examine-media" data-media="0600612A" style="left:5px;top:25px;width:300px;height:5px"></div><div class="ac-examine-media" data-media="060074C3" style="left:0;top:0;width:5px;height:5px"></div><div class="ac-examine-media" data-media="060074BF" style="left:5px;top:0;width:300px;height:5px"></div><div class="ac-examine-media" data-media="060074C4" style="left:305px;top:0;width:5px;height:5px"></div><div class="ac-examine-media" data-media="060074C0" style="left:0;top:5px;width:5px;height:390px"></div><div class="ac-examine-media" data-media="060074C2" style="left:305px;top:5px;width:5px;height:390px"></div><div class="ac-examine-media" data-media="060074C5" style="left:0;top:395px;width:5px;height:5px"></div><div class="ac-examine-media" data-media="060074C1" style="left:5px;top:395px;width:300px;height:5px"></div><div class="ac-examine-media" data-media="060074C6" style="left:305px;top:395px;width:5px;height:5px"></div>`;
}
export async function loadExamineMedia(root: HTMLElement, datClient: { image(id: number): Promise<HTMLImageElement> }): Promise<void> {
    await Promise.all(
      [...root.querySelectorAll<HTMLElement>("[data-media]")].map(
        async (element) => {
          const image = await datClient.image(
            parseInt(element.dataset.media!, 16),
          );
          element.style.backgroundImage = `url("${image.src}")`;
        },
      ),
    ).catch(() => undefined);
    const close =
      root.querySelector<HTMLButtonElement>(".ac-examine-close")!;
    const image = await datClient.image(0x06006215).catch(() => null);
    if (image) close.style.backgroundImage = `url("${image.src}")`;
  }
export function setupExamineDragging(root: HTMLElement, title: HTMLElement): void {
    let offsetX = 0;
    let offsetY = 0;
    let dragging = false;
    title.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const bounds = root.getBoundingClientRect();
      offsetX = event.clientX - bounds.left;
      offsetY = event.clientY - bounds.top;
      dragging = true;
      title.setPointerCapture(event.pointerId);
    });
    title.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      root.style.left = `${event.clientX - offsetX}px`;
      root.style.top = `${event.clientY - offsetY}px`;
    });
    const end = () => {
      dragging = false;
    };
    title.addEventListener("pointerup", end);
    title.addEventListener("pointercancel", end);
  }

