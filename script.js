const CHARSETS = {
  'alphanumeric':  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  'ascii symbols': '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  'hex':           '0123456789ABCDEF',
  'binary':        '01',
  'octal':         '01234567',
  'base64-ish':    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=',
  'letters only':  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  'digits only':   '0123456789',
  'emoji':         '🔥💀🌀🎲🧨🪄🫠🤖👾🌈🐍🦑🎯🫧🧿🪬🌊🔮🎭🪩🧬🛸🔬🎪🎰',
  'greek':         'αβγδεζηθικλμνξοπρστυφχψω',
  'cyrillic':      'абвгдеёжзийклмнопрстуфхцчшщъыьэюя',
  'mixed chaos':   'ABCabcDEFdef123!@#$%^&*αβγ🔥💀🧬',
};
const FONTS = [
  "'Space Mono', monospace",
  "'DM Mono', monospace",
  "'Bebas Neue', sans-serif",
  "'Inconsolata', monospace",
  "'Playfair Display', serif",
  "'Barlow Condensed', sans-serif",
  "'Cutive Mono', monospace",
  "'Syne', sans-serif",
];
const CASES = ['lowercase', 'uppercase', 'mixed', 'random'];
const TAGLINES = [
  'nothing here is decided by you',
  'chaos as a service',
  'determinism is dead',
  'trust the entropy',
  'randomness is the only truth',
  'your favorite string you didn\'t choose',
  'absolutely no pattern here',
  'generated from pure noise',
  'ctrl+z won\'t undo this',
  'the universe rolled a die',
  'probability said yes',
  'zero predictability guaranteed',
];
const PALETTES = [
  { bg: '#0e0e0e', fg: '#f0f0f0', accent: '#e8ff47', muted: '#555' },
  { bg: '#fafaf5', fg: '#111111', accent: '#ff3b00', muted: '#aaa' },
  { bg: '#1a0a2e', fg: '#e8d5ff', accent: '#bf6dff', muted: '#5a3f7a' },
  { bg: '#001f14', fg: '#b8ffd9', accent: '#00ff88', muted: '#2a5a42' },
  { bg: '#1c1007', fg: '#ffe8c0', accent: '#ff9500', muted: '#6b4e20' },
  { bg: '#f5f0eb', fg: '#2a1a0e', accent: '#c0392b', muted: '#b0a090' },
  { bg: '#0a0a1a', fg: '#c8d8ff', accent: '#4488ff', muted: '#2a3a6a' },
  { bg: '#1a1a1a', fg: '#ff6b9d', accent: '#ffce00', muted: '#555' },
  { bg: '#f0f4f8', fg: '#1a2030', accent: '#0033cc', muted: '#8899bb' },
  { bg: '#0d0d0d', fg: '#00ffff', accent: '#ff00aa', muted: '#333' },
  { bg: '#fff8f0', fg: '#3d1c00', accent: '#e07800', muted: '#c0a080' },
  { bg: '#10100e', fg: '#d4d4c8', accent: '#aaff00', muted: '#444' },
];
const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double'];
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randomString(charset, length) {
  const chars = charset.split('');
  let result = '';
  for (let i = 0; i < length; i++) {
    result += pick(chars);
  }
  return result;
}
function applyCase(str, caseType) {
  if (caseType === 'lowercase') return str.toLowerCase();
  if (caseType === 'uppercase') return str.toUpperCase();
  if (caseType === 'mixed') return str.toLowerCase().replace(/[a-z]/g, (c, i) => i % 2 === 0 ? c.toUpperCase() : c);
  if (caseType === 'random') return str.split('').map(c => Math.random() > 0.5 ? c.toUpperCase() : c.toLowerCase()).join('');
  return str;
}
function setPalette(palette) {
  const root = document.documentElement;
  root.style.setProperty('--bg', palette.bg);
  root.style.setProperty('--fg', palette.fg);
  root.style.setProperty('--accent', palette.accent);
  root.style.setProperty('--muted', palette.muted);
}
function generate() {
  const charsetName = pick(Object.keys(CHARSETS));
  const charset     = CHARSETS[charsetName];
  const length      = rand(4, 64);
  const caseType    = pick(CASES);
  const font        = pick(FONTS);
  const fontSize    = rand(10, 24) + 'px';
  const letterSpacing = (Math.random() * 0.3).toFixed(2) + 'em';
  const palette     = pick(PALETTES);
  const borderStyle = pick(BORDER_STYLES);
  const tagline     = pick(TAGLINES);
  let str = randomString(charset, length);
  if (/[a-zA-Z]/.test(str)) {
    str = applyCase(str, caseType);
  }
  setPalette(palette);
  const outputEl = document.getElementById('output-string');
  outputEl.style.fontFamily = font;
  outputEl.style.fontSize = fontSize;
  outputEl.style.letterSpacing = letterSpacing;
  outputEl.classList.remove('flash');
  void outputEl.offsetWidth; 
  outputEl.classList.add('flash');
  outputEl.textContent = str;
  document.getElementById('meta-length').textContent  = `length: ${length}`;
  document.getElementById('meta-case').textContent    = `case: ${caseType}`;
  document.getElementById('meta-charset').textContent = `charset: ${charsetName}`;
  const fontLabel = font.split(',')[0].replace(/'/g, '').trim();
  document.getElementById('meta-font').textContent    = `font: ${fontLabel}`;
  document.getElementById('output-box').style.borderStyle = borderStyle;
  document.getElementById('tagline').textContent = tagline;
  document.getElementById('logo').style.fontFamily = pick(FONTS);
}
function copyOutput() {
  const text = document.getElementById('output-string').textContent;
  if (text === '???') return;
  navigator.clipboard.writeText(text).then(() => {
    const toast = document.getElementById('copy-toast');
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1800);
  });
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('generate-btn').addEventListener('click', generate);
  document.getElementById('output-box').addEventListener('click', copyOutput);
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      generate();
    }
  });
  generate();
});
