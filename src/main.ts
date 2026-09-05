import "./style.css";
import { TerrainRenderer } from "./lib/terrainrenderer";
import { updateCameraRoute, parseRoute } from "./lib/router";
import { CameraMode } from "./lib/cameras/cameramode";
import {
  loadDatasetCatalog,
  populateDatasetSelector,
  selectDataset,
} from "./lib/datasetcatalog";
import { worldToMapCoordinates } from "./lib/coordinates";
import { setupLocationsPanel } from "./lib/locationspanel";

const canvas: HTMLCanvasElement = document.querySelector("#canvas")!;
const loader = document.querySelector("#loader")!;
const coordinates = document.querySelector<HTMLElement>("#monitor-coordinates")!;

async function start(): Promise<void> {
  const selector =
    document.querySelector<HTMLSelectElement>("#dataset-selector")!;
  const catalog = await loadDatasetCatalog();
  const selection = selectDataset(catalog);
  const apiBase = import.meta.env.VITE_ACTERRAIN_API_URL ?? "https://terrainapi.utilitybelt.me/";
  const apiRoot = apiBase.length === 0 ? `${window.location.origin}/` : apiBase.endsWith("/") ? apiBase : `${apiBase}/`;
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
  );
  populateDatasetSelector(selector, catalog, selection, () => renderer.shutdown());
  if (selection.server) {
    setupLocationsPanel(new URL(`v3/servers/${encodeURIComponent(selection.server.id)}/${encodeURIComponent(selection.server.version)}/locations`, apiRoot).toString(), renderer);
  }

  const hash = (window.location.hash || "").replace("#", "");
  if (hash.length > 0) {
    const route = parseRoute(hash);
    if (route) {
      renderer.restoreCameraRoute(route);
    }
  }

  let previousFrameTime: number | null = null;

  let animationFrameId: number | null = null;

  function draw(timestamp: number) {
    if (renderer.isShutdown) return;
    const dt = previousFrameTime === null
      ? 0
      : Math.min(100, timestamp - previousFrameTime);
    previousFrameTime = timestamp;
    renderer.update(dt);
    renderer.draw(dt);

    const position = worldToMapCoordinates(renderer.currentCamera.Position);
    coordinates.textContent = `${Math.abs(position.NS).toFixed(2)}${position.NS >= 0 ? "N" : "S"}, ${Math.abs(position.EW).toFixed(2)}${position.EW >= 0 ? "E" : "W"}`;

    const camera = renderer.currentCamera;
    if (renderer.currentCameraMode === CameraMode.Camera2D) {
      updateCameraRoute({
        mode: "2d",
        position: camera.Position,
        zoom: renderer.camera2D.Zoom,
      });
    } else {
      updateCameraRoute({
        mode: "3d",
        position: camera.Position,
        yaw: renderer.flyingCamera.Yaw,
        pitch: renderer.flyingCamera.Pitch,
        roll: renderer.flyingCamera.Roll,
        fov: renderer.flyingCamera.FOV,
      });
    }

    animationFrameId = window.requestAnimationFrame(draw);
  }

  window.addEventListener("beforeunload", () => {
    renderer.shutdown();
    if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
  }, { once: true });
  animationFrameId = window.requestAnimationFrame(draw);
}

void start().catch((error) => {
  loader.textContent = `Unable to load dataset catalog: ${error instanceof Error ? error.message : String(error)}`;
});
