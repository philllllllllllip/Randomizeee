// Chess game logic wrapper using chess.js (loaded via global script tag)
// chess.js is loaded via CDN in main.js before this module is used

export class ChessGame {
  constructor() {
    this._chess = null;
    this._moveHistory = [];
    this._confirmedFen = null;
  }

  init() {
    // chess.js exposes Chess as global via UMD build
    if (typeof Chess === 'undefined') throw new Error('chess.js not loaded');
    this._chess = new Chess();
    this._confirmedFen = this._chess.fen();
    return this;
  }

  get chess() { return this._chess; }

  fen() { return this._chess.fen(); }

  turn() { return this._chess.turn(); } // 'w' or 'b'

  isGameOver() { return this._chess.game_over(); }

  inCheck() { return this._chess.in_check(); }

  // Returns array of {from, to, san, flags} for all legal moves
  legalMoves(square) {
    const opts = { verbose: true };
    if (square) opts.square = square;
    return this._chess.moves(opts);
  }

  // Returns all legal moves in minimal {from,to} form
  legalMovePairs() {
    return this._chess.moves({ verbose: true }).map(m => ({ from: m.from, to: m.to, san: m.san, flags: m.flags }));
  }

  // Apply a move by {from, to, promotion?}. Returns move object or null.
  applyMove(from, to, promotion = 'q') {
    const move = this._chess.move({ from, to, promotion });
    if (move) {
      this._moveHistory.push(move);
      this._confirmedFen = this._chess.fen();
    }
    return move;
  }

  // Apply from SAN notation
  applyMoveSan(san) {
    const move = this._chess.move(san);
    if (move) {
      this._moveHistory.push(move);
      this._confirmedFen = this._chess.fen();
    }
    return move;
  }

  undo() {
    const move = this._chess.undo();
    if (move) {
      this._moveHistory.pop();
      this._confirmedFen = this._chess.fen();
    }
    return move;
  }

  reset() {
    this._chess.reset();
    this._moveHistory = [];
    this._confirmedFen = this._chess.fen();
  }

  loadFen(fen) {
    try {
      this._chess.load(fen);
      this._moveHistory = [];
      this._confirmedFen = fen;
      return true;
    } catch {
      return false;
    }
  }

  // Returns piece at a square: {type, color} or null
  pieceAt(square) {
    return this._chess.get(square);
  }

  // Returns the full board as an 8x8 array of piece objects (or null)
  boardArray() {
    return this._chess.board();
  }

  // Returns the confirmed FEN (last position both sides agreed on)
  confirmedFen() {
    return this._confirmedFen;
  }

  // For ambiguity resolution: given candidate moves {from, to}[], return those that are legal
  filterLegal(candidates) {
    const legal = this.legalMovePairs();
    return candidates.filter(c =>
      legal.some(l => l.from === c.from && l.to === c.to)
    );
  }

  // Check if a specific from→to is legal (without committing)
  isLegal(from, to) {
    return this._chess.moves({ verbose: true }).some(m => m.from === from && m.to === to);
  }

  // Returns piece grid as a simple 64-element array [a8..h8, a7..h7, ..., a1..h1]
  // Each element: { type: 'p'|'n'|'b'|'r'|'q'|'k', color: 'w'|'b' } | null
  pieceGrid() {
    const board = this._chess.board(); // 8x8, [rank8..rank1][fileA..fileH]
    return board.flat();
  }

  // Returns the last move played
  lastMove() {
    return this._moveHistory.length ? this._moveHistory[this._moveHistory.length - 1] : null;
  }

  moveHistory() {
    return [...this._moveHistory];
  }

  // Returns algebraic square from board indices (row=0 is rank 8, col=0 is file a)
  static indexToSquare(row, col) {
    return 'abcdefgh'[col] + (8 - row);
  }

  static squareToIndex(sq) {
    return { col: 'abcdefgh'.indexOf(sq[0]), row: 8 - parseInt(sq[1]) };
  }
}
