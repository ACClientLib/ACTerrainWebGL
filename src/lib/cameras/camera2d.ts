
import * as settings from '../../settings'
import Coordinates from "../coordinates";
import { BaseCamera } from './basecamera';
import { Matrix4, Vector3, Vector2 } from "@math.gl/core";

function isTouchDevice() {
  return typeof window.ontouchstart !== "undefined";
}

export class Camera2D extends BaseCamera {
  private _zoom = 0.08;
  private _didPinch = false;
  private lastDistance: number = 0;
  private distance: number = 0;
  
  public MapSize: Vector3 = new Vector3(255 * 192, 255 * 192, 700);

  get Zoom() { return this._zoom; }
  set Zoom(v) { this._zoom = v; }

  get Scale() { return this.Zoom / settings.data.renderScale; }

  get ViewPortCenter() {
    return new Vector3(this.ViewportSize.x / 2.0, this.ViewportSize.y / 2.0, 1);
  }

  get TranslationMatrix() {
    this.Position.z = 1;
    const zoomVec = new Vector3(this.Scale, this.Scale, 1);
    const offset = this.ViewportSize.clone().divide(zoomVec).divide(new Vector3(2, 2, 1));
    return Matrix4.IDENTITY.clone()
      .scale(zoomVec.clone())
      .translate(this.Position.clone().multiply(new Vector3(-1, -1, 1)).add(offset));
  }

  get ViewProjection() {
    return (new Matrix4()).ortho({
      left: 0,
      top: 0,
      right: this.canvas.width,
      bottom: this.canvas.height,
      near: 0.000901,
      far: 100000000000
    });
  }

  get Transform() {
    return this.TranslationMatrix.multiplyLeft(this.ViewProjection);
  }

  protected setupEventListeners() {
    if (isTouchDevice()) {
      this.setupTouchEvents();
    } else {
      this.setupMouseEvents();
    }
  }

  private setupTouchEvents() {
    this.canvas.addEventListener("touchstart", (event) => {
      if (this.renderer.currentCamera != this) return;
      event.preventDefault();
      this._mouseDown = true;
      this.lastDistance = 0;
      this.distance = 0;
    });

    this.canvas.addEventListener("touchend", (event) => {
      if (this.renderer.currentCamera != this) return;
      event.preventDefault();
      this._mouseDown = false;
    });

    this.canvas.addEventListener("touchmove", (event) => {
      if (this.renderer.currentCamera != this) return;
      event.preventDefault();
      if (event.touches.length == 1) {
        this.handleMove(event.touches[0].pageX, event.touches[0].clientY);
      } else {
        this.handlePinch(event);
      }
    });
  }

  private setupMouseEvents() {
    this.canvas.addEventListener("mousedown", (event) => {
      if (this.renderer.currentCamera != this) return;
      if (event.button == 0) {
        this._mouseDown = true;
        event.preventDefault();
      }
    });

    this.canvas.addEventListener("mouseup", (event) => {
      if (this.renderer.currentCamera != this) return;
      if (event.button == 0) {
        this._mouseDown = false;
        event.preventDefault();
      }
    });

    this.canvas.addEventListener("mousemove", (event) => {
      if (this.renderer.currentCamera != this) return;
      event.preventDefault();
      this.handleMove(event.clientX, event.clientY);
    });

    this.canvas.addEventListener("wheel", (event) => {
      if (this.renderer.currentCamera != this) return;
      event.preventDefault();
      this.handleWheel(event);
    });
  }

  private handlePinch(event: TouchEvent) {
    if (this.renderer.currentCamera != this) return;
    const touch0 = new Vector2(event.touches[0].clientX, event.touches[0].clientY);
    const touch1 = new Vector2(event.touches[1].clientX, event.touches[1].clientY);

    this.distance = Math.sqrt(
      (touch0.x - touch1.x) * (touch0.x - touch1.x) +
      (touch0.y - touch1.y) * (touch0.y - touch1.y)
    );

    if (this.lastDistance != 0) {
      let newZoom = 0;
      if (this.lastDistance > this.distance) {
        newZoom = this.Zoom / Math.pow(2, (this.lastDistance - this.distance) * 0.0075);
      } else if (this.lastDistance < this.distance) {
        newZoom = this.Zoom * Math.pow(2, (this.distance - this.lastDistance) * 0.0075);
      }

      if (newZoom > 0) {
        this.Zoom = this.capZoom(newZoom);
      }
    }

    this.lastDistance = this.distance;
  }

