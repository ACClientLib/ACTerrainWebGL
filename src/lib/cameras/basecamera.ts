import { Matrix4, Vector3, Vector2 } from "@math.gl/core";
import { TerrainRenderer } from "../terrainrenderer";

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

  constructor(canvas: HTMLCanvasElement, renderer: TerrainRenderer) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.setupEventListeners();
  }

  protected abstract setupEventListeners(): void;
  
  abstract get ViewProjection(): Matrix4;
  abstract get Transform(): Matrix4;
  
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