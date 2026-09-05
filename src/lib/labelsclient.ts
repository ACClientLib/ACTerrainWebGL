import { Vector3 } from "@math.gl/core";
import { BaseCamera } from "./cameras/basecamera";
import { Camera2D } from "./cameras/camera2d";
import { CameraFlying } from "./cameras/cameryflying";

export interface TerrainLabel {
  type: "poi" | "portal" | "npc" | "vendor";
  id: string;
  text: string;
  x: number;
  y: number;
  z: number;
  minZoom: number;
  insideEnvCell: boolean;
}

interface LabelTile { tileX: number; tileY: number; tileSize: number; labels: TerrainLabel[]; }

const TILE_SIZE = 4096;
const CACHE_NAME = "acterrain-labels-v2";
const LEGACY_CACHE_NAMES = ["acterrain-labels-v1"];
const LABEL_HEIGHT = 18;
const LABEL_GAP = 4;

export class LabelsClient {
  private readonly loaded = new Map<string, TerrainLabel[]>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly elements = new Map<string, HTMLDivElement>();
  private enabled = true;
  private readonly lifecycleController = new AbortController();
  private lastCamera: BaseCamera | null = null;
  private maximum3DDistance = Number.POSITIVE_INFINITY;
  private readonly cachePromise = typeof caches === "undefined" ? null : caches.open(CACHE_NAME);

