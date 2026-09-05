import { Matrix4, Vector3, Vector2 } from "@math.gl/core";
import { TerrainRenderer } from "../terrainrenderer";
import { extractFrustumPlanes, FrustumPlanes } from "../objectvisibility";

// Abstract base camera class
export abstract class BaseCamera {
  protected canvas: HTMLCanvasElement;
  protected _mouseDown = false;
  protected _isDragging = false;
  protected _lastDrag = new Vector2(0, 0);
  protected _dragStart = new Vector2(0, 0);
  protected renderer: TerrainRenderer;

  public Position: Vector3 = new Vector3(0, 0, 0);
  public ViewportSize: Vector3 = new Vector3(1, 1, 1);
  public mousePos = new Vector2(0, 0);
  private frameTransform: Matrix4 | null = null;
  private frameInverseTransform: Matrix4 | null = null;
  private frameFrustum: FrustumPlanes | null = null;

  constructor(canvas: HTMLCanvasElement, renderer: TerrainRenderer) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.setupEventListeners();
  }

  protected abstract setupEventListeners(): void;

  abstract get ViewProjection(): Matrix4;
  abstract get Transform(): Matrix4;
  abstract WorldToScreen(worldPosition: Vector3): Vector3;

  // Build the camera matrix once after input/update and reuse it for the
  // complete render and culling pass.
  prepareFrame(): void {
    this.frameTransform = this.Transform;
    this.frameInverseTransform = this.frameTransform.clone().invert();
    this.frameFrustum = extractFrustumPlanes(this.frameTransform);
  }

  get FrameTransform(): Matrix4 {
    return this.frameTransform ?? this.Transform;
  }

  get FrameInverseTransform(): Matrix4 {
    return this.frameInverseTransform ?? this.FrameTransform.clone().invert();
  }

  get FrameFrustum(): FrustumPlanes {
    return this.frameFrustum ?? extractFrustumPlanes(this.FrameTransform);
  }

  // Camera-relative particle expansion basis. The 2D camera lies in the
  // world XY plane, while 3D cameras override these with their view basis.
  get ParticleRight(): Vector3 {
    return new Vector3(1, 0, 0);
  }
  get ParticleUp(): Vector3 {
    return new Vector3(0, 1, 0);
  }

  abstract update(dt: number): void;

  protected handleMove(x: number, y: number) {
    const newPos = new Vector2(x, y);

    if (this._mouseDown) {
      if (!this._isDragging) {
        this._dragStart = newPos.clone();
      } else {
        this.handleDrag(this._lastDrag.clone().subtract(newPos));
      }
      this._isDragging = true;
      this._lastDrag = newPos.clone();
    }

    this.mousePos.x = x;
    this.mousePos.y = y;
  }

  protected abstract handleDrag(delta: Vector2): void;

  getClipSpaceMousePosition(x: number, y: number): Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    const cssX = x - rect.left;
    const cssY = y - rect.top;

    const normalizedX = cssX / this.canvas.clientWidth;
    const normalizedY = cssY / this.canvas.clientHeight;

    const clipX = normalizedX * 2 - 1;
    const clipY = normalizedY * -2 + 1;

    return new Vector2(clipX, clipY);
  }
}
