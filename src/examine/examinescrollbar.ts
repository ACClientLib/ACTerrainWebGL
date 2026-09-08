// LayoutDesc 0x2100003E / 0x10000367, inherited by both item scrollbars.
export class ExamineScrollbar {
  readonly root = document.createElement("div");
  private readonly thumb = document.createElement("button");
  private readonly observer: ResizeObserver;
  private readonly mutationObserver: MutationObserver;
  private readonly onScroll = () => this.update();

  constructor(
    private readonly content: HTMLElement,
    top: number,
    height: number,
  ) {
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
    up.className = "ac-scroll-up";
    down.className = "ac-scroll-down";
    this.thumb.className = "ac-scroll-thumb";
    for (const [top, height] of [
      [0, 3],
      [3, 10],
      [13, 3],
    ]) {
      const part = document.createElement("span");
      part.style.cssText = `position:absolute;left:0;top:${top}px;width:16px;height:${height}px;pointer-events:none`;
      part.className = `ac-scroll-thumb-part ac-scroll-thumb-part-${top}`;
      this.thumb.append(part);
    }
    up.addEventListener("click", () => {
      content.scrollTop -= 16;
    });
    down.addEventListener("click", () => {
      content.scrollTop += 16;
    });
    this.root.addEventListener("pointerdown", (event) => {
      if (event.target === this.root) {
        content.scrollTop +=
          event.offsetY < this.thumb.offsetTop
            ? -content.clientHeight
            : content.clientHeight;
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
        content.scrollTop =
          scrollTop +
          ((event.clientY - dragY) *
            (content.scrollHeight - content.clientHeight)) /
            Math.max(1, this.root.clientHeight - 32 - this.thumb.clientHeight);
      }
    });
    this.thumb.addEventListener("pointerup", (event) => {
      if (this.thumb.hasPointerCapture(event.pointerId)) {
        this.thumb.releasePointerCapture(event.pointerId);
      }
    });
    content.addEventListener("scroll", this.onScroll);
    this.observer = new ResizeObserver(() => this.update());
    this.observer.observe(content);
    this.observer.observe(this.root);
    this.mutationObserver = new MutationObserver((records) => {
      if (
        records.some(
          (record) => record.type !== "attributes" || record.target !== content,
        )
      ) {
        this.update();
      }
    });
    this.mutationObserver.observe(content, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "hidden"],
    });
  }

  update(): void {
    const range = this.content.scrollHeight - this.content.clientHeight;
    // The inherited scrollbar has HideDisabled=true and a 16px widget.
    const needsScrollbar = !this.content.hidden && range > 1;
    this.root.hidden = !needsScrollbar;
    this.content.classList.toggle("has-ac-scrollbar", needsScrollbar);
    const trackHeight = Math.max(0, this.root.clientHeight - 32);
    const thumbHeight =
      range > 0
        ? Math.min(
            trackHeight,
            Math.max(
              16,
              (trackHeight * this.content.clientHeight) /
                this.content.scrollHeight,
            ),
          )
        : 16;
    this.thumb.style.height = `${thumbHeight}px`;
    const middle = this.thumb.querySelector<HTMLElement>(
      ".ac-scroll-thumb-part-3",
    );
    const bottom = this.thumb.querySelector<HTMLElement>(
      ".ac-scroll-thumb-part-13",
    );
    if (middle) middle.style.height = `${Math.max(10, thumbHeight - 6)}px`;
    if (bottom) bottom.style.top = `${thumbHeight - 3}px`;
    this.thumb.style.top = `${16 + (range > 0 ? this.content.scrollTop / range : 0) * Math.max(0, this.root.clientHeight - 32 - thumbHeight)}px`;
  }

  destroy(): void {
    this.content.removeEventListener("scroll", this.onScroll);
    this.content.classList.remove("has-ac-scrollbar");
    this.observer.disconnect();
    this.mutationObserver.disconnect();
    this.root.remove();
  }
}
