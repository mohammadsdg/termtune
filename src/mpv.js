'use strict';
// Thin wrapper around mpv's JSON IPC. mpv does the decoding/output, we just remote-control it.

const { spawn, spawnSync } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

class Mpv extends EventEmitter {
  constructor({ bin = 'mpv' } = {}) {
    super();
    this.bin = bin;
    this.reqId = 0;
    this.pending = new Map();
    this.buf = '';
    this.sock = null;
    this.proc = null;
    this.sockPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\termtune-${process.pid}`
        : path.join(os.tmpdir(), `termtune-${process.pid}.sock`);
  }

  static available(bin = 'mpv') {
    const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
    return !r.error && r.status === 0;
  }

  start() {
    const extra = (process.env.TERMTUNE_MPV_ARGS || '').split(/\s+/).filter(Boolean);
    const args = [
      '--idle=yes',
      '--no-video',
      '--no-terminal',
      '--really-quiet',
      '--audio-display=no',
      '--force-window=no',
      '--ytdl=yes',
      `--input-ipc-server=${this.sockPath}`,
      ...extra,
    ];

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      this.proc = spawn(this.bin, args, { stdio: 'ignore' });
      this.proc.once('error', (err) => (settled ? this.emit('exit', err) : fail(err)));
      this.proc.once('exit', (code) => (settled ? this.emit('exit', code) : fail(new Error(`mpv exited (${code})`))));

      const deadline = Date.now() + 5000;
      const attempt = () => {
        if (settled) return;
        const sock = net.connect(this.sockPath);
        sock.once('connect', () => {
          if (settled) return sock.destroy();
          settled = true;
          this.sock = sock;
          this._wire();
          resolve();
        });
        sock.once('error', () => {
          sock.destroy();
          if (Date.now() > deadline) fail(new Error('timed out connecting to mpv'));
          else setTimeout(attempt, 40);
        });
      };
      attempt();
    });
  }

  _wire() {
    this.sock.setEncoding('utf8');
    this.sock.on('data', (chunk) => {
      this.buf += chunk;
      let nl;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line.trim()) this._handle(line);
      }
    });
    this.sock.on('error', () => {});
  }

  _handle(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.request_id != null && this.pending.has(msg.request_id)) {
      const { res, rej } = this.pending.get(msg.request_id);
      this.pending.delete(msg.request_id);
      if (msg.error === 'success') res(msg.data);
      else rej(new Error(msg.error));
      return;
    }
    switch (msg.event) {
      case 'property-change':
        this.emit('prop', msg.name, msg.data);
        break;
      case 'end-file':
        this.emit('end', { reason: msg.reason, error: msg.file_error });
        break;
      case 'file-loaded':
        this.emit('loaded');
        break;
    }
  }

  command(...args) {
    return new Promise((res, rej) => {
      if (!this.sock || this.sock.destroyed) return rej(new Error('mpv is not connected'));
      const id = ++this.reqId;
      this.pending.set(id, { res, rej });
      this.sock.write(JSON.stringify({ command: args, request_id: id }) + '\n');
    });
  }

  observe(...names) {
    names.forEach((n, i) => this.command('observe_property', 100 + i, n).catch(() => {}));
  }

  // Synchronous on purpose: safe to call from process 'exit' handlers.
  kill() {
    try {
      this.proc && this.proc.kill();
    } catch {}
    if (process.platform !== 'win32') {
      try {
        fs.rmSync(this.sockPath, { force: true });
      } catch {}
    }
  }
}

module.exports = { Mpv };
