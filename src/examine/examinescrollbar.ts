// LayoutDesc 0x2100003E / 0x10000367, inherited by both item scrollbars.
export class ExamineScrollbar {
  readonly root = document.createElement("div");
  private readonly thumb = document.createElement("button");
  private readonly observer: ResizeObserver;

  constructor(private readonly content: HTMLElement, image: (id: number) => Promise<HTMLImageElement>, top: number, height: number) {
    this.root.className = "ac-item-scrollbar";
    this.root.style.cssText = `position:absolute;left:284px;top:${top}px;width:16px;height:${height}px`;
    const up = document.createElement("button");
    const down = document.createElement("button");
    for (const button of [up, down, this.thumb]) {
      button.type = "button";
    }
    up.setAttribute("aria-label", "Scroll up");
    down.setAttribute("aria-label", "Scroll down");
    this.thumb.setAttribute("aria-label", "Scroll position");
    up.style.top = "0";
    down.style.bottom = "0";
    this.thumb.style.top = "16px";
    this.thumb.style.touchAction = "none";
    this.root.append(up, down, this.thumb);
    const setMedia = (element: HTMLElement, ids: number[]) => {
      void Promise.all(ids.map(image)).then((images) => {
        element.style.setProperty("--normal", `url("${images[0].src}")`);
        element.style.setProperty("--pressed", `url("${images[1].src}")`);
        element.style.setProperty("--hover", `url("${images[2].src}")`);
      }).catch(() => undefined);
    };
    void image(0x06004c5f).then((media) => {
      this.root.style.backgroundImage = `url("${media.src}")`;
    }).catch(() => undefined);
    setMedia(up, [0x06004c69, 0x06004c6a, 0x06004c6b]);
    setMedia(down, [0x06004c6c, 0x06004c6d, 0x06004c6e]);
    for (const [top, height, id] of [[0, 3, 0x06004c60], [3, 10, 0x06004c63], [13, 3, 0x06004c66]]) {
      const part = document.createElement("span");
      part.style.cssText = `position:absolute;left:0;top:${top}px;width:16px;height:${height}px;pointer-events:none`;
      setMedia(part, [id, id + 1, id + 2]);
      this.thumb.append(part);
    }
    up.addEventListener("click", () => { content.scrollTop -= 16; });
    down.addEventListener("click", () => { content.scrollTop += 16; });
    this.root.addEventListener("pointerdown", (event) => {
      if (event.target === this.root) {
        content.scrollTop += event.offsetY < this.thumb.offsetTop ? -content.clientHeight : content.clientHeight;
      }
    });
    let dragY = 0;
    let scrollTop = 0;
    this.thumb.addEventListener("pointerdown", (event) => {
      dragY = event.clientY;
      scrollTop = content.scrollTop;
      this.thumb.setPointerCapture(event.pointerId);
    });
    this.thumb.addEventListener("pointermove", (event) => {
      if (this.thumb.hasPointerCapture(event.pointerId)) {
        content.scrollTop = scrollTop + (event.clientY - dragY) * (content.scrollHeight - content.clientHeight) / Math.max(1, height - 48);
      }
    });
    this.thumb.addEventListener("pointerup", (event) => {
      if (this.thumb.hasPointerCapture(event.pointerId)) {
        this.thumb.releasePointerCapture(event.pointerId);
      }
    });
    content.addEventListener("scroll", () => this.update());
    this.observer = new ResizeObserver(() => this.update());
    this.observer.observe(content);
  }

  update(): void {
    const range = this.content.scrollHeight - this.content.clientHeight;
    // The inherited scrollbar has HideDisabled=true and a 16px widget.
    this.root.hidden = this.content.hidden || range <= 0;
    this.thumb.style.top = `${16 + (range > 0 ? this.content.scrollTop / range : 0) * (this.root.clientHeight - 48)}px`;
  }

  destroy(): void {
    this.observer.disconnect();
    this.root.remove();
  }
}
