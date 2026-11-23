// Stockfish 11 in a Web Worker, served from this site (no CDN).
// WASM build first; pure-JS asm.js build as a fallback.
// Provides async getBestMove(fen, depth, movetime) → {move, score}

const BUILDS = ['js/vendor/stockfish/stockfish.js', 'js/vendor/stockfish/stockfish.asm.js'];

export class StockfishEngine {
  constructor() {
    this._worker = null;
    this._ready = false;
    this._bestMoveResolve = null;
    this._bestMoveBuffer = [];
  }

  async load(onProgress) {
    let lastErr;
    for (const url of BUILDS) {
      try {
        onProgress?.('Loading Stockfish…');
        await this._start(url);
        onProgress?.('Stockfish ready');
        return this;
      } catch (err) {
        lastErr = err;
        console.warn(`Stockfish build ${url} failed:`, err?.message ?? err);
        this._worker?.terminate();
        this._worker = null;
      }
    }
    throw lastErr ?? new Error('Stockfish failed to load');
  }

  _start(url) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(url);
      this._worker = worker;
      const timeout = setTimeout(() => reject(new Error('Stockfish init timeout')), 20000);
      worker.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data : String(e.data ?? '');
        if (!line.includes('uciok')) return;
        clearTimeout(timeout);
        this._ready = true;
        worker.onmessage = (ev) => this._handleMessage(ev);
        resolve();
      };
      worker.onerror = (err) => { clearTimeout(timeout); reject(new Error(err.message || 'worker error')); };
      worker.postMessage('uci');
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
    if (this._worker) this._send('stop');
  }

  newGame() {
    if (this._worker) this._send('ucinewgame');
  }

  destroy() {
    this._worker?.terminate();
    this._worker = null;
    this._ready = false;
  }
}
