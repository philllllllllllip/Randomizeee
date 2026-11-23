// Automatic chessboard finding in a camera frame — pure JS, no WASM.
//
//  1. ChESS X-corner detector (Bennett & Lasenby 2014) finds the inner
//     corners where four squares meet.
//  2. A perspective lattice is grown from a seed square of four corners and
//     refit by least squares (homography lattice→image).
//  3. The lattice is cut to the 7×7 inner corners; the outer board edge and
//     which corner is a8 are chosen by matching piece occupancy against the
//     known game position (at lock) or by continuity with the last frame.
//
// Output corners are always labelled [a8, h8, h1, a1] in image pixels, so the
// warped board is canonical: row 0 = rank 8, col 0 = file a.

import { BoardDetector, mismatch, buildHomography, applyH } from './vision.js';

const RAD = 5;
const RING = Array.from({ length: 16 }, (_, n) => {
  const t = (n * Math.PI) / 8;
  return [Math.round(RAD * Math.cos(t)), Math.round(RAD * Math.sin(t))];
});

export function toGray(img) {
  const { width: W, height: H, data } = img;
  const g = new Float32Array(W * H);
  for (let i = 0, j = 0; i < W * H; i++, j += 4) g[i] = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;
  const t = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 1; x < W - 1; x++) t[o + x] = (g[o + x - 1] + g[o + x] + g[o + x + 1]) / 3;
  }
  for (let y = 1; y < H - 1; y++) {
    const o = y * W;
    for (let x = 1; x < W - 1; x++) g[o + x] = (t[o + x - W] + t[o + x] + t[o + x + W]) / 3;
  }
  return g;
}

export function findCorners(g, W, H, maxPts = 300) {
  const offs = RING.map(([dx, dy]) => dy * W + dx);
  const resp = new Float32Array(W * H);
  const I = new Float32Array(16);
  let rmax = 0;
  const m = RAD + 1;
  for (let y = m; y < H - m; y++) {
    for (let x = m; x < W - m; x++) {
      const i = y * W + x;
      let sum = 0;
      for (let n = 0; n < 16; n++) { I[n] = g[i + offs[n]]; sum += I[n]; }
      let sr = 0, dr = 0;
      for (let n = 0; n < 4; n++) sr += Math.abs(I[n] + I[n + 8] - I[n + 4] - I[n + 12]);
      for (let n = 0; n < 8; n++) dr += Math.abs(I[n] - I[n + 8]);
      const local = (g[i] + g[i - 1] + g[i + 1] + g[i - W] + g[i + W]) / 5;
      const r = sr - dr - 16 * Math.abs(sum / 16 - local);
      if (r > 0) { resp[i] = r; if (r > rmax) rmax = r; }
    }
  }
  const thresh = Math.max(rmax * 0.12, 30);
  const pts = [];
  const N = 3;
  for (let y = m; y < H - m; y++) {
    for (let x = m; x < W - m; x++) {
      const i = y * W + x, r = resp[i];
      if (r < thresh) continue;
      let isMax = true;
      for (let dy = -N; dy <= N && isMax; dy++) {
        for (let dx = -N; dx <= N; dx++) {
          if ((dx || dy) && resp[i + dy * W + dx] > r) { isMax = false; break; }
        }
      }
      if (!isMax) continue;
      let sx = 0, sy = 0, sw = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const w = resp[i + dy * W + dx];
          sx += (x + dx) * w; sy += (y + dy) * w; sw += w;
        }
      }
      pts.push({ x: sx / sw, y: sy / sw, r });
    }
  }
  pts.sort((a, b) => b.r - a.r);
  return pts.slice(0, maxPts);
}

