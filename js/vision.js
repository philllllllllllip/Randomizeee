// Chess board vision pipeline — pure JS, zero external dependencies
// No OpenCV.js, no WASM download, loads instantly.
//
// Pipeline (chesscog-inspired, MIT):
//   1. Board localisation via contour/corner detection on Canvas pixels
//   2. Perspective warp via JS homography (computed from 4 corner points)
//   3. Per-square occupancy + colour classification (histogram on getImageData)
//   4. Diff-based move detection + legal-move filtering via chess.js

// ─── Homography (perspective transform) ─────────────────────────────────────
// Given 4 src points → 4 dst points, solve for a 3×3 homography H.
// Then for each dst pixel (x,y) compute src pixel via H_inv and bilinear sample.

export function buildHomography(src, dst) {
  // src, dst: [{x,y}×4] in order TL,TR,BR,BL
  // Returns 9-element Float64Array (row-major 3×3)
  const A = [];
  for (let i = 0; i < 4; i++) {
    const { x: sx, y: sy } = src[i];
    const { x: dx, y: dy } = dst[i];
    A.push([-sx, -sy, -1,  0,   0,  0, dx*sx, dx*sy, dx]);
    A.push([ 0,   0,  0, -sx, -sy, -1, dy*sx, dy*sy, dy]);
  }
  // Solve A·h = 0 via SVD substitute (Gaussian elimination on 8×9)
  const h = gaussSolve8x9(A);
  if (!h) return null;
  return new Float64Array([h[0],h[1],h[2], h[3],h[4],h[5], h[6],h[7],1]);
}

function gaussSolve8x9(A) {
  // Solve 8×8 system (last column is RHS: h[8]=1 is known)
  const M = A.map(r => r.slice()); // deep copy
  for (let col = 0; col < 8; col++) {
    // Find pivot
    let pivot = -1, best = 0;
    for (let row = col; row < 8; row++) {
      if (Math.abs(M[row][col]) > best) { best = Math.abs(M[row][col]); pivot = row; }
    }
    if (pivot < 0 || best < 1e-10) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const scale = M[col][col];
    for (let j = col; j < 9; j++) M[col][j] /= scale;
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const f = M[row][col];
      for (let j = col; j < 9; j++) M[row][j] -= f * M[col][j];
    }
  }
  // h[i] = -M[i][8] because last col is rhs when h8=1
  return M.map((r, i) => -r[8]);
}

export function applyH(H, x, y) {
  const w = H[6]*x + H[7]*y + H[8];
  return { x: (H[0]*x + H[1]*y + H[2]) / w, y: (H[3]*x + H[4]*y + H[5]) / w };
}

// Warp src canvas into a new S×S ImageData using homography from dst→src
// src: a canvas or an ImageData.
export function warpPerspective(source, corners, S) {
  const srcData = source.data ? source
    : source.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, source.width, source.height);
  const srcW = srcData.width, srcH = srcData.height;

  // Destination corners (top-down square S×S)
  const dstPts = [{ x:0,y:0 }, { x:S,y:0 }, { x:S,y:S }, { x:0,y:S }];
  // Build H: dst→src (inverse warp)
  const H = buildHomography(dstPts, corners);
  if (!H) return null;

  const out = new Uint8ClampedArray(S * S * 4);
  const src = srcData.data;
  for (let dy = 0; dy < S; dy++) {
    for (let dx = 0; dx < S; dx++) {
      const { x: sx, y: sy } = applyH(H, dx + 0.5, dy + 0.5);
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= srcW || y0 + 1 >= srcH) continue;
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * srcW + x0) * 4, i10 = i00 + 4, i01 = i00 + srcW * 4, i11 = i01 + 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      const oi = (dy * S + dx) * 4;
      for (let c = 0; c < 3; c++) {
        out[oi + c] = src[i00 + c] * w00 + src[i10 + c] * w10 + src[i01 + c] * w01 + src[i11 + c] * w11;
      }
      out[oi + 3] = 255;
    }
  }
  return new ImageData(out, S, S);
}

