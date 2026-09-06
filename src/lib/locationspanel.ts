import type { TerrainRenderer } from "./terrainrenderer";
import { hexId } from "./dungeons";
import { locationTarget, parseLocationTargets, type LocationResult, type LocationTarget } from "./locationsearch";

export function setupLocationsPanel(renderer: TerrainRenderer, endpoint?: string): void {
  const section = document.querySelector<HTMLElement>("#locations-content")!;
  const options = { signal: renderer.shutdownSignal };
  const world = document.createElement("button");
  world.type = "button";
  world.className = "dungeon-landblock";
  world.textContent = "← Return to world / landscape";
  const currentLocation = document.createElement("p");
  currentLocation.className = "explore-help";
  const form = document.createElement("form");
  const input = document.createElement("input");
  input.className = "location-search";
  input.type = "search";
  input.placeholder = "Name, landblock, or coordinates…";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Search all locations");
  input.setAttribute("aria-describedby", "location-search-help");
  const help = document.createElement("p");
  help.id = "location-search-help";
  help.className = "explore-help";
  help.textContent = `${endpoint ? "Dungeons, NPCs, POIs. " : "Name search requires a server dataset. "}Enter a hex landblock, 12.3N,5.54E, or a cell ID [x y z] with optional W X Y Z quaternion.`;
  const results = document.createElement("div");
  results.className = "location-results dungeon-results";
  const status = document.createElement("div");
  status.setAttribute("role", "status");
  form.append(input, help, results);
  section.replaceChildren(currentLocation, world, form, status);
  let timer: number | undefined;
  let controller: AbortController | undefined;
  let action = 0;

  function clearSearch(): void {
    window.clearTimeout(timer);
    controller?.abort();
    results.replaceChildren();
  }
  function sync(): void {
    const selection = renderer.dungeonSelection;
    world.hidden = !selection;
    currentLocation.textContent = selection
      ? `${selection.name ?? "Dungeon"} · ${hexId(selection.landblock, 4)}`
      : "World / landscape";
  }
  world.addEventListener("click", () => {
    action++;
    clearSearch();
    renderer.showWorld();
    status.textContent = "";
    sync();
  }, options);
  async function select(target: LocationTarget): Promise<void> {
    clearSearch();
    const request = ++action;
    renderer.cancelDungeonLoad();
    input.value = target.text;
    status.textContent = "Loading location…";
    world.hidden = false;
    try {
      await renderer.navigateToLocation(target);
      if (request === action && !renderer.isShutdown) {
        status.textContent = "";
        sync();
      }
    } catch (error) {
      if (request === action && !renderer.isShutdown) {
        status.textContent = error instanceof Error ? error.message : String(error);
        sync();
      }
    }
  }
  function createResult(target: LocationTarget, detail: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "location-result";
    button.type = "button";
    const name = document.createElement("span");
    name.textContent = target.text;
    const description = document.createElement("span");
    description.className = "dungeon-result-id";
    description.textContent = detail;
    button.append(name, description);
    button.addEventListener("click", () => void select(target), options);
    return button;
  }
  async function search(query: string): Promise<void> {
    const request = new AbortController();
    controller = request;
    try {
      const response = await fetch(`${endpoint}?q=${encodeURIComponent(query)}`, { signal: request.signal });
      if (!response.ok) {
        throw new Error(`Location search returned HTTP ${response.status}`);
      }
      const body = await response.json() as { locations: LocationResult[] };
      if (request.signal.aborted || renderer.isShutdown) {
        return;
      }
      results.append(...body.locations.map(location => createResult(locationTarget(location),
        `${location.type.toUpperCase()} · ${hexId(location.cellId >>> 16, 4)}`)));
      status.textContent = results.childElementCount ? "" : "No matching locations.";
    } catch (error) {
      if (!request.signal.aborted && !renderer.isShutdown) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    }
  }
  input.addEventListener("input", () => {
    clearSearch();
    const query = input.value.trim();
    results.replaceChildren(...parseLocationTargets(query).map(target => createResult(target, "GO")));
    status.textContent = "";
    if (query && endpoint) {
      status.textContent = "Searching locations…";
      timer = window.setTimeout(() => void search(query), 180);
    }
  }, options);
  form.addEventListener("submit", event => {
    event.preventDefault();
    results.querySelector<HTMLButtonElement>("button")?.click();
  }, options);
  input.addEventListener("keydown", event => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      results.querySelector<HTMLButtonElement>("button")?.focus();
    } else if (event.key === "Escape") {
      clearSearch();
      status.textContent = "";
    }
  }, options);
  renderer.canvas.addEventListener("locationchange", sync, options);
  renderer.shutdownSignal.addEventListener("abort", clearSearch, { once: true });
  sync();
}
