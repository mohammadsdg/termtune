'use strict';
// Low-level terminal helpers: colors, text width, a tiny line builder and an input parser.

const env = process.env;

const TRUECOLOR =
  /truecolor|24bit/i.test(env.COLORTERM || '') ||
  ['iTerm.app', 'vscode', 'WezTerm', 'ghostty'].includes(env.TERM_PROGRAM) ||
  !!env.WT_SESSION ||
  /kitty|alacritty|foot/i.test(env.TERM || '');

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const ITALIC = '\x1b[3m';

function rgb256([r, g, b]) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const c = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * c(r) + 6 * c(g) + c(b);
}

const fg = (c) => (TRUECOLOR ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[38;5;${rgb256(c)}m`);
const bg = (c) => (TRUECOLOR ? `\x1b[48;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[48;5;${rgb256(c)}m`);
const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));

// ---------- text width (handles CJK / emoji roughly, good enough for track titles) ----------

function cw(cp) {
  if (cp === 0 || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f) return 0;
  if (cp < 0x1100) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

const clean = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ');

function strWidth(s) {
  let w = 0;
  for (const ch of s) w += cw(ch.codePointAt(0));
  return w;
}

// Hard clip to `max` columns (no ellipsis).
function clip(s, max) {
  if (max <= 0) return '';
  let out = '';
  let w = 0;
  for (const ch of s) {
    const c = cw(ch.codePointAt(0));
    if (w + c > max) {
      if (w < max) out += ' ';
      break;
    }
    out += ch;
    w += c;
  }
  return out;
}

// Clip to `max` columns and add an ellipsis if something was cut.
function truncate(s, max) {
  s = clean(s);
  if (max <= 0) return '';
  if (strWidth(s) <= max) return s;
  return clip(s, max - 1) + '…';
}

function pad(s, width) {
  s = truncate(s, width);
  return s + ' '.repeat(Math.max(0, width - strWidth(s)));
}

// ---------- line builder: tracks visible width so every row is exactly `width` columns ----------

class Line {
  constructor(width) {
    this.width = width;
    this.w = 0;
    this.s = '';
  }
  get room() {
    return this.width - this.w;
  }
  add(text, style = '') {
    text = clip(clean(text), this.room);
    if (!text) return this;
    this.w += strWidth(text);
    this.s += style + text + RESET;
    return this;
  }
  addGradient(text, c1, c2, extra = '') {
    const chars = [...text];
    chars.forEach((ch, i) => this.add(ch, extra + fg(mix(c1, c2, chars.length > 1 ? i / (chars.length - 1) : 0))));
    return this;
  }
  padTo(col, style = '') {
    const n = col - this.w;
    if (n > 0) this.add(' '.repeat(n), style);
    return this;
  }
  fill(style = '') {
    if (this.room > 0) this.add(' '.repeat(this.room), style);
    return this;
  }
  toString(fillStyle = '') {
    return this.fill(fillStyle).s;
  }
}

// ---------- input parsing (keys + SGR mouse) ----------

const CSI_NAMES = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
const TILDE_NAMES = { 1: 'home', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end' };

function parseInput(data) {
  const s = data.toString('utf8');
  const events = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const rest = s.slice(i);
      let m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
      if (m) {
        events.push({ type: 'mouse', button: +m[1], x: +m[2], y: +m[3], down: m[4] === 'M' });
        i += m[0].length;
        continue;
      }
      m = /^\x1b\[(\d*)(?:;(\d+))?([A-Za-z~])/.exec(rest);
      if (m) {
        const name = m[3] === '~' ? TILDE_NAMES[m[1]] : CSI_NAMES[m[3]];
        const mod = m[2] ? +m[2] : 1;
        if (name) events.push({ type: 'key', name, shift: mod === 2, ctrl: mod === 5 });
        i += m[0].length;
        continue;
      }
      m = /^\x1bO([A-Za-z])/.exec(rest);
      if (m) {
        if (CSI_NAMES[m[1]]) events.push({ type: 'key', name: CSI_NAMES[m[1]] });
        i += m[0].length;
        continue;
      }
      events.push({ type: 'key', name: 'escape' });
      i += 1;
      continue;
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (ch === '\r' || ch === '\n') events.push({ type: 'key', name: 'enter' });
    else if (ch === '\t') events.push({ type: 'key', name: 'tab' });
    else if (ch === '\x7f' || ch === '\b') events.push({ type: 'key', name: 'backspace' });
    else if (ch === ' ') events.push({ type: 'key', name: 'space', ch });
    else if (cp < 32) events.push({ type: 'key', name: String.fromCharCode(cp + 96), ctrl: true });
    else events.push({ type: 'key', name: ch, ch });
  }
  return events;
}

module.exports = {
  TRUECOLOR, RESET, BOLD, ITALIC, fg, bg, mix,
  strWidth, clip, truncate, pad, clean, Line, parseInput,
};