// ─── Board Detector ──────────────────────────────────────────────────────────

export class BoardDetector {
  constructor() {
    this._corners = null; // [{x,y}×4] TL,TR,BR,BL in src image pixels
    this._boardSize = 256;
    this._calib = null; // learned per-board thresholds, see calibrate()
    // Direction from board centre toward the viewer in warped-image axes
    // (x = files left→right, y = rows far→near). Default: viewer at the near edge.
    this._viewDir = { x: 0, y: 1 };
    this._lastOccupancy = null;
    this._lastColors = null;
    this._confirmedOccupancy = null;
  }

  setCorners(tl, br) {
    this._corners = [
      { x: tl.x, y: tl.y },
      { x: br.x, y: tl.y },
      { x: br.x, y: br.y },
      { x: tl.x, y: br.y },
    ];
  }

  setFourCorners(corners) { this._corners = corners; }

  setViewDir(x, y) {
    const n = Math.hypot(x, y) || 1;
    this._viewDir = { x: x / n, y: y / n };
  }
  hasCorners() { return this._corners !== null; }
  getCorners() { return this._corners; }

  // Auto-detect board corners using edge+contour detection on raw pixels
  detectBoardCorners(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const W = canvas.width, H = canvas.height;
    const data = ctx.getImageData(0, 0, W, H).data;

    // Convert to grayscale + simple Sobel edge magnitude
    const gray = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      gray[i] = (data[i*4]*77 + data[i*4+1]*150 + data[i*4+2]*29) >> 8;
    }

    // Threshold edges
    const edges = new Uint8Array(W * H);
    for (let y = 1; y < H-1; y++) {
      for (let x = 1; x < W-1; x++) {
        const gx = -gray[(y-1)*W+(x-1)] + gray[(y-1)*W+(x+1)]
                   -2*gray[y*W+(x-1)]   + 2*gray[y*W+(x+1)]
                   -gray[(y+1)*W+(x-1)] + gray[(y+1)*W+(x+1)];
        const gy = -gray[(y-1)*W+(x-1)] - 2*gray[(y-1)*W+x] - gray[(y-1)*W+(x+1)]
                   +gray[(y+1)*W+(x-1)] + 2*gray[(y+1)*W+x] + gray[(y+1)*W+(x+1)];
        edges[y*W+x] = Math.sqrt(gx*gx + gy*gy) > 40 ? 255 : 0;
      }
    }

    // Find largest bounding quadrilateral — simple approach: find extreme corners
    // of the edge point cloud with enough density
    const pts = [];
    for (let y = 0; y < H; y += 4) {
      for (let x = 0; x < W; x += 4) {
        if (edges[y*W+x]) pts.push({ x, y });
      }
    }
    if (pts.length < 20) return null;

    // Find the 4 extreme corners: min(x+y), max(x-y), max(x+y), min(x-y)
    let tl = pts[0], tr = pts[0], br = pts[0], bl = pts[0];
    for (const p of pts) {
      if (p.x+p.y < tl.x+tl.y) tl = p;
      if (p.x-p.y > tr.x-tr.y) tr = p;
      if (p.x+p.y > br.x+br.y) br = p;
      if (p.x-p.y < bl.x-bl.y) bl = p;
    }

    // Sanity: board should cover at least 10% of image area
    const area = Math.abs((tr.x-tl.x)*(br.y-tl.y));
    if (area < W * H * 0.1) return null;

