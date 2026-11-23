// Board Coach XR — main entry point
// Three.js / XRSession is loaded dynamically (only on "Start AR") so the
// landing page renders immediately without any CDN round-trip at boot.

import { ChessGame } from './game.js';
import { StockfishEngine } from './engine.js';
import { PhysicalBoardMode } from './modes/physical.js';
import { ManualBoardMode } from './modes/manual.js';
import { DesktopBoard, showToast } from './ui.js';

// ─── Progress helpers ─────────────────────────────────────────────────────────
function setProgress(pct, msg) {
  const fill = document.getElementById('loader-fill');
  const status = document.getElementById('loader-status');
  if (fill) fill.style.width = pct + '%';
  if (status) status.textContent = msg;
}

function hideLoading() {
  const ls = document.getElementById('loading-screen');
  if (ls) {
    ls.classList.add('fade-out');
    setTimeout(() => ls.remove(), 500);
  }
}

// ─── App State ────────────────────────────────────────────────────────────────
const state = {
  game: new ChessGame(),
  engine: new StockfishEngine(),
  xr: null,          // created lazily on "Start AR"
  mode: null,
  modeInstance: null,
  playerColor: 'w',
  engineDepth: 15,
  desktopBoard: null,
  engineBusy: false,
};

// ─── Boot — runs immediately, never waits for CDN ────────────────────────────
async function boot() {
  // chess.js is a local <script> tag — available synchronously
  setProgress(10, 'Starting up…');
  if (typeof Chess === 'undefined') {
    // Shouldn't happen but guard anyway
    setProgress(10, 'chess.js not found — check js/lib/chess.js');
    return;
  }
  state.game.init();
  setProgress(40, 'Chess engine ready');

  // Stockfish loads in the background — non-blocking, non-fatal
  setProgress(70, 'Loading Stockfish (background)…');
  state.engine.load((msg) => {
    // Keep status updated but don't block UI
    const status = document.getElementById('loader-status');
    if (status && document.getElementById('loading-screen')) status.textContent = msg;
  }).catch((err) => {
    console.warn('Stockfish unavailable:', err.message);
  });

  setProgress(90, 'Checking WebXR…');
  const xrSupported = await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false);
  if (!xrSupported) {
    document.getElementById('browser-warning')?.classList.remove('hidden');
  }

  setProgress(100, 'Ready');
  setTimeout(hideLoading, 300);

  document.getElementById('landing')?.classList.remove('hidden');
  setupLandingUI();
  setupDesktopFallback();
}

// ─── Landing UI ───────────────────────────────────────────────────────────────
function setupLandingUI() {
  document.getElementById('color-select')?.addEventListener('change', (e) => {
    state.playerColor = e.target.value;
  });
  document.getElementById('depth-select')?.addEventListener('change', (e) => {
    state.engineDepth = parseInt(e.target.value);
  });

  document.getElementById('btn-physical')?.addEventListener('click', () => startMode('physical'));
  document.getElementById('btn-manual')?.addEventListener('click', () => startMode('manual'));
}

async function startMode(mode) {
  document.getElementById('landing')?.classList.add('hidden');
  state.mode = mode;

  const xrSupported = await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false);
  if (!xrSupported) {
    startDesktopFallback();
    return;
  }
  await startXRMode(mode);
}

// Three.js and XRSession are loaded here — only when the user actually
// enters AR, so the landing page never waits for CDN traffic.
async function startXRMode(modeName) {
  // Show a small loading overlay while Three.js downloads
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;background:#000a;color:#fff;display:flex;' +
    'align-items:center;justify-content:center;font-size:20px;z-index:800;';
  overlay.textContent = 'Loading AR… (first time ~2 s)';
  document.body.appendChild(overlay);

  try {
    const { XRSession } = await import('./xr.js');
    const xr = new XRSession();
    await xr.init();
    state.xr = xr;
    xr.startRenderLoop();

    overlay.remove();

    const arButton = xr.createARButton();
    arButton.style.cssText =
      'position:fixed;bottom:40px;left:50%;transform:translateX(-50%);' +
      'padding:14px 32px;background:#4a9eff;color:#fff;border:none;' +
      'border-radius:8px;font-size:16px;font-weight:700;cursor:pointer;z-index:600;';
    document.body.appendChild(arButton);

    xr.renderer.xr.addEventListener('sessionstart', () => {
      arButton.remove();
      xr.showCanvas();
      launchMode(modeName);
    });
  } catch (err) {
    overlay.remove();
    console.error('XR init failed:', err);
    showToast('AR unavailable — using desktop board');
    startDesktopFallback();
  }
}

function launchMode(modeName) {
  const { game, engine, xr } = state;
  game.reset();
  engine.newGame?.();
  xr.clearHighlights?.();
  xr.clearArrow?.();
  state.modeInstance?.stop?.();

  if (modeName === 'physical') {
    state.modeInstance = new PhysicalBoardMode(game, engine, xr, onMoveConfirmed);
    state.modeInstance.start({ playerColor: state.playerColor });
  } else {
    state.modeInstance = new ManualBoardMode(game, engine, xr, onMoveConfirmed);
    state.modeInstance.start({ playerColor: state.playerColor });
  }

  xr.onFrame((_time, _frame) => { /* XR HUD updates if needed */ });
}

