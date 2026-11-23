// Runs board finding off the main thread so the headset keeps its frame rate.
import { BoardFinder } from './boardfind.js';

const finder = new BoardFinder();
let canvas = null, ctx = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'reset') { finder.reset(); return; }
  if (m.type !== 'frame') return;
  const { bitmap, expected, id } = m;
  const W = bitmap.width, H = bitmap.height;
  if (!canvas || canvas.width !== W || canvas.height !== H) {
    canvas = new OffscreenCanvas(W, H);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const t0 = performance.now();
  const res = finder.process(ctx.getImageData(0, 0, W, H), expected);
  const out = { ...res, type: 'result', id, W, H, ms: performance.now() - t0 };
  const transfer = [];
  if (res.warp) {
    out.warp = { width: res.warp.width, height: res.warp.height, data: res.warp.data };
    transfer.push(res.warp.data.buffer);
  }
  self.postMessage(out, transfer);
};
