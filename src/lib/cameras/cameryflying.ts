import { Matrix4, Vector3, Vector2 } from "@math.gl/core";
import { BaseCamera } from "./basecamera";

// Flying 3D Camera implementation
export class CameraFlying extends BaseCamera {
  private _yaw = 0;     // Rotation around Z axis (left/right, since Y is forward)
  private _pitch = 0;   // Rotation around X axis (up/down)
  private _roll = 0;    // Rotation around Y axis (banking)
  
  private _fov = 45;    // Field of view in degrees
  // A very small near plane wastes most of the 24-bit depth buffer when the
  // scene spans the whole map. Keep it above sub-unit distances to improve
  // terrain/building depth separation in the 3D view.
  private _near = 1;
  private _far = 100000;
  
  private _moveSpeed = 25;
  private _mouseSensitivity = 0.005; // Increased slightly as per previous suggestion
  
  private _forward = new Vector3(0, 1, 0); // Y-forward
  private _right = new Vector3(1, 0, 0);
  private _up = new Vector3(0, 0, 1); // Z-up
  
  private _keys: { [key: string]: boolean } = {};

  get Yaw() { return this._yaw; }
  set Yaw(v) { this._yaw = v; this.updateVectors(); }
  
  get Pitch() { return this._pitch; }
  set Pitch(v) { this._pitch = Math.max(-Math.PI/2 + 0.01, Math.min(Math.PI/2 - 0.01, v)); this.updateVectors(); }
  
  get Roll() { return this._roll; }
  set Roll(v) { this._roll = v; this.updateVectors(); }

  get FOV() { return this._fov; }
  set FOV(v) { this._fov = Math.max(1, Math.min(179, v)); }

  get MoveSpeed() { return this._moveSpeed; }
  set MoveSpeed(v) { this._moveSpeed = Math.max(0.1, Math.min(400, v)); }

  get ViewProjection() {
    const aspect = this.canvas.width / this.canvas.height;
    return new Matrix4().perspective({
      fovy: (this._fov * Math.PI) / 180,
      aspect: aspect,
      near: this._near,
      far: this._far
    });
  }

  get ViewMatrix() {
    const target = this.Position.clone().add(this._forward);
    return new Matrix4().lookAt({
      eye: this.Position,
      center: target,
      up: this._up
    });
  }

  get Transform() {
    // Mirror view-space X so world +X moves in the same screen direction as 2D.
    const mirroredView = new Matrix4()
      .scale([-1, 1, 1])
      .multiplyRight(this.ViewMatrix);
    return mirroredView.multiplyLeft(this.ViewProjection);
  }

  protected setupEventListeners() {
    // Mouse events for looking around
    this.canvas.addEventListener("mousedown", (event) => {
      if (this.renderer.currentCamera != this) return;
      if (event.button === 0) {
        this._mouseDown = true;
        this.canvas.requestPointerLock();
        event.preventDefault();
      }
    });

    this.canvas.addEventListener("mouseup", (event) => {
      if (this.renderer.currentCamera != this) return;
      if (event.button === 0) {
        this._mouseDown = false;
        document.exitPointerLock();
        event.preventDefault();
      }
    });

    this.canvas.addEventListener("mousemove", (event) => {
      if (this.renderer.currentCamera != this) return;
      if (this._mouseDown && document.pointerLockElement === this.canvas) {
        this.handleMouseLook(event.movementX, event.movementY);
        this.mousePos.x = event.clientX;
        this.mousePos.y = event.clientY;
        return;
      }
      this.handleMove(event.clientX, event.clientY);
    });

    // Keyboard events for movement
    window.addEventListener("keydown", (event) => {
      if (this.renderer.currentCamera != this) return;
      this._keys[event.code.toLowerCase()] = true;
    });

    window.addEventListener("keyup", (event) => {
      if (this.renderer.currentCamera != this) return;
      this._keys[event.code.toLowerCase()] = false;
    });

    // Mouse wheel for speed adjustment
    this.canvas.addEventListener("wheel", (event) => {
      if (this.renderer.currentCamera != this) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this._moveSpeed *= event.deltaY > 0 ? 0.9 : 1.1;
      this._moveSpeed = Math.max(0.01, Math.min(400, this._moveSpeed));
      this.renderer.updateFlyingCameraControls();
    });
  }

  private handleMouseLook(deltaX: number, deltaY: number) {
    if (this.renderer.currentCamera != this) return;
    const maxDelta = 100;
    deltaX = Math.max(-maxDelta, Math.min(maxDelta, deltaX));
    deltaY = Math.max(-maxDelta, Math.min(maxDelta, deltaY));
    this.Yaw += deltaX * this._mouseSensitivity;
    this.Pitch -= deltaY * this._mouseSensitivity;
  }

  protected handleDrag(delta: Vector2) {
    if (this.renderer.currentCamera != this) return;
    if (this._isDragging) {
      this.Yaw -= delta.x * this._mouseSensitivity;
      this.Pitch += delta.y * this._mouseSensitivity;
    }
  }

