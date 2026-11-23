// Physical Board Mode — fully automatic.
//
// Look at your real board: it is found in the passthrough camera image, the
// grid is drawn onto it, and every move is picked up once the board is still
// again (hand gone). No corner marking, no buttons needed.
//
// Camera frames stay on the device (vision runs in a local Web Worker); only
// FEN + candidate moves are ever sent to Groq, and only for ambiguous moves.

import { BoardFinder, canonicalIndex } from '../boardfind.js';
import {
  matchMove, decideMove, matchTwoPly, expectedFromBoard, squareDescriptors, descriptorChanges,
} from '../vision.js';
import { rankCandidateMoves } from '../groq.js';
import { showToast } from '../ui.js';
import { MovePicker } from './picker.js';

const CONTROLS = 'Hands-free. Optional: A/X undo · B/Y re-find board · Trigger: enter a move yourself';
const SUBMIT_EVERY = 3;    // XR frames between camera submissions
const STABLE = 2;          // identical readings needed before judging a move
const STABLE_WEAK = 5;     // ...for low-evidence captures

export class PhysicalBoardMode {
  constructor(game, engine, xr, onMoveConfirmed, camera = null) {
    this._game = game;
    this._xr = xr;
    this._onMoveConfirmed = onMoveConfirmed;
    this._camera = camera;
    this._picker = new MovePicker(game, xr, (move) => this._afterMove([move], 'Played'));
    this._state = 'searching';
    this._busy = false;
    this._lost = 0;
    this._stableKey = null;
    this._stable = 0;
    this._pausedUntil = 0;
    this._asked = new Set();
    this._warned = false;
    this._arrow = null;
    this._lastRes = null;
    this._worker = null;
    this._localFinder = null;
    this._frameId = 0;
    this._ref = null; // square descriptors of the last confirmed position
  }

  start({ playerColor = 'w' } = {}) {
    const xr = this._xr;
    this._blackView = playerColor === 'b';
    xr.whiteAtBottom = true;
    xr.setStyle('overlay');
    xr.resetOverlay();
    xr.setPieces(null);
    xr.placeHudInFront(0.75, 0.25);
    xr.setHud({ title: 'Physical board', controls: CONTROLS, hint: '' });
    this._startVision();

    if (!this._camera?.ready) {
      showToast('Camera is off, so the board cannot be seen. Allow "headset cameras" for this site in the browser settings, then restart.');
    } else {
      showToast('Set up the starting position and look at the board — it will lock on automatically.');
    }

    xr.on('selectstart', (i) => { xr.setHoverOwner(i); this._picker.selectSquare(xr.squareAtController(i)); });
    xr.on('selectend', null);
    xr.on('squeeze', () => { if (!this._picker.cancel()) this._refind(); });
    xr.on('button', (name) => {
      if (name === 'primary') this.undo();
      else if (name === 'secondary') this._refind();
      else if (name === 'left' || name === 'right') this._picker.cyclePromotion(name === 'left' ? -1 : 1);
    });
    xr.onFrame((_t, _f, n) => { if (n % SUBMIT_EVERY === 0) this._submit(); });
    this._minimap();
    return this;
  }

  stop() {
    for (const e of ['selectstart', 'selectend', 'squeeze', 'button']) this._xr.on(e, null);
    this._worker?.terminate();
    this._worker = null;
    this._xr.setMinimap(null);
  }

  undo() {
    const move = this._game.undo();
    if (!move) { showToast('Nothing to undo'); return; }
    this._picker.reset();
    this._ref = null;
    this._pausedUntil = performance.now() + 4000;
    this._onMoveConfirmed(null);
    showToast(`Undone ${move.san} — put the pieces back (pausing 4 s)`);
  }

  loadPosition(fen) {
    if (!this._game.loadFen(fen)) { showToast('Invalid FEN'); return false; }
    this._refind();
    this._onMoveConfirmed(null);
    return true;
  }

  // Called by main when the engine has a suggestion, so the HUD map shows it.
  setHintArrow(from, to) {
    this._arrow = from ? { from, to } : null;
    this._minimap();
  }

  _refind() {
    this._state = 'searching';
    this._ref = null;
    this._worker?.postMessage({ type: 'reset' });
    this._localFinder?.reset();
    this._xr.resetOverlay();
    showToast('Looking for the board again…');
  }

  // ─── Vision plumbing ─────────────────────────────────────────────────────

  _startVision() {
    try {
      this._worker = new Worker(new URL('../vision-worker.js', import.meta.url), { type: 'module' });
      this._worker.onmessage = (e) => this._onResult(e.data);
      this._worker.onerror = (e) => {
        console.warn('Vision worker failed, using main thread:', e.message);
        this._worker = null;
        this._busy = false;
      };
    } catch (err) {
      console.warn('Module worker unsupported, using main thread:', err);
      this._worker = null;
    }
  }

  async _submit() {
    if (this._busy || !this._camera?.ready) return;
    this._busy = true;
    try {
      const expected = expectedFromBoard(this._game.boardArray(), canonicalIndex);
      const bitmap = await this._camera.bitmap(640);
      if (!bitmap) { this._busy = false; return; }
      const id = ++this._frameId;
      if (this._worker) {
        this._worker.postMessage({ type: 'frame', bitmap, expected, id }, [bitmap]);
      } else {
        this._localFinder ??= new BoardFinder();
        const c = (this._fallbackCanvas ??= document.createElement('canvas'));
        c.width = bitmap.width; c.height = bitmap.height;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const res = this._localFinder.process(ctx.getImageData(0, 0, c.width, c.height), expected);
        this._onResult({ ...res, W: c.width, H: c.height, id });
      }
    } catch (err) {
      console.warn('frame submit failed', err);
      this._busy = false;
    }
  }

