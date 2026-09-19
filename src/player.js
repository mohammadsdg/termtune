'use strict';
// Playback state + queue logic. The UI reads its fields and calls its methods; it never talks to mpv directly.

const EventEmitter = require('events');
const path = require('path');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function shuffled(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class Player extends EventEmitter {
  constructor(mpv, { volume = 70, shuffle = false, repeat = 'off' } = {}) {
    super();
    this.mpv = mpv;
    this.volume = clamp(Math.round(volume), 0, 100);
    this.muted = false;
    this.shuffle = shuffle;
    this.repeat = repeat; // 'off' | 'all' | 'one'
    this.status = 'stopped'; // 'stopped' | 'playing' | 'paused'
    this.position = 0;
    this.duration = 0;
    this.current = null;
    this.queue = [];
    this.order = [];
    this.pos = -1;
    this.failures = 0;
  }

  async init() {
    await this.mpv.command('set_property', 'volume', this.volume);
    this.mpv.on('prop', (n, v) => this._onProp(n, v));
    this.mpv.on('end', (e) => this._onEnd(e));
    this.mpv.on('loaded', () => (this.failures = 0));
    this.mpv.observe('time-pos', 'duration', 'pause', 'volume', 'mute', 'metadata', 'media-title');
  }

  // ---------- mpv -> state ----------

  _onProp(name, v) {
    switch (name) {
      case 'time-pos':
        this.position = typeof v === 'number' ? v : 0;
        return; // high-frequency; the UI polls it
      case 'duration':
        this.duration = typeof v === 'number' ? v : 0;
        break;
      case 'pause':
        if (this.status !== 'stopped') this.status = v ? 'paused' : 'playing';
        break;
      case 'volume':
        if (typeof v === 'number') this.volume = Math.round(v);
        break;
      case 'mute':
        this.muted = !!v;
        break;
      case 'metadata':
        this._applyTags(v);
        break;
      case 'media-title':
        if (this.current && this.current.url && !this.current.tagged && typeof v === 'string') this.current.title = v;
        break;
    }
    this.emit('change');
  }

  _applyTags(md) {
    const t = this.current;
    if (!t || !md || typeof md !== 'object') return;
    const tags = {};
    for (const [k, v] of Object.entries(md)) tags[k.toLowerCase()] = String(v).trim();
    if (tags.title) t.title = tags.title;
    if (tags.artist || tags.album_artist) t.artist = tags.artist || tags.album_artist;
    if (tags.album) t.album = tags.album;
    if (tags.title || tags.artist) t.tagged = true;
    t._hay = null; // invalidate search cache
  }

  _onEnd({ reason, error }) {
    if (reason === 'error') {
      this.failures++;
      this.emit('error', `Can't play ${this.current ? path.basename(this.current.path) : 'track'}${error ? ` (${error})` : ''}`);
      if (this.failures < Math.min(this.queue.length, 5)) return this.next(true);
      return this._stop();
    }
    if (reason !== 'eof') return; // 'stop' etc. = we replaced the file ourselves
    if (this.repeat === 'one') return this._loadCurrent();
    this.next(true);
  }

  _stop() {
    this.status = 'stopped';
    this.position = 0;
    this.duration = 0;
    this.emit('change');
  }

  // ---------- queue ----------

  _buildOrder(startIdx) {
    const n = this.queue.length;
    const idx = Array.from({ length: n }, (_, i) => i);
    if (this.shuffle) {
      const rest = shuffled(idx.filter((i) => i !== startIdx));
      this.order = startIdx >= 0 ? [startIdx, ...rest] : rest;
      this.pos = 0;
    } else {
      this.order = idx;
      this.pos = startIdx;
    }
  }

  playQueue(tracks, startIdx = 0) {
    if (!tracks.length) return;
    this.queue = tracks.slice();
    this._buildOrder(clamp(startIdx, 0, tracks.length - 1));
    this._loadCurrent();
  }

  _loadCurrent() {
    const track = this.queue[this.order[this.pos]];
    if (!track) return this._stop();
    this.current = track;
    this.status = 'playing';
    this.position = 0;
    this.duration = 0;
    this.mpv.command('loadfile', track.path, 'replace').catch((e) => this.emit('error', e.message));
    this.mpv.command('set_property', 'pause', false).catch(() => {});
    this.emit('change');
    this.emit('track', track);
  }

  next(auto = false) {
    if (!this.queue.length) return;
    let p = this.pos + 1;
    if (p >= this.order.length) {
      if (this.repeat === 'all') {
        if (this.shuffle) this._buildOrder(-1);
        p = 0;
      } else if (auto) return this._stop();
      else return;
    }
    this.pos = p;
    this._loadCurrent();
  }

  prev() {
    if (!this.queue.length) return;
    // Like most players: restart the track if we're past the first few seconds.
    if (this.position > 3) return this.seekAbs(0);
    if (this.pos > 0) {
      this.pos -= 1;
      return this._loadCurrent();
    }
    if (this.repeat === 'all') {
      this.pos = this.order.length - 1;
      return this._loadCurrent();
    }
    this.seekAbs(0);
  }

  peekNext() {
    if (!this.queue.length) return null;
    if (this.repeat === 'one') return this.current;
    if (this.pos + 1 < this.order.length) return this.queue[this.order[this.pos + 1]];
    return this.repeat === 'all' ? this.queue[this.order[0]] : null;
  }

  // ---------- transport ----------

  toggle() {
    if (this.status === 'stopped') {
      if (!this.current) return false; // nothing to resume; caller decides what to play
      this._loadCurrent();
      return true;
    }
    this.mpv.command('cycle', 'pause').catch(() => {});
    return true;
  }

  seek(sec) {
    if (this.status !== 'stopped') this.mpv.command('seek', sec, 'relative').catch(() => {});
  }

  seekAbs(sec) {
    if (this.status !== 'stopped') this.mpv.command('seek', Math.max(0, sec), 'absolute').catch(() => {});
  }

  setVolume(v) {
    this.volume = clamp(Math.round(v), 0, 100);
    this.mpv.command('set_property', 'volume', this.volume).catch(() => {});
    if (this.muted && v > 0) this.toggleMute();
    this.emit('change');
  }

  toggleMute() {
    this.muted = !this.muted;
    this.mpv.command('set_property', 'mute', this.muted).catch(() => {});
    this.emit('change');
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.queue.length && this.pos >= 0) {
      const qi = this.order[this.pos];
      this._buildOrder(qi);
    }
    this.emit('change');
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this.emit('change');
  }

  shutdown() {
    this.mpv.kill();
  }
}

module.exports = { Player };