    return [tl, tr, br, bl];
  }

  // Warp the board and analyse all 64 squares
  // Returns { occupancy[64], colors[64] } or null
  // src: canvas or ImageData. Result includes the warped board image.
  analyzeFrame(src) {
    if (!this._corners) return null;
    const S = this._boardSize;
    const img = warpPerspective(src, this._corners, S);
    if (!img) return null;
    const res = this._analyzeImageData(img, S);
    res.warp = img;
    return res;
  }

  setBoardSize(S) { this._boardSize = S; }

  _analyzeImageData(img, S) {
    const sqSize = S / 8;
    // Tall pieces project into the square behind them, so sample a window
    // shifted away from the viewer: it sees this square's piece body but not
    // the top of the piece standing in front.
    const inner = Math.round(sqSize * 0.5);
    const shiftX = -this._viewDir.x * sqSize * 0.17;
    const shiftY = -this._viewDir.y * sqSize * 0.17;
    const occupancy = new Array(64).fill(false);
    const colors = new Array(64).fill(null);
    const mu = new Array(64), sigma = new Array(64);

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const idx = row * 8 + col;
        const ox = Math.round((col + 0.5) * sqSize + shiftX - inner / 2);
        const oy = Math.round((row + 0.5) * sqSize + shiftY - inner / 2);
        let sumL = 0, sumL2 = 0, n = 0;
        for (let dy = 0; dy < inner; dy++) {
          for (let dx = 0; dx < inner; dx++) {
            const px = ox + dx, py = oy + dy;
            if (px < 0 || py < 0 || px >= S || py >= S) continue;
            const i = (py * S + px) * 4;
            const L = (img.data[i] * 77 + img.data[i + 1] * 150 + img.data[i + 2] * 29) >> 8;
            sumL += L; sumL2 += L * L; n++;
          }
        }
        const m = sumL / n;
        const sd = Math.sqrt(Math.max(0, sumL2 / n - m * m));
        mu[idx] = m; sigma[idx] = sd;
        const light = (row + col) % 2 === 0 ? 'light' : 'dark';
        const c = this._calib?.[light];

        if (c) {
          // Calibrated: occupied if texture OR brightness departs from the empty square.
          const occ = sd > c.sigmaThresh || Math.abs(m - c.emptyMu) > c.muThresh;
          occupancy[idx] = occ;
          if (occ) colors[idx] = Math.abs(m - c.whiteMu) <= Math.abs(m - c.blackMu) ? 'w' : 'b';
        } else {
          const occ = sd > (light === 'light' ? 16 : 18);
          occupancy[idx] = occ;
          if (occ) {
            const diff = m - (light === 'light' ? 210 : 85);
            colors[idx] = light === 'light' ? (diff < -35 ? 'b' : 'w') : (diff > 35 ? 'w' : 'b');
          }
        }
      }
    }
    return { occupancy, colors, mu, sigma };
  }

  // Learn thresholds from a frame whose true contents are known
  // (expected[i] = 'w' | 'b' | null per display index). Returns true if usable.
  calibrate(stats, expected) {
    const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const calib = {};
    for (const light of ['light', 'dark']) {
      const empty = [], white = [], black = [], emptySd = [], occSd = [];
      for (let i = 0; i < 64; i++) {
        const isLight = (Math.floor(i / 8) + (i % 8)) % 2 === 0;
        if ((light === 'light') !== isLight) continue;
        const e = expected[i];
        if (!e) { empty.push(stats.mu[i]); emptySd.push(stats.sigma[i]); }
        else { (e === 'w' ? white : black).push(stats.mu[i]); occSd.push(stats.sigma[i]); }
      }
      const eSd = avg(emptySd), oSd = avg(occSd), eMu = avg(empty);
      if (eSd === null || oSd === null || oSd <= eSd + 2) return false;
      const wMu = avg(white) ?? eMu + 60, bMu = avg(black) ?? eMu - 60;
      const pieceMuGap = Math.min(Math.abs(wMu - eMu), Math.abs(bMu - eMu));
      calib[light] = {
        sigmaThresh: (eSd + oSd) / 2,
        emptyMu: eMu,
        muThresh: Math.max(25, pieceMuGap * 0.6),
        whiteMu: wMu,
        blackMu: bMu,
      };
    }
    this._calib = calib;
    return true;
  }

  clearCalibration() { this._calib = null; }

  diffOccupancy(prev, curr) {
    const vacated = [], arrived = [];
    for (let i = 0; i < 64; i++) {
      if (prev[i] && !curr[i]) vacated.push(i);
      else if (!prev[i] && curr[i]) arrived.push(i);
    }
    return { vacated, arrived };
  }

  static indexToSquare(idx, whiteAtBottom = true) {
    const row = Math.floor(idx / 8), col = idx % 8;
    return whiteAtBottom
      ? 'abcdefgh'[col] + (8 - row)
      : 'abcdefgh'[7 - col] + (row + 1);
  }

  processFrame(canvas, prevOccupancy, chessGame, whiteAtBottom = true) {
    const result = this.analyzeFrame(canvas);
    if (!result) return null;
    const { occupancy, colors } = result;

    if (!prevOccupancy) {
      this._lastOccupancy = occupancy;
      this._lastColors = colors;
      return { candidates: [], occupancy, colors };
    }

    const { vacated, arrived } = this.diffOccupancy(prevOccupancy, occupancy);
    const candidates = [];

    if (vacated.length === 1 && arrived.length === 1) {
      candidates.push({
        from: BoardDetector.indexToSquare(vacated[0], whiteAtBottom),
        to:   BoardDetector.indexToSquare(arrived[0], whiteAtBottom),
      });
    } else if (vacated.length === 1 && arrived.length === 0) {
      // Capture: source vacated, dest already occupied
      const fromSq = BoardDetector.indexToSquare(vacated[0], whiteAtBottom);
      const captureMoves = chessGame.legalMoves(fromSq)
        .filter(m => m.flags.includes('c') || m.flags.includes('e'));
      for (const m of captureMoves) candidates.push({ from: m.from, to: m.to });
    } else if (vacated.length === 2 && arrived.length === 2) {
      for (const v of vacated)
        for (const a of arrived)
          candidates.push({
            from: BoardDetector.indexToSquare(v, whiteAtBottom),
            to:   BoardDetector.indexToSquare(a, whiteAtBottom),
          });
    } else if (vacated.length >= 1 && arrived.length >= 1) {
      for (const v of vacated)
        for (const a of arrived)
          if (v !== a) candidates.push({
            from: BoardDetector.indexToSquare(v, whiteAtBottom),
            to:   BoardDetector.indexToSquare(a, whiteAtBottom),
          });
    }

    const legal = chessGame.filterLegal(candidates);
    this._lastOccupancy = occupancy;
    this._lastColors = colors;
    return { candidates: legal, occupancy, colors };
  }

  rescanChangedSquares(canvas, prevOccupancy) {
    return this.analyzeFrame(canvas);
  }

  saveConfirmedOccupancy() {
    this._confirmedOccupancy = this._lastOccupancy ? [...this._lastOccupancy] : null;
  }

  getLastOccupancy() { return this._lastOccupancy; }
}

