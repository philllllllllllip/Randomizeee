// Desktop canvas board renderer + XR text panel utilities

const PIECE_UNICODE = {
  wk: '♔', wq: '♕', wr: '♖', wb: '♗', wn: '♘', wp: '♙',
  bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '♟',
};

export class DesktopBoard {
  constructor(canvas) {
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');
    this._size = canvas.width; // assume square
    this._sqSize = this._size / 8;
    this._flipped = false;
    this._highlights = {}; // sq → {fill, alpha}
    this._arrow = null; // {from, to}
    this._selectedSquare = null;
    this._onClick = null;
    canvas.addEventListener('click', (e) => this._handleClick(e));
  }

  flip(val) {
    this._flipped = val ?? !this._flipped;
    return this;
  }

  highlight(sq, color = '#4a9eff', alpha = 0.5) {
    this._highlights[sq] = { color, alpha };
  }

  clearHighlights() { this._highlights = {}; }

  setArrow(from, to) { this._arrow = from && to ? { from, to } : null; }
  clearArrow() { this._arrow = null; }

  onClick(cb) { this._onClick = cb; }

  _handleClick(e) {
    const rect = this._canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (this._size / rect.width);
    const y = (e.clientY - rect.top) * (this._size / rect.height);
    const col = Math.floor(x / this._sqSize);
    const row = Math.floor(y / this._sqSize);
    const sq = this._indexToSquare(row, col);
    this._onClick?.(sq);
  }

  _indexToSquare(row, col) {
    if (this._flipped) {
      return 'abcdefgh'[7 - col] + (row + 1);
    }
    return 'abcdefgh'[col] + (8 - row);
  }

  _squareToXY(sq) {
    const col = 'abcdefgh'.indexOf(sq[0]);
    const row = 8 - parseInt(sq[1]);
    if (this._flipped) {
      return { x: (7 - col) * this._sqSize, y: (7 - row) * this._sqSize };
    }
    return { x: col * this._sqSize, y: row * this._sqSize };
  }

  render(boardArray) {
    // boardArray: 8x8 array from chess.board() — [rank8..rank1][fileA..fileH]
    const ctx = this._ctx;
    const s = this._sqSize;

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const sq = this._indexToSquare(row, col);
        const isLight = (row + col) % 2 === 0;
        ctx.fillStyle = isLight ? '#f0d9b5' : '#b58863';
        ctx.fillRect(col * s, row * s, s, s);

        // Highlight
        if (this._highlights[sq]) {
          const h = this._highlights[sq];
          ctx.fillStyle = h.color;
          ctx.globalAlpha = h.alpha;
          ctx.fillRect(col * s, row * s, s, s);
          ctx.globalAlpha = 1;
        }
      }
    }

    // Arrow
    if (this._arrow) {
      const { from, to } = this._arrow;
      const p1 = this._squareToXY(from);
      const p2 = this._squareToXY(to);
      const cx1 = p1.x + s / 2, cy1 = p1.y + s / 2;
      const cx2 = p2.x + s / 2, cy2 = p2.y + s / 2;
      this._drawArrow(ctx, cx1, cy1, cx2, cy2, '#ff9500', s * 0.12);
    }

    // Pieces
    if (!boardArray) return;
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const piece = boardArray[rank]?.[file];
        if (!piece) continue;
        const sq = `${'abcdefgh'[file]}${8 - rank}`;
        const { x, y } = this._squareToXY(sq);
        const key = `${piece.color}${piece.type}`;
        ctx.font = `${s * 0.78}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Shadow for visibility
        ctx.fillStyle = piece.color === 'w' ? '#1a1a1a' : '#cccccc';
        ctx.fillText(PIECE_UNICODE[key] ?? '?', x + s / 2 + 1, y + s / 2 + 1);
        ctx.fillStyle = piece.color === 'w' ? '#ffffff' : '#1a1a1a';
        ctx.fillText(PIECE_UNICODE[key] ?? '?', x + s / 2, y + s / 2);
      }
    }

    // Rank/file labels
    ctx.font = `${s * 0.18}px monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < 8; i++) {
      const isLight = i % 2 === 0;
      ctx.fillStyle = isLight ? '#b58863' : '#f0d9b5';
      const rank = this._flipped ? (i + 1) : (8 - i);
      ctx.fillText(rank, 2, i * s + 2);
      const file = this._flipped ? 'abcdefgh'[7 - i] : 'abcdefgh'[i];
      ctx.fillText(file, (i + 1) * s - s * 0.22, 8 * s - s * 0.22);
    }
  }

  _drawArrow(ctx, x1, y1, x2, y2, color, lineWidth) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLen = lineWidth * 3;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    const ux = dx / len, uy = dy / len;
    // Shorten to avoid arrowhead overlap
    const ex = x2 - ux * headLen, ey = y2 - uy * headLen;

    ctx.save();
    ctx.globalAlpha = 0.82;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // Arrowhead
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - headLen * Math.cos(angle - Math.PI / 6),
      y2 - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      x2 - headLen * Math.cos(angle + Math.PI / 6),
      y2 - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

// Simple toast notification
export function showToast(message, duration = 2500, type = 'info') {
  let el = document.getElementById('xr-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'xr-toast';
    el.style.cssText = `
      position:fixed; bottom:40px; left:50%; transform:translateX(-50%);
      background:rgba(10,10,20,0.92); color:#e8e8f0; padding:12px 24px;
      border-radius:10px; font-size:15px; font-weight:600; z-index:9999;
      border:1px solid #2a2a3a; pointer-events:none; transition:opacity 0.3s;
      max-width:90vw; text-align:center;
    `;
    document.body.appendChild(el);
  }
  if (type === 'warn') el.style.borderColor = '#ff9500';
  else if (type === 'error') el.style.borderColor = '#ff4a6a';
  else el.style.borderColor = '#4a9eff';

  el.textContent = message;
  el.style.opacity = '1';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.opacity = '0'; }, duration);
}
