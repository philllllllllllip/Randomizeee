// Physical Board Mode — overlay locked onto a real board seen in passthrough.
//
//   1. Touch the controller tip to one board corner, hold trigger, drag to the
//      opposite corner, release → overlay locks onto the real board.
//   2. The first camera frame is used to calibrate empty/white/black squares
//      against the known position.
//   3. Each stable frame is scored against every legal move (vision.matchMove).
//      Clear winner → played. Tie → Groq suggests, grip accepts.
//   4. The trigger can always enter a move by hand (camera-less fallback).
//
// Camera frames never leave the device; only FEN + candidate moves go to Groq.

import { BoardDetector, matchMove, decideMove, expectedFromBoard } from '../vision.js';
import { rankCandidateMoves } from '../groq.js';
import { showToast } from '../ui.js';
import { MovePicker } from './picker.js';

const PLACE_HELP =
  'Set up your pieces, touch the controller tip to one corner of the real board, ' +
  'HOLD trigger, drag to the opposite corner, release.';
const SCAN_CONTROLS =
  'Moves auto-detect · Trigger: enter a move yourself · Grip: rescan / accept suggestion · ' +
  'A/X: undo · B/Y: re-mark board · Stick ←/→: rotate overlay · Stick click: switch side';
const FRAME_EVERY = 10;
const STABLE_FRAMES = 3;

export class PhysicalBoardMode {
  constructor(game, engine, xr, onMoveConfirmed, camera = null) {
    this._game = game;
    this._xr = xr;
    this._onMoveConfirmed = onMoveConfirmed;
    this._camera = camera;
    this._detector = new BoardDetector();
    this._picker = new MovePicker(game, xr, (move) => this._afterMove(move, 'entered'));
    this._picker.extraHighlights = () => this._drawCandidates();
    this._state = 'placing';
    this._drag = null;
    this._prevOcc = null;
    this._stable = 0;
    this._pausedUntil = 0;
    this._pending = null; // {candidates, suggestion}
    this._warnedUnreadable = false;
  }

  start({ playerColor = 'w' } = {}) {
    const xr = this._xr;
    xr.whiteAtBottom = playerColor === 'w';
    xr.setStyle('overlay');
    xr.hideBoard();
    xr.setPieces(null);
    this._enterPlacing();

    xr.on('selectstart', (i) => this._onTrigger(i));
    xr.on('selectend', (i) => this._onTriggerEnd(i));
    xr.on('squeeze', () => this._onGrip());
    xr.on('button', (name) => this._onButton(name));
    xr.onFrame((_t, _f, n) => this._onFrame(n));
    return this;
  }

  stop() {
    for (const e of ['selectstart', 'selectend', 'squeeze', 'button']) this._xr.on(e, null);
    this._xr.showPreview(null);
  }

  _enterPlacing() {
    this._state = 'placing';
    this._drag = null;
    this._pending = null;
    this._detector.clearCalibration();
    this._xr.hideBoard();
    this._xr.clearArrows();
    this._xr.placeHudInFront();
    this._xr.setHud({
      title: 'Physical board — mark the board',
      controls: this._camera ? '' : 'Camera off: overlay + arrows only, enter moves with the trigger.',
    });
    showToast(PLACE_HELP);
  }

  // ─── Input ────────────────────────────────────────────────────────────────

  _onTrigger(i) {
    const xr = this._xr;
    if (this._state === 'placing') {
      this._drag = { start: xr.controllerTip(i), idx: i };
      showToast('Now drag to the opposite corner and release');
      return;
    }
    xr.setHoverOwner(i);
    this._picker.selectSquare(xr.squareAtController(i));
  }

  _onTriggerEnd(i) {
    if (this._state !== 'placing' || !this._drag || this._drag.idx !== i) return;
    const spec = this._xr.boardFromDiagonal(this._drag.start, this._xr.controllerTip(i));
    this._drag = null;
    this._xr.showPreview(null);
    if (!spec) { showToast('Too small — drag corner to opposite corner of the board'); return; }
    this._xr.lockBoard(spec);
    this._xr.setHud({ title: 'Physical board', controls: SCAN_CONTROLS });
    this._picker.reset();
    this._onMoveConfirmed(null);
    if (this._camera?.ready) {
      this._beginCalibration();
    } else {
      this._state = 'manual';
      showToast(`Board locked (${Math.round(spec.size * 100)} cm). No camera — enter moves with the trigger.`);
    }
  }

  _onGrip() {
    if (this._state === 'placing') return;
    if (this._pending?.suggestion) { this._play(this._pending.suggestion, 'accepted'); return; }
    if (this._picker.cancel()) return;
    if (this._camera?.ready) { this._beginCalibration(); showToast('Rescanning board…'); }
  }

  _onButton(name) {
    if (this._state === 'placing') return;
    if (name === 'primary') this.undo();
    else if (name === 'secondary') this._enterPlacing();
    else if (name === 'stick') this.flip();
    else if (name === 'left' || name === 'right') {
      if (this._picker.cyclePromotion(name === 'left' ? -1 : 1)) return;
      this._xr.rotateBoard(name === 'left' ? 1 : -1);
      this._resync('Overlay rotated');
    }
  }

  flip() {
    this._xr.whiteAtBottom = !this._xr.whiteAtBottom;
    this._resync(`${this._xr.whiteAtBottom ? 'White' : 'Black'} side now nearest you`);
  }

