import type { TerrainRenderer } from "./terrainrenderer";

type LocationType = "poi" | "npc" | "portal";
interface LocationResult { type: LocationType; id: string; text: string; x: number; y: number; z: number; }

export function setupLocationsPanel(endpoint: string, renderer: TerrainRenderer): void {
  const section = document.querySelector<HTMLElement>("#locations-content");
  if (!section) return;
  const input = document.createElement("input");
  input.className = "location-search";
  input.type = "search";
  input.placeholder = "Search locations…";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Search locations");
  const results = document.createElement("div");
  results.className = "location-results";
  section.append(input, results);
  let timer: number | undefined;
  let controller: AbortController | undefined;
  renderer.shutdownSignal.addEventListener("abort", () => {
    window.clearTimeout(timer);
    controller?.abort();
    results.replaceChildren();
  }, { once: true });
  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    controller?.abort();
    const query = input.value.trim();
    if (query.length < 2) { results.replaceChildren(); return; }
    timer = window.setTimeout(() => void search(query), 180);
  }, { signal: renderer.shutdownSignal });
  async function search(query: string): Promise<void> {
    const requestController = new AbortController();
    controller = requestController;
    try {
      const response = await fetch(`${endpoint}?q=${encodeURIComponent(query)}`, { signal: requestController.signal });
      if (!response.ok) throw new Error(`Location search returned HTTP ${response.status}`);
      const body = await response.json() as { locations?: LocationResult[] };
      if (renderer.isShutdown || requestController.signal.aborted) return;
      results.replaceChildren(...(body.locations ?? []).map(createResult));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.warn("Unable to search ACTerrain locations", error);
    }
  }
  function createResult(location: LocationResult): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "location-result";
    button.type = "button";
    button.innerHTML = `<span class="location-icon location-icon-${location.type}" aria-hidden="true">${iconFor(location.type)}</span><span></span>`;
    button.querySelector("span:last-child")!.textContent = location.text;
    button.addEventListener("click", () => { renderer.focusLocation(location.x, location.y, location.type); input.value = location.text; results.replaceChildren(); }, { signal: renderer.shutdownSignal });
    return button;
  }
}
function iconFor(type: LocationType): string { return type === "poi" ? "◆" : type === "npc" ? "♙" : "◇"; }