  _onResult(res) {
    this._busy = false;
    this._lastRes = res;
    const xr = this._xr;

    if (!res.found) {
      this._lost++;
      this._stable = 0;
      if (this._state === 'searching') {
        const why = res.lattice
          ? 'Board grid seen — set up the starting position so I can tell which side is which.'
          : res.nCorners > 20 ? 'Almost — get the whole board in view, a bit more from above.'
            : 'Looking for the board… get the whole board in view.';
        if (this._lost % 5 === 1) xr.setHud({ status: why });
      } else if (this._lost === 6) {
        xr.setHud({ status: 'Board hidden (hand in the way?) — waiting…' });
      }
      return;
    }

    this._lost = 0;
    const world = xr.imageToTable(res.corners, res.W, res.H);
    xr.placeBoardFromCorners(world);

    if (this._state === 'searching') {
      this._state = 'tracking';
      this._stableKey = null;
      // Lock happens on the known position, so this frame is the reference.
      this._ref = res.warp ? squareDescriptors(res.warp) : null;
      this._picker.reset();
      showToast(this._game.moveHistory().length
        ? 'Board found — tracking moves'
        : 'Board found! Make your move — I\'ll see it when your hand is gone.');
      this._onMoveConfirmed(null);
    }
    this._minimap(res);
    this._judge(res);
  }

  _minimap(res = this._lastRes) {
    const last = this._game.lastMove();
    this._xr.setMinimap({
      warp: res?.warp ?? null,
      occupancy: res?.occupancy,
      colors: res?.colors,
      arrow: this._arrow,
      last: last ? { from: last.from, to: last.to } : null,
      blackView: this._blackView,
    });
  }

  // ─── Move judgement ──────────────────────────────────────────────────────

  _judge(res) {
    const key = res.occupancy.map(Number).join('') + res.colors.map(c => c ?? '-').join('');
    this._stable = key === this._stableKey ? this._stable + 1 : 0;
    this._stableKey = key;
    if (this._stable < STABLE || this._picker.busy || performance.now() < this._pausedUntil) return;

    const chess = this._game.chess;
    const desc = res.warp ? squareDescriptors(res.warp) : null;
    const change = this._ref && desc ? descriptorChanges(this._ref, desc) : null;
    this._lastDesc = desc;
    const d = decideMove(matchMove(res, chess, canonicalIndex, change));
    if (d.kind === 'none') {
      // Board matches the position: refresh the reference (lighting, head pose).
      this._warned = false;
      if (desc) this._ref = desc;
      return;
    }
    if (d.kind === 'move') { this._play([d.move], 'Detected'); return; }
    if (d.kind === 'ambiguous') {
      if (d.weak && this._stable < STABLE_WEAK) return;
      this._resolve(d.candidates);
      return;
    }
    // Nothing single explains it — maybe a move was missed while the board was hidden.
    if (this._stable >= STABLE + 2) {
      const pair = matchTwoPly(res, chess, canonicalIndex, change);
      if (pair) { this._play(pair, 'Caught up'); return; }
      if (!this._warned && this._stable >= STABLE + 4) {
        this._warned = true;
        showToast("Can't match that to a legal move. Check the pieces, press A/X to undo, or enter it with the trigger.");
      }
    }
  }

  async _resolve(candidates) {
    const key = this._game.fen() + candidates.map(m => m.from + m.to).join(',');
    if (this._asked.has(key)) return;
    this._asked.add(key);
    showToast(`Was it ${candidates.map(m => m.san).join(' or ')}? Checking…`);
    const ranked = await rankCandidateMoves(
      this._game.fen(),
      candidates.map(m => ({ from: m.from, to: m.to, evidence: m.san }))
    );
    if (!key.startsWith(this._game.fen())) return; // position moved on
    const pick = ranked && candidates.find(m => m.from === ranked.from && m.to === ranked.to);
    if (pick) { this._play([pick], 'Best guess'); return; }
    // No tie-breaker available: guessing would silently corrupt the game.
    this._xr.clearHighlights();
    for (const m of candidates) { this._xr.highlightSquare(m.from, 0xffaa00, 0.6); this._xr.highlightSquare(m.to, 0xffd700, 0.6); }
    showToast(`Was it ${candidates.map(m => m.san).join(' or ')}? Point at the piece and pull the trigger to say which.`);
  }

  _play(moves, how) {
    const played = [];
    for (const m of moves) {
      const r = this._game.applyMove(m.from, m.to, m.promotion || 'q');
      if (!r) break;
      played.push(r);
    }
    if (played.length) this._afterMove(played, how);
  }

  _afterMove(played, how) {
    const last = played[played.length - 1];
    this._picker.lastMove = { from: last.from, to: last.to };
    this._picker.redraw();
    this._stable = 0;
    this._warned = false;
    this._arrow = null;
    // The frame that confirmed the move shows the new position.
    if (how !== 'Played' && this._lastDesc) this._ref = this._lastDesc;
    else this._ref = null;
    const undoTip = how === 'Detected' || how === 'Played' ? '' : '  (wrong? A/X undoes)';
    showToast(`${how}: ${played.map(m => m.san).join(' ')}${undoTip}`);
    this._minimap();
    this._onMoveConfirmed(last);
  }
}
