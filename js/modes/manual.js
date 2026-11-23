// Manual Board Mode
// Virtual floating board — no camera, no vision inference
// Players enter both sides' moves via controller trigger
// Supports: undo, promotion selection, board flip

import { showToast } from '../ui.js';
import { ChessGame } from '../game.js';

export class ManualBoardMode {
  constructor(game, engine, xrSession, onMoveConfirmed) {
    this._game = game;
    this._engine = engine;
    this._xr = xrSession;
    this._onMoveConfirmed = onMoveConfirmed;

    this._active = false;
    this._state = 'idle'; // idle | selecting-from | selecting-to | promotion
    this._selectedFrom = null;
    this._pendingPromo = null;
    this._legalFromSquares = [];
    this._legalToSquares = [];
    this._whiteAtBottom = true;
    this._floatDistance = 0.6; // metres in front
  }

  start(options = {}) {
    this._whiteAtBottom = (options.playerColor ?? 'w') === 'w';
    this._active = true;
    this._state = 'selecting-from';

    this._placeVirtualBoard();
    this._setupControllers();
    this._refreshLegalFromSquares();
    showToast('Select a piece to move (trigger)');
    return this;
  }

  stop() {
    this._active = false;
    this._state = 'idle';
    this._xr.clearHighlights();
    this._xr.clearArrow();
  }

  flip() {
    this._whiteAtBottom = !this._whiteAtBottom;
    showToast(`Flipped — ${this._whiteAtBottom ? 'White' : 'Black'} at bottom`);
    this._refreshLegalFromSquares();
  }

  undo() {
    const move = this._game.undo();
    if (!move) { showToast('Nothing to undo'); return; }
    showToast(`Undone: ${move.san}`);
    this._state = 'selecting-from';
    this._selectedFrom = null;
    this._refreshLegalFromSquares();
    this._onMoveConfirmed(null);
  }

  _placeVirtualBoard() {
    const camera = this._xr.camera;
    const THREE = this._xr.renderer.domElement.THREE;
    // Position board in front of user
    const pos = camera.position.clone();
    // Move forward by _floatDistance along camera's -Z
    const forward = new camera.position.constructor(0, 0, -this._floatDistance);
    forward.applyQuaternion(camera.quaternion);
    pos.add(forward);
    pos.y -= 0.15; // slightly below eye level

    this._xr.placeBoard(pos, { x: -Math.PI / 10, y: 0, z: 0 }, 0.38);
  }

  _setupControllers() {
    this._xr.onSelectStart((ctrlIdx, _e) => {
      if (!this._active) return;
      const sqIdx = this._xr.getControllerBoardIntersection(ctrlIdx);
      if (sqIdx === null) return;
      const sq = this._indexToSquare(sqIdx);
      this._handleSquareSelect(sq);
    });

    this._xr.onSqueezeStart((_ctrlIdx, _e) => {
      if (!this._active) return;
      if (this._state === 'selecting-to' && this._selectedFrom) {
        // Grip cancels selection
        this._state = 'selecting-from';
        this._selectedFrom = null;
        this._xr.clearHighlights();
        this._refreshLegalFromSquares();
        showToast('Selection cleared');
      }
    });
  }

  _indexToSquare(idx) {
    const row = Math.floor(idx / 8);
    const col = idx % 8;
    if (this._whiteAtBottom) {
      return 'abcdefgh'[col] + (8 - row);
    } else {
      return 'abcdefgh'[7 - col] + (row + 1);
    }
  }

  _squareToIndex(sq) {
    const col = 'abcdefgh'.indexOf(sq[0]);
    const row = 8 - parseInt(sq[1]);
    return this._whiteAtBottom
      ? row * 8 + col
      : (7 - row) * 8 + (7 - col);
  }

  _handleSquareSelect(sq) {
    if (this._state === 'selecting-from') {
      const piece = this._game.pieceAt(sq);
      if (!piece) { showToast('No piece there'); return; }

      const legal = this._game.legalMoves(sq);
      if (!legal.length) { showToast('No legal moves for that piece'); return; }

      this._selectedFrom = sq;
      this._legalToSquares = legal.map(m => m.to);
      this._state = 'selecting-to';

      // Highlight the piece + legal destinations
      this._xr.clearHighlights();
      this._xr.highlightSquare(sq, 0x4a9eff, 0.8);
      for (const dest of this._legalToSquares) {
        this._xr.highlightSquare(dest, 0x44ff88, 0.5);
      }
      showToast(`${sq} selected — pick destination`);

    } else if (this._state === 'selecting-to') {
      if (!this._legalToSquares.includes(sq)) {
        // Reselect if the square has a friendly piece
        const piece = this._game.pieceAt(sq);
        if (piece && piece.color === this._game.turn()) {
          this._selectedFrom = null;
          this._state = 'selecting-from';
          this._handleSquareSelect(sq);
          return;
        }
        showToast('Not a legal destination');
        return;
      }

      const needsPromo = this._checkPromotion(this._selectedFrom, sq);
      if (needsPromo) {
        this._pendingPromo = { from: this._selectedFrom, to: sq };
        this._state = 'promotion';
        this._showPromotionUI();
      } else {
        this._executeMove(this._selectedFrom, sq);
      }
    }
  }

  _checkPromotion(from, to) {
    const piece = this._game.pieceAt(from);
    if (!piece || piece.type !== 'p') return false;
    return (piece.color === 'w' && to[1] === '8') || (piece.color === 'b' && to[1] === '1');
  }

  _showPromotionUI() {
    // For XR: show a floating panel with 4 promotion options
    // For desktop: use the HTML panel
    const promoEl = document.getElementById('promotion-panel');
    if (promoEl) {
      promoEl.classList.remove('hidden');
      const buttons = promoEl.querySelectorAll('.promo-btn');
      for (const btn of buttons) {
        btn.onclick = () => {
          promoEl.classList.add('hidden');
          const piece = btn.dataset.piece;
          this._executeMove(this._pendingPromo.from, this._pendingPromo.to, piece);
          this._pendingPromo = null;
        };
      }
    } else {
      // XR fallback: auto-promote to queen
      this._executeMove(this._pendingPromo.from, this._pendingPromo.to, 'q');
      this._pendingPromo = null;
    }
    showToast('Choose promotion piece (or auto-queen in XR)');
  }

  _executeMove(from, to, promotion = 'q') {
    const move = this._game.applyMove(from, to, promotion);
    if (!move) { showToast('Illegal move', 2000, 'error'); return; }

    this._xr.clearHighlights();
    this._selectedFrom = null;
    this._state = 'selecting-from';

    // Highlight last move squares
    this._xr.highlightSquare(from, 0xffee44, 0.4);
    this._xr.highlightSquare(to, 0xffee44, 0.6);

    this._onMoveConfirmed(move);
    this._refreshLegalFromSquares();
    showToast(`Played: ${move.san}`);
  }

  _refreshLegalFromSquares() {
    this._legalFromSquares = [...new Set(
      this._game.legalMovePairs().map(m => m.from)
    )];
    // Show selectable squares subtly
    for (const sq of this._legalFromSquares) {
      this._xr.highlightSquare(sq, 0x888888, 0.15);
    }
  }

  // Allow loading a custom FEN position
  loadPosition(fen) {
    if (!this._game.loadFen(fen)) {
      showToast('Invalid FEN', 2000, 'error');
      return false;
    }
    this._state = 'selecting-from';
    this._selectedFrom = null;
    this._xr.clearHighlights();
    this._xr.clearArrow();
    this._refreshLegalFromSquares();
    this._onMoveConfirmed(null);
    showToast('Position loaded');
    return true;
  }
}