  private updateVectors() {
    // Rotation order: yaw (Z-axis), pitch (X-axis), roll (Y-axis)
    const rotationMatrix = new Matrix4()
      .rotateZ(this._yaw)  // Yaw around Z-axis (since Y is forward)
      .rotateX(this._pitch) // Pitch around X-axis
      .rotateY(this._roll); // Roll around Y-axis (forward axis)

    this._forward = new Vector3(0, 1, 0).transform(rotationMatrix).normalize();
    this._right = new Vector3(1, 0, 0).transform(rotationMatrix).normalize();
    this._up = new Vector3(0, 0, 1).transform(rotationMatrix).normalize();
  }

  update(dt: number) {
    if (this.renderer.currentCamera != this) return;
    this.handleKeyboardInput(dt);
  }

  private handleKeyboardInput(dt: number) {
    if (this.renderer.currentCamera != this) return;
    const speedMultiplier = this._keys['shiftleft'] || this._keys['shiftright'] ? 2 : 1;
    const moveDistance = (this._moveSpeed * speedMultiplier / 50000) * dt;

    // WASD movement
    if (this._keys['keyw'] || this._keys['arrowup']) {
      this.Position.add(this._forward.clone().scale(moveDistance));
    }
    if (this._keys['keys'] || this._keys['arrowdown']) {
      this.Position.subtract(this._forward.clone().scale(moveDistance));
    }
    if (this._keys['keya'] || this._keys['arrowleft']) {
      this.Position.add(this._right.clone().scale(moveDistance));
    }
    if (this._keys['keyd'] || this._keys['arrowright']) {
      this.Position.subtract(this._right.clone().scale(moveDistance));
    }

    // Vertical movement always follows AC's world Z axis, independent of view pitch.
    const worldUp = new Vector3(0, 0, 1);
    if (this._keys['space']) {
      this.Position.add(worldUp.clone().scale(moveDistance));
    }
    if (this._keys['controlleft'] || this._keys['controlright']) {
      this.Position.subtract(worldUp.scale(moveDistance));
    }

  }

  LookAt(target: Vector3) {
    const direction = target.clone().subtract(this.Position).normalize();
    this._yaw = Math.atan2(direction.x, direction.y); // Y-forward
    this._pitch = Math.asin(direction.z); // Z-up; negative pitch looks down
    this.updateVectors();
  }

  SetRotation(yaw: number, pitch: number, roll: number = 0) {
    this.Yaw = yaw;
    this.Pitch = pitch;
    this.Roll = roll;
  }

  GetForward() { return this._forward.clone(); }
  GetRight() { return this._right.clone(); }
  GetUp() { return this._up.clone(); }
  get ParticleRight() {
    // These are upright Z-axis billboards, so only the camera's horizontal
    // facing direction determines their rotation. Deriving the axis from the
    // controller direction avoids mixing view-matrix rows/columns. Account
    // for the Y conversion and view-space X mirror used by object rendering.
    const forward = this.GetForward()
    return new Vector3(forward.y, forward.x, 0).normalize()
  }
  get ParticleUp() {
    return new Vector3(0, 0, 1)
  }

  GetMapPosition(): Vector3 {
    const ray = this.ScreenToWorldRay(this.canvas.width / 2, this.canvas.height / 2);
    if (Math.abs(ray.direction.z) > 0.000001) {
      const groundHeight = this.renderer.getTerrainHeightAt(this.Position.x, this.Position.y);
      const distance = (groundHeight - ray.origin.z) / ray.direction.z;
      if (distance >= 0) {
        return ray.origin.clone().add(ray.direction.clone().scale(distance));
      }
    }
    return this.Position.clone();
  }

  WorldToScreen(worldPosition: Vector3): Vector3 {
    const clipSpace = worldPosition.clone().transform(this.Transform);
    const ndc = clipSpace.clone().scale(1 / 1);
    
    const screenX = (ndc.x + 1) * 0.5 * this.canvas.width;
    const screenY = (1 - ndc.y) * 0.5 * this.canvas.height;
    
    return new Vector3(screenX, screenY, ndc.z);
  }

  ScreenToWorldRay(screenX: number, screenY: number, transform = this.FrameTransform, inverseTransform = transform === this.FrameTransform ? this.FrameInverseTransform : transform.clone().invert()): { origin: Vector3, direction: Vector3 } {
    const clipPos = this.getClipSpaceMousePosition(screenX, screenY);
    
    const nearPoint = new Vector3(clipPos.x, clipPos.y, -1);
    const farPoint = new Vector3(clipPos.x, clipPos.y, 1);
    
    const worldNear = nearPoint.transform(inverseTransform);
    const worldFar = farPoint.transform(inverseTransform);
    
    const direction = worldFar.clone().subtract(worldNear).normalize();
    
    return { origin: worldNear, direction };
  }
}
