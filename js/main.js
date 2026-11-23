// Board Coach XR — main entry point
// Three.js / XRSession is loaded dynamically (only on "Start AR") so the
// landing page renders immediately without any CDN round-trip at boot.

import { ChessGame } from './game.js';
import { StockfishEngine } from './engine.js';
import { PhysicalBoardMode } from './modes/physical.js';
import { ManualBoardMode } from './modes/manual.js';
import { DesktopBoard, showToast, setToastSink } from './ui.js';
import { CameraManager } from './vision.js';

// Preloaded in the background after boot; awaited when entering AR.
let xrModulePromise = null;
function loadXRModule() {
  xrModulePromise ??= import('./xr.js');
  return xrModulePromise;
}

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
  camera: null,
  engineRerun: false,
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
  state.engine.load().then(() => {
    // If a game is already running, show the first hint now that the engine is up.
    if (state.mode) onMoveConfirmed(null);
  }).catch((err) => {
    console.warn('Stockfish unavailable:', err.message);
  });

  setProgress(90, 'Checking WebXR…');
  const xrSupported = await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false);
  if (!xrSupported) {
    document.getElementById('browser-warning')?.classList.remove('hidden');
  } else {
    loadXRModule().catch(() => { xrModulePromise = null; });
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

function overlay(text) {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;inset:0;background:#05060cf0;color:#fff;display:flex;flex-direction:column;' +
    'gap:24px;align-items:center;justify-content:center;font:600 20px system-ui,sans-serif;' +
    'z-index:800;text-align:center;padding:24px;';
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

async function startXRMode(modeName) {
  const ov = overlay(modeName === 'physical' ? 'Requesting camera…' : 'Loading AR…');
  try {
    if (modeName === 'physical') {
      state.camera ??= new CameraManager();
      try {
        await state.camera.start();
      } catch (err) {
        console.warn('Camera unavailable:', err);
        state.camera = null;
        showToast('No camera access — overlay + arrows only, enter moves with the trigger', 5000, 'warn');
      }
    }
    ov.textContent = 'Loading AR…';
    if (!state.xr) {
      const { XRSession } = await loadXRModule();
      state.xr = await new XRSession().init();
      state.xr.startRenderLoop();
      state.xr.on('sessionstart', () => launchMode(state.mode));
      state.xr.on('sessionend', onSessionEnd);
      setToastSink((msg) => state.xr.setHud({ status: msg }));
    }

    // requestSession needs a fresh user gesture, so ask for one more tap.
    ov.textContent = '';
    const btn = document.createElement('button');
    btn.textContent = 'ENTER AR';
    btn.style.cssText =
      'padding:22px 56px;background:#4a9eff;color:#fff;border:none;border-radius:14px;' +
      'font:800 26px system-ui,sans-serif;cursor:pointer;';
    const back = document.createElement('button');
    back.textContent = 'Back';
    back.style.cssText = 'background:none;border:1px solid #445;color:#aab;padding:10px 28px;border-radius:10px;font-size:16px;';
    ov.append(btn, back);
    back.onclick = () => { ov.remove(); showLanding(); };
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Starting…';
      try {
        await state.xr.enterAR();
        ov.remove();
      } catch (err) {
        console.error('requestSession failed:', err);
        btn.disabled = false;
        btn.textContent = 'ENTER AR';
        showToast('Could not start AR: ' + err.message, 5000, 'error');
      }
    };
  } catch (err) {
    ov.remove();
    console.error('XR init failed:', err);
    showToast('AR unavailable — using desktop board', 4000, 'warn');
    startDesktopFallback();
  }
}

async function launchMode(modeName) {
  const { game, engine, xr } = state;
  state.modeInstance?.stop?.();
  xr.clearFrameCallbacks();
  xr.clearArrows();
  xr.clearHighlights();
  game.reset();
  engine.newGame?.();
  xr.setHud({ status: 'Starting…', hint: '', controls: '' });

  // The viewer pose is only real after a few XR frames.
  await xr.waitForPose(5);

  if (modeName === 'physical') {
    state.modeInstance = new PhysicalBoardMode(game, engine, xr, onMoveConfirmed, state.camera);
  } else {
    state.modeInstance = new ManualBoardMode(game, engine, xr, onMoveConfirmed);
  }
  state.modeInstance.start({ playerColor: state.playerColor });
  onMoveConfirmed(null);
}

function onSessionEnd() {
  state.modeInstance?.stop?.();
  state.modeInstance = null;
  state.xr?.clearFrameCallbacks();
  state.camera?.stop();
  state.camera = null;
  showLanding();
}

function showLanding() {
  state.mode = null;
  document.getElementById('desktop-hud')?.classList.add('hidden');
  document.getElementById('landing')?.classList.remove('hidden');
}

// ─── Move Confirmed Callback ──────────────────────────────────────────────────
async function onMoveConfirmed(_move) {
  updateDesktopBoard();

  if (state.game.isGameOver()) {
    showToast('Game over: ' + getGameOverReason());
    return;
  }

  const isPlayerTurn = state.game.turn() === state.playerColor;
  state.xr?.clearArrow('best');
  state.modeInstance?.setHintArrow?.(null);
  state.desktopBoard?.clearArrow();
  const el = document.getElementById('desktop-move-hint');
  if (el) el.textContent = '';
  if (isPlayerTurn) {
    state.xr?.setHud({ hint: state.engine._ready ? 'Thinking…' : 'Engine loading…' });
    requestEngineHint();
  } else {
    state.xr?.setHud({ hint: 'Opponent to move' });
  }
}

async function requestEngineHint() {
  if (!state.engine._ready) return;
  if (state.engineBusy) { state.engineRerun = true; return; }
  state.engineBusy = true;
  try {
    const fen = state.game.fen();
    const { move, score } = await state.engine.getBestMove(fen, state.engineDepth, 2000);
    // Ignore stale results if the position changed while thinking.
    if (fen !== state.game.fen() || !move || move === '(none)') return;
    const from = move.slice(0, 2);
    const to = move.slice(2, 4);
    state.xr?.showArrow(from, to);
    state.modeInstance?.setHintArrow?.(from, to);
    state.desktopBoard?.setArrow(from, to);
    updateDesktopBoard();
    updateMoveHintUI(move, score);
  } catch (err) {
    console.warn('Engine error:', err);
  } finally {
    state.engineBusy = false;
    if (state.engineRerun) {
      state.engineRerun = false;
      if (state.game.turn() === state.playerColor) requestEngineHint();
    }
  }
}

function updateMoveHintUI(uciMove, score) {
  const from = uciMove.slice(0, 2), to = uciMove.slice(2, 4);
  const scoreStr = score != null
    ? (score > 0 ? `+${(score / 100).toFixed(1)}` : `${(score / 100).toFixed(1)}`)
    : '';
  const el = document.getElementById('desktop-move-hint');
  if (el) el.textContent = `Best: ${from}→${to}  ${scoreStr}`;
  // Engine score is from the side to move's perspective.
  state.xr?.setHud({ hint: `Best move: ${from} → ${to}   ${scoreStr}` });
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