// ─── Move matching ───────────────────────────────────────────────────────────
// Instead of hand-coding capture/castling/en-passant cases, simulate every legal
// move and score how well the resulting position explains the observed squares.

// chess.board() → 64-array of 'w' | 'b' | null indexed by display index.
export function expectedFromBoard(boardArray, squareToIndex) {
  const out = new Array(64).fill(null);
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const p = boardArray[rank][file];
      if (p) out[squareToIndex('abcdefgh'[file] + (8 - rank))] = p.color;
    }
  }
  return out;
}

export function mismatch(observed, expected) {
  let s = 0;
  for (let i = 0; i < 64; i++) {
    const o = observed.occupancy[i], e = expected[i];
    if (o !== !!e) s += 1;
    else if (o && observed.colors?.[i] && observed.colors[i] !== e) s += 0.35;
  }
  return s;
}

// ─── Change detection ─────────────────────────────────────────────────────
// Per-square appearance (4×4 luminance cells + chroma) of a canonical warp.
// Comparing against the frame of the last confirmed position catches pieces
// whose brightness matches the square (white on light), which occupancy alone
// misses.
const DESC = 18;
export function squareDescriptors(warp) {
  const S = warp.width, q = S / 8, d = warp.data;
  const out = new Float32Array(64 * DESC);
  const m = Math.max(1, Math.round(q * 0.1)), inner = q - 2 * m, cell = inner / 4;
  for (let i = 0; i < 64; i++) {
    const ox = (i % 8) * q + m, oy = Math.floor(i / 8) * q + m;
    let cr = 0, cb = 0, n = 0;
    for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) {
      let L = 0, k = 0;
      for (let y = Math.floor(oy + cy * cell); y < Math.floor(oy + (cy + 1) * cell); y++) {
        for (let x = Math.floor(ox + cx * cell); x < Math.floor(ox + (cx + 1) * cell); x++) {
          const j = (y * S + x) * 4;
          L += d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114;
          cr += d[j] - d[j + 1]; cb += d[j + 2] - d[j + 1]; k++; n++;
        }
      }
      out[i * DESC + cy * 4 + cx] = k ? L / k : 0;
    }
    out[i * DESC + 16] = n ? cr / n : 0;
    out[i * DESC + 17] = n ? cb / n : 0;
  }
  return out;
}

