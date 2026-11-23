// WebXR + Three.js scene: passthrough AR session, controllers, board, pieces,
// best-move arrow and an in-headset HUD panel (DOM is not visible inside an
// immersive session on Quest, so every message must be drawn in 3D).

import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

const FILES = 'abcdefgh';

// Board-local units: the board is 1×1 on the XZ plane, centred at the origin,
// row 0 at -Z (far side), row 7 at +Z (near side, facing the viewer).
// The group's scale is the real board width in metres.

export class XRSession {
  constructor() {
    this.whiteAtBottom = true;
    this._style = 'virtual';
    this._handlers = {};
    this._frameCbs = [];
    this._controllers = [];
    this._highlights = new Map();
    this._pieceGroup = null;
    this._arrows = new Map();
    this._hud = { title: '', status: '', hint: '', controls: '' };
    this._buttonState = [{}, {}];
    this._hoverOwner = -1;
  }

  async init() {
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    r.setPixelRatio(window.devicePixelRatio);
    r.setSize(window.innerWidth, window.innerHeight);
    r.xr.enabled = true;
    r.xr.setReferenceSpaceType('local-floor');
    r.domElement.style.cssText = 'position:fixed;inset:0;z-index:0;display:none;';
    document.body.appendChild(r.domElement);
    this._renderer = r;

    this._scene = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
    this._camera.position.set(0, 1.6, 0);

    this._scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 2.0));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.6, 3, 1.2);
    this._scene.add(sun);

    this._buildControllers();
    this._buildBoard();
    this._buildHud();
    this._buildPreviewRect();

    r.xr.addEventListener('sessionstart', () => this._handlers.sessionstart?.());
    r.xr.addEventListener('sessionend', () => this._handlers.sessionend?.());

    window.addEventListener('resize', () => {
      if (r.xr.isPresenting) return;
      this._camera.aspect = window.innerWidth / window.innerHeight;
      this._camera.updateProjectionMatrix();
      r.setSize(window.innerWidth, window.innerHeight);
    });
    return this;
  }

  // Must be called from a user gesture (click).
  async enterAR() {
    if (!navigator.xr) throw new Error('WebXR not available');
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['hand-tracking'],
    });
    await this._renderer.xr.setSession(session);
    return session;
  }

  async exitAR() {
    await this._renderer.xr.getSession()?.end();
  }

  on(event, cb) { this._handlers[event] = cb; }
  onFrame(cb) { this._frameCbs.push(cb); }
  clearFrameCallbacks() { this._frameCbs = []; }

  startRenderLoop() {
    let n = 0;
    this._renderer.setAnimationLoop((time, frame) => {
      n++;
      this._pollButtons();
      this._updateLasers();
      for (const cb of this._frameCbs) cb(time, frame, n);
      this._renderer.render(this._scene, this._camera);
    });
  }

  // Resolves once the headset has reported a few poses, so the viewer
  // position is real (not the origin) when we place the board.
  waitForPose(frames = 3) {
    return new Promise((resolve) => {
      let left = frames;
      const cb = () => {
        if (--left > 0) return;
        this._frameCbs = this._frameCbs.filter(f => f !== cb);
        resolve();
      };
      this.onFrame(cb);
    });
  }

  getViewer() {
    const pos = new THREE.Vector3();
    const dir = new THREE.Vector3();
    this._camera.getWorldPosition(pos);
    this._camera.getWorldDirection(dir);
    return { pos, dir };
  }

  // ─── Controllers ──────────────────────────────────────────────────────────

  _buildControllers() {
    const factory = new XRControllerModelFactory();
    for (let i = 0; i < 2; i++) {
      const controller = this._renderer.xr.getController(i);
      const grip = this._renderer.xr.getControllerGrip(i);
      grip.add(factory.createControllerModel(grip));
      this._scene.add(controller, grip);

      const laser = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: 0x4aa8ff })
      );
      laser.scale.z = 3;
      controller.add(laser);
      const tip = new THREE.Mesh(
        new THREE.SphereGeometry(0.006, 10, 10),
        new THREE.MeshBasicMaterial({ color: 0x4aa8ff })
      );
      tip.position.z = -3;
      controller.add(tip);

      const entry = { controller, grip, laser, tip, inputSource: null };
      controller.addEventListener('connected', (e) => { entry.inputSource = e.data; });
      controller.addEventListener('disconnected', () => { entry.inputSource = null; });
      controller.addEventListener('selectstart', () => this._handlers.selectstart?.(i));
      controller.addEventListener('selectend', () => this._handlers.selectend?.(i));
      controller.addEventListener('squeezestart', () => this._handlers.squeeze?.(i));
      this._controllers.push(entry);
    }
  }

  // Edge-detects A/X (primary), B/Y (secondary), stick click and stick flicks.
  _pollButtons() {
    this._controllers.forEach((c, i) => {
      const gp = c.inputSource?.gamepad;
      if (!gp) return;
      const prev = this._buttonState[i];
      const now = {
        stick: !!gp.buttons[3]?.pressed,
        primary: !!gp.buttons[4]?.pressed,
        secondary: !!gp.buttons[5]?.pressed,
        left: (gp.axes[2] ?? 0) < -0.75,
        right: (gp.axes[2] ?? 0) > 0.75,
      };
      for (const k of Object.keys(now)) {
        if (now[k] && !prev[k]) this._handlers.button?.(k, i);
      }
      this._buttonState[i] = now;
    });
  }

  controllerTip(i) {
    const c = this._controllers[i]?.controller;
    if (!c) return null;
    const p = new THREE.Vector3();
    c.getWorldPosition(p);
    return p;
  }

  _rayFrom(i) {
    const c = this._controllers[i].controller;
    const origin = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(c.matrixWorld);
    return new THREE.Raycaster(origin, dir, 0, 5);
  }

  _updateLasers() {
    let hoverSq = null;
    this._controllers.forEach((c, i) => {
      let len = 3;
      if (this._board.visible && c.inputSource) {
        const hit = this._rayFrom(i).intersectObject(this._pickPlane, false)[0];
        if (hit) {
          len = hit.distance;
          const sq = this._localToSquare(this._board.worldToLocal(hit.point.clone()));
          if (sq && (hoverSq === null || i === this._hoverOwner)) hoverSq = sq;
        }
      }
      c.laser.scale.z = len;
      c.tip.position.z = -len;
    });
    if (hoverSq) {
      const { x, z } = this._squareLocal(hoverSq);
      this._hover.position.set(x, 0.004, z);
      this._hover.visible = true;
    } else {
      this._hover.visible = false;
    }
  }

  setHoverOwner(i) { this._hoverOwner = i; }

  // Square under controller i's laser, or null.
  squareAtController(i) {
    if (!this._board.visible || !this._controllers[i]) return null;
    const hit = this._rayFrom(i).intersectObject(this._pickPlane, false)[0];
    if (!hit) return null;
    return this._localToSquare(this._board.worldToLocal(hit.point.clone()));
  }

  // ─── Board ────────────────────────────────────────────────────────────────

  _buildBoard() {
    const board = new THREE.Group();
    board.visible = false;
    board.rotation.order = 'YXZ';
    this._board = board;
    this._scene.add(board);

    const s = 1 / 8;
    const sqGeo = new THREE.BoxGeometry(s, 0.01, s);
    const light = new THREE.MeshStandardMaterial({ color: 0xeed6b0, roughness: 0.8 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x9a6b45, roughness: 0.8 });
    this._squares = new THREE.Group();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const m = new THREE.Mesh(sqGeo, (r + c) % 2 === 0 ? light : dark);
        m.position.set((c - 3.5) * s, -0.005, (r - 3.5) * s);
        this._squares.add(m);
      }
    }
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1.08, 0.012, 1.08),
      new THREE.MeshStandardMaterial({ color: 0x3b2414, roughness: 0.7 })
    );
    frame.position.y = -0.008;
    this._squares.add(frame);
    board.add(this._squares);

    // Thin grid used when overlaying a real board in passthrough.
    const pts = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8 - 0.5;
      pts.push(new THREE.Vector3(t, 0.002, -0.5), new THREE.Vector3(t, 0.002, 0.5));
      pts.push(new THREE.Vector3(-0.5, 0.002, t), new THREE.Vector3(0.5, 0.002, t));
    }
    this._grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x4aa8ff, transparent: true, opacity: 0.6 })
    );
    this._grid.visible = false;
    board.add(this._grid);

    this._pickPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
    );
    this._pickPlane.rotation.x = -Math.PI / 2;
    board.add(this._pickPlane);

    this._hlGeo = new THREE.PlaneGeometry(s * 0.94, s * 0.94).rotateX(-Math.PI / 2);
    this._hover = new THREE.Mesh(
      new THREE.RingGeometry(s * 0.36, s * 0.46, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false })
    );
    this._hover.visible = false;
    board.add(this._hover);

    this._pieceGroup = new THREE.Group();
    board.add(this._pieceGroup);
    this._pieceProtos = buildPieceProtos();
  }

  setStyle(style) {
    this._style = style;
    this._squares.visible = style === 'virtual';
    this._grid.visible = style === 'overlay';
    this._pieceGroup.visible = style === 'virtual';
  }

  get boardVisible() { return this._board.visible; }

  // Floating board in front of the viewer (manual mode).
  placeInFront(distance = 0.5, drop = 0.42, size = 0.42) {
    const { pos, dir } = this.getViewer();
    const flat = new THREE.Vector3(dir.x, 0, dir.z);
    if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
    flat.normalize();
    const center = pos.clone().addScaledVector(flat, distance);
    center.y = pos.y - drop;
    const yaw = Math.atan2(-flat.x, -flat.z);
    this._setBoardTransform(center, yaw, size, 0.28);
  }

  // Board from two diagonal corners touched with a controller (physical mode).
  // Of the four 90° orientations, picks the one whose near edge faces the viewer.
  boardFromDiagonal(a, b) {
    const center = a.clone().add(b).multiplyScalar(0.5);
    const d = new THREE.Vector2(b.x - a.x, b.z - a.z);
    const size = d.length() / Math.SQRT2;
    if (size < 0.1) return null;
    const ang = Math.atan2(d.y, d.x) + Math.PI / 4;
    const base = Math.atan2(-Math.sin(ang), Math.cos(ang));
    const { pos } = this.getViewer();
    const toViewer = new THREE.Vector2(pos.x - center.x, pos.z - center.z).normalize();
    let best = base, bestDot = -Infinity;
    for (let k = 0; k < 4; k++) {
      const yaw = base + (k * Math.PI) / 2;
      const dot = Math.sin(yaw) * toViewer.x + Math.cos(yaw) * toViewer.y;
      if (dot > bestDot) { bestDot = dot; best = yaw; }
    }
    return { center, yaw: best, size };
  }

  lockBoard({ center, yaw, size }) {
    this._setBoardTransform(center, yaw, size, 0);
  }

  rotateBoard(quarterTurns) {
    this._board.rotation.y += (quarterTurns * Math.PI) / 2;
    this._placeHudNearBoard();
  }

  _setBoardTransform(center, yaw, size, tilt) {
    this._board.position.copy(center);
    this._board.rotation.set(tilt, yaw, 0, 'YXZ');
    this._board.scale.setScalar(size);
    this._board.visible = true;
    this._placeHudNearBoard();
  }

  hideBoard() { this._board.visible = false; }

  // ─── Corner-drag preview ─────────────────────────────────────────────────

  _buildPreviewRect() {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 0, -0.5),
      new THREE.Vector3(0.5, 0, 0.5), new THREE.Vector3(-0.5, 0, 0.5),
    ]);
    this._preview = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: 0x44ff88 }));
    this._preview.rotation.order = 'YXZ';
    this._preview.visible = false;
    this._scene.add(this._preview);
  }

  showPreview(spec) {
    if (!spec) { this._preview.visible = false; return; }
    this._preview.position.copy(spec.center);
    this._preview.rotation.set(0, spec.yaw, 0, 'YXZ');
    this._preview.scale.setScalar(spec.size);
    this._preview.visible = true;
  }

  // ─── Square mapping ──────────────────────────────────────────────────────

  // Display index (row*8+col in board-local space) → algebraic square.
  indexToSquare(idx) {
    const row = Math.floor(idx / 8), col = idx % 8;
    return this.whiteAtBottom ? FILES[col] + (8 - row) : FILES[7 - col] + (row + 1);
  }

  squareToIndex(sq) {
    const f = FILES.indexOf(sq[0]), rank = parseInt(sq[1], 10);
    return this.whiteAtBottom ? (8 - rank) * 8 + f : (rank - 1) * 8 + (7 - f);
  }

  _squareLocal(sq) {
    const idx = this.squareToIndex(sq);
    const row = Math.floor(idx / 8), col = idx % 8;
    return { x: (col - 3.5) / 8, z: (row - 3.5) / 8 };
  }

  _localToSquare(p) {
    const col = Math.floor((p.x + 0.5) * 8);
    const row = Math.floor((p.z + 0.5) * 8);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return this.indexToSquare(row * 8 + col);
  }

  // Four board corners in world space, ordered far-left, far-right,
  // near-right, near-left (matches display index row 0 = far edge).
  boardCornersWorld() {
    return [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, z]) =>
      this._board.localToWorld(new THREE.Vector3(x, 0, z))
    );
  }

  // Board-centre → viewer direction in board-local XZ (= warped image x/y axes).
  viewerDirOnBoard() {
    const { pos } = this.getViewer();
    const local = this._board.worldToLocal(pos.clone());
    return { x: local.x, y: local.z };
  }

  // Approximate pixel positions of the board corners in a passthrough camera
  // image of size W×H, using the left-eye projection as a stand-in for the
  // camera intrinsics (not exposed to the web).
  projectBoardToImage(W, H) {
    const xrCam = this._renderer.xr.isPresenting ? this._renderer.xr.getCamera() : null;
    const cam = xrCam?.cameras?.[0] ?? this._camera;
    return this.boardCornersWorld().map((p) => {
      const v = p.clone().project(cam);
      return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
    });
  }

  // ─── Highlights ──────────────────────────────────────────────────────────

  highlightSquare(sq, color = 0x4aa8ff, opacity = 0.6) {
    if (!/^[a-h][1-8]$/.test(sq)) return;
    let m = this._highlights.get(sq);
    if (!m) {
      m = new THREE.Mesh(this._hlGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
      this._board.add(m);
      this._highlights.set(sq, m);
    }
    const { x, z } = this._squareLocal(sq);
    m.position.set(x, 0.003, z);
    m.material.color.setHex(color);
    m.material.opacity = opacity;
    m.visible = true;
  }

  clearHighlights() {
    for (const m of this._highlights.values()) m.visible = false;
  }

  // ─── Pieces ──────────────────────────────────────────────────────────────

  setPieces(boardArray) {
    const g = this._pieceGroup;
    while (g.children.length) g.remove(g.children[0]);
    if (!boardArray) return;
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const p = boardArray[rank]?.[file];
        if (!p) continue;
        const sq = FILES[file] + (8 - rank);
        const proto = this._pieceProtos[p.color + p.type];
        const mesh = proto.clone();
        const { x, z } = this._squareLocal(sq);
        mesh.position.set(x, 0, z);
        // Knights face the opponent.
        const facesFar = (p.color === 'w') === this.whiteAtBottom;
        mesh.rotation.y = facesFar ? 0 : Math.PI;
        g.add(mesh);
      }
    }
  }

  // ─── Arrows ──────────────────────────────────────────────────────────────

  showArrow(from, to, color = 0xff9500, key = 'best') {
    this.clearArrow(key);
    if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) return;
    const a = this._squareLocal(from), b = this._squareLocal(to);
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    const headLen = 0.055, shaftLen = Math.max(len - headLen, 0.01);
    const mat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.55, transparent: true, opacity: 0.92,
    });
    const group = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, shaftLen, 12), mat);
    shaft.rotation.z = -Math.PI / 2;
    shaft.position.x = shaftLen / 2;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.03, headLen, 16), mat);
    head.rotation.z = -Math.PI / 2;
    head.position.x = shaftLen + headLen / 2;
    group.add(shaft, head);
    group.position.set(a.x, this._style === 'virtual' ? 0.15 : 0.02, a.z);
    group.rotation.y = Math.atan2(-dz, dx);
    this._board.add(group);
    this._arrows.set(key, group);
  }

  clearArrow(key = 'best') {
    const g = this._arrows.get(key);
    if (!g) return;
    this._board.remove(g);
    g.traverse((o) => { o.geometry?.dispose(); });
    this._arrows.delete(key);
  }

  clearArrows() {
    for (const k of [...this._arrows.keys()]) this.clearArrow(k);
  }

  // ─── HUD ─────────────────────────────────────────────────────────────────

  _buildHud() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 420;
    this._hudCanvas = canvas;
    this._hudTex = new THREE.CanvasTexture(canvas);
    this._hudTex.colorSpace = THREE.SRGBColorSpace;
    this._hudMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.5 * (420 / 1024)),
      new THREE.MeshBasicMaterial({ map: this._hudTex, transparent: true, depthTest: false })
    );
    this._hudMesh.renderOrder = 10;
    this._hudMesh.visible = false;
    this._scene.add(this._hudMesh);
    this._drawHud();
  }

  placeHudInFront(distance = 0.8, drop = 0.05) {
    const { pos, dir } = this.getViewer();
    const flat = new THREE.Vector3(dir.x, 0, dir.z);
    if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
    flat.normalize();
    this._hudMesh.position.copy(pos).addScaledVector(flat, distance);
    this._hudMesh.position.y = pos.y - drop;
    this._hudMesh.rotation.set(0, Math.atan2(-flat.x, -flat.z), 0);
    this._hudMesh.visible = true;
  }

  _placeHudNearBoard() {
    if (!this._board.visible) return;
    const size = this._board.scale.x;
    // Use the viewer-facing yaw (not the board yaw, which may be rotated by 90°).
    const { pos } = this.getViewer();
    const c = this._board.position;
    const toViewer = new THREE.Vector3(pos.x - c.x, 0, pos.z - c.z);
    if (toViewer.lengthSq() < 1e-6) toViewer.set(0, 0, 1);
    toViewer.normalize();
    this._hudMesh.position.copy(c)
      .addScaledVector(toViewer, -size * 0.62)
      .add(new THREE.Vector3(0, size * 0.55 + 0.1, 0));
    this._hudMesh.rotation.set(0, Math.atan2(toViewer.x, toViewer.z), 0);
    this._hudMesh.visible = true;
  }

  setHud(patch) {
    Object.assign(this._hud, patch);
    this._drawHud();
  }

  _drawHud() {
    const ctx = this._hudCanvas.getContext('2d');
    const W = this._hudCanvas.width, H = this._hudCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(8,10,20,0.86)';
    roundRect(ctx, 0, 0, W, H, 36);
    ctx.fill();
    ctx.strokeStyle = '#4aa8ff';
    ctx.lineWidth = 4;
    roundRect(ctx, 2, 2, W - 4, H - 4, 34);
    ctx.stroke();

    ctx.textBaseline = 'top';
    ctx.fillStyle = '#8fc6ff';
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText(this._hud.title || 'Board Coach XR', 36, 24);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 44px sans-serif';
    let y = wrapText(ctx, this._hud.status || '', 36, 76, W - 72, 52, 3);

    if (this._hud.hint) {
      ctx.fillStyle = '#ffb347';
      ctx.font = 'bold 42px sans-serif';
      y = wrapText(ctx, this._hud.hint, 36, y + 8, W - 72, 50, 1);
    }

    if (this._hud.controls) {
      ctx.fillStyle = '#a9b0c4';
      ctx.font = '27px sans-serif';
      wrapText(ctx, this._hud.controls, 36, Math.max(y + 12, H - 110), W - 72, 33, 3);
    }
    this._hudTex.needsUpdate = true;
  }

  get renderer() { return this._renderer; }
  get scene() { return this._scene; }
  get camera() { return this._camera; }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, x, y, maxW, lineH, maxLines) {
  const words = String(text).split(/\s+/);
  let line = '', lines = 0;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y);
      y += lineH;
      line = w;
      if (++lines >= maxLines - 1) break;
    } else {
      line = test;
    }
  }
  if (line) { ctx.fillText(line, x, y); y += lineH; }
  return y;
}

