import './style.css'
import { TerrainRenderer } from './lib/terrainrenderer'
import { updateRoute, parseRoute } from './lib/router';
import { Vector3 } from '@math.gl/core';

const canvas: HTMLCanvasElement = document.querySelector("#canvas")!;
const overlay = document.querySelector("#overlay")!;
const loader = document.querySelector("#loader")!;

const renderer = new TerrainRenderer(canvas, overlay, loader, 1);

const hash = (window.location.hash || "").replace("#", "")
if (hash.length > 0) {
  const route = parseRoute(hash);
  if (route) {
    //renderer.currentCamera.Zoom = route.zoom
    //renderer.currentCamera.CenterOnCoords(route.coords)
  }
}

function draw(dt: number) {
  renderer.update(dt);
  renderer.draw(dt);

  const centerPos = new Vector3(canvas.width / 2.0, canvas.height / 2.0, 0);
  //updateRoute(renderer.currentCamera.ScreenToCoords(centerPos), renderer.currentCamera.Zoom);

  window.requestAnimationFrame(draw);
}

window.requestAnimationFrame(draw);