// → { c: per-square change (64), T: threshold for "really changed" }
export function descriptorChanges(ref, cur) {
  const c = new Float32Array(64);
  for (let i = 0; i < 64; i++) {
    let s = 0;
    for (let k = 0; k < 16; k++) s += Math.abs(cur[i * DESC + k] - ref[i * DESC + k]);
    c[i] = s / 16 + 0.5 * (Math.abs(cur[i * DESC + 16] - ref[i * DESC + 16]) + Math.abs(cur[i * DESC + 17] - ref[i * DESC + 17]));
  }
  const med = [...c].sort((a, b) => a - b)[32];
  return { c, T: Math.max(10, med * 3) };
}

const CHANGE_WEIGHT = 1.5;

// Cost of a hypothesised position: occupancy/colour mismatch plus, if change
// info is given, how badly "squares whose contents differ from the reference
// position" agree with "squares that visibly changed".
function makeScorer(observed, squareToIndex, change, refBoard) {
  return (board) => {
    let s = mismatch(observed, expectedFromBoard(board, squareToIndex));
    if (!change) return s;
    const { c, T } = change;
    const exp = new Uint8Array(64);
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const a = refBoard[r][f], b = board[r][f];
      if ((a?.type ?? '') + (a?.color ?? '') !== (b?.type ?? '') + (b?.color ?? '')) {
        exp[squareToIndex('abcdefgh'[f] + (8 - r))] = 1;
      }
    }
    let cost = 0;
    for (let i = 0; i < 64; i++) {
      cost += exp[i] ? Math.min(1, Math.max(0, (T - c[i]) / T)) : Math.min(1, Math.max(0, (c[i] - T) / T));
    }
    return s + CHANGE_WEIGHT * cost;
  };
}

// Returns { base, ranked: [{move, score}] } where base is the cost of
// "nothing moved" and ranked is sorted best-first.
// change (optional): descriptorChanges() against the frame of the current position.
export function matchMove(observed, chess, squareToIndex, change = null) {
  const refBoard = chess.board();
  const score = makeScorer(observed, squareToIndex, change, refBoard);
  const base = score(refBoard);
  const ranked = [];
  for (const m of chess.moves({ verbose: true })) {
    if (m.promotion && m.promotion !== 'q') continue;
    chess.move({ from: m.from, to: m.to, promotion: m.promotion });
    ranked.push({ move: m, score: score(chess.board()) });
    chess.undo();
  }
  ranked.sort((a, b) => a.score - b.score);
  return { base, ranked };
}

