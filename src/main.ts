import './style.css'
import { TerrainRenderer } from './lib/terrainrenderer'
import { updateCameraRoute, parseRoute } from './lib/router';
import { CameraMode } from './lib/cameras/cameramode';

const canvas: HTMLCanvasElement = document.querySelector("#canvas")!;
const overlay = document.querySelector("#overlay")!;
const loader = document.querySelector("#loader")!;

const renderer = new TerrainRenderer(canvas, overlay, loader, 1);

const hash = (window.location.hash || "").replace("#", "")
if (hash.length > 0) {
  const route = parseRoute(hash);
  if (route) {
    renderer.restoreCameraRoute(route)
  }
}

function draw(dt: number) {
  renderer.update(dt);
  renderer.draw(dt);

  const camera = renderer.currentCamera
  if (renderer.currentCameraMode === CameraMode.Camera2D) {
    updateCameraRoute({
      mode: "2d",
      position: camera.Position,
      zoom: renderer.camera2D.Zoom
    })
  } else {
    updateCameraRoute({
      mode: "3d",
      position: camera.Position,
      yaw: renderer.flyingCamera.Yaw,
      pitch: renderer.flyingCamera.Pitch,
      roll: renderer.flyingCamera.Roll,
      fov: renderer.flyingCamera.FOV
    })
  }

  window.requestAnimationFrame(draw);
}

window.requestAnimationFrame(draw);
