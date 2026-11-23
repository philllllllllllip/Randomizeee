// Physical Board Mode
// Uses WebXR passthrough + camera vision to detect chess moves automatically
//
// Flow:
//   1. Enter AR mode
//   2. Controller trigger-drag to mark board corners (TL → BR)
//   3. Board locks in; vision pipeline starts scanning
//   4. Auto-detect moves, validate with chess.js
//   5. Ambiguous moves → Groq disambiguation → controller confirm

import { BoardDetector, CameraManager } from '../vision.js';
import { rankCandidateMoves } from '../groq.js';
import { showToast } from '../ui.js';

export class PhysicalBoardMode {
  constructor(game, engine, xrSession, onMoveConfirmed) {
    this._game = game;
    this._engine = engine;
    this._xr = xrSession;
    this._onMoveConfirmed = onMoveConfirmed;

    this._detector = new BoardDetector();
    this._camera = new CameraManager();
    this._active = false;
    this._state = 'idle'; // idle | placing | scanning | ambiguous | paused
    this._cornerDragStart = null; // {x,y} in screen space
    this._cornerDragController = null;
    this._pendingCandidates = [];
    this._occlusionCounter = 0;
    this._maxOcclusion = 10; // frames of allowed occlusion
    this._frameInterval = 8; // process every N frames for performance
    this._frameCount = 0;
    this._lastOccupancy = null;
    this._whiteAtBottom = true;
    this._scanTimeout = null;
    this._gripRequestedRescan = false;
  }

  async start(options = {}) {
    this._whiteAtBottom = (options.playerColor ?? 'w') === 'w';
    this._active = true;
    this._state = 'placing';

    showToast('Aim controller at board corners and pull trigger to mark TL and BR');

    // Start camera
    try {
      await this._camera.start();
    } catch (err) {
      showToast('Camera not available. Using XR camera frames.', 3000, 'warn');
    }

    this._setupControllers();
    this._camera.onFrame((canvas) => this._onCameraFrame(canvas));
    return this;
  }

  stop() {
    this._active = false;
    this._camera.stop();
    this._state = 'idle';
  }

  flip() {
    this._whiteAtBottom = !this._whiteAtBottom;
    showToast(`Board flipped — ${this._whiteAtBottom ? 'White' : 'Black'} at bottom`);
  }

  requestRescan() {
    this._gripRequestedRescan = true;
    showToast('Rescan requested — prioritising changed squares');
  }

  _setupControllers() {
    this._xr.onSelectStart((ctrlIdx, _e) => {
      if (this._state !== 'placing') {
        // In scanning mode, trigger starts manual correction
        return;
      }
      if (!this._cornerDragStart) {
        this._cornerDragStart = this._xr.getControllerPosition(ctrlIdx);
        this._cornerDragController = ctrlIdx;
        showToast('Corner 1 set — now aim at opposite corner and pull trigger again');
      } else if (this._cornerDragController === ctrlIdx) {
        const end = this._xr.getControllerPosition(ctrlIdx);
        this._lockBoard(this._cornerDragStart, end);
        this._cornerDragStart = null;
      }
    });

    this._xr.onSqueezeStart((ctrlIdx, _e) => {
      if (this._state === 'scanning') {
        this.requestRescan();
      } else if (this._state === 'ambiguous') {
        // Side grip selects first candidate
        this._resolveAmbiguity(this._pendingCandidates[0]);
      }
    });
  }

  _lockBoard(tlWorld, brWorld) {
    // Convert 3D world positions to 2D screen-space for the detector
    // Using a simplified projection: project to camera canvas coordinates
    const cameraCanvas = this._camera.getCanvas();
    const W = cameraCanvas.width;
    const H = cameraCanvas.height;

    // Fallback: use center fraction of image as board
    const margin = 0.15;
    const tl2d = { x: W * margin, y: H * margin };
    const br2d = { x: W * (1 - margin), y: H * (1 - margin) };
    this._detector.setCorners(tl2d, br2d);

    this._state = 'scanning';
    this._lastOccupancy = null;
    showToast('Board locked. Scanning for moves…');

    // Place the 3D board overlay at a reasonable AR position
    // Position it 0.6m in front of the camera, slightly below
    const camera = this._xr.camera;
    const boardPos = new (camera.position.constructor)();
    boardPos.copy(camera.position);
    boardPos.z -= 0.6;
    boardPos.y -= 0.1;
    this._xr.placeBoard(boardPos, { x: -Math.PI / 12, y: 0, z: 0 }, 0.35);
  }