// Turns a matchMove result into a decision.
//   { kind: 'none' }                   — board still matches the current position
//   { kind: 'move', move }             — one clear winner
//   { kind: 'ambiguous', candidates }  — several moves explain the frame equally
//   { kind: 'unreadable' }             — nothing explains the frame
export function decideMove({ base, ranked }) {
  const best = ranked[0];
  // A capture changes one square's occupancy plus its colour (1 + 0.35), so 1.3
  // is the smallest real change; a single misread square (1.0) is ignored.
  if (!best || base < 1) return { kind: 'none' };
  if (base < 1.3) {
    // One square emptied with no colour evidence: could be a capture or a misread.
    // Never auto-play it; offer the matching captures for confirmation.
    const weak = ranked.filter(r => r.score <= base - 1 + 1e-9).slice(0, 4).map(r => r.move);
    return weak.length ? { kind: 'ambiguous', candidates: weak, weak: true } : { kind: 'none' };
  }
  // Misreads that persist across positions add equally to every candidate,
  // so only the improvement over "nothing moved" matters.
  if (best.score > base - 1.3) return { kind: 'unreadable' };
  const tied = ranked.filter(r => r.score - best.score < 0.5);
  if (tied.length === 1) return { kind: 'move', move: best.move };
  return { kind: 'ambiguous', candidates: tied.slice(0, 4).map(r => r.move) };
}

// Recovery when a move was missed: find a move + reply pair that explains the
// frame clearly better than any single move. Returns [m1, m2] or null.
export function matchTwoPly(observed, chess, squareToIndex, change = null) {
  const refBoard = chess.board();
  const score = makeScorer(observed, squareToIndex, change, refBoard);
  const base = score(refBoard);
  let single = Infinity;
  const pairs = [];
  for (const m1 of chess.moves({ verbose: true })) {
    if (m1.promotion && m1.promotion !== 'q') continue;
    chess.move({ from: m1.from, to: m1.to, promotion: m1.promotion });
    single = Math.min(single, score(chess.board()));
    for (const m2 of chess.moves({ verbose: true })) {
      if (m2.promotion && m2.promotion !== 'q') continue;
      chess.move({ from: m2.from, to: m2.to, promotion: m2.promotion });
      pairs.push({ m1, m2, score: score(chess.board()) });
      chess.undo();
    }
    chess.undo();
  }
  pairs.sort((a, b) => a.score - b.score);
  const [best, second] = pairs;
  if (!best || best.score > base - 2.6 || best.score > single - 1.3) return null;
  if (second && second.score - best.score < 0.5) return null;
  return [best.m1, best.m2];
}

// ─── Camera Manager ──────────────────────────────────────────────────────────

// Frames are pulled with grab() from the XR render loop: window
// requestAnimationFrame is paused on Quest while an immersive session runs.
export class CameraManager {
  constructor() {
    this._stream = null;
    this._video = null;
    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
  }

  get ready() { return !!this._video && this._video.readyState >= 2; }

  async start() {
    if (this._stream) return this;
    this._stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    this._video = document.createElement('video');
    this._video.srcObject = this._stream;
    this._video.muted = true;
    this._video.setAttribute('playsinline', '');
    await this._video.play();
    const vw = this._video.videoWidth || 1280, vh = this._video.videoHeight || 960;
    const scale = Math.min(1, 640 / vw);
    this._canvas.width = Math.round(vw * scale);
    this._canvas.height = Math.round(vh * scale);
    return this;
  }

  // Downscaled frame as a transferable ImageBitmap (for the vision worker).
  bitmap(width = 640) {
    if (!this.ready) return null;
    const vw = this._video.videoWidth, vh = this._video.videoHeight;
    return createImageBitmap(this._video, {
      resizeWidth: width, resizeHeight: Math.round((width * vh) / vw), resizeQuality: 'medium',
    });
  }

  get label() { return this._stream?.getVideoTracks()[0]?.label ?? ''; }

  grab() {
    if (!this.ready) return null;
    this._ctx.drawImage(this._video, 0, 0, this._canvas.width, this._canvas.height);
    return this._canvas;
  }

  getCanvas() { return this._canvas; }

  stop() {
    this._stream?.getTracks().forEach(t => t.stop());
    this._stream = null;
    this._video = null;
  }
}

// loadOpenCV is kept as a no-op for API compatibility
export async function loadOpenCV(onProgress) {
  onProgress?.('Vision ready (pure JS)');
  return true;
}
