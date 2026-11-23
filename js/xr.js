// WebXR + Three.js session manager
// Handles: immersive-ar session, passthrough, controllers, board overlay, arrows

import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

export class XRSession {
  constructor(canvas) {
    this._canvas = canvas;
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._controllers = []; // [{controller, grip, model}]
    this._boardGroup = null;
    this._arrowMesh = null;
    this._squareHighlights = []; // 64 meshes
    this._laserLines = []; // 2 controller laser rays
    this._onSelectStart = null;
    this._onSelectEnd = null;
    this._onSqueezeStart = null;
    this._boardWorldCorners = null; // [{x,y,z}, ...] 4 corners in world space
    this._raycaster = new THREE.Raycaster();
    this._textSprites = [];
  }

  async init() {
    // Renderer — canvas is hidden until XR session starts so it never blocks UI
    this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this._renderer.setPixelRatio(window.devicePixelRatio);
    this._renderer.setSize(window.innerWidth, window.innerHeight);
    this._renderer.xr.enabled = true;
    document.body.appendChild(this._renderer.domElement);
    this._renderer.domElement.style.cssText =
      'position:fixed;inset:0;z-index:500;pointer-events:none;display:none;';

    // Scene
    this._scene = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.8);
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(0, 5, 2);
    this._scene.add(ambient, dir);

