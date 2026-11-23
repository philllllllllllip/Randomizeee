// Stockfish WASM wrapper — loads the engine in a Web Worker via Blob URL
// Provides async getBestMove(fen, depth, movetime) → {move, score}

const STOCKFISH_CDN = 'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish-nnue-16-single.js';
// Fallback: smaller non-NNUE build
const STOCKFISH_FALLBACK = 'https://cdn.jsdelivr.net/npm/stockfish@11.0.0/stockfish.js';

export class StockfishEngine {
  constructor() {
    this._worker = null;
    this._ready = false;
    this._resolveMap = new Map(); // id → {resolve, reject, buffer}
    this._currentId = 0;
    this._pendingLines = [];
    this._bestMoveResolve = null;
    this._bestMoveBuffer = [];
    this._onReady = null;
  }

  async load(onProgress) {
    onProgress?.('Fetching Stockfish…');
    let scriptText;
    try {
      const r = await fetch(STOCKFISH_CDN);
      if (!r.ok) throw new Error('CDN fetch failed');
      scriptText = await r.text();
    } catch {
      onProgress?.('Falling back to Stockfish 11…');
      const r2 = await fetch(STOCKFISH_FALLBACK);
      scriptText = await r2.text();
    }

    // Create blob URL so we can use the script as a Worker
    const blob = new Blob([scriptText], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    this._worker = new Worker(blobUrl);
    URL.revokeObjectURL(blobUrl);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Stockfish init timeout')), 20000);
      this._worker.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data : (e.data?.text ?? '');
        if (line.startsWith('Stockfish') || line.includes('uciok')) {
          clearTimeout(timeout);
          this._ready = true;
          this._worker.onmessage = (ev) => this._handleMessage(ev);
          onProgress?.('Stockfish ready');
          resolve(this);
        }
      };
      this._worker.onerror = (err) => { clearTimeout(timeout); reject(err); };
      this._worker.postMessage('uci');
    });
  }

  _handleMessage(e) {
    const line = typeof e.data === 'string' ? e.data : (e.data?.text ?? '');
    this._bestMoveBuffer.push(line);
    if (line.startsWith('bestmove') && this._bestMoveResolve) {
      const parts = line.split(' ');
      const move = parts[1] ?? null;
      const ponder = parts[3] ?? null;
      // Extract score from accumulated info lines
      let score = null;
      for (const l of this._bestMoveBuffer) {
        const m = l.match(/score cp (-?\d+)/);
        if (m) score = parseInt(m[1]);
        const mate = l.match(/score mate (-?\d+)/);
        if (mate) score = parseInt(mate[1]) > 0 ? 9999 : -9999;
      }
      this._bestMoveBuffer = [];
      const cb = this._bestMoveResolve;
      this._bestMoveResolve = null;
      cb({ move, ponder, score });
    }
  }

  _send(cmd) {
    if (!this._worker) throw new Error('Engine not loaded');
    this._worker.postMessage(cmd);
  }

  // Returns Promise<{move: string, score: number}>
  // move is in UCI format e.g. "e2e4", "e1g1" (castling), "e7e8q" (promotion)
  getBestMove(fen, depth = 15, movetime = 2000) {
    return new Promise((resolve, reject) => {
      if (!this._ready) { reject(new Error('Engine not ready')); return; }
      const timer = setTimeout(() => {
        this._bestMoveResolve = null;
        this._bestMoveBuffer = [];
        reject(new Error('Engine timeout'));
      }, movetime + 5000);

      this._bestMoveResolve = (result) => {
        clearTimeout(timer);
        resolve(result);
      };

      this._send(`position fen ${fen}`);
      this._send(`go depth ${depth} movetime ${movetime}`);
    });
  }

  stop() {
    this._send('stop');
  }

  newGame() {
    this._send('ucinewgame');
  }

  destroy() {
    this._worker?.terminate();
    this._worker = null;
    this._ready = false;
  }
}
