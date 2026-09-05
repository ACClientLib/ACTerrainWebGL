import { Matrix4, Vector3, Vector2 } from "@math.gl/core";
import { BaseCamera } from "./basecamera";

// Flying 3D Camera implementation
export class CameraFlying extends BaseCamera {
  private _yaw = 0; // Rotation around Z axis (left/right, since Y is forward)
  private _pitch = 0; // Rotation around X axis (up/down)
  private _roll = 0; // Rotation around Y axis (banking)

  private _fov = 45; // Field of view in degrees
  // A very small near plane wastes most of the 24-bit depth buffer when the
  // scene spans the whole map. Keep it above sub-unit distances to improve
  // terrain/building depth separation in the 3D view.
  private _near = 1;
  private _far = 100000;

  private _moveSpeed = 60;
  private _mouseSensitivity = 0.005; // Increased slightly as per previous suggestion
  private _mobileMoveSensitivity = 85;
  private _mobileLookSensitivity = 1.5;
  private _mobileLookInvertY = false;

  private _forward = new Vector3(0, 1, 0); // Y-forward
  private _right = new Vector3(1, 0, 0);
  private _up = new Vector3(0, 0, 1); // Z-up

  private _keys: { [key: string]: boolean } = {};
  private _mobileMovement = { x: 0, y: 0 };
  private _mobileLook = { x: 0, y: 0 };
  private _mobileInputActive = false;

  get Yaw() {
    return this._yaw;
  }
  set Yaw(v) {
    this._yaw = v;
    this.updateVectors();
  }

  get Pitch() {
    return this._pitch;
  }
  set Pitch(v) {
    this._pitch = Math.max(
      -Math.PI / 2 + 0.01,
      Math.min(Math.PI / 2 - 0.01, v),
    );
    this.updateVectors();
  }

  get Roll() {
    return this._roll;
  }
  set Roll(v) {
    this._roll = v;
    this.updateVectors();
  }

  get FOV() {
    return this._fov;
  }
  set FOV(v) {
    this._fov = Math.max(1, Math.min(179, v));
  }

  get Far() {
    return this._far;
  }
  set Far(v) {
    this._far = Math.max(this._near + 1, v);
  }

  get MoveSpeed() {
    return this._moveSpeed;
  }

  get hasActiveInput(): boolean {
    return this._mobileInputActive || Object.values(this._keys).some(Boolean);
  }
  set MoveSpeed(v) {
    this._moveSpeed = Math.max(0.1, Math.min(2000, v));
  }

  get MobileMoveSensitivity() {
    return this._mobileMoveSensitivity;
  }
  set MobileMoveSensitivity(v) {
    this._mobileMoveSensitivity = Math.max(0, Math.min(200, v));
  }

  get MobileLookSensitivity() {
    return this._mobileLookSensitivity;
  }
  set MobileLookSensitivity(v) {
    this._mobileLookSensitivity = Math.max(0, Math.min(3, v));
  }

  get MobileLookInvertY() {
    return this._mobileLookInvertY;
  }
  set MobileLookInvertY(v) {
    this._mobileLookInvertY = v;
  }

  get ViewProjection() {
    const aspect = this.canvas.width / this.canvas.height;
    return new Matrix4().perspective({
      fovy: (this._fov * Math.PI) / 180,
      aspect: aspect,
      near: this._near,
      far: this._far,
    });
  }

  get ViewMatrix() {
    const target = this.Position.clone().add(this._forward);
    return new Matrix4().lookAt({
      eye: this.Position,
      center: target,
      up: this._up,
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
    // BaseCamera invokes this during super(), before CameraFlying fields exist.
    Promise.resolve().then(() => this.setupMobileJoysticks());

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
      this._moveSpeed = Math.max(0.1, Math.min(2000, this._moveSpeed));
      this.renderer.updateFlyingCameraControls();
    });
  }