// Least-squares homography (u,v)→(x,y) with Hartley normalisation.
function homographyLSQ(pairs) {
  const norm = (xs, ys) => {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let d = 0;
    for (let i = 0; i < n; i++) d += Math.hypot(xs[i] - mx, ys[i] - my);
    return { mx, my, s: Math.SQRT2 / ((d / n) || 1) };
  };
  const ni = norm(pairs.map(p => p.x), pairs.map(p => p.y));
  const nl = norm(pairs.map(p => p.u), pairs.map(p => p.v));
  const A = Array.from({ length: 8 }, () => new Float64Array(9));
  const addRow = (row, rhs) => {
    for (let a = 0; a < 8; a++) {
      if (!row[a]) continue;
      for (let b = 0; b < 8; b++) A[a][b] += row[a] * row[b];
      A[a][8] += row[a] * rhs;
    }
  };
  for (const p of pairs) {
    const u = (p.u - nl.mx) * nl.s, v = (p.v - nl.my) * nl.s;
    const x = (p.x - ni.mx) * ni.s, y = (p.y - ni.my) * ni.s;
    addRow([u, v, 1, 0, 0, 0, -u * x, -v * x], x);
    addRow([0, 0, 0, u, v, 1, -u * y, -v * y], y);
  }
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  // H = Timg⁻¹ · Hn · Tlat
  const Ti = [1 / ni.s, 0, ni.mx, 0, 1 / ni.s, ni.my, 0, 0, 1];
  const Tl = [nl.s, 0, -nl.s * nl.mx, 0, nl.s, -nl.s * nl.my, 0, 0, 1];
  const H = mul3(mul3(Ti, Hn), Tl);
  return H.map(v => v / H[8]);
}

function mul3(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return o;
}