  constructor(private readonly endpoint: string, private readonly overlay: HTMLElement) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.removeElements();
  }

  loadPois(): void {
    const promise = this.loadAllPois().catch((error) => {
      if (!this.lifecycleController.signal.aborted) {
        console.warn("Unable to load ACTerrain POIs", error);
      }
    }).finally(() => this.pending.delete("all-poi"));
    this.pending.set("all-poi", promise);
  }

  shutdown(): void {
    this.lifecycleController.abort();
    this.enabled = false;
    this.lastCamera = null;
    this.loaded.clear();
    this.removeElements();
  }

  async clearCache(): Promise<void> {
    await Promise.allSettled(this.pending.values());
    this.loaded.clear();
    for (const element of this.elements.values()) element.remove();
    this.elements.clear();
    if (typeof caches !== "undefined") await Promise.all([CACHE_NAME, ...LEGACY_CACHE_NAMES].map((name) => caches.delete(name)));
  }

  update(camera: BaseCamera, maximum3DDistance?: number): void {
    this.lastCamera = camera;
    this.maximum3DDistance = maximum3DDistance ?? Number.POSITIVE_INFINITY;
    const flyingCamera = camera instanceof CameraFlying ? camera : null;
    const is3D = flyingCamera !== null;
    const types = is3D
      ? "portal,npc"
      : camera instanceof Camera2D
        ? camera.Zoom >= 0.5
          ? "portal,npc"
          : camera.Zoom >= 0.25
            ? "portal"
            : ""
        : "";
    if (types.length === 0) {
      this.draw(camera);
      return;
    }

    if (is3D) {
      const centerTileX = Math.floor(camera.Position.x / TILE_SIZE);
      const centerTileY = Math.floor(camera.Position.y / TILE_SIZE);
      for (let tileY = centerTileY - 1; tileY <= centerTileY + 1; tileY++) {
        for (let tileX = centerTileX - 1; tileX <= centerTileX + 1; tileX++) {
          if (tileX >= 0 && tileX <= 63 && tileY >= 0 && tileY <= 63) this.load(tileX, tileY, types);
        }
      }
    } else {
      const camera2D = camera as Camera2D;
      const topLeft = camera2D.ScreenToWorld(new Vector3(0, 0, 1));
      const bottomRight = camera2D.ScreenToWorld(new Vector3(camera2D.ViewportSize.x, camera2D.ViewportSize.y, 1));
      const minX = Math.max(0, Math.floor(Math.min(topLeft.x, bottomRight.x) / TILE_SIZE));
      const maxX = Math.min(63, Math.floor(Math.max(topLeft.x, bottomRight.x) / TILE_SIZE));
      const minY = Math.max(0, Math.floor(Math.min(topLeft.y, bottomRight.y) / TILE_SIZE));
      const maxY = Math.min(63, Math.floor(Math.max(topLeft.y, bottomRight.y) / TILE_SIZE));
      for (let tileY = minY; tileY <= maxY; tileY++) for (let tileX = minX; tileX <= maxX; tileX++) this.load(tileX, tileY, types);
    }
    this.draw(camera);
  }

  private async loadAllPois(): Promise<void> {
    const url = this.endpoint.replace(/\/labels$/, "/labels/pois");
    const cache = await this.cachePromise;
    let response = cache ? await cache.match(url) : undefined;
    this.lifecycleController.signal.throwIfAborted();
    if (!response) {
      response = await fetch(url, { cache: "no-store", signal: this.lifecycleController.signal });
      if (!response.ok) throw new Error(`POI labels returned HTTP ${response.status}`);
      this.lifecycleController.signal.throwIfAborted();
      await cache?.put(url, response.clone());
    }
    const body = (await response.json()) as LabelTile & { Labels?: TerrainLabel[] };
    this.lifecycleController.signal.throwIfAborted();
    this.loaded.set("all-poi", (body.labels ?? body.Labels ?? []).map((value) => normalizeLabel(value as unknown as Record<string, unknown>)));
    if (this.lastCamera) this.draw(this.lastCamera);
  }

  private load(tileX: number, tileY: number, types: string): void {
    const key = `${tileX}/${tileY}/${types}`;
    if (this.loaded.has(key) || this.pending.has(key)) return;
    const promise = this.read(key, tileX, tileY, types).catch((error) => {
      if (!this.lifecycleController.signal.aborted) {
        console.warn("Unable to load ACTerrain label tile", error);
      }
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
  }

  private async read(key: string, tileX: number, tileY: number, types: string): Promise<void> {
    const url = `${this.endpoint}?tileX=${tileX}&tileY=${tileY}&types=${encodeURIComponent(types)}`;
    const cache = await this.cachePromise;
    let response = cache ? await cache.match(url) : undefined;
    this.lifecycleController.signal.throwIfAborted();
    if (!response) {
      response = await fetch(url, { cache: "no-store", signal: this.lifecycleController.signal });
      if (!response.ok) throw new Error(`Label tile returned HTTP ${response.status}`);
      this.lifecycleController.signal.throwIfAborted();
      await cache?.put(url, response.clone());
    }
    const body = (await response.json()) as LabelTile & { Labels?: TerrainLabel[] };
    this.lifecycleController.signal.throwIfAborted();
    this.loaded.set(key, (body.labels ?? body.Labels ?? []).map((value) => normalizeLabel(value as unknown as Record<string, unknown>)));
    if (this.lastCamera) this.draw(this.lastCamera);
  }

  private draw(camera: BaseCamera): void {
    if (!this.enabled) {
      this.removeElements();
      return;
    }
    const flyingCamera = camera instanceof CameraFlying ? camera : null;
    const is3D = flyingCamera !== null;
    const visible: TerrainLabel[] = [];
    for (const labels of this.loaded.values()) {
      for (const label of labels) {
        if (is3D && label.type === "poi") continue;
        if (!is3D && camera instanceof Camera2D && camera.Zoom < label.minZoom) continue;
        visible.push(label);
      }
    }
    visible.sort((a, b) => {
      if (is3D) {
        const distanceA = Math.hypot(
          a.x - camera.Position.x,
          a.y - camera.Position.y,
          a.z - camera.Position.z,
        );
        const distanceB = Math.hypot(
          b.x - camera.Position.x,
          b.y - camera.Position.y,
          b.z - camera.Position.z,
        );
        if (distanceA !== distanceB) return distanceA - distanceB;
      }
      return labelPriority(a) - labelPriority(b) || a.minZoom - b.minZoom || a.text.localeCompare(b.text);
    });
    const occupied: { x: number; y: number; width: number; height: number }[] = [];
    const active = new Set<string>();
    const scaleX = this.overlay.clientWidth / camera.ViewportSize.x;
    const scaleY = this.overlay.clientHeight / camera.ViewportSize.y;
    for (const label of visible) {
      const z = is3D
        ? label.z + (label.type === "portal" ? 2.5 : 2)
        : 1;
      const worldPosition = new Vector3(label.x, label.y, z);
      const point = camera.WorldToScreen(worldPosition);
      if (is3D && (point.z < -1 || point.z > 1)) continue;
      const x = point.x * scaleX;
      const y = point.y * scaleY;
      const key = `${label.type}:${label.id}`;
      const width = Math.min(240, Math.max(32, label.text.length * 7 + 12));
      const labelOffset = is3D ? 0 : Math.min(18, Math.max(4, (camera as Camera2D).Zoom * 24));
      const candidateOffsets = [
        [0, labelOffset],
        [0, -labelOffset],
        [width / 2 + LABEL_GAP, 0],
        [-width / 2 - LABEL_GAP, 0],
        [width / 2 + LABEL_GAP, labelOffset],
        [-width / 2 - LABEL_GAP, labelOffset],
        [width / 2 + LABEL_GAP, -labelOffset],
        [-width / 2 - LABEL_GAP, -labelOffset],
      ] as const;
      let placement: { x: number; y: number; box: { x: number; y: number; width: number; height: number } } | undefined;
      for (const [offsetX, offsetY] of candidateOffsets) {
        const centerX = x + offsetX;
        const centerY = y + offsetY;
        const box = { x: centerX - width / 2, y: centerY - LABEL_HEIGHT / 2, width, height: LABEL_HEIGHT };
        const inBounds = box.x < this.overlay.clientWidth && box.x + box.width > 0 && box.y < this.overlay.clientHeight && box.y + box.height > 0;
        const overlaps = occupied.some(item => item.x < box.x + box.width && item.x + item.width > box.x && item.y < box.y + box.height && item.y + item.height > box.y);
        if (inBounds && !overlaps) {
          placement = { x: centerX, y: centerY, box };
          break;
        }
      }
      if (!placement) continue;
      occupied.push(placement.box); active.add(key);
      let element = this.elements.get(key);
      if (!element) {
        element = document.createElement("div");
        element.className = `terrain-label terrain-label-${label.type}${label.insideEnvCell && (label.type === "npc" || label.type === "portal") ? " terrain-label-inside" : ""}`;
        element.textContent = label.text;
        this.overlay.append(element);
        this.elements.set(key, element);
      }
      element.style.transform = `translate3d(${placement.x}px, ${placement.y}px, 0) translate(-50%, -50%)`;
      if (is3D) {
        const distance = Math.hypot(
          worldPosition.x - camera.Position.x,
          worldPosition.y - camera.Position.y,
          worldPosition.z - camera.Position.z,
        );
        if (distance > this.maximum3DDistance) {
          active.delete(key);
          element.remove();
          this.elements.delete(key);
          continue;
        }
        const distanceRatio = Math.min(1, distance / Math.max(1, Math.min(flyingCamera!.Far, this.maximum3DDistance)));
        element.style.opacity = String(1 - distanceRatio * 0.9);
      } else {
        element.style.opacity = "";
      }
    }
    for (const [key, element] of this.elements) if (!active.has(key)) { element.remove(); this.elements.delete(key); }
  }

  private removeElements(): void {
    for (const element of this.elements.values()) element.remove();
    this.elements.clear();
  }
}

function labelPriority(label: TerrainLabel): number {
  return label.insideEnvCell && (label.type === "npc" || label.type === "portal") ? 1 : 0;
}

function normalizeLabel(value: Record<string, unknown>): TerrainLabel {
  return {
    type: (value.type ?? value.Type) as TerrainLabel["type"],
    id: String(value.id ?? value.Id),
    text: String(value.text ?? value.Text),
    x: Number(value.x ?? value.X),
    y: Number(value.y ?? value.Y),
    z: Number(value.z ?? value.Z),
    minZoom: Number(value.minZoom ?? value.MinZoom),
    insideEnvCell: Boolean(value.insideEnvCell ?? value.InsideEnvCell),
  };
}
