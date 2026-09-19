'use strict';

const path = require('path');
const { RESET, BOLD, ITALIC, fg, bg, mix, strWidth, pad, truncate, Line, parseInput } = require('./term');

const THEMES = [
  { name: 'aurora', accent: [94, 234, 212], accent2: [167, 139, 250], text: [226, 232, 240], muted: [148, 163, 184], dim: [71, 85, 105], bar: [30, 41, 59], warn: [251, 146, 60] },
  { name: 'sunset', accent: [251, 146, 60], accent2: [244, 114, 182], text: [254, 240, 220], muted: [190, 160, 150], dim: [100, 80, 80], bar: [45, 30, 36], warn: [250, 204, 21] },
  { name: 'forest', accent: [134, 239, 172], accent2: [250, 204, 21], text: [225, 240, 228], muted: [150, 175, 155], dim: [70, 95, 78], bar: [25, 40, 32], warn: [251, 146, 60] },
  { name: 'ocean', accent: [96, 165, 250], accent2: [34, 211, 238], text: [224, 236, 250], muted: [140, 165, 195], dim: [65, 85, 115], bar: [22, 35, 55], warn: [251, 191, 36] },
  { name: 'mono', accent: [255, 255, 255], accent2: [150, 150, 150], text: [225, 225, 225], muted: [150, 150, 150], dim: [85, 85, 85], bar: [38, 38, 38], warn: [255, 255, 255] },
];

const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const N_BARS = 32;

const HELP = [
  ['↑ ↓  j k', 'move'],
  ['PgUp PgDn', 'move by page'],
  ['g  G', 'top / bottom'],
  ['enter', 'play selected (queue = current list)'],
  ['space', 'pause / resume'],
  ['n  p', 'next / previous (p restarts after 3s)'],
  ['← →  h l', 'seek 5s  (shift: 30s)'],
  ['+  -', 'volume up / down'],
  ['m', 'mute'],
  ['s', 'shuffle'],
  ['r', 'repeat: off → all → one'],
  ['/', 'search (enter plays the top match)'],
  ['esc', 'clear search'],
  ['c', 'jump to the playing track'],
  ['t', 'next colour theme'],
  ['v', 'toggle visualizer'],
  ['q', 'quit'],
];