// ─── Move Confirmed Callback ──────────────────────────────────────────────────
async function onMoveConfirmed(_move) {
  updateDesktopBoard();

  if (state.game.isGameOver()) {
    showToast('Game over: ' + getGameOverReason());
    return;
  }

  const isPlayerTurn = state.game.turn() === state.playerColor;
  if (isPlayerTurn && !state.engineBusy) {
    requestEngineHint();
  } else {
    state.xr?.clearArrow?.();
    const el = document.getElementById('desktop-move-hint');
    if (el) el.textContent = '';
  }
}

async function requestEngineHint() {
  if (!state.engine._ready || state.engineBusy) return;
  state.engineBusy = true;
  try {
    const fen = state.game.fen();
    const { move, score } = await state.engine.getBestMove(fen, state.engineDepth, 2000);
    if (!move || move === '(none)') return;
    const from = move.slice(0, 2);
    const to = move.slice(2, 4);
    state.xr?.showArrow?.(from, to);
    updateMoveHintUI(move, score);
  } catch (err) {
    console.warn('Engine error:', err);
  } finally {
    state.engineBusy = false;
  }
}

function updateMoveHintUI(uciMove, score) {
  const from = uciMove.slice(0, 2), to = uciMove.slice(2, 4);
  const scoreStr = score != null
    ? (score > 0 ? `+${(score / 100).toFixed(1)}` : `${(score / 100).toFixed(1)}`)
    : '';
  const el = document.getElementById('desktop-move-hint');
  if (el) el.textContent = `Best: ${from}→${to}  ${scoreStr}`;
}

function getGameOverReason() {
  const g = state.game.chess;
  if (g.in_checkmate()) return 'Checkmate!';
  if (g.in_stalemate()) return 'Stalemate';
  if (g.insufficient_material()) return 'Draw — insufficient material';
  if (g.in_threefold_repetition()) return 'Draw — threefold repetition';
  if (g.in_draw()) return 'Draw';
  return 'Game over';
}

// ─── Desktop Fallback ─────────────────────────────────────────────────────────
function setupDesktopFallback() {
  const canvas = document.getElementById('desktop-board');
  if (!canvas) return;
  state.desktopBoard = new DesktopBoard(canvas);

  document.getElementById('btn-undo')?.addEventListener('click', () => {
    if (state.modeInstance?.undo) {
      state.modeInstance.undo();
    } else {
      state.game.undo();
      updateDesktopBoard();
    }
  });
  document.getElementById('btn-new-game')?.addEventListener('click', () => {
    state.game.reset();
    state.engine.newGame?.();
    updateDesktopBoard();
    state.xr?.clearArrow?.();
    const el = document.getElementById('desktop-move-hint');
    if (el) el.textContent = '';
  });
  document.getElementById('btn-flip')?.addEventListener('click', () => {
    state.desktopBoard.flip();
    updateDesktopBoard();
  });
  document.getElementById('btn-load-fen')?.addEventListener('click', () => {
    const fen = document.getElementById('fen-input')?.value?.trim();
    if (!fen) return;
    if (state.modeInstance?.loadPosition) {
      state.modeInstance.loadPosition(fen);
    } else {
      state.game.loadFen(fen);
    }
    updateDesktopBoard();
  });

  let selectedFrom = null;
  state.desktopBoard.onClick((sq) => {
    if (!selectedFrom) {
      const piece = state.game.pieceAt(sq);
      if (!piece || piece.color !== state.game.turn()) return;
      selectedFrom = sq;
      state.desktopBoard.clearHighlights();
      state.desktopBoard.highlight(sq, '#4a9eff', 0.7);
      const moves = state.game.legalMoves(sq);
      for (const m of moves) state.desktopBoard.highlight(m.to, '#44ff88', 0.4);
      updateDesktopBoard();
    } else {
      if (state.game.isLegal(selectedFrom, sq)) {
        const prom = document.getElementById('promotion-panel');
        const p = state.game.pieceAt(selectedFrom);
        const needProm = p?.type === 'p' &&
          ((p.color === 'w' && sq[1] === '8') || (p.color === 'b' && sq[1] === '1'));
        if (needProm) {
          prom?.classList.remove('hidden');
          const { from, to } = { from: selectedFrom, to: sq };
          selectedFrom = null;
          for (const btn of document.querySelectorAll('.promo-btn')) {
            btn.onclick = () => {
              prom?.classList.add('hidden');
              state.game.applyMove(from, to, btn.dataset.piece);
              updateDesktopBoard();
              onMoveConfirmed(state.game.lastMove());
            };
          }
        } else {
          state.game.applyMove(selectedFrom, sq);
          onMoveConfirmed(state.game.lastMove());
        }
      }
      selectedFrom = null;
      state.desktopBoard.clearHighlights();
      updateDesktopBoard();
    }
  });
}

function startDesktopFallback() {
  document.getElementById('desktop-hud')?.classList.remove('hidden');
  updateDesktopBoard();
  onMoveConfirmed(null);
}

function updateDesktopBoard() {
  if (!state.desktopBoard) return;
  const fen = state.game.fen();
  const el = document.getElementById('desktop-fen-display');
  if (el) el.textContent = fen;
  state.desktopBoard.render(state.game.boardArray());
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
boot().catch((err) => {
  console.error('Boot failed:', err);
  setProgress(100, 'Error: ' + err.message);
});
