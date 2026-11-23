// Board Coach XR — main entry point
// Orchestrates loading, mode selection, XR session, game state, and engine

import { XRSession } from './xr.js';
import { ChessGame } from './game.js';
import { StockfishEngine } from './engine.js';
import { loadOpenCV } from './vision.js';
import { PhysicalBoardMode } from './modes/physical.js';
import { ManualBoardMode } from './modes/manual.js';
import { DesktopBoard, showToast } from './ui.js';

// ─── Load chess.js from CDN ───────────────────────────────────────────────────
async function loadChessJS() {
  return new Promise((resolve, reject) => {
    if (typeof Chess !== 'undefined') { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js';
    s.onload = resolve;
    s.onerror = () => {
      // Try alternate CDN
      const s2 = document.createElement('script');
      s2.src = 'https://cdn.jsdelivr.net/npm/chess.js@0.10.3/chess.js';
      s2.onload = resolve;
      s2.onerror = reject;
      document.head.appendChild(s2);
    };
    document.head.appendChild(s);
  });
}

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
  xr: null,
  mode: null, // 'physical' | 'manual'
  modeInstance: null,
  playerColor: 'w',
  engineDepth: 15,
  desktopBoard: null,
  engineBusy: false,
};

// ─── Boot sequence ────────────────────────────────────────────────────────────
async function boot() {
  setProgress(5, 'Loading chess.js…');
  await loadChessJS();
  state.game.init();

  setProgress(20, 'Loading Stockfish…');
  try {
    await state.engine.load((msg) => setProgress(35, msg));
  } catch (err) {
    console.warn('Stockfish load failed:', err);
    showToast('Engine unavailable — playing without hints', 4000, 'warn');
  }

  setProgress(70, 'Vision ready');

  setProgress(85, 'Setting up XR…');
  const xr = new XRSession();
  await xr.init();
  state.xr = xr;
  xr.startRenderLoop();

  setProgress(100, 'Ready');
  setTimeout(hideLoading, 400);

  // Check WebXR support
  const xrSupported = await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false);
  if (!xrSupported) {
    document.getElementById('browser-warning')?.classList.remove('hidden');
  }

  // Show landing
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

  document.getElementById('btn-physical')?.addEventListener('click', () => {
    startMode('physical');
  });
  document.getElementById('btn-manual')?.addEventListener('click', () => {
    startMode('manual');
  });
}

function startMode(mode) {
  document.getElementById('landing')?.classList.add('hidden');
  state.mode = mode;

  if (mode === 'manual') {
    // Manual mode works without XR too
    if (!navigator.xr) {
      startDesktopManual();
      return;
    }
    startXRMode('manual');
  } else {
    startXRMode('physical');
  }
}

function startXRMode(modeName) {
  const arButton = state.xr.createARButton();
  arButton.style.cssText = `
    position:fixed; bottom:40px; left:50%; transform:translateX(-50%);
    padding:14px 32px; background:#4a9eff; color:#fff; border:none;
    border-radius:8px; font-size:16px; font-weight:700; cursor:pointer; z-index:600;
  `;
  document.body.appendChild(arButton);

  // When XR session starts
  state.xr.renderer.xr.addEventListener('sessionstart', () => {
    arButton.remove();
    launchMode(modeName);
  });
}

function launchMode(modeName) {
  const { game, engine, xr } = state;
  game.reset();
  engine.newGame?.();
  xr.clearHighlights?.();
  xr.clearArrow?.();

  state.modeInstance?.stop();

  if (modeName === 'physical') {
    state.modeInstance = new PhysicalBoardMode(game, engine, xr, onMoveConfirmed);
    state.modeInstance.start({ playerColor: state.playerColor });
  } else {
    state.modeInstance = new ManualBoardMode(game, engine, xr, onMoveConfirmed);
    state.modeInstance.start({ playerColor: state.playerColor });
  }

  xr.onFrame((_time, _frame) => {
    updateXRHUD();
  });
}

// ─── Move Confirmed Callback ──────────────────────────────────────────────────
async function onMoveConfirmed(move) {
  updateDesktopBoard();

  if (state.game.isGameOver()) {
    showToast('Game over: ' + getGameOverReason());
    return;
  }

  // Show Stockfish hint on the player's turn
  const isPlayerTurn = state.game.turn() === state.playerColor;
  if (isPlayerTurn && !state.engineBusy) {
    requestEngineHint();
  } else {
    state.xr.clearArrow?.();
    document.getElementById('desktop-move-hint').textContent = '';
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
    state.xr.showArrow?.(from, to);
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
  if (g.isCheckmate()) return 'Checkmate!';
  if (g.isStalemate()) return 'Stalemate';
  if (g.isInsufficientMaterial()) return 'Draw — insufficient material';
  if (g.isThreefoldRepetition()) return 'Draw — threefold repetition';
  if (g.isDraw()) return 'Draw';
  return 'Game over';
}

// ─── XR HUD ───────────────────────────────────────────────────────────────────
function updateXRHUD() {
  // Keep board overlay updated with current piece positions
  if (!state.xr.boardGroup?.visible) return;
  const board = state.game.boardArray();
  if (!board) return;
  // Piece rendering inside XR happens via the highlight system + text sprites
  // Full 3D piece models would require additional assets
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
      const move = state.game.undo();
      if (move) { updateDesktopBoard(); }
    }
  });
  document.getElementById('btn-new-game')?.addEventListener('click', () => {
    state.game.reset();
    state.engine.newGame?.();
    updateDesktopBoard();
    state.xr.clearArrow?.();
    document.getElementById('desktop-move-hint').textContent = '';
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

  // Click-to-move for desktop board
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
        const needProm = (() => {
          const p = state.game.pieceAt(selectedFrom);
          return p?.type === 'p' && ((p.color === 'w' && sq[1] === '8') || (p.color === 'b' && sq[1] === '1'));
        })();
        if (needProm) {
          prom?.classList.remove('hidden');
          const { from, to } = { from: selectedFrom, to: sq };
          selectedFrom = null;
          const buttons = document.querySelectorAll('.promo-btn');
          for (const btn of buttons) {
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

function startDesktopManual() {
  document.getElementById('desktop-hud')?.classList.remove('hidden');
  updateDesktopBoard();
  onMoveConfirmed(null);
}

function updateDesktopBoard() {
  if (!state.desktopBoard) return;
  const fen = state.game.fen();
  document.getElementById('desktop-fen-display').textContent = fen;
  state.desktopBoard.render(state.game.boardArray());
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
boot().catch((err) => {
  console.error('Boot failed:', err);
  setProgress(100, 'Error: ' + err.message);
});