    // Controllers
    const factory = new XRControllerModelFactory();
    for (let i = 0; i < 2; i++) {
      const controller = this._renderer.xr.getController(i);
      const grip = this._renderer.xr.getControllerGrip(i);
      const model = factory.createControllerModel(grip);
      grip.add(model);
      this._scene.add(controller, grip);

      // Laser ray
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -5),
      ]);
      const mat = new THREE.LineBasicMaterial({ color: 0x44aaff, linewidth: 2 });
      const laser = new THREE.Line(geo, mat);
      controller.add(laser);
      this._laserLines.push(laser);

      // Dot at laser tip
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.005, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0x44aaff })
      );
      dot.position.set(0, 0, -5);
      controller.add(dot);

      controller.addEventListener('selectstart', (e) => this._onSelectStart?.(i, e));
      controller.addEventListener('selectend', (e) => this._onSelectEnd?.(i, e));
      controller.addEventListener('squeezestart', (e) => this._onSqueezeStart?.(i, e));
      this._controllers.push({ controller, grip });
    }

    // Board group (initially hidden)
    this._boardGroup = new THREE.Group();
    this._boardGroup.visible = false;
    this._scene.add(this._boardGroup);

    // Resize handler
    window.addEventListener('resize', () => {
      this._camera.aspect = window.innerWidth / window.innerHeight;
      this._camera.updateProjectionMatrix();
      this._renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return this;
  }

  showCanvas() {
    this._renderer.domElement.style.display = 'block';
    this._renderer.domElement.style.pointerEvents = 'auto';
  }

  createARButton(requiredFeatures = [], optionalFeatures = []) {
    return ARButton.createButton(this._renderer, {
      requiredFeatures: ['local-floor', ...requiredFeatures],
      optionalFeatures: ['camera-access', 'plane-detection', 'hand-tracking', ...optionalFeatures],
    });
  }

  startRenderLoop() {
    this._renderer.setAnimationLoop((time, frame) => {
      this._onFrame?.(time, frame);
      this._renderer.render(this._scene, this._camera);
    });
  }

  onFrame(cb) { this._onFrame = cb; }

  onSelectStart(cb) { this._onSelectStart = cb; }
  onSelectEnd(cb) { this._onSelectEnd = cb; }
  onSqueezeStart(cb) { this._onSqueezeStart = cb; }

  // ─── Board Overlay ────────────────────────────────────────────────────────

  // Place the board overlay at a 3D position/orientation
  placeBoard(position, rotation, scale = 0.4) {
    this._boardGroup.position.copy(position);
    this._boardGroup.rotation.copy(rotation);
    this._boardGroup.scale.setScalar(scale);
    this._boardGroup.visible = true;
    if (!this._boardGroup.children.length) {
      this._buildBoardGeometry();
    }
  }

  _buildBoardGeometry() {
    const sqSize = 1 / 8;
    const lightMat = new THREE.MeshLambertMaterial({ color: 0xf0d9b5, transparent: true, opacity: 0.85 });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0xb58863, transparent: true, opacity: 0.85 });
    const geo = new THREE.BoxGeometry(sqSize, 0.004, sqSize);

    this._squareHighlights = [];

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const isLight = (row + col) % 2 === 0;
        const mesh = new THREE.Mesh(geo, isLight ? lightMat : darkMat);
        mesh.position.set(
          (col - 3.5) * sqSize,
          0,
          (row - 3.5) * sqSize
        );
        this._boardGroup.add(mesh);

        // Highlight overlay (initially transparent)
        const hlMat = new THREE.MeshBasicMaterial({
          color: 0x44aaff, transparent: true, opacity: 0, depthWrite: false
        });
        const hlMesh = new THREE.Mesh(new THREE.PlaneGeometry(sqSize * 0.9, sqSize * 0.9), hlMat);
        hlMesh.rotation.x = -Math.PI / 2;
        hlMesh.position.set(mesh.position.x, 0.003, mesh.position.z);
        this._boardGroup.add(hlMesh);
        this._squareHighlights.push(hlMesh);
      }
    }

    // Board border
    const borderGeo = new THREE.BoxGeometry(1.04, 0.002, 1.04);
    const borderMat = new THREE.MeshLambertMaterial({ color: 0x5d3a1a });
    const border = new THREE.Mesh(borderGeo, borderMat);
    border.position.y = -0.002;
    this._boardGroup.add(border);
  }

  // Highlight a square (by index 0-63 or algebraic)
  highlightSquare(squareOrIndex, color = 0x44aaff, opacity = 0.6) {
    const idx = typeof squareOrIndex === 'string'
      ? this._algebraicToIndex(squareOrIndex)
      : squareOrIndex;
    if (idx < 0 || idx >= 64) return;
    const hl = this._squareHighlights[idx];
    if (!hl) return;
    hl.material.color.setHex(color);
    hl.material.opacity = opacity;
  }

  clearHighlights() {
    for (const hl of this._squareHighlights) {
      hl.material.opacity = 0;
    }
  }

  // Show best-move arrow from sq1 → sq2 (algebraic)
  showArrow(from, to, color = 0xff9500) {
    if (this._arrowMesh) {
      this._boardGroup.remove(this._arrowMesh);
      this._arrowMesh.geometry.dispose();
      this._arrowMesh.material.dispose();
      this._arrowMesh = null;
    }

    const sqSize = 1 / 8;
    const p1 = this._squareCenter3D(from);
    const p2 = this._squareCenter3D(to);
    if (!p1 || !p2) return;

    const dir = p2.clone().sub(p1).normalize();
    const len = p1.distanceTo(p2) * 0.85;
    const arrowHelper = new THREE.ArrowHelper(dir, p1, len, color, 0.06, 0.04);
    arrowHelper.position.y = 0.012;
    this._boardGroup.add(arrowHelper);
    this._arrowMesh = arrowHelper;
  }

  clearArrow() {
    if (this._arrowMesh) {
      this._boardGroup.remove(this._arrowMesh);
      this._arrowMesh = null;
    }
  }

  _squareCenter3D(sq) {
    const col = 'abcdefgh'.indexOf(sq[0]);
    const row = 8 - parseInt(sq[1]);
    if (col < 0 || row < 0 || row >= 8) return null;
    const sqSize = 1 / 8;
    return new THREE.Vector3((col - 3.5) * sqSize, 0, (row - 3.5) * sqSize);
  }

  _algebraicToIndex(sq) {
    const col = 'abcdefgh'.indexOf(sq[0]);
    const row = 8 - parseInt(sq[1]);
    return row * 8 + col;
  }

  // ─── Controller Raycasting ────────────────────────────────────────────────

  // Returns the board square index (0-63) the controller laser intersects, or null
  getControllerBoardIntersection(controllerIdx) {
    const ctrl = this._controllers[controllerIdx]?.controller;
    if (!ctrl || !this._boardGroup.visible) return null;

    const tempMatrix = new THREE.Matrix4();
    tempMatrix.identity().extractRotation(ctrl.matrixWorld);
    this._raycaster.ray.origin.setFromMatrixPosition(ctrl.matrixWorld);
    this._raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

    const intersects = this._raycaster.intersectObjects(this._boardGroup.children, true);
    if (!intersects.length) return null;

    const hit = intersects[0].point;
    const local = this._boardGroup.worldToLocal(hit.clone());
    const sqSize = 1 / 8;
    const col = Math.floor((local.x + 0.5) / sqSize);
    const row = Math.floor((local.z + 0.5) / sqSize);
    if (col < 0 || col >= 8 || row < 0 || row >= 8) return null;
    return row * 8 + col;
  }

  getControllerPosition(controllerIdx) {
    const ctrl = this._controllers[controllerIdx]?.controller;
    if (!ctrl) return null;
    return ctrl.position.clone();
  }

  // Show/hide controller laser
  setLaserVisible(controllerIdx, visible) {
    if (this._laserLines[controllerIdx]) {
      this._laserLines[controllerIdx].visible = visible;
    }
  }

  // ─── HUD Text Sprites ─────────────────────────────────────────────────────

  createTextSprite(text, position, color = '#ffffff') {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = color;
    ctx.font = 'bold 48px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 64);
    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(position);
    sprite.scale.set(0.4, 0.1, 1);
    this._scene.add(sprite);
    this._textSprites.push(sprite);
    return sprite;
  }

  clearTextSprites() {
    for (const s of this._textSprites) {
      this._scene.remove(s);
      s.material.map?.dispose();
      s.material.dispose();
    }
    this._textSprites = [];
  }

  get renderer() { return this._renderer; }
  get scene() { return this._scene; }
  get camera() { return this._camera; }
  get boardGroup() { return this._boardGroup; }
}
