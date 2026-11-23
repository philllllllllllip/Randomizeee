// Tests vision.matchMove/decideMove on simulated observations.
// Run: node test/matcher-test.mjs
import { createRequire } from 'node:module';
import { matchMove, decideMove, expectedFromBoard } from '../js/vision.js';

const require = createRequire(import.meta.url);
const { Chess } = require('../js/lib/chess.js');

const FILES = 'abcdefgh';
const toIdx = (white) => (sq) => {
  const f = FILES.indexOf(sq[0]), r = +sq[1];
  return white ? (8 - r) * 8 + f : (r - 1) * 8 + (7 - f);
};

function observe(chess, map, { flip = [], noColor = false } = {}) {
  const exp = expectedFromBoard(chess.board(), map);
  const occupancy = exp.map(Boolean);
  const colors = noColor ? new Array(64).fill(null) : exp.slice();
  for (const sq of flip) { const i = map(sq); occupancy[i] = !occupancy[i]; colors[i] = occupancy[i] ? 'w' : null; }
  return { occupancy, colors };
}

let pass = 0, fail = 0;
function check(name, cond, info = '') {
  if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, info); }
}

// Plays `san` on a copy to make the observation, then asks the matcher.
function detect(fen, san, opts = {}) {
  const white = opts.white ?? true;
  const game = new Chess(fen);
  const after = new Chess(fen);
  after.move(san, { sloppy: true });
  const obs = observe(after, toIdx(white), opts);
  return decideMove(matchMove(obs, game, toIdx(white)));
}

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

console.log('Move detection');
let d = detect(START, 'e4');
check('quiet pawn move e4', d.kind === 'move' && d.move.san === 'e4', JSON.stringify(d));
d = detect(START, 'Nf3', { white: false });
check('Nf3 with board seen from Black side', d.kind === 'move' && d.move.san === 'Nf3', JSON.stringify(d));
d = detect('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2', 'exd5');
check('capture exd5', d.kind === 'move' && d.move.san === 'exd5', JSON.stringify(d));
d = detect('r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4', 'O-O');
check('castling O-O', d.kind === 'move' && d.move.san === 'O-O', JSON.stringify(d));
d = detect('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3', 'exf6');
check('en passant exf6', d.kind === 'move' && d.move.san === 'exf6', JSON.stringify(d));
d = detect('8/4P3/8/8/8/2k5/8/4K3 w - - 0 1', 'e8=Q');
check('promotion e8=Q', d.kind === 'move' && d.move.from === 'e7' && d.move.to === 'e8', JSON.stringify(d));
d = detect('4k3/8/2p5/8/3N4/8/4p3/4K3 w - - 0 1', 'Nxc6', { noColor: true });
check('two captures, no colour info → ambiguous', d.kind === 'ambiguous' && d.candidates.length === 2, JSON.stringify(d));
d = detect('4k3/8/2p5/8/3N4/8/4p3/4K3 w - - 0 1', 'Nxc6');
check('same position with colours → resolved', d.kind === 'move' && d.move.san === 'Nxc6', JSON.stringify(d));

console.log('Noise rejection');
const g = new Chess(START);
d = decideMove(matchMove(observe(g, toIdx(true)), g, toIdx(true)));
check('unchanged board → none', d.kind === 'none');
d = decideMove(matchMove(observe(g, toIdx(true), { flip: ['e2'] }), g, toIdx(true)));
check('one flickering square (e2 reads empty) → none', d.kind === 'none', JSON.stringify(d));
d = detect('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2', 'exd5', { noColor: true });
check('capture without colour → offered for confirmation, not auto-played', d.kind === 'ambiguous' && d.weak && d.candidates[0].san === 'exd5', JSON.stringify(d));
d = decideMove(matchMove(observe(g, toIdx(true), { flip: ['a4', 'h5', 'c3', 'f6', 'd5'] }), g, toIdx(true)));
check('hand over board (5 random squares) → no move', d.kind !== 'move', JSON.stringify(d));

console.log('Full game replay (Opera game, 33 plies)');
const opera = 'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#'.split(' ');
const game = new Chess();
let ok = 0, amb = 0;
const t0 = Date.now();
for (const san of opera) {
  const after = new Chess(game.fen());
  after.move(san);
  const res = decideMove(matchMove(observe(after, toIdx(true)), game, toIdx(true)));
  if (res.kind === 'move' && res.move.san === san) ok++;
  else if (res.kind === 'ambiguous' && res.candidates.some(m => m.san === san)) amb++;
  game.move(san);
}
const ms = (Date.now() - t0) / opera.length;
console.log(`  ${ok}/${opera.length} auto-detected, ${amb} ambiguous (resolved by Groq/trigger), ${ms.toFixed(1)} ms/move`);
check('all Opera-game moves detected or flagged ambiguous', ok + amb === opera.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