  undo() {
    const move = this._game.undo();
    if (!move) { showToast('Nothing to undo'); return; }
    this._pending = null;
    this._picker.reset();
    this._pausedUntil = performance.now() + 4000;
    this._onMoveConfirmed(null);
    showToast(`Undone ${move.san} — put the pieces back (detection paused 4 s)`);
  }

  loadPosition(fen) {
    if (!this._game.loadFen(fen)) { showToast('Invalid FEN'); return false; }
    this._resync('Position loaded');
    this._onMoveConfirmed(null);
    return true;
  }

  _resync(msg) {
    this._pending = null;
    this._picker.reset();
    this._xr.clearArrow('suggest');
    this._onMoveConfirmed(null);
    if (this._camera?.ready && this._state !== 'placing') this._beginCalibration();
    showToast(msg);
  }

  // ─── Vision loop ──────────────────────────────────────────────────────────

  _beginCalibration() {
    this._state = 'calibrating';
    this._detector.clearCalibration();
    this._prevOcc = null;
    this._stable = 0;
  }

  _onFrame(n) {
    const xr = this._xr;
    if (this._state === 'placing') {
      if (this._drag) xr.showPreview(xr.boardFromDiagonal(this._drag.start, xr.controllerTip(this._drag.idx)));
      return;
    }
    if (n % FRAME_EVERY !== 0 || !this._camera?.ready) return;
    if (this._state !== 'calibrating' && this._state !== 'scanning') return;

    const canvas = this._camera.grab();
    if (!canvas) return;
    this._detector.setFourCorners(xr.projectBoardToImage(canvas.width, canvas.height));
    const v = xr.viewerDirOnBoard();
    this._detector.setViewDir(v.x, v.y);
    const obs = this._detector.analyzeFrame(canvas);
    if (!obs) return;
    const toIdx = (sq) => xr.squareToIndex(sq);

    if (this._state === 'calibrating') {
      const expected = expectedFromBoard(this._game.boardArray(), toIdx);
      const ok = this._detector.calibrate(obs, expected);
      const check = ok ? matchMove(this._detector.analyzeFrame(canvas), this._game.chess, toIdx).base : 99;
      this._state = 'scanning';
      this._warnedUnreadable = false;
      showToast(ok && check <= 6
        ? 'Board locked and calibrated — make your move'
        : 'Board locked, but the camera view does not line up well. Moves may need the trigger. B/Y re-marks.');
      return;
    }

    const occKey = obs.occupancy.map(Number).join('');
    this._stable = occKey === this._prevOcc ? this._stable + 1 : 0;
    this._prevOcc = occKey;
    if (this._stable < STABLE_FRAMES || this._picker.busy || performance.now() < this._pausedUntil) return;

    const decision = decideMove(matchMove(obs, this._game.chess, toIdx));
    if (decision.kind === 'move') {
      this._play(decision.move, 'detected');
    } else if (decision.kind === 'ambiguous') {
      this._handleAmbiguity(decision.candidates);
    } else if (decision.kind === 'unreadable' && !this._warnedUnreadable && this._stable > STABLE_FRAMES * 3) {
      this._warnedUnreadable = true;
      showToast("Can't read that move — point and pull the trigger to enter it, or grip to rescan");
    } else if (decision.kind === 'none') {
      this._warnedUnreadable = false;
    }
  }

  async _handleAmbiguity(candidates) {
    const key = candidates.map(m => m.from + m.to).join(',');
    if (this._pending?.key === key) return;
    this._pending = { key, candidates, suggestion: null };
    this._picker.redraw();
    showToast(`Unclear: ${candidates.map(m => m.san).join(' or ')} — asking for a suggestion…`);

    const ranked = await rankCandidateMoves(
      this._game.fen(),
      candidates.map(m => ({ from: m.from, to: m.to, evidence: m.san }))
    );
    if (this._pending?.key !== key) return;
    const pick = ranked && candidates.find(m => m.from === ranked.from && m.to === ranked.to);
    if (pick) {
      this._pending.suggestion = pick;
      this._xr.showArrow(pick.from, pick.to, 0xc77dff, 'suggest');
      showToast(`Looks like ${pick.san}. Grip to accept, or trigger the real move.`);
    } else {
      showToast(`Which was it: ${candidates.map(m => m.san).join(' / ')}? Enter it with the trigger.`);
    }
  }

  _drawCandidates() {
    if (!this._pending) return;
    for (const m of this._pending.candidates) {
      this._xr.highlightSquare(m.from, 0xffaa00, 0.55);
      this._xr.highlightSquare(m.to, 0xffd700, 0.55);
    }
  }

  _play(move, how) {
    const played = this._game.applyMove(move.from, move.to, move.promotion || 'q');
    if (!played) { showToast(`${move.san ?? move.from + move.to} is not legal here`); return; }
    this._afterMove(played, how);
  }

  _afterMove(move, how) {
    this._pending = null;
    this._xr.clearArrow('suggest');
    this._picker.lastMove = { from: move.from, to: move.to };
    this._picker.redraw();
    this._stable = 0;
    this._warnedUnreadable = false;
    showToast(`${how === 'detected' ? 'Detected' : 'Played'} ${move.san}`);
    this._onMoveConfirmed(move);
  }
}
