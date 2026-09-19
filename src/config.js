'use strict';
// Tiny JSON settings store: ~/.config/termtune/state.json (or %APPDATA%\termtune on Windows).

const fs = require('fs');
const os = require('os');
const path = require('path');

function configDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'termtune');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'termtune');
}

class Config {
  constructor() {
    this.file = path.join(configDir(), 'state.json');
    this.data = {};
    this.timer = null;
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch {}
  }
  get(key, fallback) {
    return this.data[key] === undefined ? fallback : this.data[key];
  }
  set(key, value) {
    if (JSON.stringify(this.data[key]) === JSON.stringify(value)) return;
    this.data[key] = value;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
    if (this.timer.unref) this.timer.unref();
  }
  flush() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch {}
  }
}

module.exports = { Config };
