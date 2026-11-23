// Laser-and-trigger move entry shared by both modes:
// trigger a piece, then trigger a highlighted destination.
// Promotion: flick the stick left/right to cycle the piece, trigger to confirm.

import { showToast } from '../ui.js';

const PROMO = ['q', 'r', 'b', 'n'];
const PROMO_NAME = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };

export class MovePicker {
  constructor(game, xr, onMove) {
    this._game = game;
    this._xr = xr;
    this._onMove = onMove;
    this._from = null;
    this._dests = [];
    this._promo = null; // {from, to, idx}
    this.lastMove = null;
    this.extraHighlights = () => {};
  }

  get busy() { return !!(this._from || this._promo); }

  selectSquare(sq) {
    if (!sq) return;
    if (this._promo) {
      const { from, to, idx } = this._promo;
      this._promo = null;
      this._commit(from, to, PROMO[idx]);
      return;
    }
    const piece = this._game.pieceAt(sq);
    if (!this._from || (piece && piece.color === this._game.turn() && !this._dests.includes(sq))) {
      if (!piece || piece.color !== this._game.turn()) {
        showToast(`${this._game.turn() === 'w' ? 'White' : 'Black'} to move — pick one of their pieces`);
        return;
      }
      const moves = this._game.legalMoves(sq);
      if (!moves.length) { showToast(`${sq}: no legal moves`); return; }
      this._from = sq;
      this._dests = [...new Set(moves.map(m => m.to))];
      showToast(`${sq} selected — pick a green square`);
      this.redraw();
      return;
    }
    if (!this._dests.includes(sq)) { showToast('Not a legal square — grip to cancel'); return; }
    const p = this._game.pieceAt(this._from);
    const isPromo = p?.type === 'p' && (sq[1] === '8' || sq[1] === '1');
    if (isPromo) {
      this._promo = { from: this._from, to: sq, idx: 0 };
      this._from = null;
      this._dests = [];
      this._showPromo();
      this.redraw();
      return;
    }
    this._commit(this._from, sq);
  }

  cyclePromotion(dir) {
    if (!this._promo) return false;
    this._promo.idx = (this._promo.idx + dir + PROMO.length) % PROMO.length;
    this._showPromo();
    return true;
  }

  _showPromo() {
    const { idx } = this._promo;
    showToast(`Promote to ${PROMO_NAME[PROMO[idx]]} — stick ←/→ to change, trigger to confirm`);
  }

  cancel() {
    if (!this.busy) return false;
    this._from = null;
    this._dests = [];
    this._promo = null;
    showToast('Selection cleared');
    this.redraw();
    return true;
  }

  _commit(from, to, promotion = 'q') {
    this._from = null;
    this._dests = [];
    const move = this._game.applyMove(from, to, promotion);
    if (!move) { showToast('Illegal move'); this.redraw(); return; }
    this.lastMove = { from: move.from, to: move.to };
    this.redraw();
    this._onMove(move);
  }

  redraw() {
    const xr = this._xr;
    xr.clearHighlights();
    if (this.lastMove) {
      xr.highlightSquare(this.lastMove.from, 0xffe14a, 0.35);
      xr.highlightSquare(this.lastMove.to, 0xffe14a, 0.5);
    }
    this.extraHighlights();
    if (this._from) {
      xr.highlightSquare(this._from, 0x4aa8ff, 0.75);
      for (const d of this._dests) xr.highlightSquare(d, 0x44ff88, 0.5);
    }
    if (this._promo) xr.highlightSquare(this._promo.to, 0xc77dff, 0.7);
  }

  reset() {
    this._from = null;
    this._dests = [];
    this._promo = null;
    const last = this._game.lastMove();
    this.lastMove = last ? { from: last.from, to: last.to } : null;
    this.redraw();
  }
}
