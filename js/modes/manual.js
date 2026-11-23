// Manual Board Mode — virtual floating board, no camera.
// Both sides' moves are entered with the controller laser + trigger.

import { showToast } from '../ui.js';
import { MovePicker } from './picker.js';

const CONTROLS =
  'Trigger: piece → square · Grip: cancel · A/X: undo · B/Y: re-centre board · ' +
  'Stick click: switch White/Black side · Stick ←/→: rotate board';

export class ManualBoardMode {
  constructor(game, engine, xr, onMoveConfirmed) {
    this._game = game;
    this._xr = xr;
    this._onMoveConfirmed = onMoveConfirmed;
    this._picker = new MovePicker(game, xr, (move) => this._afterMove(move));
  }

  start({ playerColor = 'w' } = {}) {
    const xr = this._xr;
    xr.whiteAtBottom = playerColor === 'w';
    xr.setStyle('virtual');
    xr.placeInFront();
    xr.setHud({ title: 'Manual board', controls: CONTROLS });
    this._sync();
    this._picker.reset();

    xr.on('selectstart', (i) => {
      xr.setHoverOwner(i);
      this._picker.selectSquare(xr.squareAtController(i));
    });
    xr.on('selectend', null);
    xr.on('squeeze', () => this._picker.cancel());
    xr.on('button', (name) => {
      if (name === 'primary') this.undo();
      else if (name === 'secondary') { xr.placeInFront(); showToast('Board re-centred'); }
      else if (name === 'stick') this.flip();
      else if (name === 'left' || name === 'right') {
        if (!this._picker.cyclePromotion(name === 'left' ? -1 : 1)) xr.rotateBoard(name === 'left' ? 1 : -1);
      }
    });
    showToast(`${this._game.turn() === 'w' ? 'White' : 'Black'} to move — aim at a piece and pull the trigger`);
    return this;
  }

  stop() {
    for (const e of ['selectstart', 'selectend', 'squeeze', 'button']) this._xr.on(e, null);
  }

  flip() {
    this._xr.whiteAtBottom = !this._xr.whiteAtBottom;
    this._sync();
    this._picker.redraw();
    this._onMoveConfirmed(null);
    showToast(`${this._xr.whiteAtBottom ? 'White' : 'Black'} now on your side`);
  }

  undo() {
    const move = this._game.undo();
    if (!move) { showToast('Nothing to undo'); return; }
    this._picker.reset();
    this._sync();
    this._onMoveConfirmed(null);
    showToast(`Undone: ${move.san}`);
  }

  loadPosition(fen) {
    if (!this._game.loadFen(fen)) { showToast('Invalid FEN'); return false; }
    this._picker.reset();
    this._sync();
    this._onMoveConfirmed(null);
    showToast('Position loaded');
    return true;
  }

  _afterMove(move) {
    this._sync();
    showToast(`Played ${move.san}`);
    this._onMoveConfirmed(move);
  }

  _sync() {
    this._xr.setPieces(this._game.boardArray());
  }
}
