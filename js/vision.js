// Chess board vision pipeline
// Runs entirely in-browser using OpenCV.js (loaded lazily)
// Pipeline: corner detection → perspective warp → square analysis → move tracking
//
// Approach (chesscog-inspired, adapted for browser/JS):
//   1. Board localisation via contour/corner detection (OpenCV.js)
//   2. Occupancy + colour classification per square (histogram analysis)
//   3. Diff-based move detection between frames
//   4. Legal-move filtering via chess.js to eliminate noise
//
// License of this file: MIT (original work, inspired by chesscog MIT pipeline)

const OPENCV_CDN = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.8.0-release.1/dist/opencv.js';

let cv = null; // OpenCV module

export async function loadOpenCV(onProgress) {
  if (cv) return cv;
  onProgress?.('Loading OpenCV.js…');
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = OPENCV_CDN;
    script.async = true;
    script.onload = () => {
      // OpenCV.js sets window.cv as a promise or object
      const wait = () => {
        if (window.cv && window.cv.Mat) {
          cv = window.cv;
          onProgress?.('OpenCV ready');
          resolve(cv);
        } else {
          setTimeout(wait, 100);
        }
      };
      wait();
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// ─── Board Detector ──────────────────────────────────────────────────────────

export class BoardDetector {
  constructor() {
    this._corners = null; // [{x,y}, {x,y}, {x,y}, {x,y}] clockwise from TL
    this._homography = null;
    this._boardSize = 480; // output size in px
    this._lastOccupancy = null;
    this._lastColors = null;
    this._occlusionFen = null; // last confirmed FEN before occlusion
  }

  // Manually set corners from controller drag (two opposite corners = TL, BR)
  setCorners(tl, br) {
    // Build all 4 corners from 2 diagonal corners
    this._corners = [
      { x: tl.x, y: tl.y },
      { x: br.x, y: tl.y },
      { x: br.x, y: br.y },
      { x: tl.x, y: br.y },
    ];
    this._computeHomography();
  }

  // Set all 4 corners directly
  setFourCorners(corners) {
    this._corners = corners;
    this._computeHomography();
  }

  hasCorners() { return this._corners !== null; }
  getCorners() { return this._corners; }

  _computeHomography() {
    if (!cv) return;
    const S = this._boardSize;
    const src = cv.matFromArray(4, 1, cv.CV_32FC2, [
      this._corners[0].x, this._corners[0].y,
      this._corners[1].x, this._corners[1].y,
      this._corners[2].x, this._corners[2].y,
      this._corners[3].x, this._corners[3].y,
    ]);
    const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0, S, 0, S, S, 0, S
    ]);
    this._homography = cv.getPerspectiveTransform(src, dst);
    src.delete(); dst.delete();
  }

  // Auto-detect board corners in an image (HTMLCanvasElement or ImageData)
  // Returns array of 4 {x,y} points or null
  detectBoardCorners(canvas) {
    if (!cv) return null;
    const src = cv.imread(canvas);
    const gray = new cv.Mat();
    const blur = new cv.Mat();
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();

    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      cv.Canny(blur, edges, 30, 90);

      // Dilate edges to close gaps
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      cv.dilate(edges, edges, kernel);
      kernel.delete();

      cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      let bestArea = 0;
      let bestRect = null;

      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);
        if (area < 10000) continue; // minimum board area

        const peri = cv.arcLength(cnt, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

        if (approx.rows === 4 && area > bestArea) {
          bestArea = area;
          const pts = [];
          for (let j = 0; j < 4; j++) {
            pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
          }
          bestRect = this._orderCorners(pts);
        }
        approx.delete();
      }

      return bestRect;
    } finally {
      src.delete(); gray.delete(); blur.delete(); edges.delete();
      contours.delete(); hierarchy.delete();
    }
  }

  // Order corners: TL, TR, BR, BL
  _orderCorners(pts) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    const tl = pts.find(p => p.x < cx && p.y < cy) ?? pts[0];
    const tr = pts.find(p => p.x >= cx && p.y < cy) ?? pts[1];
    const br = pts.find(p => p.x >= cx && p.y >= cy) ?? pts[2];
    const bl = pts.find(p => p.x < cx && p.y >= cy) ?? pts[3];
    return [tl, tr, br, bl];
  }

  // Warp the input canvas to a top-down S×S board view
  warpBoard(canvas) {
    if (!cv || !this._homography) return null;
    const S = this._boardSize;
    const src = cv.imread(canvas);
    const dst = new cv.Mat();
    const dsize = new cv.Size(S, S);
    cv.warpPerspective(src, dst, this._homography, dsize);
    src.delete();
    return dst; // caller must delete()
  }

  // Analyze a warped board Mat → returns occupancy[64] and colors[64]
  // occupancy: true = piece present; colors: 'w' | 'b' | null
  analyzeBoard(boardMat) {
    const S = this._boardSize;
    const sqSize = S / 8;
    const occupancy = new Array(64).fill(false);
    const colors = new Array(64).fill(null);

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const idx = row * 8 + col;
        const x = Math.round(col * sqSize);
        const y = Math.round(row * sqSize);
        const w = Math.round(sqSize);
        const h = Math.round(sqSize);

        // Extract square ROI (inner 60% to avoid edge artifacts)
        const margin = Math.round(sqSize * 0.2);
        const roi = boardMat.roi(new cv.Rect(
          x + margin, y + margin,
          w - 2 * margin, h - 2 * margin
        ));

        const { occ, color } = this._classifySquare(roi, row, col);
        occupancy[idx] = occ;
        colors[idx] = color;
        roi.delete();
      }
    }
    return { occupancy, colors };
  }

  // Classify a single square ROI
  _classifySquare(roi, row, col) {
    const gray = new cv.Mat();
    cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);

    // Compute mean and std of the grayscale square
    const mean = new cv.Mat();
    const stddev = new cv.Mat();
    cv.meanStdDev(gray, mean, stddev);
    const mu = mean.data64F[0];
    const sigma = stddev.data64F[0];
    gray.delete(); mean.delete(); stddev.delete();

    // Empty squares have low std (uniform colour of board)
    // Pieces have higher texture/contrast
    const isLightSquare = (row + col) % 2 === 0;
    const occupancyThreshold = isLightSquare ? 18 : 20;
    const occ = sigma > occupancyThreshold;

    if (!occ) return { occ: false, color: null };

    // Piece color: white pieces appear lighter than the dark squares,
    // and darker than the light squares.
    // Classify by mu relative to expected empty square luminance
    const emptyLight = 230; // approx pixel value for empty light square
    const emptyDark = 100;  // approx pixel value for empty dark square
    const emptyRef = isLightSquare ? emptyLight : emptyDark;
    const diff = mu - emptyRef;

    // White piece on dark square: mu >> emptyDark → diff positive and large
    // Black piece on light square: mu << emptyLight → diff negative and large
    // Heuristic works best for standard Staunton piece sets
    let color;
    if (isLightSquare) {
      color = diff < -40 ? 'b' : 'w'; // black piece darkens light square
    } else {
      color = diff > 40 ? 'w' : 'b';  // white piece lightens dark square
    }

    return { occ, color };
  }

  // Compute changed squares between two occupancy arrays
  // Returns { vacated: [sqIdx], arrived: [sqIdx] }
  diffOccupancy(prev, curr) {
    const vacated = [];
    const arrived = [];
    for (let i = 0; i < 64; i++) {
      if (prev[i] && !curr[i]) vacated.push(i);
      else if (!prev[i] && curr[i]) arrived.push(i);
    }
    return { vacated, arrived };
  }

  // Convert flat board index to algebraic square
  // Index 0 = a8 (top-left when White is at bottom)
  static indexToSquare(idx, whiteAtBottom = true) {
    const row = Math.floor(idx / 8);
    const col = idx % 8;
    if (whiteAtBottom) {
      return 'abcdefgh'[col] + (8 - row);
    } else {
      return 'abcdefgh'[7 - col] + (row + 1);
    }
  }

  // Process a camera frame (canvas) end-to-end
  // Returns { candidates: [{from,to}], occupancy, colors } or null if no board
  processFrame(canvas, prevOccupancy, chessGame, whiteAtBottom = true) {
    const boardMat = this.warpBoard(canvas);
    if (!boardMat) return null;

    try {
      const { occupancy, colors } = this.analyzeBoard(boardMat);

      if (!prevOccupancy) {
        this._lastOccupancy = occupancy;
        this._lastColors = colors;
        return { candidates: [], occupancy, colors };
      }

      const { vacated, arrived } = this.diffOccupancy(prevOccupancy, occupancy);
      const candidates = [];

      // Simple move: 1 vacated + 1 arrived → candidate move
      if (vacated.length === 1 && arrived.length === 1) {
        // Normal move
        const from = BoardDetector.indexToSquare(vacated[0], whiteAtBottom);
        const to = BoardDetector.indexToSquare(arrived[0], whiteAtBottom);
        candidates.push({ from, to });
      } else if (vacated.length === 1 && arrived.length === 0) {
        // Capture: source vacated, destination already had a piece (no arrival signal)
        const fromSq = BoardDetector.indexToSquare(vacated[0], whiteAtBottom);
        const captureMoves = chessGame.legalMoves(fromSq)
          .filter(m => m.flags.includes('c') || m.flags.includes('e'));
        for (const m of captureMoves) candidates.push({ from: m.from, to: m.to });
      }
      // Castling: 2 vacated + 2 arrived
      else if (vacated.length === 2 && arrived.length === 2) {
        for (const v of vacated) {
          for (const a of arrived) {
            candidates.push({
              from: BoardDetector.indexToSquare(v, whiteAtBottom),
              to: BoardDetector.indexToSquare(a, whiteAtBottom),
            });
          }
        }
      }

      // Filter by legal moves
      const legal = chessGame.filterLegal(candidates);

      this._lastOccupancy = occupancy;
      this._lastColors = colors;

      return { candidates: legal, occupancy, colors };
    } finally {
      boardMat.delete();
    }
  }

  // Partial rescan: analyze only the squares that changed
  // Used after grip-triggered rescan request
  rescanChangedSquares(canvas, prevOccupancy) {
    const boardMat = this.warpBoard(canvas);
    if (!boardMat) return null;
    try {
      const { occupancy, colors } = this.analyzeBoard(boardMat);
      return { occupancy, colors };
    } finally {
      boardMat.delete();
    }
  }

  // Save last confirmed occupancy for occlusion recovery
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
    this._canvas.width = this._video.videoWidth;
    this._canvas.height = this._video.videoHeight;
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
