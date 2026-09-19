'use strict';
// Finds audio files and reads their tags, falling back to the file name and folder layout.

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const AUDIO = new Set([
  '.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.wav', '.wma',
  '.aiff', '.aif', '.ape', '.wv', '.mka', '.webm', '.mp2', '.alac',
]);
const MAX_DEPTH = 12;
const TAG_READERS = 8;
const isUrl = (s) => /^https?:\/\//i.test(s);

let metadataModule;
async function readTags(track) {
  try {
    metadataModule ||= import('music-metadata');
    const { parseFile } = await metadataModule;
    const { common = {} } = await parseFile(track.path, { skipCovers: true, duration: false });
    const title = typeof common.title === 'string' ? common.title.trim() : '';
    const artistValue = common.artist || common.albumartist;
    const artist = typeof artistValue === 'string' ? artistValue.trim() : '';
    const album = typeof common.album === 'string' ? common.album.trim() : '';
    if (title) track.title = title;
    if (artist) track.artist = artist;
    if (album) track.album = album;
    track.tagged = !!(title || artist || album);
  } catch {
    // Broken/unsupported files still get the useful filename-based values.
  }
}

async function readAllTags(tracks) {
  const local = tracks.filter((track) => !track.url);
  let next = 0;
  async function worker() {
    while (next < local.length) {
      const track = local[next++];
      await readTags(track);
    }
  }
  await Promise.all(Array.from({ length: Math.min(TAG_READERS, local.length) }, worker));
}

function expandHome(p) {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p;
}

function makeTrack(file, root) {
  const rel = path.relative(root, file).split(path.sep);
  let base = path.basename(file, path.extname(file));
  base = base.replace(/^\s*(?:\d{1,3}\s*[-._)]\s*|0\d\s+)/, ''); // "01 - ", "02. ", "03_", "04 "
  let artist = '';
  let title = base;
  const parts = base.split(' - ');
  if (parts.length >= 2) {
    artist = parts[0].trim();
    title = parts.slice(1).join(' - ').trim();
  }
  const album = rel.length >= 2 ? rel[rel.length - 2] : '';
  if (!artist && rel.length >= 3) artist = rel[rel.length - 3];
  return { path: file, title: title || base, artist, album, tagged: false };
}

async function walk(dir, root, out, depth) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const st = await fsp.stat(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) await walk(full, root, out, depth + 1);
    else if (isFile && AUDIO.has(path.extname(e.name).toLowerCase())) out.push(makeTrack(full, root));
  }
}

async function scan(inputs) {
  const tracks = [];
  for (const raw of inputs) {
    if (isUrl(raw)) {
      tracks.push({ path: raw, title: raw, artist: '', album: '', tagged: false, url: true });
      continue;
    }
    const abs = path.resolve(expandHome(raw));
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) await walk(abs, abs, tracks, 0);
    else if (AUDIO.has(path.extname(abs).toLowerCase())) tracks.push(makeTrack(abs, path.dirname(abs)));
  }
  // De-dupe (overlapping folders) and sort naturally by path.
  const seen = new Set();
  const result = tracks
    .filter((t) => (seen.has(t.path) ? false : seen.add(t.path)))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  await readAllTags(result);
  return result;
}

module.exports = { scan, isUrl, expandHome };