class Grid {
  constructor(pts, cell = 12) {
    this.cell = cell;
    this.map = new Map();
    pts.forEach((p, i) => {
      const k = this._key(Math.floor(p.x / cell), Math.floor(p.y / cell));
      (this.map.get(k) ?? this.map.set(k, []).get(k)).push(i);
    });
    this.pts = pts;
  }
  _key(cx, cy) { return cx * 100003 + cy; }
  nearest(x, y, maxD) {
    const c = this.cell, r = Math.ceil(maxD / c);
    const cx = Math.floor(x / c), cy = Math.floor(y / c);
    let best = -1, bd = maxD;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      for (const i of this.map.get(this._key(cx + dx, cy + dy)) ?? []) {
        const d = Math.hypot(this.pts[i].x - x, this.pts[i].y - y);
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  }
}

function growLattice(pts, grid, seed, W, H) {
  let Hm = homographyLSQ(seed);
  if (!Hm) return null;
  let matches = [];
  for (let iter = 0; iter < 5; iter++) {
    const tol = iter < 2 ? 0.3 : 0.18;
    matches = [];
    const used = new Set();
    for (let u = -8; u <= 8; u++) {
      for (let v = -8; v <= 8; v++) {
        const p = applyH(Hm, u, v);
        if (!(p.x > -5 && p.y > -5 && p.x < W + 5 && p.y < H + 5)) continue;
        const pu = applyH(Hm, u + 1, v), pv = applyH(Hm, u, v + 1);
        const sp = Math.min(Math.hypot(pu.x - p.x, pu.y - p.y), Math.hypot(pv.x - p.x, pv.y - p.y));
        if (!(sp > 5)) continue;
        const k = grid.nearest(p.x, p.y, sp * tol);
        if (k < 0 || used.has(k)) continue;
        used.add(k);
        matches.push({ u, v, x: pts[k].x, y: pts[k].y });
      }
    }
    if (matches.length < 5) return null;
    Hm = robustFit(matches);
    if (!Hm) return null;
  }
  // A board has 7 inner corner lines per axis: keep the densest 7-wide window.
  const cut = (key) => {
    const vals = matches.map(m => m[key]);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    let bestS = lo, bestN = -1;
    for (let s = lo; s <= Math.max(lo, hi - 6); s++) {
      const n = vals.filter(x => x >= s && x <= s + 6).length;
      if (n > bestN) { bestN = n; bestS = s; }
    }
    matches = matches.filter(m => m[key] >= bestS && m[key] <= bestS + 6);
  };
  cut('u');
  cut('v');
  if (matches.length < 5) return null;
  Hm = robustFit(matches);
  return Hm ? { H: Hm, matches } : null;
}

// Least squares, then drop points far from the fit (piece edges that happened
// to look like corners) and refit.
function robustFit(matches) {
  let H = homographyLSQ(matches);
  if (!H || matches.length < 8) return H;
  const res = matches.map(m => { const p = applyH(H, m.u, m.v); return Math.hypot(p.x - m.x, p.y - m.y); });
  const med = [...res].sort((a, b) => a - b)[Math.floor(res.length / 2)];
  const keep = matches.filter((_, i) => res[i] <= Math.max(1.5, med * 2.5));
  if (keep.length >= 6 && keep.length < matches.length) {
    matches.splice(0, matches.length, ...keep);
    H = homographyLSQ(matches) ?? H;
  }
  return H;
}

export function fitLattice(pts, W, H) {
  if (pts.length < 9) return null;
  const grid = new Grid(pts);
  const nn = pts.map((p) =>
    pts.map((q, j) => ({ j, d: Math.hypot(q.x - p.x, q.y - p.y) }))
      .filter(o => o.d > 3).sort((a, b) => a.d - b.d).slice(0, 4)
  );
  let best = null;
  const seeds = Math.min(pts.length, 50);
  for (let s = 0; s < seeds; s++) {
    const p0 = pts[s];
    const ns = nn[s];
    for (let a = 0; a < ns.length; a++) {
      for (let b = a + 1; b < ns.length; b++) {
        const A = pts[ns[a].j], B = pts[ns[b].j];
        const va = { x: A.x - p0.x, y: A.y - p0.y }, vb = { x: B.x - p0.x, y: B.y - p0.y };
        const la = ns[a].d, lb = ns[b].d;
        if (Math.min(la, lb) / Math.max(la, lb) < 0.45) continue;
        if (Math.abs(va.x * vb.y - va.y * vb.x) / (la * lb) < 0.45) continue;
        const c = grid.nearest(p0.x + va.x + vb.x, p0.y + va.y + vb.y, Math.min(la, lb) * 0.3);
        if (c < 0) continue;
        const C = pts[c];
        const fit = growLattice(pts, grid, [
          { u: 0, v: 0, x: p0.x, y: p0.y }, { u: 1, v: 0, x: A.x, y: A.y },
          { u: 0, v: 1, x: B.x, y: B.y }, { u: 1, v: 1, x: C.x, y: C.y },
        ], W, H);
        if (fit && (!best || fit.matches.length > best.matches.length)) best = fit;
      }
    }
    if (best && best.matches.length >= 36) break;
  }
  if (!best || best.matches.length < 12) return null;
  const us = best.matches.map(m => m.u), vs = best.matches.map(m => m.v);
  if (Math.max(...us) - Math.min(...us) < 2 || Math.max(...vs) - Math.min(...vs) < 2) return null;
  return best;
}

// Every way the fitted inner-corner lattice could sit on an 8×8 board:
// outer-edge offset × which image corner is a8. Corners: [a8, h8, h1, a1].
export function boardHypotheses({ H, matches }) {
  const us = matches.map(m => m.u), vs = matches.map(m => m.v);
  const umin = Math.min(...us), umax = Math.max(...us), vmin = Math.min(...vs), vmax = Math.max(...vs);
  const out = [];
  for (let su = umax - 6; su <= umin; su++) {
    for (let sv = vmax - 6; sv <= vmin; sv++) {
      const quad = [[su - 1, sv - 1], [su + 7, sv - 1], [su + 7, sv + 7], [su - 1, sv + 7]]
        .map(([u, v]) => applyH(H, u, v));
      const cx = quad.reduce((a, p) => a + p.x, 0) / 4, cy = quad.reduce((a, p) => a + p.y, 0) / 4;
      // Clockwise on screen (y down); a board seen from above is clockwise a8→h8→h1→a1.
      quad.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
      for (let s = 0; s < 4; s++) out.push([0, 1, 2, 3].map(k => quad[(k + s) % 4]));
    }
  }
  return out;
}

const CANON = (sq) => (8 - +sq[1]) * 8 + 'abcdefgh'.indexOf(sq[0]);
export const canonicalIndex = CANON;

export class BoardFinder {
  constructor() {
    this.det = new BoardDetector();
    this.det.setBoardSize(160);
    this.reset();
  }