function lathe(profile) {
  return new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(r, h)), 28);
}

// Simple low-poly Staunton-ish pieces in board-local units (square = 0.125).
function buildPieceProtos() {
  const base = [[0, 0], [0.043, 0], [0.043, 0.008], [0.036, 0.013], [0.027, 0.019]];
  const geos = {
    p: [lathe([...base, [0.016, 0.045], [0.024, 0.049], [0.012, 0.053], [0, 0.053]]),
        sphere(0.018, 0, 0.066)],
    r: [lathe([...base, [0.026, 0.066], [0.033, 0.068], [0.033, 0.086], [0.024, 0.086], [0.024, 0.08], [0, 0.08]])],
    n: [lathe([...base, [0.022, 0.034], [0, 0.034]]),
        box(0.03, 0.06, 0.042, 0, 0.06, 0.004, -0.25),
        box(0.026, 0.024, 0.04, 0, 0.078, -0.022, 0.3)],
    b: [lathe([...base, [0.013, 0.07], [0.022, 0.074], [0.011, 0.078], [0, 0.078]]),
        sphere(0.02, 0, 0.094, 1.35), sphere(0.007, 0, 0.122)],
    q: [lathe([...base, [0.015, 0.08], [0.026, 0.084], [0.016, 0.088], [0.03, 0.104], [0.018, 0.106], [0, 0.106]]),
        sphere(0.012, 0, 0.114)],
    k: [lathe([...base, [0.016, 0.088], [0.027, 0.092], [0.017, 0.096], [0.028, 0.112], [0, 0.112]]),
        box(0.009, 0.034, 0.009, 0, 0.13, 0), box(0.026, 0.009, 0.009, 0, 0.134, 0)],
  };
  const mats = {
    w: new THREE.MeshStandardMaterial({ color: 0xf4ecd9, roughness: 0.45 }),
    b: new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.35, metalness: 0.1 }),
  };
  const protos = {};
  for (const color of ['w', 'b']) {
    for (const [type, parts] of Object.entries(geos)) {
      const g = new THREE.Group();
      for (const geo of parts) g.add(new THREE.Mesh(geo, mats[color]));
      protos[color + type] = g;
    }
  }
  return protos;
}

function sphere(r, x, y, sy = 1) {
  const g = new THREE.SphereGeometry(r, 18, 14);
  g.scale(1, sy, 1);
  g.translate(x, y, 0);
  return g;
}

function box(w, h, d, x, y, z, tilt = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (tilt) g.rotateX(tilt);
  g.translate(x, y, z);
  return g;
}
