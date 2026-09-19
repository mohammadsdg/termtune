# ♫ termtune

Just A friendly terminal music player written in Node.js.
It draws its own UI and uses [mpv](https://mpv.io) as the audio engine,
so it plays practically every format (mp3, flac, ogg, opus, m4a, wav, …) and even URLs.

Built it cause i was tired of leaving terminal to listen and change my music.

```
 ♫ termtune                                        ▶ playing   vol ██████░░ 70%   ⇄ off   ↻ off
 Library                                                                            20 tracks
   Ignition                       Nova Drift                 Neon Skies
 ▶ Afterglow                      Nova Drift                 Neon Skies
   Low Orbit                      Nova Drift                 Neon Skies
   ...
 Now playing ─────────────────────────────────────────────────────────────────────────────────
  ▂▆█▃▂        ▅▂ ▁▂             Afterglow
 ▇███████▇▄▂▇██████▅▂▂          Nova Drift  ·  Neon Skies
 ██████████████████████████     next ▸ Low Orbit — Nova Drift
 01:12 ━━━━━━━━━━━━━━●───────────────────────────────────────────────────────────────── 04:03
 space play/pause  enter play  n/p skip  ←/→ seek  +/- volume  s shuffle  r repeat  / search
```

## Install

You need **Node.js 18+** and **mpv**:

| OS      | Install mpv                                    |
|---------|------------------------------------------------|
| Debian/Ubuntu | `sudo apt install mpv`                   |
| Fedora  | `sudo dnf install mpv`                         |
| Arch    | `sudo pacman -S mpv`                           |

Then, from this folder:

```sh
node bin/termtune.js ~/Music        # try it out
npm link                            # optional: gives you a global `termtune` command
```

## Usage

```sh
termtune ~/Music                    # folders, files and http(s) URLs can be mixed
termtune                            # afterwards: reuses the last folders you gave it
termtune -a -s ~/Music/Jazz         # autoplay + shuffle
termtune --theme sunset --volume 60
```

Options: `-a/--autoplay`, `-s/--shuffle`, `--volume <0-100>`, `--theme <aurora|sunset|forest|ocean|mono>`, `--no-mouse`, `-h`, `-v`.

Your folders, volume, shuffle/repeat, theme and visualizer setting are remembered in
`~/.config/termtune/state.json` (`%APPDATA%\termtune` on Windows).

## Keys

| Key | Action |
|-----|--------|
| `↑ ↓` / `j k` | move · `PgUp/PgDn` page · `g` / `G` top / bottom |
| `enter` | play the selected track (the queue is whatever list you're looking at) |
| `space` | pause / resume (replays the current track if it had finished) |
| `n` / `p` | next / previous (`p` restarts the track if you're >3s in) |
| `← →` / `h l` | seek ±5s · hold `shift` for ±30s |
| `+` / `-` · `m` | volume · mute |
| `s` · `r` | shuffle · repeat (off → all → one) |
| `/` | search — type to filter by title/artist/album/file name, `enter` plays the top match, `esc` clears |
| `c` | jump to the playing track |
| `t` · `v` | cycle colour theme · toggle the visualizer |
| `?` | help · `q` quit |

**Mouse:** click to select, double-click to play, click the progress bar to seek, scroll to browse.

## Good to know

- **Tags:** embedded title, artist, and album tags are read while the library is scanned. Files without
  usable tags fall back to their file/folder names (`Artist/Album/01 - Title.mp3`, or `Artist - Title.mp3`).
- **Search** matches embedded tags as soon as the library opens, as well as file names.
- **The visualizer is decorative.** It animates while music plays but doesn't analyse the audio.
- **Streams:** pass a URL and mpv plays it (YouTube etc. also work if `yt-dlp` is installed).
- **Custom mpv flags:** `TERMTUNE_MPV_ARGS="--audio-device=..."`; use `TERMTUNE_MPV=/path/to/mpv` for a non-standard binary.
- Colours: truecolor when the terminal advertises it, otherwise a 256-colour approximation.
- Quitting stops playback.

## Layout

```
bin/termtune.js   CLI entry: args, startup, shutdown
src/mpv.js        mpv JSON-IPC wrapper (unix socket / Windows named pipe)
src/player.js     queue, shuffle/repeat, transport, mpv events
src/library.js    folder scanning + filename heuristics
src/ui.js         rendering (diffed, flicker-free), input, themes
src/term.js       ANSI colours, Unicode-aware widths, key/mouse parser
src/config.js     persisted settings
```