  private handleWheel(event: WheelEvent) {
    if (this.renderer.currentCamera != this) return;
    const clipPos = this.getClipSpaceMousePosition(event.clientX, event.clientY);
    const preZoom = this.Transform.clone().invert().transform(clipPos);

    const newZoom = this.Zoom * Math.pow(2, event.deltaY * -0.005);
    this.Zoom = this.capZoom(newZoom);
    
    const postZoom = this.Transform.clone().invert().transform(clipPos);
  
    this.Position.x += preZoom[0] - postZoom[0];
    this.Position.y += preZoom[1] - postZoom[1];
  }

  protected handleDrag(delta: Vector2) {
    if (this.renderer.currentCamera != this) return;
    const p = delta.divide(new Vector2(this.Zoom, this.Zoom));
    this.Position.x += p.x;
    this.Position.y += p.y;
  }

  private capZoom(zoom: number) {
    return Math.max(settings.data.minZoom, Math.min(settings.data.maxZoom, zoom));
  }

  update(dt: number) {
    if (this.renderer.currentCamera != this) return;
    if (!this._mouseDown && this._isDragging) {
      this._isDragging = false;
    }
  }

  // Original 2D camera methods
  AdjustZoom(amount: number, position: Vector3) {
    if (this.renderer.currentCamera != this) return;
    const za = 0.1;
    amount = amount < 0 ? za : -za;
    this.Zoom += this.Zoom * amount;
  }

  MoveCamera(cameraMovement: Vector3, clampToMap = false) {
    if (this.renderer.currentCamera != this) return;
    const newPosition = this.Position.clone().add(cameraMovement);
    if (clampToMap) {
      this.Position = this.MapClampedPosition(newPosition);
    } else {
      this.Position = newPosition;
    }
  }

  CenterOnVec(position: Vector3) {
    this.Position = position.clone();
  }

  CenterOnCoords(coords: Coordinates) {
    this.Position = this.CenteredPosition(coords, false);
  }

  CenteredPosition(coords: Coordinates, clampToMap = false) {
    const cameraPosition = this.ScreenToWorld(this.CoordsToScreen(coords));
    if (clampToMap) {
      return this.MapClampedPosition(cameraPosition);
    }
    return cameraPosition;
  }

  MapClampedPosition(position: Vector3) {
    const z2v = new Vector3(this.Zoom / 2, this.Zoom / 2, 1);
    const cameraMin = this.ViewportSize.clone().divide(z2v);
    const cameraMax = this.MapSize.clone().subtract(cameraMin);
    return position.clone().clamp(cameraMin, cameraMax);
  }

  WorldToScreen(worldPosition: Vector3) {
    const wPos = new Vector3(worldPosition.x, worldPosition.y, 1);
    return wPos.transform(this.TranslationMatrix);
  }

  ScreenToWorld(screenPosition: Vector3) {
    screenPosition = screenPosition.clone();
    return screenPosition.transform(this.TranslationMatrix.clone().invert());
  }

  CoordsToScreen(coords: Coordinates) {
    let offset = new Vector3((coords.LBX()) * 192 + coords.LocalX, coords.LBY() * 192 + coords.LocalY);
    offset = offset.divide(new Vector3(255 * 192, 255 * 192, 1)).multiply(this.MapSize);
    return this.WorldToScreen(new Vector3(offset.x, this.MapSize.y - offset.y));
  }

  ScreenToCoords(screenPosition: Vector3) {
    const worldPos = this.ScreenToWorld(screenPosition);
    let offset = new Vector3(worldPos.x, this.MapSize.y - worldPos.y);
      
    if (offset.x < 0) offset.x = 0;
    if (offset.y < 0) offset.y = 0;

    const landblock = (((Math.min(Math.floor(offset.x / 192.), 0xFE)) * Math.pow(2, 24)) + (Math.min(Math.floor(offset.y / 192.), 0xFE) << 16));
    return new Coordinates(landblock, offset.x % 192, offset.y % 192, 0);
  }
}