  reset() {
    this.locked = null;
    this.calib = null;
    this.det.clearCalibration();
  }

  // img: ImageData of the camera frame. expected: 64-array ('w'|'b'|null) of
  // the current game position in canonical index order.
  process(img, expected) {
    const W = img.width, H = img.height;
    const pts = findCorners(toGray(img), W, H);
    const fit = fitLattice(pts, W, H);
    if (!fit) return { found: false, nCorners: pts.length };
    const hyps = boardHypotheses(fit);

    let chosen = null, how = 'track';
    if (this.locked) {
      const scale = perimeter(this.locked) / 32;
      let bd = Infinity;
      for (const h of hyps) {
        const d = h.reduce((a, p, k) => a + Math.hypot(p.x - this.locked[k].x, p.y - this.locked[k].y), 0) / 4;
        if (d < bd) { bd = d; chosen = h; }
      }
      if (bd > scale * 0.6) chosen = null;
    }

    if (!chosen) {
      how = this.calib ? 'reacquire' : 'lock';
      let best = null;
      for (const h of hyps) {
        if (!insideEnough(h, W, H)) continue;
        this._setGeometry(h, W, H);
        let score, calib = this.calib;
        if (!calib) {
          this.det.clearCalibration();
          const stats = this.det.analyzeFrame(img);
          if (!stats || !this.det.calibrate(stats, expected)) continue;
          calib = this.det._calib;
          // White pieces are brighter than black ones — rules out the 180° twin.
          if (calib.light.whiteMu < calib.light.blackMu + 15 || calib.dark.whiteMu < calib.dark.blackMu + 15) continue;
        }
        this.det._calib = calib;
        score = mismatch(this.det.analyzeFrame(img), expected);
        if (!best || score < best.score) best = { h, score, calib };
      }
      if (!best || best.score > 10) {
        this.det._calib = this.calib;
        return { found: false, nCorners: pts.length, lattice: fit.matches.length, bestScore: best?.score };
      }
      chosen = best.h;
      this.calib = best.calib;
      this.det._calib = best.calib;
    }

    this.locked = chosen;
    this._setGeometry(chosen, W, H);
    const obs = this.det.analyzeFrame(img);
    return {
      found: true, how, corners: chosen, nCorners: pts.length, lattice: fit.matches.length,
      occupancy: obs.occupancy, colors: obs.colors, warp: obs.warp,
    };
  }

  _setGeometry(corners, W, H) {
    this.det.setFourCorners(corners);
    // Viewer is toward the bottom of the image; express that in warp axes.
    const S = 160;
    const Hi = buildHomography(corners, [{ x: 0, y: 0 }, { x: S, y: 0 }, { x: S, y: S }, { x: 0, y: S }]);
    if (!Hi) return;
    const cx = corners.reduce((a, p) => a + p.x, 0) / 4, cy = corners.reduce((a, p) => a + p.y, 0) / 4;
    const a = applyH(Hi, cx, cy), b = applyH(Hi, cx, cy + H * 0.05);
    this.det.setViewDir(b.x - a.x, b.y - a.y);
  }
}

function perimeter(c) {
  let p = 0;
  for (let k = 0; k < 4; k++) p += Math.hypot(c[k].x - c[(k + 1) % 4].x, c[k].y - c[(k + 1) % 4].y);
  return p;
}

function insideEnough(c, W, H) {
  const mx = W * 0.08, my = H * 0.08;
  return c.every(p => p.x > -mx && p.y > -my && p.x < W + mx && p.y < H + my);
}
