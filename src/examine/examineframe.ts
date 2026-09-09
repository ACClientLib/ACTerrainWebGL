import { ExamineScrollbar } from "./examinescrollbar";
export function examineFrame(body: string): string {
  return `<div class="ac-examine-title"><span></span></div><button class="ac-examine-close" type="button" aria-label="Close"></button>${body}<div class="ac-examine-divider"></div>`;
}

export function setupAcSidebar(
  root: HTMLElement,
): ExamineScrollbar | undefined {
  root
    .querySelectorAll<HTMLInputElement>("input[type=checkbox]")
    .forEach((input) => input.classList.add("ac-dat-checkbox"));
  root
    .querySelectorAll<HTMLInputElement>("input[type=range]")
    .forEach((input) => input.classList.add("ac-dat-slider"));
  root.querySelectorAll<HTMLSelectElement>("select").forEach((select) => {
    select.classList.add("ac-dat-combo");
    const wrapper = document.createElement("div");
    wrapper.className = "ac-select";
    select.before(wrapper);
    wrapper.append(select);
  });
  root
    .querySelectorAll<HTMLButtonElement>(".action-button")
    .forEach((button) => button.classList.add("ac-dat-button"));
  const content = root.querySelector<HTMLElement>(".sidebar-content");
  if (content) {
    const scrollbar = new ExamineScrollbar(content, 0, 1);
    const headerHeight =
      root.querySelector<HTMLElement>(".sidebar-header")?.offsetHeight ?? 25;
    scrollbar.root.style.cssText = `position:absolute;right:4px;top:${headerHeight}px;left:auto;width:16px;height:calc(100% - ${headerHeight}px)`;
    root.append(scrollbar.root);
    scrollbar.update();
    return scrollbar;
  }
}
export function setupExamineDragging(
  root: HTMLElement,
  title: HTMLElement,
): void {
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
    if (!dragging) {
      return;
    }
    root.style.left = `${event.clientX - offsetX}px`;
    root.style.top = `${event.clientY - offsetY}px`;
  });
  const end = (event: PointerEvent) => {
    dragging = false;
    if (title.hasPointerCapture(event.pointerId)) {
      title.releasePointerCapture(event.pointerId);
    }
  };
  title.addEventListener("pointerup", end);
  title.addEventListener("pointercancel", end);
}
