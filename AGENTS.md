# AGENTS.md — Umbrella Player

Windows desktop music player. Python backend (`SOVAKOD/`) serves a local
frontend over HTTP inside a pywebview window. No package.json, no test
framework, no linter config.

## Entrypoints

- `SOVAKOD/main.py` — frozen-exe entry: `bind_server()` in background thread +
  `webview.create_window(http://HOST:port)`. `get_root()` uses `sys._MEIPASS`
  when frozen, `APP_ROOT` env otherwise.
- `SOVAKOD/start_player.pyw` — dev mode: serves + opens system browser
  (no pywebview). Run via `SOVAKOD/DEV - Запуск сервера.bat`.
- `SOVAKOD/server.py` — all HTTP API + static files (`AppHandler`,
  `bind_server`). ~2100 lines; read before touching any route.
  SoundCloud-only: there is no YouTube support anywhere (removed 2026-09);
  `yt-dlp` remains solely as the SoundCloud engine (search/stream/download).
- `SOVAKOD/config.py` — single source of truth for HOST/PORT, TTLs, limits,
  window size, theme mirrors. Change values here, never hardcode in
  `server.py` / `app2.js` / `main.py`.
- Frontend: `SOVAKOD/index.html` + `styles.css` + `app2.js` (+ `archaeo.js`,
  `spring-ui.js`, `silk-aurora.js`, vendored `hls.min.js`, `gsap.min.js`).

## Commands

- Validate Python: `py -3 SOVAKOD/check_syntax.py` (AST parse of all
  `SOVAKOD/*.py`) or `python -m py_compile SOVAKOD/<file>.py` (what CI runs).
- Rebuild exe: `rebuild.bat` from repo root. Killswitches
  `Umbrella Player.exe`, resolves Python (`.venv` → `venv` → `py -3` →
  `python`), installs PyInstaller if missing, runs
  `PyInstaller "Umbrella Player.spec" --noconfirm --clean`. Output:
  `dist/Umbrella Player.exe`.
- Release: push tag `v*` only. CI (`.github/workflows/release.yml`,
  Python 3.11) syncs the version from the tag into `SOVAKOD/app_version.py`,
  `installer/UmbrellaPlayer.iss`, `updates/latest.json`, then builds exe +
  onefile `Umbrella Player Updater.exe` from `SOVAKOD/updater_main.py`,
  Inno Setup installer, portable zip + sha256. Never hand-bump versions.

## Packaging gotchas (spec)

- `Umbrella Player.spec` `datas=[...]` is the asset allowlist. A file must be
  BOTH referenced (e.g. `<script src>` in `index.html`) AND listed here to
  work in the exe. `ui-motion.js`, `liquid-metal.js`, `noise.png` exist on
  disk but are referenced nowhere — do not add them unless you wire them up.
- `hiddenimports` currently lists `tg_integration`, which has no matching
  `.py` on disk and nothing imports it (stale entry). New real backend
  modules go here.
- `console=False` (windowed): `sys.stdout` can be `None` — `server.py`
  `_force_utf8_stdio()` guards this (cp1251 crashes). Keep it.

## Conventions / constraints

- `config.py` ↔ `app2.js` mirrors: `THEME_PRESETS`, `PLAYLIST_GRADIENTS` must
  stay identical on both sides when edited.
- Auth: `POST /api/shutdown`, `/api/update/apply` and `DELETE /api/sc/file`
  require `X-Umbrella-Token` from `GET /api/session`
  (`secrets.compare_digest`). `POST /api/sc/download` is intentionally
  unauthenticated — do not "fix" it. Do not weaken auth.
- Streaming: `/api/sc/stream` 302-redirects to the signed SoundCloud URL
  (instant start); full download-then-serve is HLS-only fallback.
  `/api/archaeo/related` takes repeated `s=«artist — title»` seeds (no ids).
- SC library identity: canonical key `scUrl || url || scId` (`scKey()`),
  persisted `umbrella_scmap`; title+artist equality as fallback. Never mix
  key orders.
- Listening time: real seconds accumulate in `umbrella_listen_sec` day
  buckets (`listenTick` 1s interval, flush every 20s + on `pagehide`).
  Dashboard `lstatTime` uses buckets, falls back to durations sum.
- Env knobs: `HOST`/`PORT`, `MB_UA`, `UMBRELLA_UA`,
  `SC_OAUTH_TOKEN` (falls back to `sc_token.txt`), `SC_APP_ID`/`SC_APP_SECRET`
  (fall back to `sc_app.txt`), `APP_DATA_DIR`/`APP_ROOT`.
- Secrets and runtime dirs are gitignored — never commit `tg_token.txt`,
  `sc_token.txt`, `sc_app.txt`, `sc_accounts.json`, `cookies.txt`,
  `user_data/`, `_sc_cache/`, `sc_music/`, `build/`, `dist/`, `*.log`.
- Deps: `SOVAKOD/requirements.txt` (`yt-dlp`, `pywebview`, `syncedlyrics`).
  SoundCloud-only: no YouTube, no Zvuk anywhere (removed). Startup runs
  `yt_dlp_updater.check_and_update()`; update
  check via `app_updater.fetch_update()` against `UPDATE_MANIFEST_URL` in
  `app_version.py`. `updates/latest.json` is a stub (empty
  `packageUrl`/`sha256`) until release fills it.

## Design-kit files (separate concern, ignore for player work)

- `CLAUDE.md` + `tokens/`, `components/`, `taste/`, `design-systems/`,
  `frameworks/`, `accessibility/`, `workflows/`, `scripts/`,
  `.claude/skills/` are the vendored `ux-ui-agent-skills` kit (+ a working
  mirror of its 18 skills in `.agents/skills/`). Neither location registers
  skills in the host app's slash picker — that registry is managed by the
  app itself. Do NOT hand-edit `skills-lock.json` (`computedHash` is not
  reproducible locally; verified).
  Its zero-emoji rule and `node scripts/accuracy_report.mjs` gate apply to
  design-kit output, not to the player runtime. Do NOT hand-edit
  `skills-lock.json` (`computedHash` is not reproducible locally).
