import './style.css'
import { TerrainRenderer } from './terrainrenderer'

const canvas: HTMLCanvasElement = document.querySelector("#canvas")!;
const overlay = document.querySelector("#overlay")!;

const renderer = new TerrainRenderer(canvas, overlay, 1);

function draw(dt: number) {
  renderer.update(dt);
  renderer.draw(dt);
  window.requestAnimationFrame(draw);
}

window.requestAnimationFrame(draw);

window.renderer = renderer;

/*
let times: number[] = [];
let fps = 0;

function updateFrameRate() {
  const now = performance.now();
  while (times.length > 0 && times[0] <= now - 1000) {
    times.shift();
  }
  times.push(now);
  fps = times.length;
  overlay.innerHTML = `FPS: ${fps}`;
}
*/
