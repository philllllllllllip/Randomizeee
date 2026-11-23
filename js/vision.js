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

function buildHomography(src, dst) {
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

function applyH(H, x, y) {
  const w = H[6]*x + H[7]*y + H[8];
  return { x: (H[0]*x + H[1]*y + H[2]) / w, y: (H[3]*x + H[4]*y + H[5]) / w };
}

// Warp src canvas into a new S×S ImageData using homography from dst→src
function warpPerspective(srcCanvas, corners, S) {
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const srcData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const srcW = srcCanvas.width, srcH = srcCanvas.height;

  // Destination corners (top-down square S×S)
  const dstPts = [{ x:0,y:0 }, { x:S,y:0 }, { x:S,y:S }, { x:0,y:S }];
  // Build H: dst→src (inverse warp)
  const H = buildHomography(dstPts, corners);
  if (!H) return null;

  const out = new Uint8ClampedArray(S * S * 4);

  for (let dy = 0; dy < S; dy++) {
    for (let dx = 0; dx < S; dx++) {
      const { x: sx, y: sy } = applyH(H, dx + 0.5, dy + 0.5);
      // Bilinear sample
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = x0 + 1, y1 = y0 + 1;
      const fx = sx - x0, fy = sy - y0;
      const getP = (px, py) => {
        if (px < 0 || py < 0 || px >= srcW || py >= srcH) return [0,0,0,0];
        const i = (py * srcW + px) * 4;
        return [srcData.data[i], srcData.data[i+1], srcData.data[i+2], srcData.data[i+3]];
      };
      const p00 = getP(x0,y0), p10 = getP(x1,y0), p01 = getP(x0,y1), p11 = getP(x1,y1);
      const oi = (dy * S + dx) * 4;
      for (let c = 0; c < 4; c++) {
        out[oi+c] = p00[c]*(1-fx)*(1-fy) + p10[c]*fx*(1-fy) + p01[c]*(1-fx)*fy + p11[c]*fx*fy;
      }
    }
  }
  return new ImageData(out, S, S);
}

// ─── Board Detector ──────────────────────────────────────────────────────────

export class BoardDetector {
  constructor() {
    this._corners = null; // [{x,y}×4] TL,TR,BR,BL in src image pixels
    this._boardSize = 480;
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
  analyzeFrame(canvas) {
    if (!this._corners) return null;
    const S = this._boardSize;
    const img = warpPerspective(canvas, this._corners, S);
    if (!img) return null;
    return this._analyzeImageData(img, S);
  }

  _analyzeImageData(img, S) {
    const sqSize = S / 8;
    const margin = Math.round(sqSize * 0.2);
    const inner = Math.round(sqSize * 0.6);
    const occupancy = new Array(64).fill(false);
    const colors = new Array(64).fill(null);

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const idx = row * 8 + col;
        const ox = Math.round(col * sqSize) + margin;
        const oy = Math.round(row * sqSize) + margin;

        let sumL = 0, sumL2 = 0, n = 0;
        for (let dy = 0; dy < inner; dy++) {
          for (let dx = 0; dx < inner; dx++) {
            const px = ox + dx, py = oy + dy;
            if (px >= S || py >= S) continue;
            const i = (py * S + px) * 4;
            const r = img.data[i], g = img.data[i+1], b = img.data[i+2];
            const L = (r*77 + g*150 + b*29) >> 8;
            sumL += L; sumL2 += L*L; n++;
          }
        }
        const mu = sumL / n;
        const sigma = Math.sqrt(sumL2/n - mu*mu);
        const isLightSq = (row + col) % 2 === 0;

        // Occupied if stddev exceeds threshold (piece adds texture)
        const threshold = isLightSq ? 16 : 18;
        const occ = sigma > threshold;
        occupancy[idx] = occ;

        if (occ) {
          // Colour: white pieces are brighter than dark squares,
          // black pieces are darker than light squares
          const emptyRef = isLightSq ? 210 : 85;
          const diff = mu - emptyRef;
          colors[idx] = isLightSq ? (diff < -35 ? 'b' : 'w') : (diff > 35 ? 'w' : 'b');
        }
      }
    }
    return { occupancy, colors };
  }

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

// ─── Camera Manager ──────────────────────────────────────────────────────────

export class CameraManager {
  constructor() {
    this._stream = null;
    this._video = null;
    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    this._running = false;
    this._frameCallback = null;
  }

  async start(constraints = { video: { facingMode: 'environment', width: 1280, height: 720 } }) {
    this._stream = await navigator.mediaDevices.getUserMedia(constraints);
    this._video = document.createElement('video');
    this._video.srcObject = this._stream;
    this._video.setAttribute('playsinline', '');
    await this._video.play();
    this._canvas.width = this._video.videoWidth || 1280;
    this._canvas.height = this._video.videoHeight || 720;
    this._running = true;
    this._loop();
    return this;
  }

  _loop() {
    if (!this._running) return;
    if (this._video.readyState >= 2) {
      this._ctx.drawImage(this._video, 0, 0);
      this._frameCallback?.(this._canvas);
    }
    requestAnimationFrame(() => this._loop());
  }

  onFrame(cb) { this._frameCallback = cb; }
  getCanvas() { return this._canvas; }

  stop() {
    this._running = false;
    this._stream?.getTracks().forEach(t => t.stop());
  }
}

// loadOpenCV is kept as a no-op for API compatibility
export async function loadOpenCV(onProgress) {
  onProgress?.('Vision ready (pure JS)');
  return true;
}