const p2 = (n) => String(n).padStart(2, '0');
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${p2(m)}:${p2(s % 60)}` : `${p2(m)}:${p2(s % 60)}`;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function hay(t) {
  if (!t._hay) t._hay = `${t.title} ${t.artist} ${t.album} ${path.basename(t.path)}`.toLowerCase();
  return t._hay;
}

class UI {
  constructor({ player, tracks, config, mouse = true, onQuit }) {
    this.p = player;
    this.all = tracks;
    this.view = tracks;
    this.cfg = config;
    this.useMouse = mouse;
    this.onQuit = onQuit;

    const ti = THEMES.findIndex((t) => t.name === config.get('theme'));
    this.themeIdx = ti >= 0 ? ti : 0;
    this.showViz = config.get('viz', true);

    this.filter = '';
    this.searching = false;
    this.showHelp = false;
    this.cursor = 0;
    this.top = 0;
    this.listRows = 10;

    this.bars = new Array(N_BARS).fill(0);
    this.phase = 0;
    this.last = Date.now();
    this.prev = [];
    this.size = '';
    this.hit = {};
    this.flash = null;
    this.lastClick = { t: 0, i: -1 };
    this.title = '';
    this.started = false;
  }

  // ---------- lifecycle ----------

  start() {
    const out = process.stdout;
    out.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J');
    if (this.useMouse) out.write('\x1b[?1000h\x1b[?1006h');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    this._onData = (d) => this.onData(d);
    this._onResize = () => this.render();
    process.stdin.on('data', this._onData);
    out.on('resize', this._onResize);
    this.p.on('error', (msg) => this.toast(msg));
    this.timer = setInterval(() => this.tick(), 66);
    this.started = true;
    this.render();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    clearInterval(this.timer);
    process.stdin.off('data', this._onData);
    process.stdout.off('resize', this._onResize);
    try {
      process.stdin.setRawMode(false);
    } catch {}
    process.stdin.pause();
    process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[?1049l\x1b]0;\x07');
  }

  toast(text) {
    this.flash = { text, until: Date.now() + 4000 };
  }

  // ---------- input ----------

  onData(data) {
    for (const ev of parseInput(data)) {
      if (ev.type === 'mouse') this.onMouse(ev);
      else this.onKey(ev);
    }
    this.render();
  }

  onKey(k) {
    if (k.ctrl && k.name === 'c') return this.onQuit();
    if (this.showHelp) {
      this.showHelp = false;
      return;
    }
    if (this.searching) return this.onSearchKey(k);

    const p = this.p;
    switch (k.name) {
      case 'q': return this.onQuit();
      case 'up': case 'k': return this.move(-1);
      case 'down': case 'j': return this.move(1);
      case 'pageup': return this.move(-this.listRows + 1);
      case 'pagedown': return this.move(this.listRows - 1);
      case 'home': case 'g': return this.move(-Infinity);
      case 'end': case 'G': return this.move(Infinity);
      case 'enter': return this.playSelected();
      case 'space':
        if (!p.toggle()) this.playSelected();
        return;
      case 'n': case '>': return p.next();
      case 'p': case '<': return p.prev();
      case 'left': case 'h': return p.seek(k.shift ? -30 : -5);
      case 'right': case 'l': return p.seek(k.shift ? 30 : 5);
      case 'H': return p.seek(-30);
      case 'L': return p.seek(30);
      case '+': case '=': return p.setVolume(p.volume + 5);
      case '-': case '_': return p.setVolume(p.volume - 5);
      case 'm': return p.toggleMute();
      case 's': return p.toggleShuffle();
      case 'r': return p.cycleRepeat();
      case '/':
        this.searching = true;
        return;
      case 'escape':
        if (this.filter) {
          this.filter = '';
          this.applyFilter();
        }
        return;
      case 'c': return this.jumpToCurrent();
      case 't':
        this.themeIdx = (this.themeIdx + 1) % THEMES.length;
        this.cfg.set('theme', THEMES[this.themeIdx].name);
        return;
      case 'v':
        this.showViz = !this.showViz;
        this.cfg.set('viz', this.showViz);
        return;
      case '?': this.showHelp = true; return;
    }
  }

  onSearchKey(k) {
    switch (k.name) {
      case 'escape':
        this.filter = '';
        this.searching = false;
        return this.applyFilter();
      case 'enter':
        this.searching = false;
        return this.playSelected();
      case 'backspace': {
        if (!this.filter) {
          this.searching = false;
          return;
        }
        this.filter = [...this.filter].slice(0, -1).join('');
        return this.applyFilter();
      }
      case 'up': return this.move(-1);
      case 'down': return this.move(1);
      case 'pageup': return this.move(-this.listRows + 1);
      case 'pagedown': return this.move(this.listRows - 1);
    }
    if (k.ctrl && k.name === 'u') {
      this.filter = '';
      return this.applyFilter();
    }
    if (k.ch && !k.ctrl) {
      this.filter += k.ch;
      this.applyFilter();
    }
  }

  onMouse(e) {
    const b = e.button & ~28; // strip modifier bits
    if (b === 64) return this.move(-3);
    if (b === 65) return this.move(3);
    if (b !== 0 || !e.down) return;

    const { listY0, bar } = this.hit;
    if (this.showHelp) {
      this.showHelp = false;
      return;
    }
    if (listY0 && e.y >= listY0 && e.y < listY0 + this.listRows) {
      const idx = this.top + (e.y - listY0);
      if (idx >= this.view.length) return;
      const now = Date.now();
      if (this.lastClick.i === idx && now - this.lastClick.t < 400) {
        this.cursor = idx;
        this.playSelected();
        this.lastClick = { t: 0, i: -1 };
      } else {
        this.cursor = idx;
        this.lastClick = { t: now, i: idx };
      }
    } else if (bar && e.y === bar.row && e.x >= bar.x0 && e.x < bar.x0 + bar.w && this.p.duration > 0) {
      this.p.seekAbs(((e.x - bar.x0 + 0.5) / bar.w) * this.p.duration);
    }
  }

  // ---------- list state ----------

  move(d) {
    if (!this.view.length) return;
    this.cursor = clamp(this.cursor + (d === Infinity ? this.view.length : d === -Infinity ? -this.view.length : d), 0, this.view.length - 1);
    this.ensureVisible();
  }

  ensureVisible() {
    const rows = this.listRows;
    if (this.cursor < this.top) this.top = this.cursor;
    if (this.cursor >= this.top + rows) this.top = this.cursor - rows + 1;
    this.top = clamp(this.top, 0, Math.max(0, this.view.length - rows));
  }

  applyFilter() {
    const cur = this.view[this.cursor];
    const terms = this.filter.toLowerCase().split(/\s+/).filter(Boolean);
    this.view = terms.length ? this.all.filter((t) => terms.every((x) => hay(t).includes(x))) : this.all;
    const idx = cur ? this.view.indexOf(cur) : -1;
    this.cursor = idx >= 0 ? idx : 0;
    this.top = 0;
    this.ensureVisible();
  }

  playSelected() {
    if (this.view.length) this.p.playQueue(this.view, this.cursor);
  }

  jumpToCurrent() {
    const t = this.p.current;
    if (!t) return;
    let idx = this.view.indexOf(t);
    if (idx < 0) {
      this.filter = '';
      this.applyFilter();
      idx = this.view.indexOf(t);
    }
    if (idx < 0) return;
    this.cursor = idx;
    this.top = clamp(idx - Math.floor(this.listRows / 2), 0, Math.max(0, this.view.length - this.listRows));
  }

  // ---------- animation ----------

  tick() {
    const now = Date.now();
    const dt = Math.min(0.2, (now - this.last) / 1000);
    this.last = now;
    this.stepBars(dt, this.p.status === 'playing');
    this.updateTitle();
    this.render();
  }

  // Decorative only: an animated equaliser-style effect, not a real spectrum analyser.
  stepBars(dt, playing) {
    this.phase += dt;
    const t = this.phase;
    for (let i = 0; i < N_BARS; i++) {
      let target = 0;
      if (playing) {
        const x = i / N_BARS;
        target = 0.36 + 0.26 * Math.sin(t * 3.1 + i * 0.55) + 0.2 * Math.sin(t * 5.3 - i * 1.3) + 0.12 * Math.sin(t * 9.7 + i * 2.1);
        target *= 1 - 0.5 * x;
        target *= 0.72 + 0.28 * Math.max(0, Math.sin(t * 4.2));
        target += (Math.random() - 0.5) * 0.16;
      }
      target = clamp(target, 0, 1);
      const rate = target > this.bars[i] ? 0.6 : 0.16;
      this.bars[i] += (target - this.bars[i]) * rate;
      if (this.bars[i] < 0.01) this.bars[i] = 0;
    }
  }

  updateTitle() {
    const t = this.p.current;
    const s = t && this.p.status !== 'stopped' ? `♪ ${t.title}${t.artist ? ' — ' + t.artist : ''}` : 'termtune';
    if (s !== this.title) {
      this.title = s;
      process.stdout.write(`\x1b]0;${s.replace(/[\x00-\x1f\x07]/g, '')}\x07`);
    }
  }

  // ---------- rendering ----------

  render() {
    if (!this.started) return;
    const W = process.stdout.columns || 80;
    const H = process.stdout.rows || 24;
    const th = THEMES[this.themeIdx];
    let lines;
    if (W < 40 || H < 12) {
      lines = Array.from({ length: H }, () => new Line(W).toString());
      lines[Math.floor(H / 2)] = new Line(W).add(' Terminal too small', fg(th.warn)).toString();
    } else {
      lines = this.compose(W, H, th);
    }

    let out = '';
    const size = `${W}x${H}`;
    if (size !== this.size) {
      this.size = size;
      this.prev = [];
      out += '\x1b[2J';
    }
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== this.prev[i]) out += `\x1b[${i + 1};1H${lines[i]}`;
    }
    this.prev = lines;
    if (out) process.stdout.write(out);
  }

  compose(W, H, th) {
    const listRows = H - 8;
    this.listRows = listRows;
    this.ensureVisible();
    this.hit = { listY0: 3 };
    const lines = [this.headerLine(W, th), this.searchLine(W, th)];
    lines.push(...(this.showHelp ? this.helpLines(W, th, listRows) : this.listLines(W, th, listRows)));

    const sep = new Line(W).add(' Now playing ', fg(th.muted) + BOLD).add('─'.repeat(W), fg(th.dim));
    lines.push(sep.toString());
    lines.push(...this.nowPlayingLines(W, th));
    lines.push(this.progressLine(W, H, th));
    lines.push(this.hintLine(W, th));
    return lines;
  }

  headerLine(W, th) {
    const p = this.p;
    const L = new Line(W);
    L.add(' ♫ ', fg(th.accent2) + BOLD).addGradient('termtune', th.accent, th.accent2, BOLD);

    const segs = [];
    if (p.status === 'playing') segs.push(['▶ playing', fg(th.accent) + BOLD]);
    else if (p.status === 'paused') segs.push(['❚❚ paused', fg(th.warn) + BOLD]);
    else segs.push(['■ stopped', fg(th.muted)]);

    const filled = Math.round((p.volume / 100) * 8);
    const volText = p.muted ? 'vol muted' : `vol ${'█'.repeat(filled)}${'░'.repeat(8 - filled)} ${p.volume}%`;
    segs.push([volText, p.muted ? fg(th.warn) : fg(th.muted)]);
    segs.push([`⇄ ${p.shuffle ? 'on' : 'off'}`, p.shuffle ? fg(th.accent) + BOLD : fg(th.dim)]);
    const rep = { off: '↻ off', all: '↻ all', one: '↻ one' }[p.repeat];
    segs.push([rep, p.repeat !== 'off' ? fg(th.accent) + BOLD : fg(th.dim)]);

    const budget = W - L.w - 3;
    const width = (s) => s.reduce((a, [t]) => a + strWidth(t), 0) + (s.length - 1) * 3;
    while (segs.length > 1 && width(segs) > budget) segs.pop();
    let col = W - width(segs) - 1;
    L.padTo(col);
    segs.forEach(([t, st], i) => {
      if (i) L.add('   ');
      L.add(t, st);
    });
    return L.toString();
  }

  searchLine(W, th) {
    const L = new Line(W);
    const style = bg(th.bar);
    if (this.searching || this.filter) {
      L.add(' / ', fg(th.accent) + BOLD + style);
      L.add(this.filter, fg(th.text) + style);
      if (this.searching) L.add('▏', fg(th.accent) + style);
    } else {
      L.add(' Library', fg(th.muted) + BOLD + style);
    }
    const count = this.filter ? `${this.view.length} of ${this.all.length} tracks ` : `${this.all.length} tracks `;
    L.padTo(W - strWidth(count), style);
    L.add(count, fg(th.muted) + style);
    return L.toString(style);
  }

  listLines(W, th, rows) {
    const p = this.p;
    const out = [];
    const total = this.view.length;
    const inner = W - 1;
    const avail = inner - 4;

    let wT = avail, wA = 0, wB = 0;
    if (W >= 100) {
      wT = Math.floor((avail - 4) * 0.45);
      wA = Math.floor((avail - 4) * 0.28);
      wB = avail - 4 - wT - wA;
    } else if (W >= 64) {
      wT = Math.floor((avail - 2) * 0.62);
      wA = avail - 2 - wT;
    }

    const selBg = bg(mix(th.bar, th.accent, 0.16));
    const faint = mix(th.muted, th.dim, 0.5);

    // scrollbar geometry
    let thumbLen = 0, thumbPos = 0;
    if (total > rows) {
      thumbLen = Math.max(1, Math.round((rows * rows) / total));
      thumbPos = Math.round((this.top / (total - rows)) * (rows - thumbLen));
    }

    for (let i = 0; i < rows; i++) {
      const L = new Line(W);
      const idx = this.top + i;
      const t = this.view[idx];
      if (t) {
        const isCur = idx === this.cursor;
        const isLast = p.current === t;
        const b = isCur ? selBg : '';
        const marker = isLast ? (p.status === 'paused' ? '❚' : p.status === 'playing' ? '▶' : '■') : isCur ? '›' : ' ';
        L.add(' ', b);
        L.add(marker, (isLast ? fg(th.accent) + BOLD : fg(th.accent2)) + b);
        L.add(' ', b);
        L.add(pad(t.title, wT), (isLast ? fg(th.accent) + BOLD : isCur ? fg(th.text) + BOLD : fg(th.text)) + b);
        if (wA) {
          L.add('  ', b);
          L.add(pad(t.artist, wA), (isLast ? fg(th.accent2) : fg(th.muted)) + b);
        }
        if (wB) {
          L.add('  ', b);
          L.add(pad(t.album, wB), fg(faint) + b);
        }
        L.fill(b);
      } else if (total === 0 && i === Math.floor(rows / 2)) {
        const msg = this.filter ? 'No matches' : 'No tracks';
        L.padTo(Math.floor((inner - msg.length) / 2)).add(msg, fg(th.muted) + ITALIC);
      }
      L.padTo(inner);
      if (thumbLen) L.add(i >= thumbPos && i < thumbPos + thumbLen ? '┃' : '│', fg(i >= thumbPos && i < thumbPos + thumbLen ? th.accent2 : th.dim));
      out.push(L.toString());
    }
    return out;
  }

  helpLines(W, th, rows) {
    const out = [];
    const keyW = 14;
    const startRow = Math.max(0, Math.floor((rows - (HELP.length + 2)) / 2));
    for (let i = 0; i < rows; i++) {
      const L = new Line(W);
      const h = HELP[i - startRow - 1];
      if (i === startRow) L.add('   Keyboard shortcuts', fg(th.accent) + BOLD);
      else if (h) L.add('   ').add(pad(h[0], keyW), fg(th.accent2) + BOLD).add(h[1], fg(th.text));
      else if (i === startRow + HELP.length + 2) L.add('   Mouse: click to select, double-click to play, click the bar to seek, scroll to browse', fg(th.muted));
      out.push(L.toString());
    }
    return out;
  }

  nowPlayingLines(W, th) {
    const p = this.p;
    const t = p.current;
    const vw = this.showViz && W >= 64 ? Math.min(28, Math.floor(W * 0.32)) : 0;
    const lines = [new Line(W), new Line(W), new Line(W)];

    for (let r = 0; r < 3; r++) {
      const L = lines[r];
      L.add(' ');
      if (vw) {
        for (let x = 0; x < vw; x++) {
          const lvl = clamp(Math.round(this.bars[x] * 24) - (2 - r) * 8, 0, 8);
          const c = mix(th.accent, th.accent2, x / (vw - 1));
          if (lvl === 0 && r === 2) L.add('▁', fg(mix(th.dim, th.bar, 0.3)));
          else L.add(BLOCKS[lvl], fg(c));
        }
        L.add('   ');
      }
    }

    const room = W - lines[0].w - 1;
    if (t) {
      const sub = [t.artist, t.album].filter(Boolean).join('  ·  ') || path.basename(path.dirname(t.path));
      lines[0].add(truncate(t.title, room), fg(th.text) + BOLD);
      lines[1].add(truncate(sub, room), fg(th.muted));
      const nx = p.peekNext();
      if (nx) {
        lines[2].add('next ', fg(th.dim)).add('▸ ', fg(th.accent2)).add(truncate(nx.title + (nx.artist ? ' — ' + nx.artist : ''), room - 7), fg(th.dim));
      }
    } else {
      lines[0].add('Nothing playing', fg(th.muted) + ITALIC);
      lines[1].add('Pick a track and press enter', fg(th.dim));
    }
    return lines.map((l) => l.toString());
  }

  progressLine(W, H, th) {
    const p = this.p;
    const pos = p.status === 'stopped' ? 0 : p.position;
    const dur = p.duration;
    const L = new Line(W);
    const left = ' ' + fmtTime(pos) + ' ';
    const right = ' ' + (dur ? fmtTime(dur) : '--:--') + ' ';
    L.add(left, fg(th.muted));
    const bw = Math.max(4, W - strWidth(left) - strWidth(right) - 1);
    this.hit.bar = { row: H - 1, x0: L.w + 1, w: bw };

    const frac = dur > 0 ? clamp(pos / dur, 0, 1) : 0;
    const f = Math.min(bw - 1, Math.floor(frac * bw));
    for (let i = 0; i < bw; i++) {
      if (i < f) L.add('━', fg(mix(th.accent, th.accent2, i / bw)));
      else if (i === f && dur > 0) L.add('●', fg(mix(th.accent, th.accent2, i / bw)) + BOLD);
      else L.add('─', fg(th.dim));
    }
    L.add(right, fg(th.muted));
    return L.toString();
  }

  hintLine(W, th) {
    const L = new Line(W);
    if (this.flash && Date.now() < this.flash.until) {
      L.add(' ⚠ ' + this.flash.text, fg(th.warn));
      return L.toString();
    }
    const hints = this.searching
      ? [['enter', 'play'], ['esc', 'clear'], ['↑↓', 'move'], ['ctrl-u', 'wipe']]
      : [['space', 'play/pause'], ['enter', 'play'], ['n/p', 'skip'], ['←/→', 'seek'], ['+/-', 'volume'], ['s', 'shuffle'], ['r', 'repeat'], ['/', 'search'], ['t', 'theme'], ['?', 'help'], ['q', 'quit']];
    L.add(' ');
    for (const [k, d] of hints) {
      if (L.w + strWidth(k) + 1 + strWidth(d) + 2 > W) break;
      L.add(k, fg(th.accent2) + BOLD).add(' ' + d + '  ', fg(th.dim));
    }
    return L.toString();
  }
}

module.exports = { UI, THEMES };