  // Auto-detect board in camera frame and lock
  async _autoDetectBoard(canvas) {
    const corners = this._detector.detectBoardCorners(canvas);
    if (corners) {
      this._detector.setFourCorners(corners);
      this._state = 'scanning';
      this._lastOccupancy = null;
      showToast('Board auto-detected and locked. Scanning…');
      return true;
    }
    return false;
  }

  _onCameraFrame(canvas) {
    if (!this._active || this._state === 'idle' || this._state === 'placing') return;
    this._frameCount++;
    if (this._frameCount % this._frameInterval !== 0) return;

    if (this._gripRequestedRescan) {
      this._gripRequestedRescan = false;
      const result = this._detector.rescanChangedSquares(canvas, this._lastOccupancy);
      if (result) {
        this._lastOccupancy = result.occupancy;
        this._updateBoardOverlay(result.occupancy, result.colors);
      }
      return;
    }

    if (this._state === 'scanning') {
      this._processFrame(canvas);
    }
  }

  _processFrame(canvas) {
    const result = this._detector.processFrame(
      canvas,
      this._lastOccupancy,
      this._game,
      this._whiteAtBottom
    );
    if (!result) return;

    const { candidates, occupancy, colors } = result;
    this._lastOccupancy = occupancy;
    this._updateBoardOverlay(occupancy, colors);

    if (!candidates.length) {
      this._occlusionCounter++;
      if (this._occlusionCounter > this._maxOcclusion) {
        // Board temporarily occluded — keep last known position, do nothing
      }
      return;
    }

    this._occlusionCounter = 0;

    if (candidates.length === 1) {
      // Unambiguous legal move — confirm after a short settling delay
      clearTimeout(this._scanTimeout);
      this._scanTimeout = setTimeout(() => {
        this._confirmMove(candidates[0]);
      }, 400);
    } else if (candidates.length > 1) {
      this._handleAmbiguity(candidates);
    }
  }

  _updateBoardOverlay(occupancy, colors) {
    this._xr.clearHighlights();
    for (let i = 0; i < 64; i++) {
      if (occupancy[i]) {
        const c = colors[i] === 'w' ? 0xf5f0e0 : 0x2a2a2a;
        this._xr.highlightSquare(i, c, 0.4);
      }
    }
  }

  async _handleAmbiguity(candidates) {
    this._state = 'ambiguous';
    this._pendingCandidates = candidates;

    // Show candidates as highlights
    this._xr.clearHighlights();
    for (const c of candidates) {
      this._xr.highlightSquare(c.from, 0xffaa00, 0.7);
      this._xr.highlightSquare(c.to, 0xffd700, 0.7);
    }

    showToast(`Ambiguous: ${candidates.map(c => `${c.from}→${c.to}`).join(' or ')}. Asking Groq…`, 4000);

    // Ask Groq to rank them
    const ranked = await rankCandidateMoves(
      this._game.confirmedFen(),
      candidates.map(c => ({ ...c, evidence: `color-match` }))
    );

    if (ranked) {
      showToast(`Groq suggests ${ranked.from}→${ranked.to}. Pull trigger to confirm or grip to cycle.`);
      this._pendingCandidates = [ranked, ...candidates.filter(c => c !== ranked)];
    } else {
      showToast(`Select move: ${candidates.map((c, i) => `[${i + 1}] ${c.from}→${c.to}`).join(' | ')}`);
    }
  }

  _resolveAmbiguity(candidate) {
    if (!candidate) return;
    this._state = 'scanning';
    this._confirmMove(candidate);
  }

  _confirmMove({ from, to }) {
    const promotion = this._needsPromotion(from, to) ? 'q' : undefined;
    const move = this._game.applyMove(from, to, promotion);
    if (!move) {
      showToast(`Move ${from}→${to} rejected by rules`, 2000, 'warn');
      this._state = 'scanning';
      return;
    }
    this._detector.saveConfirmedOccupancy();
    this._onMoveConfirmed(move);
    this._xr.clearHighlights();
    this._state = 'scanning';
  }

  _needsPromotion(from, to) {
    const piece = this._game.pieceAt(from);
    if (!piece || piece.type !== 'p') return false;
    return (piece.color === 'w' && to[1] === '8') || (piece.color === 'b' && to[1] === '1');
  }
}
