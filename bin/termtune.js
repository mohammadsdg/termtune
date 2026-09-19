#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');
const pkg = require('../package.json');
const { Config } = require('../src/config');
const { scan, isUrl, expandHome } = require('../src/library');
const { Mpv } = require('../src/mpv');
const { Player } = require('../src/player');
const { UI, THEMES } = require('../src/ui');

const USAGE = `
termtune ${pkg.version} — a friendly terminal music player

Usage
  termtune [options] [folder | file | url ...]

  Give it folders/files the first time; they're remembered, so afterwards
  just run \`termtune\`. With no arguments and nothing saved it opens ~/Music.

Options
  -a, --autoplay        start playing right away
  -s, --shuffle         start with shuffle on
      --volume <0-100>  set the volume (remembered)
      --theme <name>    ${THEMES.map((t) => t.name).join(' | ')} (remembered)
      --no-mouse        don't capture the mouse
  -h, --help            show this help
  -v, --version         show version

Press ? inside the player for keyboard shortcuts.
`;

function die(msg) {
  process.stderr.write(msg.trimEnd() + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const a = { paths: [], mouse: true };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => (x.includes('=') ? x.split('=').slice(1).join('=') : argv[++i]);
    if (x === '-h' || x === '--help') a.help = true;
    else if (x === '-v' || x === '--version') a.version = true;
    else if (x === '-a' || x === '--autoplay') a.autoplay = true;
    else if (x === '-s' || x === '--shuffle') a.shuffle = true;
    else if (x === '--no-mouse') a.mouse = false;
    else if (x.startsWith('--volume')) a.volume = Number(val());
    else if (x.startsWith('--theme')) a.theme = val();
    else if (x.startsWith('-') && x.length > 1) die(`Unknown option: ${x}\n${USAGE}`);
    else a.paths.push(x);
  }
  return a;
}

const INSTALL_HELP = `
termtune needs mpv to play audio, and it wasn't found on your PATH.

  macOS    brew install mpv
  Debian   sudo apt install mpv
  Fedora   sudo dnf install mpv
  Arch     sudo pacman -S mpv
  Windows  winget install mpv   (or: scoop install mpv / choco install mpv)
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return process.stdout.write(USAGE);
  if (args.version) return process.stdout.write(pkg.version + '\n');
  if (!process.stdin.isTTY || !process.stdout.isTTY) die('termtune needs an interactive terminal.');

  const bin = process.env.TERMTUNE_MPV || 'mpv';
  if (!Mpv.available(bin)) die(INSTALL_HELP);

  const cfg = new Config();
  const saved = cfg.get('paths', []);
  const paths = args.paths.length ? args.paths : saved.length ? saved : [path.join(os.homedir(), 'Music')];

  process.stdout.write(`Scanning ${paths.join(', ')} …`);
  const tracks = await scan(paths);
  process.stdout.write('\r\x1b[K');
  if (!tracks.length) {
    die(`No audio files found in: ${paths.join(', ')}\nTry: termtune /path/to/your/music`);
  }
  if (args.paths.length) cfg.set('paths', paths.map((p) => (isUrl(p) ? p : path.resolve(expandHome(p)))));

  if (args.theme) {
    if (!THEMES.some((t) => t.name === args.theme)) die(`Unknown theme "${args.theme}". Choose: ${THEMES.map((t) => t.name).join(', ')}`);
    cfg.set('theme', args.theme);
  }
  if (Number.isFinite(args.volume)) cfg.set('volume', Math.max(0, Math.min(100, args.volume)));

  const mpv = new Mpv({ bin });
  try {
    await mpv.start();
  } catch (e) {
    die(`Couldn't start mpv: ${e.message}`);
  }

  const player = new Player(mpv, {
    volume: cfg.get('volume', 70),
    shuffle: args.shuffle || cfg.get('shuffle', false),
    repeat: cfg.get('repeat', 'off'),
  });
  await player.init();

  let closing = false;
  const ui = new UI({ player, tracks, config: cfg, mouse: args.mouse, onQuit: () => quit(0) });

  function quit(code = 0) {
    if (closing) return;
    closing = true;
    ui.stop();
    player.shutdown();
    cfg.flush();
    process.exit(code);
  }

  player.on('change', () => {
    cfg.set('volume', player.volume);
    cfg.set('shuffle', player.shuffle);
    cfg.set('repeat', player.repeat);
  });
  mpv.on('exit', () => {
    if (closing) return;
    closing = true;
    ui.stop();
    process.stderr.write('mpv exited unexpectedly.\n');
    process.exit(1);
  });
  process.on('SIGINT', () => quit(0));
  process.on('SIGTERM', () => quit(0));
  process.on('SIGHUP', () => quit(0));
  process.on('exit', () => {
    ui.stop();
    mpv.kill();
  });
  process.on('uncaughtException', (e) => {
    ui.stop();
    console.error(e);
    quit(1);
  });

  ui.start();
  if (args.autoplay) player.playQueue(tracks, 0);
}

main().catch((e) => die(String(e && e.stack ? e.stack : e)));