  private setupMobileJoysticks() {
    const controls = document.getElementById("mobile-controls");
    if (!controls) return;

    const isTouchDevice =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches ||
      navigator.maxTouchPoints > 0 ||
      typeof window.ontouchstart !== "undefined";
    if (isTouchDevice) controls.classList.add("touch-device");

    const setupJoystick = (
      id: string,
      output: { x: number; y: number },
      onInput: (value: { x: number; y: number }) => void,
    ) => {
      const element = document.getElementById(id);
      const knob = element?.querySelector<HTMLElement>(".mobile-joystick-knob");
      if (!element || !knob) return;
      let pointerId: number | null = null;
      let touchId: number | null = null;
      const radius = 48;

      const update = (clientX: number, clientY: number) => {
        let stage = "start";
        stage = "finite-check";
        if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
        stage = "viewport-center";
        const centerX = id === "look-joystick" ? window.innerWidth - 90 : 90;
        const centerY = window.innerHeight - 90;
        stage = "coordinates";
        const x = clientX - centerX;
        const y = clientY - centerY;
        stage = "joystick-math";
        const distance = Math.min(radius, Math.hypot(x, y));
        const angle = Math.atan2(y, x);
        const normalizedDistance = distance / radius;
        const curvedDistance = normalizedDistance * normalizedDistance;
        const valueX = Math.cos(angle) * curvedDistance;
        const visualValueY = -Math.sin(angle) * curvedDistance;
        const valueY =
          id === "look-joystick" && this._mobileLookInvertY
            ? -visualValueY
            : visualValueY;
        stage = "state-update";
        output.x = valueX;
        output.y = valueY;
        stage = "knob-style";
        knob.style.transform = `translate(calc(-50% + ${valueX * radius}px), calc(-50% - ${visualValueY * radius}px))`;
        stage = "camera-input";
        onInput(output);
      };

      const clear = () => {
        pointerId = null;
        touchId = null;
        output.x = 0;
        output.y = 0;
        knob.style.transform = "translate(-50%, -50%)";
        element.classList.remove("active");
        onInput(output);
        this._mobileInputActive =
          Math.hypot(this._mobileMovement.x, this._mobileMovement.y) > 0 ||
          Math.hypot(this._mobileLook.x, this._mobileLook.y) > 0;
      };

      element.addEventListener("pointerdown", (event) => {
        if (this.renderer.currentCamera != this || event.pointerType === "mouse") return;
        event.preventDefault();
        pointerId = event.pointerId;
        if (typeof element.setPointerCapture === "function") {
          element.setPointerCapture(pointerId);
        }
        element.classList.add("active");
        update(event.clientX, event.clientY);
      });
      element.addEventListener("pointermove", (event) => {
        if (event.pointerId !== pointerId) return;
        event.preventDefault();
        update(event.clientX, event.clientY);
      });
      element.addEventListener("pointerup", (event) => {
        if (event.pointerId === pointerId) clear();
      });
      element.addEventListener("pointercancel", (event) => {
        if (event.pointerId === pointerId) clear();
      });

      element.addEventListener("touchstart", (event) => {
        if (pointerId !== null || touchId !== null) return;
        const touch = event.changedTouches[0];
        if (!touch) return;
        event.preventDefault();
        touchId = touch.identifier;
        element.classList.add("active");
        update(touch.clientX, touch.clientY);
      }, { passive: false });
      element.addEventListener("touchmove", (event) => {
        const touch = Array.from(event.changedTouches).find(
          (changedTouch) => changedTouch.identifier === touchId,
        );
        if (!touch) return;
        event.preventDefault();
        update(touch.clientX, touch.clientY);
      }, { passive: false });
      const endTouch = (event: TouchEvent) => {
        if (touchId === null) return;
        const ended = Array.from(event.changedTouches).some(
          (touch) => touch.identifier === touchId,
        );
        if (ended) clear();
      };
      element.addEventListener("touchend", endTouch, { passive: false });
      element.addEventListener("touchcancel", endTouch, { passive: false });
    };

    setupJoystick("movement-joystick", this._mobileMovement, () => {
      this._mobileInputActive = true;
    });
    setupJoystick("look-joystick", this._mobileLook, () => {
      this._mobileInputActive = true;
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
      .rotateZ(this._yaw) // Yaw around Z-axis (since Y is forward)
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
    const speedMultiplier =
      this._keys["shiftleft"] || this._keys["shiftright"] ? 2 : 1;
    // MoveSpeed is the desktop movement rate in world units per second.
    const moveDistance = (this._moveSpeed * speedMultiplier * dt) / 1000;

    const horizontalForward = new Vector3(this._forward.x, this._forward.y, 0);
    const horizontalLength = Math.hypot(horizontalForward.x, horizontalForward.y);
    if (horizontalLength > 0) horizontalForward.scale(1 / horizontalLength);
    if (Math.hypot(this._mobileMovement.x, this._mobileMovement.y) > 0) {
      const movementRight = new Vector3(
        horizontalForward.y,
        -horizontalForward.x,
        0,
      );
      // Touch movement has its own rate. Do not multiply it by MoveSpeed:
      // changing the desktop control must not change joystick sensitivity.
      const mobileMoveDistance =
        (this._mobileMoveSensitivity * dt) / 1000;
      this.Position.add(
        movementRight.scale(-this._mobileMovement.x * mobileMoveDistance),
      );
      this.Position.add(
        this._forward.clone().scale(this._mobileMovement.y * mobileMoveDistance),
      );
    }
    if (Math.hypot(this._mobileLook.x, this._mobileLook.y) > 0) {
      this.Yaw += (this._mobileLook.x * this._mobileLookSensitivity * dt) / 1000;
      this.Pitch += (this._mobileLook.y * this._mobileLookSensitivity * dt) / 1000;
    }

    // WASD movement
    if (this._keys["keyw"] || this._keys["arrowup"]) {
      this.Position.add(this._forward.clone().scale(moveDistance));
    }
    if (this._keys["keys"] || this._keys["arrowdown"]) {
      this.Position.subtract(this._forward.clone().scale(moveDistance));
    }
    if (this._keys["keya"] || this._keys["arrowleft"]) {
      this.Position.add(this._right.clone().scale(moveDistance));
    }
    if (this._keys["keyd"] || this._keys["arrowright"]) {
      this.Position.subtract(this._right.clone().scale(moveDistance));
    }

    // Vertical movement always follows AC's world Z axis, independent of view pitch.
    const worldUp = new Vector3(0, 0, 1);
    if (this._keys["space"]) {
      this.Position.add(worldUp.clone().scale(moveDistance));
    }
    if (this._keys["controlleft"] || this._keys["controlright"]) {
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

  GetForward() {
    return this._forward.clone();
  }
  GetRight() {
    return this._right.clone();
  }
  GetUp() {
    return this._up.clone();
  }
  get ParticleRight() {
    // Particle vertices are converted from AC coordinates to renderer
    // coordinates by flipping Y in particle.vert, while Transform mirrors
    // view-space X. Convert the inverse-view right vector through both of
    // those conventions so local +X is screen-right.
    return new Vector3(-this._right.x, this._right.y, -this._right.z);
  }
  get ParticleUp() {
    // Match the same AC -> renderer Y conversion used by particle.vert.
    return new Vector3(this._up.x, -this._up.y, this._up.z);
  }

  GetMapPosition(): Vector3 {
    const ray = this.ScreenToWorldRay(
      this.canvas.width / 2,
      this.canvas.height / 2,
    );
    if (Math.abs(ray.direction.z) > 0.000001) {
      let groundHeight = this.renderer.getTerrainHeightAt(
        this.Position.x,
        this.Position.y,
      );
      for (let iteration = 0; iteration < 2; iteration++) {
        const distance = (groundHeight - ray.origin.z) / ray.direction.z;
        if (distance < 0) return this.Position.clone();
        const point = ray.origin.clone().add(ray.direction.clone().scale(distance));
        groundHeight = this.renderer.getTerrainHeightAt(point.x, point.y);
        if (iteration === 1) return point;
      }
    }
    return this.Position.clone();
  }

  WorldToScreen(worldPosition: Vector3): Vector3 {
    const clipSpace = worldPosition.clone().transform(this.FrameTransform);
    const ndc = clipSpace.clone().scale(1 / 1);

    const screenX = (ndc.x + 1) * 0.5 * this.canvas.width;
    const screenY = (1 - ndc.y) * 0.5 * this.canvas.height;

    return new Vector3(screenX, screenY, ndc.z);
  }

  ScreenToWorldRay(
    screenX: number,
    screenY: number,
    transform = this.FrameTransform,
    inverseTransform = transform === this.FrameTransform
      ? this.FrameInverseTransform
      : transform.clone().invert(),
  ): { origin: Vector3; direction: Vector3 } {
    const clipPos = this.getClipSpaceMousePosition(screenX, screenY);

    const nearPoint = new Vector3(clipPos.x, clipPos.y, -1);
    const farPoint = new Vector3(clipPos.x, clipPos.y, 1);

    const worldNear = nearPoint.transform(inverseTransform);
    const worldFar = farPoint.transform(inverseTransform);

    const direction = worldFar.clone().subtract(worldNear).normalize();

    return { origin: worldNear, direction };
  }
}
