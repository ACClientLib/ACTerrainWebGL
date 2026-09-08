import "./style.css";
import { TerrainRenderer } from "./lib/terrainrenderer";
import {
  updateCameraRoute,
  parseRoute,
  cancelCameraRouteUpdate,
} from "./lib/router";
import {
  loadDatasetCatalog,
  populateDatasetSelector,
  selectDataset,
} from "./lib/datasetcatalog";
import { worldToMapCoordinates } from "./lib/coordinates";
import { setupLocationsPanel } from "./lib/locationspanel";
import { loadDungeonNames } from "./lib/dungeons";
import { setupExamineWindow } from "./examine";
import { setupAcSidebar } from "./examine/examineframe";

const canvas: HTMLCanvasElement = document.querySelector("#canvas")!;
const loader = document.querySelector("#loader")!;
const coordinates = document.querySelector<HTMLElement>(
  "#monitor-coordinates",
)!;

async function start(): Promise<void> {
  const selector =
    document.querySelector<HTMLSelectElement>("#dataset-selector")!;
  const catalog = await loadDatasetCatalog();
  const selection = selectDataset(catalog);
  const apiBase =
    import.meta.env.VITE_ACTERRAIN_API_URL ??
    "https://terrainapi.utilitybelt.me/";
  const apiRoot =
    apiBase.length === 0
      ? `${window.location.origin}/`
      : apiBase.endsWith("/")
        ? apiBase
        : `${apiBase}/`;
  const renderer = new TerrainRenderer(
    canvas,
    loader,
    1,
    `v3/dats/${encodeURIComponent(selection.dat.id)}/dataset`,
    selection.server
      ? `v3/servers/${encodeURIComponent(selection.server.id)}/dataset`
      : undefined,
    selection.server
      ? new URL(
          `v3/servers/${encodeURIComponent(selection.server.id)}/${encodeURIComponent(selection.server.version)}/labels`,
          apiRoot,
        ).toString()
      : undefined,
    selection.server?.labelVersion ?? selection.server?.version,
    selection.server?.id,
    selection.server
      ? new URL(
          `v3/servers/${encodeURIComponent(selection.server.id)}/${encodeURIComponent(selection.server.version)}/objects`,
          apiRoot,
        ).toString()
      : undefined,
  );
  const examineWindow = selection.server
    ? setupExamineWindow({
        apiBase: apiRoot,
        serverDescriptorPath: `v3/servers/${encodeURIComponent(selection.server.id)}/dataset`,
        serverId: selection.server.id,
      })
    : undefined;
  const sidebarScrollbar = setupAcSidebar(
    document.querySelector<HTMLElement>("#sidebar")!,
  );
  renderer.shutdownSignal.addEventListener(
    "abort",
    () => sidebarScrollbar?.destroy(),
    { once: true },
  );
  const examineGuid = new URLSearchParams(window.location.search).get(
    "examine",
  );
  if (examineWindow && examineGuid) examineWindow.open(examineGuid);
  window.addEventListener(
    "ac-examine-object",
    (event) => {
      const detail = (
        event as CustomEvent<
          | number
          | string
          | {
              guid: number | string;
              modelIndex?: number;
              rotation?: [number, number, number, number];
              scale?: [number, number, number];
            }
        >
      ).detail;
      const guid = typeof detail === "object" ? detail.guid : detail;
      const modelIndex =
        typeof detail === "object" ? detail.modelIndex : undefined;
      const transform =
        typeof detail === "object" && detail.rotation && detail.scale
          ? { rotation: detail.rotation, scale: detail.scale }
          : undefined;
      if (
        examineWindow &&
        (typeof guid === "number" || typeof guid === "string")
      )
        examineWindow.open(guid, modelIndex, transform);
    },
    { signal: renderer.shutdownSignal },
  );
  populateDatasetSelector(selector, catalog, selection, () =>
    renderer.shutdown(),
  );
  window.addEventListener(
    "pagehide",
    () => {
      examineWindow?.destroy();
      renderer.shutdown();
    },
    { once: true },
  );
  const dungeonNamesEndpoint = selection.server
    ? new URL(
        `v3/servers/${encodeURIComponent(selection.server.id)}/${encodeURIComponent(selection.server.version)}/dungeon-names`,
        apiRoot,
      ).toString()
    : undefined;
  if (dungeonNamesEndpoint) {
    await loadDungeonNames(`${dungeonNamesEndpoint}/all`);
  }
  setupLocationsPanel(
    renderer,
    selection.server
      ? new URL(
          `v3/servers/${encodeURIComponent(selection.server.id)}/${encodeURIComponent(selection.server.version)}/locations`,
          apiRoot,
        ).toString()
      : undefined,
  );

  let restoringRoute = false;
  let routeRequest = 0;
  async function restoreHash(): Promise<void> {
    const request = ++routeRequest;
    const route = parseRoute(window.location.hash);
    if (!route) {
      cancelCameraRouteUpdate();
      renderer.cancelDungeonLoad();
      renderer.showWorld();
      document.querySelector<HTMLElement>(
        "#locations-content [role=status]",
      )!.textContent = "";
      restoringRoute = false;
      return;
    }
    cancelCameraRouteUpdate();
    restoringRoute = true;
    try {
      if (route.dungeon) {
        await renderer.showDungeon(route.dungeon, route);
      } else {
        renderer.showWorld();
        renderer.restoreCameraRoute(route);
      }
    } catch (error) {
      if (request === routeRequest) {
        renderer.cancelDungeonLoad();
        renderer.showWorld();
        document.querySelector<HTMLElement>(
          "#locations-content [role=status]",
        )!.textContent = "";
      }
    } finally {
      if (request === routeRequest) {
        restoringRoute = false;
      }
    }
  }
  await restoreHash();
  window.addEventListener("hashchange", () => void restoreHash(), {
    signal: renderer.shutdownSignal,
  });

  let previousFrameTime: number | null = null;

  let animationFrameId: number | null = null;

  function draw(timestamp: number) {
    if (renderer.isShutdown) return;
    const dt =
      previousFrameTime === null
        ? 0
        : Math.min(100, timestamp - previousFrameTime);
    previousFrameTime = timestamp;
    renderer.update(dt);
    renderer.draw(dt);

    const position = worldToMapCoordinates(renderer.currentCamera.Position);
    coordinates.textContent = renderer.dungeonSelection
      ? renderer.dungeonCoordinateText
      : `${Math.abs(position.NS).toFixed(2)}${position.NS >= 0 ? "N" : "S"}, ${Math.abs(position.EW).toFixed(2)}${position.EW >= 0 ? "E" : "W"}`;

    if (!restoringRoute) {
      updateCameraRoute(renderer.cameraRoute);
    }

    animationFrameId = window.requestAnimationFrame(draw);
  }

  renderer.shutdownSignal.addEventListener(
    "abort",
    () => {
      cancelCameraRouteUpdate();
      selector.disabled = true;
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    },
    { once: true },
  );
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && renderer.isShutdown) {
      window.location.reload();
    }
  });
  animationFrameId = window.requestAnimationFrame(draw);
}

void start().catch((error) => {
  loader.textContent = `Unable to load dataset catalog: ${error instanceof Error ? error.message : String(error)}`;
});
