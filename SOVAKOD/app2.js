/* Umbrella Player — frontend application (v8)
   Local music library + Umbrella search/radio + albums + lyrics */

const API = '/api';
let apiToken = '';

/* ── Централизованная конфигурация фронта ──────────────────────────
   Все таймауты, лимиты и визуальные константы — здесь, а не
   разбросаны магическими числами по файлу. Значения, которые
   должны совпадать с Python-бэком, помечены «↔ config.py». */
const API_TIMEOUT = {
  default: 30000,
  search: 60000,
  searchLong: 40000,
  albums: 20000,
  status: 10000,
  library: 15000,
  resolve: 30000,
  version: 8000,
  update: 10000,
  shutdown: 5000,
};

// Лимиты и визуальные константы — читаемые имена вместо «34» / «0.65»
const APP_CONFIG = {
  particleCount: 34,
  burstCount: 40,
  ambientParticles: 30,
  waveBars: 160,
  listenLogMax: 3000,        // ↔ LL_MAX — макс записей истории
  searchHistoryMax: 8,
  historyMax: 30,
  recentBlockMax: 4,
  playlistGridLimit: 4,      // сколько карточек показывать до «Показать всё»
  heatmapDays: 364,
  fallbackArtists: ['PHARAOH', 'Boulevard Depo', 'HammAli & Navai', 'Jony', 'Скриптонит', 'Мукка'],
};
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  tracks: [],
  searchResults: [],
  visibleTracks: [],
  sortNewest: true,
  searchSource: 'soundcloud',
  searchGen: 0,
  albumResults: [],
  currentTrack: null,
  shuffle: false,
  repeat: false,
  waveData: null,
  waveUrl: null,
  hls: null,
  hlsB: null,
  _ending: false,
  _trackGen: 0,
  _activeAudioSide: 'a',
  radioMode: false,
  radioKind: null,
  radioQuery: '',
  radioPlayedIds: new Set(),
  radioQueue: [],
  launched: false,
  customCover: null,
  activePlaylistId: null,
  scDownloaded: {},
  scLibTracks: [],
};

function scKey(track) {
  if (!track) return '';
  return track.scUrl || track.url || track.scId || '';
}

let scUrlMap = loadJSON('umbrella_scmap', {});

function isScDownloaded(track) {
  if (!track) return false;
  const k = scKey(track);
  if (k && scUrlMap[k]) return true;
  const ti = (track.title || '').trim().toLowerCase();
  if (!ti) return false;
  const ar = (track.artist || '').trim().toLowerCase();
  return state.scLibTracks.some((f) =>
    (f.title || '').trim().toLowerCase() === ti &&
    (f.artist || '').trim().toLowerCase() === ar);
}

const audio = document.createElement('audio');
// Без crossOrigin ресурс SoundCloud (чужой источник) считается tainted для
// Web Audio: createMediaElementSource(audio) будет выдавать ТИШИНУ на выходе,
// хотя сам <audio> визуально играет. CDN SoundCloud отдаёт CORS-заголовки на
// потоках, так что anonymous снимает тишину, не требуя авторизации.
audio.crossOrigin = 'anonymous';
document.body.appendChild(audio);
const audioB = document.createElement('audio');
audioB.crossOrigin = 'anonymous';
audioB.preload = 'auto';
document.body.appendChild(audioB);
let preferredVolume = Number(localStorage.getItem('umbrella_volume') || '1');
if (!Number.isFinite(preferredVolume)) preferredVolume = 1;
preferredVolume = Math.max(0, Math.min(1, preferredVolume));

// Гарантированно резюмим AudioContext на первом же пользовательском жесте.
// Визуализатор роутит звук ИСКЛЮЧИТЕЛЬНО через Web Audio (createMediaElementSource
// отключает штатный вывод <audio>), а новый AudioContext стартует suspended —
// если resume() не попадёт в окно активации жеста, трек "играет" визуально,
// но звука не будет вообще. Ловим самый первый клик/тач в документе.
function primeAudioContextOnce() {
  try {
    ensureAnalyser();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch((e) => console.warn('[Audio] initial resume failed', e));
    }
  } catch (e) {
    console.warn('[Audio] priming failed', e);
  }
}
['pointerdown', 'keydown'].forEach((evt) =>
  document.addEventListener(evt, primeAudioContextOnce, { once: true, capture: true })
);

let playbackLoadingTimer = null;
let playbackLoadingParticles = [];
let albumQueueLoadingOverlay = null;
let playbackErrorTimer = null;

function schedulePlaybackError(message) {
  clearTimeout(playbackErrorTimer);
  playbackErrorTimer = setTimeout(() => toast(message, 'error', 4000), 1200);
}

function clearAlbumQueueLoading() {
  albumQueueLoadingOverlay?.remove();
  albumQueueLoadingOverlay = null;
}

function showPlaybackLoading(track) {
  const overlay = $('#playbackLoading');
  const container = $('#playbackLoadingParticles');
  if (!overlay || !container) return;
  clearTimeout(playbackLoadingTimer);
  clearTimeout(playbackErrorTimer);
  overlay.classList.remove('is-leaving');
  overlay.hidden = false;
  $('#playbackLoadingTitle').textContent = track?.title || 'Подготавливаем трек';
  playbackLoadingParticles.forEach((particle) => particle.remove());
  playbackLoadingParticles = [];
  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;
  for (let i = 0; i < APP_CONFIG.particleCount; i++) {
    const particle = document.createElement('i');
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.max(window.innerWidth, window.innerHeight) * (.35 + Math.random() * .45);
    const x = centerX + Math.cos(angle) * distance;
    const y = centerY + Math.sin(angle) * distance;
    particle.className = 'playback-loading-particle';
    particle.style.left = `${x}px`;
    particle.style.top = `${y}px`;
    container.appendChild(particle);
    playbackLoadingParticles.push(particle);
    if (window.gsap && !reduceMotion()) {
      gsap.to(particle, { x: centerX - x, y: centerY - y, scale: .45, opacity: .85, duration: .9 + Math.random() * .55, delay: i * .018, ease: 'power3.in' });
    }
  }
}

function hidePlaybackLoading() {
  const overlay = $('#playbackLoading');
  if (!overlay || overlay.hidden) return;
  const particles = [...playbackLoadingParticles];
  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;
  if (window.gsap && !reduceMotion()) {
    particles.forEach((particle, i) => {
      const angle = Math.random() * Math.PI * 2;
      const distance = 180 + Math.random() * 460;
      gsap.to(particle, { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance, opacity: 0, scale: .3, duration: .75 + Math.random() * .35, delay: i * .01, ease: 'power3.out' });
    });
  }
  overlay.classList.add('is-leaving');
  playbackLoadingTimer = setTimeout(() => {
    overlay.hidden = true;
    overlay.classList.remove('is-leaving');
    playbackLoadingParticles.forEach((particle) => particle.remove());
    playbackLoadingParticles = [];
  }, 720);
}

/* ============================================================
   Utils
   ============================================================ */

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDuration(seconds = 0) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const mins = Math.floor(s / 60);
  const secs = String(s % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

function loadJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
  catch (e) { return fallback; }
}

const idleWriteQueue = {};
let idleFlushScheduled = false;
function flushIdleWrites() {
  idleFlushScheduled = false;
  for (const k of Object.keys(idleWriteQueue)) {
    try { localStorage.setItem(k, JSON.stringify(idleWriteQueue[k])); } catch (e) { /* storage full */ }
    delete idleWriteQueue[k];
  }
}
function saveJSON(key, value) {
  idleWriteQueue[key] = value;
  if (idleFlushScheduled) return;
  idleFlushScheduled = true;
  if (window.requestIdleCallback) window.requestIdleCallback(flushIdleWrites, { timeout: 2000 });
  else setTimeout(flushIdleWrites, 0);
}
window.addEventListener('pagehide', flushIdleWrites);

const icons = {
  heart: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.5s-7.5-4.7-9.4-9.3C1.2 8 2.9 4.7 6 4.2c1.9-.3 3.7.6 4.6 2.1L12 8.3l1.4-2c.9-1.5 2.7-2.4 4.6-2.1 3.1.5 4.8 3.8 3.4 7-1.9 4.6-9.4 9.3-9.4 9.3z"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="8,5 20,12 8,19"/></svg>',
  preview: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6"/><path d="M7 18V9"/><path d="M11 18V6"/><path d="M15 18v-4"/><path d="M19 18V2"/></svg>',
  eq: '<span class="eq-bars" aria-hidden="true"><span></span><span></span><span></span><span></span></span>',
  more: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
};

function coverGradient(index) {
  const h = ((index * 47) % 360);
  return `linear-gradient(135deg,hsl(${h} 55% 42%),hsl(${(h + 70) % 360} 62% 34%))`;
}

/* ============================================================
   Toasts
   ============================================================ */

const toastIcons = {
  success: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  error: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
};

function toast(message, type = 'info', duration = 3000, action = null) {
  const stack = $('#toastStack');
  if (!stack) { action?.onClick?.(); return; }
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.innerHTML = `${toastIcons[type] || toastIcons.info}<span>${escapeHtml(message)}</span>`;
  if (action && action.label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { try { action.onClick?.(); } finally { node.remove(); } });
    node.appendChild(btn);
  }
  stack.appendChild(node);
  if (stack.children.length > 4) stack.firstElementChild.remove();
  setTimeout(() => {
    node.classList.add('out');
    node.addEventListener('animationend', () => node.remove(), { once: true });
  }, action ? Math.max(duration, 5000) : duration);
}

/* ============================================================
   Confirm modal
   ============================================================ */

let modalResolve = null;
let modalMode = 'confirm';
let modalReturnFocus = null;

function confirmDialog({ title, body, confirmText = 'Подтвердить' }) {
  modalMode = 'confirm';
  return new Promise((resolve) => {
    const modal = $('#modal');
    modalReturnFocus = document.activeElement;
    $('#modalTitle').textContent = title;
    $('#modalBody').textContent = body;
    $('#modalInput').hidden = true;
    $('#modalList').hidden = true;
    $('#modalList').innerHTML = '';
    $('#modalConfirm').textContent = confirmText;
    modalResolve = resolve;
    modal.hidden = false;
    setTimeout(() => $('#modalConfirm')?.focus(), 40);
  });
}

function promptDialog({ title, placeholder = '', initial = '', confirmText = 'Создать' }) {
  modalMode = 'prompt';
  return new Promise((resolve) => {
    const modal = $('#modal');
    modalReturnFocus = document.activeElement;
    $('#modalTitle').textContent = title;
    $('#modalBody').textContent = '';
    const input = $('#modalInput');
    input.placeholder = placeholder;
    input.setAttribute('aria-label', title);
    input.value = initial;
    input.hidden = false;
    $('#modalList').hidden = true;
    $('#modalList').innerHTML = '';
    $('#modalConfirm').textContent = confirmText;
    modalResolve = resolve;
    modal.hidden = false;
    setTimeout(() => { input.focus(); input.select(); }, 40);
  });
}

function chooseFromList({ title, rows, confirmText = 'Отмена' }) {
  modalMode = 'list';
  return new Promise((resolve) => {
    const modal = $('#modal');
    modalReturnFocus = document.activeElement;
    $('#modalTitle').textContent = title;
    $('#modalBody').textContent = '';
    $('#modalInput').hidden = true;
    const list = $('#modalList');
    list.innerHTML = rows.map((r, i) => `
      <button class="modal-list-row" data-idx="${i}">
        <span class="ml-label">${r.label}</span>${r.sublabel ? `<small class="ml-sub">${r.sublabel}</small>` : ''}
      </button>`).join('');
    list.hidden = false;
    $('#modalConfirm').textContent = confirmText;
    modalResolve = resolve;
    modal.hidden = false;
  });
}

function closeModal(result) {
  const modal = $('#modal');
  if (modal.hidden) return;
  modal.hidden = true;
  let out = result;
  if (modalMode === 'prompt') out = result ? $('#modalInput').value.trim() : null;
  modalMode = 'confirm';
  if (modalResolve) { const r = modalResolve; modalResolve = null; r(out); }
  if (modalReturnFocus?.focus) { try { modalReturnFocus.focus(); } catch (_) {} modalReturnFocus = null; }
}

/* ============================================================
   Settings
   ============================================================ */

const DEFAULT_SETTINGS = { visualizer: true, ambient: true, keepVolume: true, autoAdd: false, offline: true, themeAuto: true, themeHue: null, led: true, lowFx: false };
let settings = Object.assign({}, DEFAULT_SETTINGS, loadJSON('umbrella_settings', {}));

// ↔ config.py THEME_PRESETS — при изменении синхронизировать оба файла
const THEME_PRESETS = [
  { hue: 262, sw: '#8b5cf6', label: 'Фиолетовый' },
  { hue: 222, sw: '#4f8cff', label: 'Синий' },
  { hue: 192, sw: '#22d3ee', label: 'Циан' },
  { hue: 155, sw: '#34d399', label: 'Изумруд' },
  { hue: 342, sw: '#f472b6', label: 'Розовый' },
  { hue: 38, sw: '#fbbf24', label: 'Янтарный' },
];

function effectiveHue() {
  if (!settings.themeAuto && settings.themeHue != null) return settings.themeHue;
  return extractHue(state.currentTrack?.color);
}

function applyHue(hue, animate = false) {
  hue = Number(hue);
  if (!isFinite(hue)) hue = 262;
  const root = document.documentElement;
  root.style.setProperty('--dyn-h', hue);
  root.style.setProperty('--dyn-accent', `hsl(${hue}, 78%, 62%)`);
  root.style.setProperty('--dyn-glow', `hsla(${hue}, 78%, 55%, 0.16)`);
  root.style.setProperty('--dyn-glow-strong', `hsla(${hue}, 85%, 58%, 0.32)`);
  if (animate && window.gsap) gsap.to(root, { '--dyn-h': hue, duration: 1.2, ease: 'power1.inOut' });
}

function syncThemeSwatches() {
  document.querySelectorAll('#themeSwatches .swatch').forEach((el) => {
    const active = !settings.themeAuto && settings.themeHue != null && Number(el.dataset.hue) === settings.themeHue;
    el.classList.toggle('active', active);
    el.setAttribute('aria-checked', active);
  });
}

function saveSettings() {
  saveJSON('umbrella_settings', settings);
  applySettings();
}

function applySettings() {
  const silk = window.__silk;
  if (silk) {
    if (settings.ambient) { silk.resume(); $('#ambient').style.opacity = '1'; }
    else { silk.pause(); $('#ambient').style.opacity = '0.4'; }
  }
  document.body.classList.toggle('low-fx', !!settings.lowFx);
  if (settings.lowFx && silk) { silk.pause(); $('#ambient').style.opacity = '0'; }
  if (settings.led) startLedLoop();
  else stopLedLoop();
  if (audio.paused) startFloatingBlobs();
  else if (settings.visualizer) ensureAnalyser(), startBeatLoop();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopLedLoop();
    if (typeof beatRAF !== 'undefined' && beatRAF) { cancelAnimationFrame(beatRAF); beatRAF = null; }
    if (typeof djBeatRAF !== 'undefined' && djBeatRAF) { cancelAnimationFrame(djBeatRAF); djBeatRAF = null; }
    stopArtistWaves();
  } else if (state.launched) {
    applySettings();
    if (!$('#vinylOverlay')?.hidden) startDjLoop();
    if (!$('#artistDetail')?.hidden) startArtistWaves();
  }
});

/* ============================================================
   Favorites
   ============================================================ */

const FAV_KEY = 'umbrella_favorites';
let favorites = loadJSON(FAV_KEY, []);

function favKey(track) {
  if (track.zvukId) return `zvuk:${track.zvukId}`;
  if (track.scId) return `sc:${track.scId}`;
  if (track.dbId) return `local:${track.dbId}`;
  return `local:${(track.title || '').toLowerCase()}|${(track.artist || '').toLowerCase()}`;
}

function isFavTrack(track) {
  return favorites.some((f) => f.key === favKey(track));
}

function saveFavorites() { saveJSON(FAV_KEY, favorites); }

function toggleFav(track) {
  const key = favKey(track);
  const idx = favorites.findIndex((f) => f.key === key);
  let added = false;
  if (idx >= 0) {
    favorites.splice(idx, 1);
    toast('Удалено из избранного', 'info', 2200);
  } else {
    favorites.unshift({
      key,
      title: track.title || 'Без названия',
      artist: track.artist || 'Неизвестный исполнитель',
      album: track.album || '',
      source: track.source || 'local',
      videoId: track.videoId || null,
      zvukId: track.zvukId || track.id || null,
      scId: track.scId || null,
      dbId: track.dbId || track.id || null,
      thumbnail: track.thumbnail || track.cover || '',
      duration: track.duration || 0,
      color: track.color || '',
    });
    added = true;
    toast('Добавлено в избранное', 'success', 2200);
  }
  saveFavorites();
  refreshFavUI();
  return added;
}

function favRecordToTrack(f) {
  return {
    title: f.title, artist: f.artist, album: f.album,
    source: f.source, videoId: f.videoId, zvukId: f.zvukId, scId: f.scId, dbId: f.dbId,
    thumbnail: f.thumbnail, duration: f.duration, color: f.color || coverGradient(0),
  };
}

function refreshFavUI() {
  if (state.launched && !$('#dashboard').hidden) {
    $$('.track-row .track-fav').forEach((btn) => {
      const rec = favorites.find((f) => f.key === btn.dataset.fav);
      btn.classList.toggle('active', !!rec);
    });
    const pb = $('#pbFav');
    if (pb && state.currentTrack) pb.classList.toggle('active', isFavTrack(state.currentTrack));
    updateStats();
    updateLibraryButtonState();
    if (!$('#favoritesContent').hidden) renderFavorites();
  }
}

/* ============================================================
   Custom playlists
   ============================================================ */

const PL_KEY = 'umbrella_playlists';
let playlists = loadJSON(PL_KEY, []);

function savePlaylists() { saveJSON(PL_KEY, playlists); }

function makePlaylistId() {
  return 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function trackSnapshot(track) {
  return {
    key: favKey(track),
    title: track.title || 'Без названия',
    artist: track.artist || 'Неизвестный исполнитель',
    album: track.album || '',
    source: track.source || 'local',
    videoId: track.videoId || null,
    zvukId: track.zvukId || track.id || null,
    scId: track.scId || null,
    scUrl: track.scUrl || track.url || null,
    dbId: track.dbId || track.id || null,
    thumbnail: track.thumbnail || '',
    duration: track.duration || 0,
    color: track.color || '',
  };
}

function playlistTrackToRecord(t) { return { ...t }; }

function createPlaylist(name) {
  const id = makePlaylistId();
  playlists.unshift({ id, name: (name || '').trim() || 'Новый плейлист', tracks: [], createdAt: Date.now() });
  savePlaylists();
  renderCustomPlaylists();
  return id;
}

function addToPlaylist(playlistId, track) {
  const pl = playlists.find((p) => p.id === playlistId);
  if (!pl) return false;
  const snap = trackSnapshot(track);
  if (pl.tracks.some((t) => t.key === snap.key)) return false;
  pl.tracks.push(snap);
  savePlaylists();
  renderCustomPlaylists();
  return true;
}

function removeFromPlaylist(playlistId, key) {
  const pl = playlists.find((p) => p.id === playlistId);
  if (!pl) return null;
  const idx = pl.tracks.findIndex((t) => t.key === key);
  if (idx < 0) return null;
  const [snap] = pl.tracks.splice(idx, 1);
  savePlaylists();
  renderCustomPlaylists();
  return { snap, idx };
}

function restorePlaylistTrack(playlistId, removed) {
  const pl = playlists.find((p) => p.id === playlistId);
  if (!pl || !removed) return false;
  if (pl.tracks.some((t) => t.key === removed.snap.key)) return false;
  pl.tracks.splice(Math.min(removed.idx, pl.tracks.length), 0, removed.snap);
  savePlaylists();
  renderCustomPlaylists();
  showPlaylistPage(playlistId);
  return true;
}

function renamePlaylist(playlistId, name) {
  const pl = playlists.find((p) => p.id === playlistId);
  if (!pl) return;
  pl.name = (name || '').trim() || pl.name;
  savePlaylists();
  renderCustomPlaylists();
}

function deletePlaylist(playlistId) {
  playlists = playlists.filter((p) => p.id !== playlistId);
  savePlaylists();
  renderCustomPlaylists();
}

function playPlaylist(playlistId) {
  const pl = playlists.find((p) => p.id === playlistId);
  if (!pl || !pl.tracks.length) return toast('Плейлист пуст');
  state.activePlaylistId = playlistId;
  const tracks = pl.tracks.map(playlistTrackToRecord);
  state.visibleTracks = tracks;
  playTrack(tracks[0], 0);
  toast(`Играет: ${pl.name}`);
}

function playPlaylistTrack(playlistId, index) {
  const pl = playlists.find((p) => p.id === playlistId);
  if (!pl) return;
  state.activePlaylistId = playlistId;
  const tracks = pl.tracks.map(playlistTrackToRecord);
  state.visibleTracks = tracks;
  playTrack(tracks[index], index);
}

function startPlaylistRadio(playlistId) {
  const pl = playlists.find((p) => p.id === playlistId);
  if (!pl || !pl.tracks.length) return toast('Плейлист пуст');
  state.activePlaylistId = playlistId;
  const first = pl.tracks[0];
  const artist = first.artist && first.artist !== 'Неизвестный исполнитель' ? first.artist : first.title;
  closePlaylistPage();
  startArtistRadio(artist);
}

function openAddToPlaylist(track) {
  const rows = playlists.map((p) => ({
    label: escapeHtml(p.name),
    sublabel: `${p.tracks.length} ${plural(p.tracks.length)}`,
  }));
  rows.push({ label: '➕ Новый плейлист…', sublabel: '' });
  chooseFromList({ title: 'Добавить в плейлист', rows }).then((res) => {
    if (!res || typeof res !== 'object') return;
    const idx = res.idx;
    if (idx == null) return;
    if (idx === playlists.length) {
      promptDialog({ title: 'Новый плейлист', placeholder: 'Название плейлиста' }).then((name) => {
        if (!name) return;
        const id = createPlaylist(name);
        const added = addToPlaylist(id, track);
        toast(added ? 'Добавлено в плейлист' : 'Трек уже в плейлисте', added ? 'success' : 'info', 2200);
      });
      return;
    }
    const pl = playlists[idx];
    if (!pl) return;
    const added = addToPlaylist(pl.id, track);
    toast(added ? `Добавлено в «${pl.name}»` : 'Трек уже в плейлисте', added ? 'success' : 'info', 2200);
  });
}

/* ============================================================
   History
   ============================================================ */

const HIST_KEY = 'umbrella_history';
let history = loadJSON(HIST_KEY, []);

function addHistory(track) {
  const key = track.zvukId || track.scUrl || track.scId || `${track.title}|${track.artist}`;
  history = history.filter((h) => (h.zvukId || h.scUrl || h.scId || `${h.title}|${h.artist}`) !== key);
  history.unshift({
    title: track.title || 'Без названия',
    artist: track.artist || 'Неизвестный исполнитель',
    source: track.source || 'local',
    videoId: track.videoId || null,
    zvukId: track.zvukId || track.id || null,
    scUrl: track.scUrl || track.url || null,
    scId: track.scId || null,
    thumbnail: track.thumbnail || '',
    duration: track.duration || 0,
    at: Date.now(),
  });
  history = history.slice(0, APP_CONFIG.historyMax);
  saveJSON(HIST_KEY, history);
  renderRecent();
}

function renderRecent() {
  const block = $('#recentBlock');
  const row = $('#recentRow');
  if (!block || !row) return;
  if (!history.length) { block.hidden = true; return; }
  block.hidden = false;
  row.innerHTML = history.slice(0, APP_CONFIG.recentBlockMax).map((h) => `
    <button class="recent-item" data-h="1">
      <span class="recent-ico">${icons.play}</span>
      <span class="recent-body">
        <span class="recent-title">${escapeHtml(h.artist)} — ${escapeHtml(h.title)} <i>&bull; ${h.source === 'soundcloud' ? 'SoundCloud' : 'Локально'}</i></span>
        <small>${formatDuration(h.duration || 0)}</small>
      </span>
    </button>`).join('');
}

/* ============================================================
   Listen log (stats)
   ============================================================ */

const LL_KEY = 'umbrella_listenlog';
const LL_MAX = APP_CONFIG.listenLogMax;
let listenLog = loadJSON(LL_KEY, []);

function seedListenLog() {
  if (!listenLog.length && history.length) {
    listenLog = history.map((h) => ({ title: h.title, artist: h.artist, source: h.source, scUrl: h.scUrl || null, scId: h.scId || null, at: h.at, duration: h.duration }));
    saveJSON(LL_KEY, listenLog);
  }
}
seedListenLog();

function recordListen(track) {
  if (!track) return;
  const now = Date.now();
  const last = listenLog[0];
  if (last && now - (last.at || 0) < 15000 && ((last.scUrl && last.scUrl === track.scUrl) || (last.scId && last.scId === track.scId) || (last.title === track.title && last.artist === track.artist))) return;
  listenLog.unshift({
    title: track.title || 'Без названия',
    artist: track.artist || 'Неизвестный исполнитель',
    source: track.source || 'local',
    scUrl: track.scUrl || track.url || null,
    scId: track.scId || null,
    duration: track.duration || 0,
    at: now,
  });
  if (listenLog.length > LL_MAX) listenLog = listenLog.slice(0, LL_MAX);
  saveJSON(LL_KEY, listenLog);
}

function clearListenLog() {
  listenLog = [];
  saveJSON(LL_KEY, listenLog);
}

// Реальные секунды прослушивания по дням (локальная дата YYYY-MM-DD).
// В отличие от listenLog (факты включения), считает только звучание:
// пауза не идёт в зачёт, перемотка назад идёт повторно — честно.
const LS_KEY = 'umbrella_listen_sec';
let listenSecByDay = loadJSON(LS_KEY, {});
let listenAccum = 0;
let listenLastT = 0;
let listenFlushAt = 0;

function listenLocalDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function flushListenSec() {
  if (listenAccum < 1) return;
  const day = listenLocalDay();
  listenSecByDay[day] = Math.round((listenSecByDay[day] || 0) + listenAccum);
  listenAccum = 0;
  saveJSON(LS_KEY, listenSecByDay);
}

function listenTick() {
  const el = (typeof djActiveElement === 'function' ? djActiveElement() : audio);
  const now = performance.now() / 1000;
  if (!el || el.paused) { listenLastT = 0; return; }
  if (listenLastT) {
    const dt = now - listenLastT;
    if (dt > 0 && dt < 5) listenAccum += dt;
  }
  listenLastT = now;
  if (now - listenFlushAt > 20) { listenFlushAt = now; flushListenSec(); }
}
setInterval(listenTick, 1000);
window.addEventListener('pagehide', flushListenSec);

function listenSecInPeriod(sinceMs) {
  let total = 0;
  for (const [day, sec] of Object.entries(listenSecByDay)) {
    const t = new Date(day + 'T00:00:00').getTime();
    if (Number.isFinite(t) && t >= sinceMs - 86400000 && sec > 0) total += sec;
  }
  return Math.round(total);
}

/* ============================================================
   Search history
   ============================================================ */

const SCH_KEY = 'umbrella_search_history';
let searchHistory = loadJSON(SCH_KEY, []);

function addSearchHistory(q) {
  searchHistory = searchHistory.filter((s) => s.toLowerCase() !== q.toLowerCase());
  searchHistory.unshift(q);
  searchHistory = searchHistory.slice(0, APP_CONFIG.searchHistoryMax);
  saveJSON(SCH_KEY, searchHistory);
  renderSearchHistory();
}

function renderSearchHistory() {
  const block = $('#searchHistory');
  const row = $('#searchHistoryRow');
  if (!block || !row) return;
  if (!searchHistory.length) { block.hidden = true; return; }
  block.hidden = false;
  row.innerHTML = searchHistory.map((q) => `<button class="chip" data-q="1"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg><span>${escapeHtml(q)}</span></button>`).join('');
}

/* ============================================================
   Audio analyser / visualizer
   ============================================================ */

const AudioCtx = window.AudioContext || window.webkitAudioContext;
let analyser = null;
let audioCtx = null;
let analyserSource = null;
let djSourceB = null;
let djAnalyserA = null;
let djAnalyserB = null;
let djGainA = null;
let djGainB = null;
let djMasterGain = null;
let beatRAF = null;

function ensureAnalyser() {
  if (analyser) return;
  try {
    audioCtx = new AudioCtx();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.65;
    analyserSource = audioCtx.createMediaElementSource(audio);
    djSourceB = audioCtx.createMediaElementSource(audioB);
    djAnalyserA = audioCtx.createAnalyser();
    djAnalyserA.fftSize = 256;
    djAnalyserA.smoothingTimeConstant = 0.65;
    djAnalyserB = audioCtx.createAnalyser();
    djAnalyserB.fftSize = 256;
    djAnalyserB.smoothingTimeConstant = 0.65;
    djGainA = audioCtx.createGain();
    djGainA.gain.value = state._activeAudioSide === 'a' ? 1 : 0;
    djGainB = audioCtx.createGain();
    djGainB.gain.value = state._activeAudioSide === 'b' ? 1 : 0;
    djMasterGain = audioCtx.createGain();
    djMasterGain.gain.value = 1;
    analyserSource.connect(djAnalyserA);
    djSourceB.connect(djAnalyserB);
    djAnalyserA.connect(djGainA);
    djAnalyserB.connect(djGainB);
    djGainA.connect(djMasterGain);
    djGainB.connect(djMasterGain);
    djMasterGain.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch (e) {
    analyser = null;
  }
}

let djLastX = 0;

function applyDjCrossfade(x) {
  if (!audioCtx || !djGainA || !djGainB) return;
  const t = (Math.max(-1, Math.min(1, Number.isFinite(x) ? x : 0)) + 1) / 2;
  const gA = Math.cos(t * Math.PI / 2);
  const gB = Math.sin(t * Math.PI / 2);
  const now = audioCtx.currentTime;
  djGainA.gain.cancelScheduledValues(now);
  djGainB.gain.cancelScheduledValues(now);
  djGainA.gain.setTargetAtTime(gA, now, 0.05);
  djGainB.gain.setTargetAtTime(gB, now, 0.05);
  const base = (Number(vinylState && vinylState.settings && vinylState.settings.fxVol) || 55) / 100;
  vinylFx.setFxVol(base * gA);
  vinylFxB.setFxVol(base * gB);
  /* Активная дека следует за фейдером, но ничего не стартует само */
  const hasA = !!vinylState.deck;
  const hasB = !!vinylState.cue;
  if (hasA && hasB) {
    let next = vinylState.dj.master;
    if (x >= 0.02 && gB > gA) next = 'b';
    else if (x <= -0.02 && gA > gB) next = 'a';
    if (next !== vinylState.dj.master) {
      vinylState.dj.master = next;
      saveVinylState();
      updateDeckPlayingUI();
    }
  }
  const prev = djLastX;
  djLastX = x;
  if (prev != null && hasA && hasB &&
      ((prev < 0 && x >= 0) || (prev > 0 && x <= 0)) &&
      djDeckPlaying('a') && djDeckPlaying('b')) {
    djMixBurst();
  }
}

function startBeatLoop() {
  const halo = $('#npHalo'), artWrap = $('#npArtWrap');
  if (!halo || !artWrap) return;
  if (beatRAF) { cancelAnimationFrame(beatRAF); beatRAF = null; }
  const data = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
  const loop = () => {
    beatRAF = requestAnimationFrame(loop);
    const t = performance.now() / 1000;
    if (!analyser || !data) {
      const v = 0.5 + Math.sin(t * 1.6) * 0.08;
      halo.style.setProperty('--np-halo-scale', (1 + v * 0.04).toFixed(3));
      artWrap.style.setProperty('--np-cover-glow', `${26 + v * 8}px`);
      return;
    }
    analyser.getByteFrequencyData(data);
    let bass = 0;
    for (let i = 0; i < 8; i++) bass += data[i];
    bass = Math.min(1, (bass / 8 / 255) * 1.6);
    halo.style.setProperty('--np-halo-scale', (1 + bass * 0.08).toFixed(3));
    artWrap.style.setProperty('--np-cover-glow', `${26 + bass * 28}px`);
  };
  loop();
}

function startFloatingBlobs() {
  const halo = $('#npHalo'), artWrap = $('#npArtWrap');
  if (!halo || !artWrap) return;
  if (beatRAF) { cancelAnimationFrame(beatRAF); beatRAF = null; }
  const loop = () => {
    beatRAF = requestAnimationFrame(loop);
    const t = performance.now() / 1000;
    halo.style.setProperty('--np-halo-scale', (1 + Math.sin(t * 0.5) * 0.018).toFixed(3));
    artWrap.style.setProperty('--np-cover-glow', '22px');
  };
  loop();
}

function updateBgState() {
  const el = djActiveElement();
  const playing = !el.paused;
  if (playing && settings.visualizer) {
    ensureAnalyser();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch((e) => console.warn('[Audio] resume in updateBgState failed', e));
    }
    startBeatLoop();
  } else {
    startFloatingBlobs();
  }
}

/* ---------- LED strip (bass reactive) ---------- */

let ledRAF = null;
let ledLevel = 0;
let ledData = null;

function drawLedStrip(canvas, segs, bass, mid, hi, t) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(40, canvas.clientWidth || (canvas.parentElement ? canvas.parentElement.clientWidth : 0) || 320);
  const h = Math.max(2, canvas.clientHeight || 4);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
    const dynH = parseInt(document.documentElement.style.getPropertyValue('--dyn-h'), 10) || 262;
  const segW = canvas.width / segs;
  for (let i = 0; i < segs; i++) {
    const f = segs === 1 ? 0 : i / (segs - 1);
    let e = bass * Math.max(0, 1 - f * 1.15);
    e = Math.max(e, mid * Math.max(0, 1 - Math.abs(f - 0.4) * 1.7));
    e = Math.max(e, hi * Math.max(0, (f - 0.52) * 1.7));
    e = Math.min(1, Math.max(0, e));
    const hgt = Math.max(0.05, e) * (0.6 + 0.4 * (1 - f * 0.6));
    const flicker = 0.86 + 0.14 * Math.sin(t * 7 + i * 0.6);
    const hue = (dynH + f * 110) % 360;
    ctx.fillStyle = `hsla(${hue.toFixed(0)}, 90%, ${(40 + e * 34).toFixed(0)}%, ${(0.45 + e * 0.55).toFixed(2)})`;
    const hh = Math.max(1, canvas.height * hgt * flicker);
    ctx.fillRect(i * segW + 0.5, canvas.height - hh, Math.max(1, segW - 0.8), hh);
  }
}

function startLedLoop() {
  if (ledRAF) return;
  const loop = () => {
    ledRAF = requestAnimationFrame(loop);
    const t = performance.now() / 1000;
    const c1 = $('#pbLed');
    const c2 = $('#npLed');
    if (!c1 && !c2) return;
    let bass = 0, mid = 0, hi = 0;
    if (settings.led && analyser && !djActiveElement().paused) {
       if (!ledData || ledData.length !== analyser.frequencyBinCount) ledData = new Uint8Array(analyser.frequencyBinCount);
       analyser.getByteFrequencyData(ledData);
       for (let i = 0; i < 6; i++) bass += ledData[i];
       for (let i = 6; i < 20; i++) mid += ledData[i];
       for (let i = 20; i < 48; i++) hi += ledData[i];
      bass = Math.min(1, (bass / 6 / 255) * 1.7);
      mid = Math.min(1, (mid / 14 / 255) * 1.4);
      hi = Math.min(1, (hi / 28 / 255) * 1.2);
    }
    const target = bass + mid * 0.5 + hi * 0.3;
    ledLevel += (target - ledLevel) * 0.22;
    drawLedStrip(c1, 52, settings.led ? bass : ledLevel * 0.25, settings.led ? mid : ledLevel * 0.12, settings.led ? hi : 0, t);
    drawLedStrip(c2, 72, settings.led ? bass : ledLevel * 0.25, settings.led ? mid : ledLevel * 0.12, settings.led ? hi : 0, t);
  };
  loop();
}

function stopLedLoop() {
  if (ledRAF) { cancelAnimationFrame(ledRAF); ledRAF = null; }
  ledLevel = 0;
  ledData = null;
  ['pbLed', 'npLed'].forEach((id) => {
    const c = $('#' + id);
    if (!c) return;
    const ctx = c.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, c.width, c.height);
  });
}

/* ============================================================
   IndexedDB (local tracks + offline)
   ============================================================ */

const DB_NAME = 'umbrella_player';
const DB_STORE = 'tracks';
const DB_OFFLINE = 'offlineAudio';
let _db = null;

function openIDB() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('IndexedDB open timeout'));
    }, 2000);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains(DB_OFFLINE)) db.createObjectStore(DB_OFFLINE, { keyPath: 'videoId' });
    };
    req.onsuccess = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(req.error);
    };
  });
}

function idbTx(store, mode, fn) {
  return openIDB().then((db) => new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('IDB transaction timeout'));
    }, 2000);
    const tx = db.transaction(store, mode);
    const out = fn(tx.objectStore(store));
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out && out.result);
    };
    tx.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(tx.error);
    };
    tx.onabort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(tx.error || new Error('IDB transaction aborted'));
    };
  }));
}

const idbSave = (meta, blob) => idbTx(DB_STORE, 'readwrite', (s) => s.add({ ...meta, blob }));
const idbGetAll = () => idbTx(DB_STORE, 'readonly', (s) => s.getAll());
const idbDelete = (id) => idbTx(DB_STORE, 'readwrite', (s) => s.delete(id));
const idbClear = () => idbTx(DB_STORE, 'readwrite', (s) => s.clear());

function getBlobFromIDB(dbId) {
  return openIDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(dbId);
    req.onsuccess = () => resolve(req.result ? req.result.blob : null);
    req.onerror = () => reject(req.error);
  }));
}

function idbClearOffline() {
  return openIDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_OFFLINE, 'readwrite');
    tx.objectStore(DB_OFFLINE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

/* Custom cover (shared for the whole player) */
const CUSTOM_COVER_KEY = '__custom_cover';

function idbSaveCustomCover(blob, type, name) {
  return openIDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_OFFLINE, 'readwrite');
    tx.objectStore(DB_OFFLINE).put({ videoId: CUSTOM_COVER_KEY, blob, type, name, addedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbGetCustomCover() {
  return openIDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_OFFLINE, 'readonly');
    const req = tx.objectStore(DB_OFFLINE).get(CUSTOM_COVER_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

function idbClearCustomCover() {
  return openIDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_OFFLINE, 'readwrite');
    tx.objectStore(DB_OFFLINE).delete(CUSTOM_COVER_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

async function loadTracksFromIDB() {
  try {
    const rows = await idbGetAll();
    // Миграция после удаления YouTube: записи без аудиоблоба и с
    // source youtube не воспроизвести — вычищаем их из библиотеки.
    const dead = rows.filter((r) => r.source === 'youtube' || (r.dbId == null && !r.blob && !r.videoId && r.source !== 'local'));
    const live = rows.filter((r) => !dead.includes(r));
    for (const d of dead) {
      try { await idbDelete(d.id); } catch (e) { /* ignore */ }
    }
    if (dead.length) {
      setTimeout(() => toast(`Удалено недоступных треков: ${dead.length} (YouTube больше не поддерживается)`, 'info', 4000), 2500);
    }
    // Чистим офлайн-кэш YouTube прошлых версий (кроме кастомной обложки).
    try {
      const db = await openIDB();
      const keys = await new Promise((res, rej) => {
        const tx = db.transaction(DB_OFFLINE, 'readonly');
        const rq = tx.objectStore(DB_OFFLINE).getAllKeys();
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => rej(rq.error);
      });
      for (const k of keys) {
        if (k === CUSTOM_COVER_KEY) continue;
        await new Promise((res, rej) => {
          const tx = db.transaction(DB_OFFLINE, 'readwrite');
          const rq = tx.objectStore(DB_OFFLINE).delete(k);
          rq.onsuccess = () => res();
          rq.onerror = () => rej(rq.error);
        });
      }
    } catch (e) { /* ignore */ }
    return live.map((r) => ({
      id: r.id, title: r.title, artist: r.artist, album: r.album,
      duration: r.duration, color: r.color, dbId: r.id,
      source: r.source || 'local', videoId: r.videoId || null, thumbnail: r.thumbnail || null,
    }));
  } catch (e) { return []; }
}

/* ============================================================
   Stats
   ============================================================ */

function animateNumber(el, target, suffix = '') {
  if (!el) return;
  if (window.SpringUI) { SpringUI.springCount(el, target); return; }
  el.textContent = target + suffix;
}

let _usTracksRef = null;
let _usKey = '';
function updateStats() {
  const tracks = state.tracks;
  const plTracks = playlists.reduce((s, p) => s + (p.tracks ? p.tracks.length : 0), 0);
  const key = tracks.length + ':' + favorites.length + ':' + playlists.length + ':' + plTracks + ':' + history.length;
  if (tracks === _usTracksRef && key === _usKey) return;
  _usTracksRef = tracks;
  _usKey = key;
  const total = tracks.length;
  animateNumber($('#statTracks'), total);
  const artists = new Set(tracks.map((t) => (t.artist || '').toLowerCase()).filter(Boolean));
  animateNumber($('#statArtists'), artists.size);
  const totalSec = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  $('#statDuration').textContent = h > 0 ? `${h} ч ${m} мин` : `${m || 0} мин`;
  animateNumber($('#statFavorites'), favorites.length);
  const tl = $('#statTracksLabel');
  if (tl) tl.textContent = `${capitalize(plural(total))} в коллекции`;
  const al = $('#statArtistsLabel');
  if (al) al.textContent = capitalize(pluralRu(artists.size, 'исполнитель', 'исполнителя', 'исполнителей'));
  const fc = $('#favCount');
  if (fc) fc.textContent = favorites.length ? `${favorites.length} ${plural(favorites.length)}` : '';
  $$('[data-plsys="fav"] .playlist-info small').forEach((el) => {
    el.textContent = `${favorites.length} ${plural(favorites.length)}`;
  });
  renderPlaylists();
  renderTopArtists();
}

function pluralRu(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function plural(n) {
  return pluralRu(n, 'трек', 'трека', 'треков');
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/* ============================================================
   Stats dashboard («Мой год в Umbrella»)
   ============================================================ */

const DAY_MS = 86400000;
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
let statPeriod = 'all';

function statPeriodMs() {
  if (statPeriod === '7') return 7 * DAY_MS;
  if (statPeriod === '30') return 30 * DAY_MS;
  if (statPeriod === '365') return 365 * DAY_MS;
  return Infinity;
}

function fmtStatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m || 0} мин`;
}

function renderStatsDashboard() {
  const wrap = $('#statsDashboard');
  const empty = $('#statsEmpty');
  if (!wrap || !empty) return;
  const since = Date.now() - statPeriodMs();
  const rows = listenLog.filter((h) => (h.at || 0) >= since);

  if (!rows.length) {
    wrap.hidden = true;
    empty.hidden = false;
    return;
  }
  wrap.hidden = false;
  empty.hidden = true;

  const realSec = listenSecInPeriod(since);
  const totalSec = realSec > 0
    ? realSec
    : rows.reduce((s, r) => s + (r.duration || 0), 0);
  animateNumber($('#lstatPlays'), rows.length);
  $('#lstatTime').textContent = fmtStatTime(totalSec);
  const artSet = new Set(rows.map((r) => (r.artist || '').toLowerCase()).filter(Boolean));
  animateNumber($('#lstatArtists'), artSet.size);
  const trkSet = new Set(rows.map((r) => (r.scId || r.scUrl || `${r.title}|${r.artist}`).toLowerCase()));
  animateNumber($('#lstatTracks'), trkSet.size);

  renderStatBars($('#topArtists'), aggStats(rows, (r) => r.artist || 'Неизвестный исполнитель', (r) => r.title || ''));
  renderStatBars($('#topTracks'), aggStats(rows, (r) => (r.title || 'Без названия') + (r.artist ? ' — ' + r.artist : ''), (r) => r.artist || ''));
  renderHeatmap(rows);
  renderHourGrid(rows);
  renderDayGrid(rows);
}

function aggStats(rows, nameFn, subFn) {
  const map = new Map();
  rows.forEach((r) => {
    const name = nameFn(r);
    const e = map.get(name);
    if (e) e.count++;
    else map.set(name, { name, sub: subFn(r), count: 1 });
  });
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 5);
}

function renderStatBars(container, items) {
  if (!container) return;
  if (!items.length) { container.innerHTML = '<div class="stat-nodata">Нет данных</div>'; return; }
  const max = items[0].count;
  container.innerHTML = items.map((it) => `
    <div class="stat-bar-row">
      <div class="stat-bar-label"><b>${escapeHtml(it.name)}</b>${it.sub ? `<span>${escapeHtml(it.sub)}</span>` : ''}</div>
      <div class="stat-bar-track"><i class="stat-bar-fill" style="width:${max ? Math.round((it.count / max) * 100) : 0}%"></i></div>
      <div class="stat-bar-val">${it.count}</div>
    </div>`).join('');
}

function renderHeatmap(rows) {
  const hm = $('#listenHeatmap');
  if (!hm) return;
  const byDay = new Map();
  rows.forEach((r) => {
    const day = Math.floor((r.at || 0) / DAY_MS) * DAY_MS;
    byDay.set(day, (byDay.get(day) || 0) + 1);
  });
  const counts = [...byDay.values()];
  const max = Math.max(1, ...counts);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 363);
  const pad = start.getDay();
  const cells = [];
  for (let i = 0; i < 364; i++) {
    const d = new Date(start.getTime() + i * DAY_MS);
    cells.push({ d, v: byDay.get(d.getTime()) || 0 });
  }
  let html = '';
  for (let w = 0; w < 53; w++) {
    let col = '';
    for (let r = 0; r < 7; r++) {
      const idx = w * 7 + r - pad;
      const cell = cells[idx];
      if (!cell) { col += '<i class="hm-cell empty"></i>'; continue; }
      const lvl = cell.v ? Math.max(1, Math.min(4, Math.ceil((cell.v / max) * 4))) : 0;
      col += `<i class="hm-cell lv${lvl}" title="${cell.d.toLocaleDateString('ru-RU')}: ${cell.v} ${plural(cell.v)}"></i>`;
    }
    html += `<div class="hm-col">${col}</div>`;
  }
  hm.innerHTML = html;
}

function renderHourGrid(rows) {
  const g = $('#hourGrid');
  if (!g) return;
  const hours = new Array(24).fill(0);
  rows.forEach((r) => { hours[new Date(r.at || 0).getHours()]++; });
  const max = Math.max(1, ...hours);
  g.innerHTML = hours.map((v, h) => `
    <div class="hgrid-cell" title="${h}:00 — ${v}">
      <i class="hgrid-bar" style="height:${Math.round((v / max) * 100)}%"></i>
      <span>${h}</span>
    </div>`).join('');
}

function renderDayGrid(rows) {
  const g = $('#dayGrid');
  if (!g) return;
  const days = new Array(7).fill(0);
  rows.forEach((r) => { days[new Date(r.at || 0).getDay()]++; });
  const order = [1, 2, 3, 4, 5, 6, 0];
  const max = Math.max(1, ...days);
  g.innerHTML = order.map((d) => `
    <div class="dgrid-cell">
      <i class="dgrid-bar" style="height:${Math.round((days[d] / max) * 100)}%"></i>
      <span>${WEEKDAYS[d === 0 ? 6 : d - 1]}</span>
    </div>`).join('');
}

/* ============================================================
   Playlists (artists grid)
   ============================================================ */

// ↔ config.py PLAYLIST_GRADIENTS — синхронизировать при изменении
const PLAYLIST_ARTS = [
  'linear-gradient(145deg,#362a68,#b03066 52%,#111)',
  'linear-gradient(145deg,#cc8a54,#734343 50%,#1f2539)',
  'linear-gradient(145deg,#072f39,#278889 48%,#d4a447)',
  'linear-gradient(145deg,#242642,#77499c 48%,#df657c)',
  'linear-gradient(145deg,#1a3a2a,#43d68f 50%,#15303a)',
  'linear-gradient(145deg,#3a1a2e,#e04070 48%,#1a1028)',
];

/* Группирует библиотеку по исполнителям: [{ title, indices, tracks }] */
function artistGroups(tracks) {
  const byArtist = {};
  tracks.forEach((t, i) => {
    const a = t.artist || 'Неизвестный исполнитель';
    if (!byArtist[a]) byArtist[a] = { title: a, indices: [], tracks: [] };
    byArtist[a].indices.push(i);
    byArtist[a].tracks.push(t);
  });
  return Object.values(byArtist);
}

/* CSS-значение для фоновой картинки группы: обложка трека или градиент */
function groupArt(group, i) {
  const withArt = group.tracks.find((t) => t.thumbnail || t.cover);
  if (withArt) return `url("${(withArt.thumbnail || withArt.cover).replace(/"/g, '%22')}")`;
  const colored = group.tracks.find((t) => t.color);
  if (colored) return colored.color;
  return PLAYLIST_ARTS[i % PLAYLIST_ARTS.length];
}

/* Кнопка «Показать всё / Свернуть»: прячется, если разворачивать нечего */
function syncShowAll(btn, total, expanded) {
  if (!btn) return;
  btn.hidden = total <= APP_CONFIG.playlistGridLimit;
  btn.textContent = expanded ? '← Свернуть' : 'Показать всё →';
}

const HERO_WAVE = `<svg class="hero-wave" viewBox="0 0 260 120" preserveAspectRatio="none" aria-hidden="true">
  <path d="M0 60C34 60 40 26 74 26s40 68 74 68 40-68 74-68 34 34 68 34" fill="none" stroke="hsla(var(--dyn-h),80%,66%,.35)" stroke-width="1.1"/>
  <path d="M0 74C34 74 40 40 74 40s40 68 74 68 40-68 74-68 34 34 68 34" fill="none" stroke="hsla(var(--dyn-h),80%,66%,.22)" stroke-width="1"/>
  <path d="M0 46C34 46 40 12 74 12s40 68 74 68 40-68 74-68 34 34 68 34" fill="none" stroke="hsla(calc(var(--dyn-h) + 50),80%,68%,.18)" stroke-width="1"/>
</svg>`;

/* «Недавно добавленные» — широкие карточки по исполнителям */
function renderPlaylists() {
  const grid = $('#playlistGrid');
  if (!grid) return;
  const tracks = state.tracks;
  if (!tracks.length) {
    grid.innerHTML = '<div class="empty-hint" style="color:var(--text-3);font-size:12.5px">Здесь появятся исполнители, как только вы добавите треки.</div>';
    syncShowAll($('#showAll'), 0, false);
    return;
  }
  const all = artistGroups(tracks);
  const groups = state.heroExpanded ? all : all.slice(0, APP_CONFIG.playlistGridLimit);
  syncShowAll($('#showAll'), all.length, state.heroExpanded);
  grid.innerHTML = groups.map((g, i) => {
    const art = groupArt(g, i);
    const label = g.title.replace(/(.{9}).*/, '$1').toUpperCase();
    const total = g.tracks.reduce((s, t) => s + (t.duration || 0), 0);
    const meta = `${g.indices.length} ${plural(g.indices.length)}${total ? ` &bull; ${formatDuration(total)}` : ''}`;
    return `<article class="playlist-card hero" style="--art:${art}" data-artist="${escapeHtml(g.title)}">
      <div class="hero-art"><span>${escapeHtml(label)}</span></div>
      <div class="hero-body">
        ${HERO_WAVE}
        <b>${escapeHtml(g.title)}</b>
        <small>${meta}</small>
        <button class="card-play" data-artist="${escapeHtml(g.title)}" aria-label="Воспроизвести">${icons.play}</button>
      </div>
    </article>`;
  }).join('');
}

/* «Популярные исполнители» — круглые аватарки из обложек треков */
function renderTopArtists() {
  const row = $('#topArtistsRow');
  if (!row) return;
  const tracks = state.tracks;
  if (!tracks.length) {
    row.innerHTML = '<div class="empty-hint">Добавьте треки — здесь появятся ваши исполнители.</div>';
    syncShowAll($('#showAllArtists'), 0, false);
    return;
  }
  const ranked = artistGroups(tracks).sort((a, b) => b.indices.length - a.indices.length);
  const groups = state.artistsExpanded ? ranked : ranked.slice(0, APP_CONFIG.playlistGridLimit);
  syncShowAll($('#showAllArtists'), ranked.length, state.artistsExpanded);
  row.innerHTML = groups.map((g, i) => {
    const art = groupArt(g, i);
    const initial = escapeHtml((g.title.trim()[0] || '?').toUpperCase());
    const hasImage = art.startsWith('url(');
    return `<button class="artist-bubble" data-artist="${escapeHtml(g.title)}" title="${escapeHtml(g.title)}">
      <span class="artist-ava" style="--cover:${art}">${hasImage ? '' : initial}</span>
      <b>${escapeHtml(g.title)}</b>
      <small>${g.indices.length} ${plural(g.indices.length)}</small>
    </button>`;
  }).join('');
}

const PL_ICON_HEART = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.5s-7.5-4.7-9.4-9.3C1.2 8 2.9 4.7 6 4.2c1.9-.3 3.7.6 4.6 2.1L12 8.3l1.4-2c.9-1.5 2.7-2.4 4.6-2.1 3.1.5 4.8 3.8 3.4 7-1.9 4.6-9.4 9.3-9.4 9.3z"/></svg>';
const PL_ICON_LIST = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h11"/><path d="M4 12h11"/><path d="M4 18h7"/><path d="M17 17.5V9l4 1.6"/><circle cx="15.6" cy="18" r="1.9"/></svg>';
const PL_ICON_PLUS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';

/* Обложка пользовательского плейлиста: картинка первого трека или градиент */
function playlistArt(pl, i) {
  const withArt = (pl.tracks || []).find((t) => t.thumbnail || t.cover);
  if (withArt) return `url("${(withArt.thumbnail || withArt.cover).replace(/"/g, '%22')}") center/cover`;
  return PLAYLIST_ARTS[i % PLAYLIST_ARTS.length];
}

function playlistCardsHtml() {
  const favCard = `<article class="playlist-card sys" data-plsys="fav" style="--art:linear-gradient(150deg,#3b2a6b,#6d3f8f 55%,#1a1230)">
      <div class="playlist-art"><span>${PL_ICON_HEART}</span></div>
      <div class="playlist-info"><b>Избранное</b><small>${favorites.length} ${plural(favorites.length)}</small></div>
    </article>`;
  const userCards = playlists.map((p, i) => {
    const art = playlistArt(p, i);
    return `<article class="playlist-card custom" style="--art:${art}" data-plid="${escapeHtml(p.id)}">
      <div class="playlist-art"><span>${PL_ICON_LIST}</span></div>
      <div class="playlist-info"><b>${escapeHtml(p.name)}</b><small>${p.tracks.length} ${plural(p.tracks.length)}</small></div>
      <button class="card-play" data-plid="${escapeHtml(p.id)}" aria-label="Воспроизвести">${icons.play}</button>
      <button class="card-del" data-plid="${escapeHtml(p.id)}" aria-label="Удалить плейлист" title="Удалить плейлист">${icons.trash}</button>
    </article>`;
  }).join('');
  const newCard = `<article class="playlist-card new-card" data-plsys="new">
      <i>${PL_ICON_PLUS}</i>
      <b>Создать плейлист</b>
    </article>`;
  return favCard + userCards + newCard;
}

function renderCustomPlaylists() {
  const html = playlistCardsHtml();
  const grid = $('#customPlaylistGrid');
  if (grid) grid.innerHTML = html;
  const all = $('#allPlaylistGrid');
  if (all) all.innerHTML = html;
}

/* Подсказки на вкладке «Радио»: исполнители из библиотеки, иначе — дефолтные */
function renderRadioSuggest() {
  const box = $('#radioSuggest');
  if (!box) return;
  const mine = artistGroups(state.tracks)
    .sort((a, b) => b.indices.length - a.indices.length)
    .slice(0, APP_CONFIG.recentBlockMax + 2)
    .map((g) => g.title);
  const names = mine.length ? mine : APP_CONFIG.fallbackArtists;
  box.innerHTML = names.map((n) => `<button type="button">${escapeHtml(n)}</button>`).join('');
}

async function createPlaylistFlow() {
  const name = await promptDialog({ title: 'Новый плейлист', placeholder: 'Название плейлиста' });
  if (!name) return;
  const id = createPlaylist(name);
  showPlaylistPage(id);
}

function showPlaylistPage(playlistId) {
  const pl = playlists.find((p) => p.id === playlistId);
  if (!pl) return;
  if ($('#albumDetail') && !$('#albumDetail').hidden) closeAlbumDetail();
  if ($('#artistDetail') && !$('#artistDetail').hidden) closeArtistPage();
  const detail = $('#playlistDetail');
  detail.hidden = false;
  cleanArtistScene();
  const tracks = pl.tracks.map(playlistTrackToRecord);
  const h = extractHue(state.currentTrack?.color) || effectiveHue();
  const rgb = hslToRgbString(h, 55, 45);
  const root = document.documentElement;
  root.style.setProperty('--artist-rgb', rgb);
  const listHtml = tracks.length
    ? tracks.map((t, i) => `
      <div class="album-detail-row" data-idx="${i}">
        ${t.thumbnail ? `<img class="sc-thumb-sm" src="${escapeHtml(t.thumbnail)}" alt="" loading="lazy" />` : `<span class="pos">${String(i + 1).padStart(2, '0')}</span>`}
        <span class="name">${escapeHtml(t.title)}</span>
        <span class="artist-sub">${escapeHtml(t.artist)}</span>
        <span class="dur">${formatDuration(t.duration)}</span>
        <button class="row-del" data-key="${escapeHtml(favKey(t))}" aria-label="Убрать из плейлиста" title="Убрать">${icons.trash}</button>
      </div>`).join('')
    : '<p style="color:var(--text-3);padding:20px 0">Плейлист пуст. Добавьте треки кнопкой «В плейлист».</p>';
  detail.innerHTML = `
  <div class="album-detail-view">
    <canvas class="artist-waves" id="artistWaves"></canvas>
    <div class="album-detail-fade"></div>
    <div class="album-detail-left">
      <button class="btn-back" id="plBack"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg>Назад</button>
      <div class="album-detail-header">
        <div class="album-detail-info">
          <h2>${escapeHtml(pl.name)}</h2>
          <p>${tracks.length} ${plural(tracks.length)}</p>
          <div class="artist-actions">
            <button class="btn btn-primary btn-sm" id="plPlayAll">${icons.play}<span>Слушать все</span></button>
            <button class="btn btn-ghost btn-sm" id="plRadio"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/></svg><span>Радио</span></button>
            <button class="btn btn-ghost btn-sm" id="plRename"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span>Переименовать</span></button>
            <button class="btn btn-danger btn-sm" id="plDelete">${icons.trash}<span>Удалить</span></button>
          </div>
        </div>
      </div>
      <div class="album-detail-tracks">${listHtml}</div>
    </div>
    <div class="album-detail-right">
      <div class="album-bio-backdrop" style="background:radial-gradient(ellipse at 50% 50%, rgba(var(--artist-rgb),.14) 0%, transparent 70%)"></div>
    </div>
  </div>`;
  $('#plBack').onclick = closePlaylistPage;
  $('#plPlayAll').onclick = () => { closePlaylistPage(); playPlaylist(playlistId); };
  $('#plRadio').onclick = () => startPlaylistRadio(playlistId);
  $('#plRename').onclick = async () => {
    const name = await promptDialog({ title: 'Переименовать плейлист', placeholder: 'Название', initial: pl.name, confirmText: 'Сохранить' });
    if (!name) return;
    renamePlaylist(playlistId, name);
    showPlaylistPage(playlistId);
  };
  $('#plDelete').onclick = async () => {
    const ok = await confirmDialog({ title: 'Удалить плейлист?', body: `«${pl.name}» будет удалён безвозвратно.`, confirmText: 'Удалить' });
    if (!ok) return;
    closePlaylistPage();
    deletePlaylist(playlistId);
  };
  detail.querySelectorAll('.album-detail-row').forEach((row) => {
    const del = row.querySelector('.row-del');
    if (del) {
      del.onclick = (e) => {
        e.stopPropagation();
        const removed = removeFromPlaylist(playlistId, del.dataset.key);
        if (!removed) return;
        showPlaylistPage(playlistId);
        toast('Трек убран из плейлиста', 'info', 5000, {
          label: 'Отменить',
          onClick: () => restorePlaylistTrack(playlistId, removed),
        });
        return;
      };
      return;
    }
    row.onclick = () => playPlaylistTrack(playlistId, Number(row.dataset.idx));
  });
  animateAlbumDetail();
}

function closePlaylistPage() {
  teardownArtistScene();
  const detail = $('#playlistDetail');
  if (!detail) return;
  detail.hidden = true;
  detail.innerHTML = '';
}

function hslToRgbString(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return `${Math.round((r + m) * 255)}, ${Math.round((g + m) * 255)}, ${Math.round((b + m) * 255)}`;
}

/* ============================================================
   Track rows
   ============================================================ */

function isCurrent(track) {
  const c = state.currentTrack;
  if (!c) return false;
  if (track.scId && c.scId) return track.scId === c.scId;
  if (track.dbId && c.dbId) return track.dbId === c.dbId;
  return c.title === track.title && c.artist === track.artist;
}

function trackRow(track, index, mode) {
  const title = escapeHtml(track.title || 'Без названия');
  const artist = escapeHtml(track.artist || 'Неизвестный исполнитель');
  const isSc = track.source === 'soundcloud';
  const playing = !(mode === 'search') && isCurrent(track);
  const numContent = playing ? icons.eq : String(index + 1).padStart(2, '0');
  const art = track.thumbnail || track.cover;
  const thumb = (isSc && art)
    ? `<img class="sc-thumb" src="${escapeHtml(art)}" alt="" loading="lazy" />`
    : `<span class="track-cover" style="--cover:${track.color || coverGradient(index)}"></span>`;
  const favBtn = `<button class="track-fav ${isFavTrack(track) ? 'active' : ''}" data-fav="${escapeHtml(favKey(track))}" aria-label="В избранное" title="В избранное">${icons.heart}</button>`;
  const plBtn = `<button class="track-pl" data-pl aria-label="В плейлист" title="В плейлист"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg><span>В плейлист</span></button>`;
  const dlBtn = isSc ? `<button class="track-dl" data-dl="${escapeHtml(track.scId || track.url || '')}" aria-label="Скачать" title="Скачать в библиотеку">${icons.download}<span>Скачать в библиотеку</span></button>` : '';
  const delBtn = (mode === 'library') ? `<button class="track-del" data-del="${track.id}" aria-label="Удалить" title="Удалить из библиотеки">${icons.trash}<span>Удалить из библиотеки</span></button>` : '';
  const menu = `<span class="track-more-wrap"><button class="track-more" aria-label="Ещё" title="Ещё">${icons.more}</button><span class="track-menu" hidden>${plBtn}${dlBtn}${delBtn}</span></span>`;
  const album = isSc ? 'SoundCloud' : escapeHtml(track.album || '');
  const actionLabel = 'Играть';
  return `<article class="track-row ${playing ? 'playing' : ''}" data-index="${index}" data-source="${mode}" draggable="true" title="Играть · перетащите на вертушку, чтобы поставить пластинку">
    <span class="track-number">${numContent}</span>
    <div class="track-main">${thumb}<span class="track-meta"><b>${title}</b><small class="track-artist">${artist}</small></span></div>
    <span class="album">${album}</span>
    <span class="duration">${formatDuration(track.duration)}</span>
    <div class="track-btns">${favBtn}${menu}</div>
    <button class="track-action" aria-label="${actionLabel}" title="${actionLabel}">${icons.play}</button>
  </article>`;
}

function renderTracks(animate = true) {
  const query = ($('#filterInput').value || '').trim().toLowerCase();
  // Показываем ВСЕ треки (локальные и из SoundCloud)
  let tracks = state.tracks.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(query));
  if (!state.sortNewest) tracks = [...tracks].reverse();
  state.visibleTracks = tracks;
  const list = $('#trackList');
  list.innerHTML = tracks.length
    ? tracks.map((t, i) => trackRow(t, i, 'library')).join('')
    : `<div class="empty-search"><div class="empty-illu">${icons.heart}</div><h2>Треки не найдены</h2><p>Добавьте трек с устройства или найдите его в SoundCloud.</p></div>`;
  updateStats();
  if (animate && window.gsap && tracks.length && !reduceMotion()) {
    gsap.fromTo('#trackList .track-row',
      { opacity: 0, y: 16, scale: 0.98 },
      { opacity: 1, y: 0, scale: 1, duration: 0.35, ease: 'power2.out', stagger: 0.025, clearProps: 'transform' });
  }
}

function renderFavorites() {
  const list = $('#favoritesList');
  if (!list) return;
  if (!favorites.length) {
    list.innerHTML = `<div class="empty-search"><div class="empty-illu">${icons.heart}</div><h2>Пока пусто</h2><p>Нажимайте на сердечко у треков, чтобы собирать свою коллекцию.</p></div>`;
    return;
  }
  const recs = favorites.map(favRecordToTrack);
  state.visibleTracks = recs;
  list.innerHTML = recs.map((t, i) => trackRow(t, i, 'favorites')).join('');
  if (window.gsap && !reduceMotion()) {
    gsap.fromTo('#favoritesList .track-row',
      { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out', stagger: 0.03, clearProps: 'transform' });
  }
}

/* ============================================================
   Player
   ============================================================ */

function effectiveDuration() {
  const el = djActiveElement();
  const elDur = el.duration;
  if (elDur && isFinite(elDur)) return elDur;
  const cur = djDecks.b && djDecks.b.track;
  if (el === audioB && cur && cur.duration) return cur.duration;
  return (state.currentTrack ? state.currentTrack.duration || 0 : 0);
}

async function resolveTrack(track) {
  if (track.dbId) {
    const blob = await getBlobFromIDB(track.dbId);
    if (!blob) throw new Error('Файл не найден в хранилище');
    if (track._blobUrl) URL.revokeObjectURL(track._blobUrl);
    track._blobUrl = URL.createObjectURL(blob);
    return track._blobUrl;
  }
  if ((!track.scUrl && !track.scId) && track._needsLookup) {
    const data = await request(`/sc/search?q=${encodeURIComponent(track._needsLookup)}&count=1`, { timeout: API_TIMEOUT.default });
    const found = (data.tracks || [])[0];
    if (!found) throw new Error('Трек не найден в SoundCloud');
    track.scUrl = found.url;
    track.scId = found.id;
    track.source = 'soundcloud';
    track.thumbnail = track.thumbnail || found.thumbnail || '';
    track.duration = track.duration || found.duration || 0;
    track._needsLookup = null;
  }
  if (track.source === 'zvuk') {
    const zid = track.zvukId || track.id;
    if (!zid) throw new Error('Нет ID трека Zvuk');
    return `${API}/zvuk/stream?trackId=${encodeURIComponent(zid)}`;
  }
  if (track.source === 'soundcloud') {
    if (track.path) return `${API}/sc/file?path=${encodeURIComponent(track.path)}`;
    const scUrl = track.scUrl || track.url;
    if (!scUrl) throw new Error('Нет ссылки на трек SoundCloud');
    return `${API}/sc/stream?url=${encodeURIComponent(scUrl)}`;
  }
   if (track.previewUrl) return track.previewUrl;
   if (track.url) return track.url;
   throw new Error('Ссылка на аудиопоток отсутствует');
 }

function revokeCurrentURL() {
  if (state.currentTrack && state.currentTrack._blobUrl) {
    URL.revokeObjectURL(state.currentTrack._blobUrl);
    state.currentTrack._blobUrl = null;
  }
}

function setPlayIcons(paused) {
  const npIcon = $('#npPlayIcon');
  if (npIcon) npIcon.innerHTML = paused
    ? '<polygon points="8,5 20,12 8,19"/>'
    : '<rect x="7.5" y="5" width="3.5" height="14" rx="1"/><rect x="13" y="5" width="3.5" height="14" rx="1"/>';
  const pbIcon = $('#pbPlayIcon');
  if (pbIcon) pbIcon.innerHTML = paused
    ? '<polygon points="8,5 20,12 8,19"/>'
    : '<rect x="6.5" y="5.5" width="3.5" height="13" rx="1"/><rect x="14" y="5.5" width="3.5" height="13" rx="1"/>';
}

async function playTrack(track, index) {
  if (!track?._keepAlbumOpen) clearAlbumQueueLoading();
  const side = state._activeAudioSide === 'a' && !audio.paused ? 'b' : 'a';
  return playTrackOn(track, index, side);
}

function activeAudio() {
  return state._activeAudioSide === 'b' ? audioB : audio;
}

function activeGain() {
  return state._activeAudioSide === 'b' ? djGainB : djGainA;
}

function deckGain(side) {
  return side === 'b' ? djGainB : djGainA;
}

let coreTransition = null;

function startCoreTransition(nextSide) {
  const oldSide = state._activeAudioSide;
  const oldEl = activeAudio();
  if (oldSide === nextSide || oldEl.paused || !state.currentTrack) return null;
  const transition = {
    oldSide,
    oldEl,
    oldVolume: oldEl.volume,
    oldRate: oldEl.playbackRate || 1,
    newVolume: preferredVolume,
  };
  coreTransition = transition;
  if (window.gsap && !reduceMotion()) {
    gsap.to(oldEl, { playbackRate: Math.max(0.72, transition.oldRate * 0.82), duration: 0.85, ease: 'power2.out' });
  } else {
    oldEl.playbackRate = Math.max(0.72, transition.oldRate * 0.82);
  }
  return transition;
}

function cancelCoreTransition() {
  const transition = coreTransition;
  if (!transition) return;
  if (!transition.oldEl.paused) {
    if (window.gsap && !reduceMotion()) {
      gsap.to(transition.oldEl, { playbackRate: transition.oldRate, volume: transition.oldVolume, duration: 0.3, ease: 'power2.out' });
      gsap.to(transition.oldEl, { volume: transition.oldVolume, duration: 0.3 });
    } else {
      transition.oldEl.playbackRate = transition.oldRate;
      transition.oldEl.volume = transition.oldVolume;
    }
    updateVolUI(preferredVolume);
  }
  coreTransition = null;
}

function completeCoreTransition(nextEl, nextSide) {
  const transition = coreTransition;
  const targetVolume = preferredVolume;
  const targetRate = 1;
  nextEl.volume = 0;
  nextEl.playbackRate = 0.82;
  state._activeAudioSide = nextSide;

  if (audioCtx && djGainA && djGainB) {
    const now = audioCtx.currentTime;
    const nextGain = deckGain(nextSide);
    const oldGain = transition ? deckGain(transition.oldSide) : null;
    nextGain.gain.cancelScheduledValues(now);
    nextGain.gain.setValueAtTime(0, now);
    nextGain.gain.linearRampToValueAtTime(1, now + 1.05);
    if (oldGain && transition) {
      oldGain.gain.cancelScheduledValues(now);
      oldGain.gain.setValueAtTime(oldGain.gain.value, now);
      oldGain.gain.linearRampToValueAtTime(0, now + 1.05);
    }
  }

  if (window.gsap && !reduceMotion()) {
    gsap.to(nextEl, { volume: targetVolume, playbackRate: targetRate, duration: 1.05, ease: 'power2.out' });
    if (transition) {
      gsap.to(transition.oldEl, {
        volume: 0,
        playbackRate: Math.max(0.65, transition.oldRate * 0.72),
        duration: 1.05,
        ease: 'power2.in',
        onComplete: () => {
          transition.oldEl.pause();
          transition.oldEl.volume = transition.oldVolume;
          transition.oldEl.playbackRate = transition.oldRate;
        },
      });
    }
  } else {
    nextEl.volume = targetVolume;
    nextEl.playbackRate = targetRate;
    if (transition) transition.oldEl.pause();
  }
  coreTransition = null;
}

async function playTrackOn(track, index, side) {
  if (!track) return;
  const gen = ++state._trackGen;
  const el = djDeckEl(side);
  const isB = side === 'b';
  const ov = $('#vinylOverlay');
  const opensFullscreen = (!ov || ov.hidden) && !track._keepAlbumOpen;
  if (opensFullscreen) showPlaybackLoading(track);
  const transition = startCoreTransition(side);
  revokeDeckURL(side);
  el.loop = state.repeat;

  let url;
  try {
    url = await resolveTrack(track);
  } catch (e) {
    cancelCoreTransition();
    el.playbackRate = 1;
    el.volume = preferredVolume;
    updateVolUI(preferredVolume);
    clearAlbumQueueLoading();
    hidePlaybackLoading();
    return toast(e.message, 'error');
  }
  if (gen !== state._trackGen) {
    cancelCoreTransition();
    el.playbackRate = 1;
    el.volume = preferredVolume;
    updateVolUI(preferredVolume);
    return;
  }

  if (isB && state.hlsB) { state.hlsB.destroy(); state.hlsB = null; }
  if (!isB && state.hls) { state.hls.destroy(); state.hls = null; }
  el.pause();
  el.dataset.targetVolume = String(preferredVolume);
  el.volume = 0;
  el.playbackRate = 0.82;
  if (audioCtx && deckGain(side)) {
    const gain = deckGain(side);
    gain.gain.cancelScheduledValues(audioCtx.currentTime);
    gain.gain.setValueAtTime(0, audioCtx.currentTime);
  }
  
  // Ошибка сети/декодирования: один повтор со свежей подписью потока
  // (подписанные URL SoundCloud протухают), затем честная ошибка.
  const retryStreamPlayback = () => {
    if (gen !== state._trackGen) return true;
    // error и play().catch() могут прийти почти одновременно. Если повтор
    // уже запланирован, считаем сбой обработанным и не пугаем пользователя.
    if (track._retryPending) return true;
    const attempts = Number(track._playAttempts || 0);
    if (attempts >= 1) return false;
    track._playAttempts = attempts + 1;
    track._retryPending = true;
    showPlaybackLoading(track);
    setTimeout(() => {
      track._retryPending = false;
      playTrackOn(track, index, side);
    }, 700);
    return true;
  };

  // Ошибка сети/декодирования сначала получает свежий поток.
  const errorHandler = () => {
    const err = el.error;
    if (!err) return;
    
    const errMsg = {
      1: 'Загрузка прервана',
      2: 'Ошибка сети',
      3: 'Ошибка декодирования',
      4: 'Формат не поддерживается'
    }[err.code] || `Ошибка ${err.code}`;
    
    console.error(`[Player] Ошибка воспроизведения ${track.title}: ${errMsg}`, err);
    
    if (retryStreamPlayback()) {
      console.warn(`[Player] Повтор потока ${track._playAttempts}/1: ${track.title}`);
      el.removeEventListener('error', errorHandler);
    } else {
      cancelCoreTransition();
      el.playbackRate = 1;
      el.volume = preferredVolume;
      updateVolUI(preferredVolume);
      clearAlbumQueueLoading();
      hidePlaybackLoading();
      schedulePlaybackError(`Не удалось воспроизвести: ${errMsg}`);
    }
  };
  
  el.removeEventListener('error', errorHandler);
  el.addEventListener('error', errorHandler, { once: true });
  const playingHandler = () => {
    if (gen !== state._trackGen) return;
    el.removeEventListener('playing', playingHandler);
    track._playAttempts = 0;
    track._retryPending = false;
    clearTimeout(playbackErrorTimer);
    completeCoreTransition(el, side);
    setPlayIcons(false);
    updateVolUI(el.dataset.targetVolume ? Number(el.dataset.targetVolume) : el.volume);
    updateBgState();
    syncVideo();
    if (Number.isInteger(track._albumRowIndex)) {
      highlightAlbumTrack(track._albumRowIndex);
      clearAlbumQueueLoading();
    }
    // Общий чёрный экран мог открыться во время автоматического retry.
    // Закрываем его при любом успешном старте, включая треки альбома.
    if (!opensFullscreen) {
      hidePlaybackLoading();
      return;
    }
    // Полноэкранный плеер открывается под загрузочным слоем, затем тот растворяется.
    if (ov && !ov.hidden) {
      if (!$('#nowPlaying').hidden) renderNowPlaying();
    } else {
      openNowPlaying();
    }
    setTimeout(hidePlaybackLoading, 130);
  };
  el.addEventListener('playing', playingHandler);
  
  const isHls = url.includes('.m3u8') || url.includes('mpegurl');
  if (settings.visualizer) {
    ensureAnalyser();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch((e) => console.warn('[Audio] resume before play failed', e));
    }
  }

  if (isHls) {
    if (!attachHlsOn(el, url, isB)) {
      el.src = url;
      el.play().catch((e) => {
        console.error('[Player] Play failed:', e);
        if (!retryStreamPlayback()) {
          cancelCoreTransition();
          el.playbackRate = 1;
          el.volume = preferredVolume;
          updateVolUI(preferredVolume);
          clearAlbumQueueLoading();
          hidePlaybackLoading();
          schedulePlaybackError('Не удалось воспроизвести трек');
        }
      });
    }
  } else {
    el.src = url;
    el.play().catch((e) => {
      console.error('[Player] Play failed:', e);
      if (!retryStreamPlayback()) {
        cancelCoreTransition();
        el.playbackRate = 1;
        el.volume = preferredVolume;
        updateVolUI(preferredVolume);
        clearAlbumQueueLoading();
        hidePlaybackLoading();
        schedulePlaybackError('Не удалось воспроизвести трек');
      }
    });
  }
  djDecks[side] = { el, track };

  if (vinylState.dj.master === side || (ov && ov.hidden)) {
    state.currentTrack = track;
    state._ending = false;
    // Очередь задаёт ВЫЗЫВАЮЩИЙ (список треков, альбом, результаты поиска).
    // Раньше здесь стояло `state.visibleTracks = [track]`, из-за чего очередь
    // схлопывалась в один трек и nextTrack() всегда возвращался на тот же.
    if (!Array.isArray(state.visibleTracks) || !state.visibleTracks.length) {
      state.visibleTracks = [track];
    }

    if (url !== state.waveUrl) {
      state.waveUrl = url;
      state.waveData = null;
      drawWaveform();
      generateWaveFor(track);
    }

    renderPlayerBar(track);
    addHistory(track);
    state._listenLogged = false;
    state._listenTrack = track;

    $$('.track-row').forEach((row) => row.classList.toggle('playing', Number(row.dataset.index) === index && row.dataset.source === (track._favSource || '')));
    updatePlayingGlow();
    renderQueue();
    refreshFavUI();
    syncVideo();
    updateVolUI(preferredVolume);
    if (navigator.mediaSession) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || '', artist: track.artist || '', album: track.album || '',
        artwork: track.thumbnail ? [{ src: track.thumbnail, sizes: '512x512' }] : [],
      });
    }
  }
  el.preservesPitch = false;
  updateDeckPlayingUI();
}

function playFromList(track, list, index) {
  state.visibleTracks = list;
  track._favSource = list === favorites.map(favRecordToTrack) ? 'favorites' : '';
  playTrack(track, index);
}

function renderPlayerBar(track) {
  const bar = $('#playerBar');
  if (!track) { bar.hidden = true; return; }
  bar.hidden = false;
  const art = track.thumbnail || track.cover;
  $('#playerCover').style.setProperty('--cover', art
    ? `url("${String(art).replace(/"/g, '%22')}") center/cover`
    : (track.color || `hsl(${extractHue(track.color)}, 60%, 45%)`));
  $('#playerTitle').textContent = track.title || 'Без названия';
  $('#playerArtist').textContent = track.artist || 'Неизвестный исполнитель';
  updatePlayerTime();
}

function renderNowPlaying() {
  const track = state.currentTrack;
  const wrap = $('#nowPlaying');
  if (!track) { wrap.hidden = true; return; }
  const trackArt = track.thumbnail || track.cover || '';
  $('#npArt').style.setProperty('--cover', trackArt
    ? `url(\"${String(trackArt).replace(/\"/g, '%22')}\") center/cover`
    : (track.color || `hsl(${extractHue(track.color)}, 60%, 42%)`));
  $('#npTitle').textContent = track.title || 'Без названия';
  $('#npArtist').textContent = track.artist || 'Неизвестный исполнитель';
  $('#npAlbum').textContent = track.album || 'Umbrella Player';
  setPlayIcons(audio.paused);
  applyDynamicTheme(track);
  updateBgState();
  syncVideo();
  renderCustomCover();
  updateVolUI(preferredVolume);
  refreshFavUI();
  updateLibraryButtonState();
  renderQueue();
  // При смене трека - только небольшой burst, без пересоздания всех частиц
  if (!wrap.hidden) {
    burstPS5Particles();
  }
}

const ps5Engine = (() => {
  let canvas, ctx, raf = 0, W = 0, H = 0, booted = false, gathering = false;
  let parts = [], extras = [];
  const mouse = { x: null, y: null, px: null, py: null, radius: 160, speed: 0 };
  let ox = 0, oy = 0, gx = 0, gy = 0;

  function resize() {
    if (!canvas) return;
    W = canvas.clientWidth; H = canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function measure() {
    if (!canvas) return;
    const cr = canvas.getBoundingClientRect();
    const art = $('#npArtWrap') || $('.np-art-wrap');
    const ar = art ? art.getBoundingClientRect() : null;
    ox = ar ? ar.left + ar.width / 2 - cr.left : cr.width / 2;
    oy = ar ? ar.top + ar.height / 2 - cr.top : cr.height / 2;
    const btn = $('#npPlay');
    const br = btn ? btn.getBoundingClientRect() : null;
    gx = br ? br.left + br.width / 2 - cr.left : cr.width / 2;
    gy = br ? br.top + br.height / 2 - cr.top : cr.height / 2;
  }

  class P {
    constructor(boot) {
      this.extra = false;
      this.dead = false;
      this.home = false;
      this.homing = false;
      this.bokeh = Math.random() > 0.65;
      this.size = this.bokeh ? Math.random() * 75 + 35 : Math.random() * 4.5 + 1.2;
      this.maxAlpha = this.bokeh ? Math.random() * 0.12 + 0.03 : Math.random() * 0.5 + 0.15;
      this.alpha = 0;
      this.blur = this.bokeh ? 12 : 0;
      this.wobbleSpeed = Math.random() * 0.02 + 0.005;
      this.wobbleWeight = Math.random() * 1.5 + 0.5;
      this.wobbleTime = Math.random() * 100;
      if (boot) {
        const r = Math.random() * 120;
        const a = Math.random() * Math.PI * 2;
        this.x = ox + Math.cos(a) * r;
        this.y = oy + Math.sin(a) * r;
        const sa = Math.random() * Math.PI * 2;
        const ss = Math.random() * 11 + 4;
        this.vx = Math.cos(sa) * ss;
        this.vy = Math.sin(sa) * ss;
      } else {
        this.x = Math.random() * W;
        this.y = H + this.size + Math.random() * 100;
        this.vx = (Math.random() - 0.5) * 0.8;
        this.vy = -(Math.random() * 1.2 + 0.6);
      }
    }
    reset() {
      this.bokeh = Math.random() > 0.65;
      this.size = this.bokeh ? Math.random() * 75 + 35 : Math.random() * 4.5 + 1.2;
      this.x = Math.random() * W;
      this.y = H + this.size + Math.random() * 100;
      this.vx = (Math.random() - 0.5) * 0.8;
      this.vy = -(Math.random() * 1.2 + 0.6);
      this.alpha = 0;
      this.maxAlpha = this.bokeh ? Math.random() * 0.14 + 0.04 : Math.random() * 0.5 + 0.2;
      this.blur = this.bokeh ? 12 : 0;
      this.homing = false;
      this.home = false;
    }
    update() {
      if (this.alpha < this.maxAlpha) this.alpha += 0.015;
      this.wobbleTime += this.wobbleSpeed;
      this.vx += Math.sin(this.wobbleTime) * this.wobbleWeight * 0.03;
      if (!gathering && mouse.x !== null && mouse.y !== null) {
        const dx = this.x - mouse.x;
        const dy = this.y - mouse.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < mouse.radius && d > 0.001) {
          const f = ((mouse.radius - d) / mouse.radius) * (1 + mouse.speed * 0.2);
          const push = f * (this.bokeh ? 0.6 : 3.8);
          this.vx += (dx / d) * push * 0.15 + (dy / d) * push * 0.03;
          this.vy += (dy / d) * push * 0.15 - (dx / d) * push * 0.03;
        }
      }
      if (gathering) {
        const dx = gx - this.x;
        const dy = gy - this.y;
        this.vx += dx * 0.02;
        this.vy += dy * 0.02;
        this.vx *= 0.86;
        this.vy *= 0.86;
        this.x += this.vx;
        this.y += this.vy;
        if (!this.home && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
          this.home = true;
          this.alpha *= 0.9;
        }
        if (this.home) this.alpha *= 0.96;
        return true;
      }
      this.vx *= 0.94;
      const tvy = -(this.bokeh ? 0.4 : 0.9);
      this.vy = this.vy * 0.94 + tvy * 0.06;
      this.x += this.vx;
      this.y += this.vy;
      if (!this.bokeh) {
        const tw = Math.sin(this.wobbleTime * 2.5) * 0.15;
        this.alpha = Math.max(0.1, Math.min(this.maxAlpha + tw, 1));
      }
      if (this.y < -this.size - 20 || this.x < -this.size - 20 || this.x > W + this.size + 20) {
        if (this.extra) return false;
        this.reset();
      }
      return true;
    }
    draw() {
      ctx.save();
      const sm = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
      if (sm > 2 && !this.bokeh) {
        ctx.translate(this.x, this.y);
        ctx.rotate(Math.atan2(this.vy, this.vx));
        ctx.scale(1 + sm * 0.12, 1);
        ctx.beginPath();
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, this.size);
        g.addColorStop(0, `rgba(250, 215, 145, ${this.alpha})`);
        g.addColorStop(1, 'rgba(225, 175, 95, 0)');
        ctx.fillStyle = g;
        ctx.arc(0, 0, this.size, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        if (this.bokeh) {
          ctx.shadowBlur = this.blur;
          ctx.shadowColor = `rgba(235, 195, 115, ${this.alpha * 0.6})`;
        }
        const g = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, this.size);
        g.addColorStop(0, `rgba(250, 215, 145, ${this.alpha})`);
        g.addColorStop(0.4, `rgba(225, 175, 95, ${this.alpha * 0.3})`);
        g.addColorStop(1, 'rgba(225, 175, 95, 0)');
        ctx.fillStyle = g;
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function loop() {
    ctx.clearRect(0, 0, W, H);
    parts = parts.filter(p => { const a = p.update(); if (a) p.draw(); return a; });
    extras = extras.filter(p => { const a = p.update(); if (a) p.draw(); return a; });
    raf = requestAnimationFrame(loop);
  }

  function onMove(e) {
    if (mouse.x !== null && mouse.px !== null) {
      mouse.speed = Math.min(Math.hypot(e.clientX - mouse.px, e.clientY - mouse.py), 50);
    }
    mouse.px = mouse.x; mouse.py = mouse.y;
    mouse.x = e.clientX; mouse.y = e.clientY;
  }
  function onLeave() { mouse.x = mouse.y = mouse.px = mouse.py = null; mouse.speed = 0; }
  function onDown(e) {
    if (gathering || !canvas) return;
    const cr = canvas.getBoundingClientRect();
    for (let i = 0; i < 15; i++) {
      const p = new P(false);
      p.extra = true;
      p.x = e.clientX - cr.left;
      p.y = e.clientY - cr.top;
      const a = Math.random() * Math.PI * 2;
      const s = Math.random() * 5 + 3;
      p.vx = Math.cos(a) * s;
      p.vy = Math.sin(a) * s;
      p.maxAlpha = Math.random() * 0.7 + 0.3;
      p.alpha = p.maxAlpha;
      extras.push(p);
    }
  }

  return {
    start(container) {
      if (reduceMotion()) return;
      if (!booted) {
        canvas = document.createElement('canvas');
        canvas.className = 'ps5-canvas';
        container.appendChild(canvas);
        ctx = canvas.getContext('2d');
        window.addEventListener('resize', resize);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseleave', onLeave);
        window.addEventListener('mousedown', onDown);
        booted = true;
      }
      cancelAnimationFrame(raf);
      gathering = false;
      extras = [];
      resize();
      measure();
      parts = [];
      for (let i = 0; i < 110; i++) parts.push(new P(true));
      for (let i = 0; i < 40; i++) parts.push(new P(false));
      loop();
    },
    burst() {
      if (!canvas || reduceMotion()) return;
      measure();
      for (let i = 0; i < 15; i++) {
        const p = new P(false);
        p.extra = true;
        p.x = ox; p.y = oy;
        const a = Math.random() * Math.PI * 2;
        const s = Math.random() * 9 + 4;
        p.vx = Math.cos(a) * s;
        p.vy = Math.sin(a) * s;
        p.maxAlpha = Math.random() * 0.6 + 0.3;
        p.alpha = p.maxAlpha;
        extras.push(p);
      }
    },
    gather() {
      if (!parts.length) return;
      measure();
      gathering = true;
      const btn = $('#npPlay');
      if (btn) btn.classList.add('particle-paused');
    },
    release() {
      if (!gathering) return;
      gathering = false;
      const btn = $('#npPlay');
      if (btn) btn.classList.remove('particle-paused');
      parts.forEach(p => {
        if (p.home) {
          p.home = false;
          p.x = gx + (Math.random() - 0.5) * 8;
          p.y = gy + (Math.random() - 0.5) * 8;
          const a = Math.random() * Math.PI * 2;
          const s = Math.random() * 8 + 3;
          p.vx = Math.cos(a) * s;
          p.vy = Math.sin(a) * s;
          p.alpha = 0;
        }
      });
    },
    stop() {
      cancelAnimationFrame(raf);
      if (ctx) ctx.clearRect(0, 0, W, H);
      gathering = false;
      parts = [];
      extras = [];
      const btn = $('#npPlay');
      if (btn) btn.classList.remove('particle-paused');
    },
  };
})();

function createPS5Particles() {
  const container = $('#npParticles');
  if (!container) return;
  ps5Engine.start(container);
}

function burstPS5Particles() { ps5Engine.burst(); }
function gatherPS5Particles() { ps5Engine.stop(); }
function gatherToPlayButton() { ps5Engine.gather(); }
function releaseFromPlayButton() { ps5Engine.release(); }
function updatePS5Particles() {
  if (settings.visualizer && !$('#nowPlaying').hidden) createPS5Particles();
}

function updateLibraryButtonState() {
  const btn = $('#npAddLibrary');
  if (!btn) return;
  const track = state.currentTrack;
  if (!track) {
    btn.classList.remove('active');
    return;
  }
  
  let inLibrary = false;

  // Для SoundCloud проверяем скачанные (библиотека = sc_music на диске)
  if (track.source === 'soundcloud') {
    inLibrary = isScDownloaded(track);
  }
  // Для локальных треков проверяем по dbId
  else if (track.dbId) {
    inLibrary = true;
  }
  // Для других источников проверяем по id
  else if (track.id) {
    inLibrary = state.tracks.some(t => t.id === track.id);
  }
  
  btn.classList.toggle('active', inLibrary);
  btn.title = inLibrary ? 'Трек в библиотеке' : 'Добавить в библиотеку';
  btn.setAttribute('aria-label', btn.title);
}

function openNowPlaying() {
  const np = $('#nowPlaying');
  if (!np) return;
  if (!np.hidden) { renderNowPlaying(); return; }
  np.hidden = false;
  np.classList.remove('closing', 'gsap-active');
  resetAnimation(np);
  renderNowPlaying();
  // После реального старта трека возвращаем фоновые частицы для сцены и паузы.
  createPS5Particles();
  
  if (window.gsap && !reduceMotion()) {
    np.classList.add('gsap-active');
    const tl = gsap.timeline({ onComplete: () => np.classList.remove('gsap-active') });
    tl.fromTo(np,
      { opacity: 0, rotateX: 70, scaleX: 0.6, scaleY: 0.6, filter: 'blur(10px) brightness(0.4)', transformOrigin: 'center 70%', transformPerspective: 900 },
      { opacity: 1, rotateX: 0, scaleX: 1, scaleY: 1, filter: 'blur(0px) brightness(1)', duration: 0.55, ease: 'back.out(1.3)' });
    tl.fromTo($('#npArt'), { scale: 0.7, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(1.6)' }, '-=0.35');
    tl.fromTo($('#npTitle'), { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 0.32, ease: 'power2.out' }, '-=0.3');
    tl.fromTo($('#npArtist'), { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.26, ease: 'power2.out' }, '-=0.22');
    tl.fromTo($('#npWave'), { scaleX: 0.3, opacity: 0 }, { scaleX: 1, opacity: 1, duration: 0.35, ease: 'power3.out' }, '-=0.22');
    tl.fromTo('.np-controls .np-btn', { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: 'back.out(2)', stagger: 0.04 }, '-=0.28');
    tl.fromTo('.np-extra > *', { y: 10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.25, ease: 'power2.out', stagger: 0.04 }, '-=0.22');
  } else {
    resetAnimation(np);
  }
}

function closeNowPlaying() {
  const np = $('#nowPlaying');
  const bar = $('#playerBar');
  if (!np || np.hidden) return;
  
  // Запускаем анимацию сборки частиц в центр
  gatherPS5Particles();
  
  if (window.gsap && !reduceMotion()) {
    np.classList.add('gsap-active');
    const tl = gsap.timeline({
      onComplete: () => {
        np.hidden = true;
        np.classList.remove('gsap-active');
        gsap.set(np, { clearProps: 'all' });
        bar.style.boxShadow = '';
      }
    });
    tl.to('.np-controls .np-btn', { scale: 0, opacity: 0, duration: 0.16, ease: 'power2.in', stagger: { each: 0.02, from: 'center' } });
    tl.to($('#npArt'), { scale: 0.5, opacity: 0, duration: 0.22, ease: 'power2.in' }, '-=0.1');
    tl.to(np, {
      opacity: 0, rotateX: 70, scaleX: 0.6, scaleY: 0.6,
      filter: 'blur(10px) brightness(0.4)',
      transformOrigin: 'center 70%', transformPerspective: 900,
      duration: 0.45, ease: 'power3.in',
    }, '-=0.1');
  } else {
    np.hidden = true;
  }
}

function resetAnimation(el) {
  if (!el) return;
  el.style.animation = 'none';
  void el.offsetHeight;
  el.style.animation = '';
}

function syncVideo() {
  const el = djActiveElement();
  if (!el) return;
  const cv = $('#npArtCustom video');
  if (cv) {
    if (!el.paused) cv.play().catch(() => {});
    else cv.pause();
  }
}

/* ---------- Custom cover (big player) ---------- */

function renderCustomCover() {
  const wrap = $('#npArtCustom');
  const video = $('#npVideo');
  const art = $('#npArt');
  const btn = $('#npCoverBtn');
  if (!wrap) return;
  if (!state.customCover) {
    wrap.hidden = true;
    wrap.innerHTML = '';
    if (art) art.style.opacity = '';
    if (btn) btn.classList.remove('active');
    return;
  }
  wrap.hidden = false;
  if (btn) btn.classList.add('active');
  if (art) art.style.opacity = '0';
  if (wrap.querySelector('img')) return;
  wrap.innerHTML = `<img src="${state.customCover.url}" alt="Обложка" loading="lazy" />`;
}

function setCustomCoverFile(file) {
  if (!file) return;
  const isImage = file.type.startsWith('image/');
  if (!isImage) return toast('Поддерживаются JPG, PNG или GIF', 'error');
  if (file.size > 50 * 1024 * 1024) return toast('Файл больше 50 МБ', 'error');
  const url = URL.createObjectURL(file);
  if (state.customCover) URL.revokeObjectURL(state.customCover.url);
  state.customCover = { url, type: 'image', name: file.name || 'cover', typeMime: file.type };
  renderCustomCover();
  idbSaveCustomCover(file, file.type, file.name).catch(() => {});
  toast('Обложка обновлена', 'success');
}

function removeCustomCover() {
  if (!state.customCover) return;
  URL.revokeObjectURL(state.customCover.url);
  state.customCover = null;
  renderCustomCover();
  idbClearCustomCover().catch(() => {});
  toast('Обложка убрана');
}

async function loadCustomCover() {
  try {
    const rec = await idbGetCustomCover();
    if (!rec || !rec.blob) return;
    const isVideo = rec.type && rec.type.startsWith('video/');
    state.customCover = {
      url: URL.createObjectURL(rec.blob),
      type: isVideo ? 'video' : 'image',
      name: rec.name || 'cover',
      typeMime: rec.type,
    };
    renderCustomCover();
  } catch (e) { /* ignore */ }
}

/* Позиция трека в очереди: по ссылке SoundCloud, иначе по имени (копии объектов). */
function queueIndexOf(list, track) {
  if (!list || !list.length || !track) return -1;
  const byRef = list.indexOf(track);
  if (byRef !== -1) return byRef;
  if (track.scUrl || track.scId) {
    const key = track.scUrl || track.scId;
    const i = list.findIndex((t) => t && (t.scUrl === key || t.scId === key));
    if (i !== -1) return i;
  }
  const key = `${(track.title || '').toLowerCase()}|${(track.artist || '').toLowerCase()}`;
  return list.findIndex((t) => t && `${(t.title || '').toLowerCase()}|${(t.artist || '').toLowerCase()}` === key);
}

function nextTrack() {
  const list = state.visibleTracks;
  if (!list.length) return;
  let idx = queueIndexOf(list, state.currentTrack);
  if (state.shuffle) {
    let r;
    do { r = Math.floor(Math.random() * list.length); } while (list.length > 1 && r === idx);
    idx = r;
  } else {
    idx += 1;
    if (idx >= list.length) idx = state.repeat ? 0 : list.length - 1;
  }
  const track = list[idx];
  if (track) playTrack(track, idx);
}

function prevTrack() {
  const list = state.visibleTracks;
  if (!list.length) return;
  let idx = queueIndexOf(list, state.currentTrack);
  if (idx === -1) idx = list.length - 1;
  if (audio.currentTime > 3 || idx <= 0) {
    audio.currentTime = 0;
    if (audio.paused) audio.play().catch(() => {});
    setPlayIcons(false);
    return;
  }
  const track = list[idx - 1];
  if (track) playTrack(track, idx - 1);
}

function togglePlay() {
  if (!state.currentTrack) { nextTrack(); return; }
  const el = activeAudio();
  if (el.paused) {
    el.play().catch(() => toast('Не удалось воспроизвести', 'error'));
    releaseFromPlayButton();
    spawnPlayParticles();
    burstPS5Particles();
  } else {
    el.pause();
    gatherToPlayButton();
  }
  setPlayIcons(el.paused);
}

function handleTrackEnded() {
  if (state._ending) return;
  state._ending = true;
  // Страховка: если следующий трек не запустится (мёртвая ссылка),
  // защёлка снимется сама и автопереход продолжит работать.
  clearTimeout(state._endingTimer);
  state._endingTimer = setTimeout(() => { state._ending = false; }, 8000);
  if (state.repeat) { const el = activeAudio(); state._ending = false; el.currentTime = 0; el.play().catch(() => {}); return; }
  if (state.radioMode) { playNextRadio(); return; }
  nextTrack();
}

function handleDeckEnded(side) {
  if (side === 'a') { handleTrackEnded(); return; }
  if (state._ending) return;
  state._ending = true;
  vinylDeckListenCompleteFor('b');
  const track = djDeckTrack('b');
  vinylState.dj.master = 'a';
  saveVinylState();
  if (track) addHistory(track);
  updateDeckPlayingUI();
  updateDeckInfo();
  updateDeckInfoB();
}

audio.addEventListener('timeupdate', () => {
  if (state._activeAudioSide !== 'a') return;
  updatePlayerTime();
  updateLyricsHighlight();
  if (state._ending) return;
  vinylStutterTick('a');
  const dur = audio.duration;
  if (!coreTransition && !audio.paused && isFinite(dur) && dur > 0 && audio.currentTime >= dur - 0.4) handleTrackEnded();
  if (!state._listenLogged && state._listenTrack) {
    const validDur = isFinite(dur) && dur > 0 ? dur : 0;
    if (audio.currentTime >= 30 || (validDur > 0 && audio.currentTime >= validDur * 0.7)) {
      state._listenLogged = true;
      recordListen(state._listenTrack);
    }
  }
});
audio.addEventListener('loadedmetadata', () => { if (state._activeAudioSide === 'a') updatePlayerTime(); });
audio.addEventListener('play', () => { if (state._activeAudioSide === 'a') { state._ending = false; setPlayIcons(false); updateBgState(); syncVideo(); } });
audio.addEventListener('pause', () => { if (state._activeAudioSide === 'a' && !coreTransition) { setPlayIcons(true); updateBgState(); syncVideo(); } });
audio.addEventListener('ended', () => { if (state._activeAudioSide === 'a' && !coreTransition) handleTrackEnded(); });
// Мёртвый поток (SoundCloud отдал ошибку) — не молчим, а идём дальше.
audio.addEventListener('error', () => {
  if (state._activeAudioSide !== 'a') return;
  if (!state.currentTrack) return;
  clearTimeout(state._endingTimer);
  state._ending = false;
  const list = state.visibleTracks;
  if (list && list.length > 1 && !state._autoSkipping) {
    state._autoSkipping = true;
    toast('Трек не открылся — включаю следующий', 'info', 2200);
    setTimeout(() => { state._autoSkipping = false; nextTrack(); }, 400);
  }
});
audioB.addEventListener('timeupdate', () => {
  if (state._activeAudioSide !== 'b') return;
  updatePlayerTime();
  updateLyricsHighlight();
  if (state._ending) return;
  const dur = audioB.duration;
  if (!coreTransition && !audioB.paused && isFinite(dur) && dur > 0 && audioB.currentTime >= dur - 0.4) handleTrackEnded();
});
audioB.addEventListener('loadedmetadata', () => {
  if (state._activeAudioSide === 'b') updatePlayerTime();
});
audioB.addEventListener('play', () => { if (state._activeAudioSide === 'b') { state._ending = false; setPlayIcons(false); updateBgState(); syncVideo(); } });
audioB.addEventListener('pause', () => { if (state._activeAudioSide === 'b' && !coreTransition) { setPlayIcons(true); updateBgState(); syncVideo(); } });
audioB.addEventListener('ended', () => { if (state._activeAudioSide === 'b' && !coreTransition) handleTrackEnded(); });

function updatePlayerTime() {
  const el = djActiveElement();
  const dur = effectiveDuration();
  const cur = el.currentTime || 0;
  const pctBar = dur ? Math.min(100, (cur / dur) * 100) : 0;
  const cNode = $('#pbCurrent');
  if (cNode) cNode.textContent = formatDuration(cur);
  const dNode = $('#pbDuration');
  if (dNode) dNode.textContent = formatDuration(dur || 0);
  const fill = $('#pbProgressFill');
  if (fill) fill.style.width = `${pctBar}%`;
  const knob = $('#pbKnob');
  if (knob) knob.style.left = `${pctBar}%`;
  const bar = $('#pbProgress');
  if (bar) bar.setAttribute('aria-valuenow', String(Math.round(pctBar)));
  const seek = $('#npSeek');
  if (seek && dur) {
    const pct = Math.round((cur / dur) * 1000);
    seek.value = pct;
    seek.style.setProperty('--sc-fill', (pct / 10) + '%');
    const c = $('#npCurrent'); if (c) c.textContent = formatDuration(cur);
    const d = $('#npDuration'); if (d) d.textContent = formatDuration(dur);
  }
  drawWaveform();
}

/* ============================================================
   HLS
   ============================================================ */

function attachHls(url) {
  return attachHlsOn(audio, url, false);
}

let hlsLoading = null;
function ensureHls() {
  if (window.Hls) return Promise.resolve(true);
  if (hlsLoading) return hlsLoading;
  hlsLoading = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'hls.min.js';
    s.onload = () => resolve(!!window.Hls);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
    setTimeout(() => resolve(!!window.Hls), 8000);
  }).then((ok) => { if (!ok) hlsLoading = null; return ok; });
  return hlsLoading;
}

function attachHlsOn(el, url, isB) {
  if (isB) {
    if (state.hlsB) { state.hlsB.destroy(); state.hlsB = null; }
  } else if (state.hls) { state.hls.destroy(); state.hls = null; }
  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls();
    hls.loadSource(url);
    hls.attachMedia(el);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => el.play().catch(() => {}));
    if (isB) state.hlsB = hls;
    else state.hls = hls;
    return true;
  }
  if (!isB) {
    ensureHls().then((ok) => {
      if (ok) attachHlsOn(el, url, false);
      else el.src = url;
    });
    return true;
  }
  return false;
}

function detachHls() {
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  if (state.hlsB) { state.hlsB.destroy(); state.hlsB = null; }
}

/* ============================================================
   Waveform
   ============================================================ */

const WAVE_BARS = APP_CONFIG.waveBars;
const WAVE_PLAYED = '#ffffff';
const WAVE_LEFT = 'rgba(255,255,255,0.16)';

function buildWaveform(arrayBuffer) {
  return new Promise((resolve) => {
    try {
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const ctx = new Ctx(1, 1, 44100);
      ctx.decodeAudioData(arrayBuffer, (buffer) => {
        const raw = buffer.getChannelData(0);
        const block = Math.floor(raw.length / WAVE_BARS) || 1;
        const peaks = new Array(WAVE_BARS).fill(0);
        for (let i = 0; i < WAVE_BARS; i++) {
          let max = 0;
          for (let j = 0; j < block; j++) {
            const v = Math.abs(raw[i * block + j] || 0);
            if (v > max) max = v;
          }
          peaks[i] = max;
        }
        const maxPeak = Math.max(...peaks, 0.001);
        resolve(peaks.map((p) => p / maxPeak));
      }, () => resolve(null));
    } catch (e) { resolve(null); }
  });
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 233280;
  return h + 1;
}

function fakeWaveform(seed) {
  const data = [];
  let s = seed || 1;
  for (let i = 0; i < WAVE_BARS; i++) {
    s = (s * 9301 + 49297) % 233280;
    const r = s / 233280;
    const env = Math.sin((i / WAVE_BARS) * Math.PI);
    data.push(0.15 + 0.85 * r * (0.5 + env * 0.5));
  }
  return data;
}

function drawWaveform() {
  const canvas = $('#npWave');
  if (!canvas) return;
  const track = state.currentTrack;
  if (!track) return;
  const data = state.waveData || fakeWaveform(hashString(track.title || 'x'));
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 80;
  const pixelWidth = Math.round(w * dpr);
  const pixelHeight = Math.round(h * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const gap = 2;
  const barW = (w - gap * (WAVE_BARS - 1)) / WAVE_BARS;
  const dur = effectiveDuration();
  const progress = dur ? activeAudio().currentTime / dur : 0;
  const mid = progress * w;
  const hue = extractHue(track.color);
  for (let i = 0; i < WAVE_BARS; i++) {
    const x = i * (barW + gap);
    const bh = Math.max(2, data[i] * (h - 6));
    const y = (h - bh) / 2;
    const played = (x + barW / 2) <= mid;
    ctx.fillStyle = played ? WAVE_PLAYED : WAVE_LEFT;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, bh, Math.min(barW / 2, 2));
    ctx.fill();
  }
}

function seekFromWave(clientX) {
  const canvas = $('#npWave');
  const dur = effectiveDuration();
  if (!canvas || !dur) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const el = djActiveElement();
  el.currentTime = ratio * dur;
}

async function generateWaveFor(track) {
  if (track._blobUrl && track._blobUrl.startsWith('blob:')) {
    try {
      const buf = await (await fetch(track._blobUrl)).arrayBuffer();
      const peaks = await buildWaveform(buf);
      if (peaks && track._blobUrl === state.waveUrl) { state.waveData = peaks; drawWaveform(); }
      return;
    } catch (e) { /* fallback */ }
  }
  state.waveData = fakeWaveform(hashString(track.title || 'x'));
  drawWaveform();
}

/* ============================================================
   Volume / speed / seek
   ============================================================ */

function updateVolUI(vol) {
  const pct = (vol * 100) + '%';
  $$('.vol-fill').forEach((el) => { el.style.width = pct; });
  $$('.vol-thumb').forEach((el) => { el.style.left = pct; });
  $$('.vol-wave-1').forEach((el) => { el.style.opacity = vol > 0 ? '1' : '0.15'; });
  $$('.vol-wave-2').forEach((el) => { el.style.opacity = vol > 0.5 ? '1' : '0.15'; });
}

function setSpeed(rate) {
  const el = activeAudio();
  el.playbackRate = rate;
  el.preservesPitch = false;
  const btn = $('#npSpeed');
  if (btn) btn.textContent = rate === 1 ? '1x' : `${rate}x`;
  localStorage.setItem('umbrella_speed', String(rate));
  const popup = $('#npSpeedPopup');
  if (popup) popup.querySelectorAll('button').forEach((b) => b.classList.toggle('active', parseFloat(b.dataset.rate) === rate));
}

/* ============================================================
   Radio
   ============================================================ */

async function request(path, options = {}) {
  const url = `${API}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 30000);
  let response;
  try {
    response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(apiToken ? { 'X-Umbrella-Token': apiToken } : {}),
        ...(options.headers || {}),
      },
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    const waitSeconds = Math.round((options.timeout || 30000) / 1000);
    if (error.name === 'AbortError') throw new Error(`Запрос не завершился за ${waitSeconds} секунд`);
    throw new Error('Сбой сети при запросе');
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || 'Сервер вернул ошибку');
    error.details = body;
    throw error;
  }
  return body;
}

async function searchSC(query, count = 20) {
  const res = await request(`/sc/search?q=${encodeURIComponent(query)}&count=${count}`, { timeout: API_TIMEOUT.search });
  return res.tracks || [];
}
async function searchZvuk(query, count = 18) {
  const res = await request(`/zvuk/search?q=${encodeURIComponent(query)}&count=${count}`, { timeout: API_TIMEOUT.search });
  return (res.tracks || []).map((t) => ({ ...t, source: 'zvuk', zvukId: t.id, thumbnail: t.thumbnail || '', duration: t.duration || 0 }));
}
async function fetchRelatedTracksSC(artist, title) {
  try {
    const q = [artist, title].filter(Boolean).join(' ');
    const res = await request(`/sc/search?q=${encodeURIComponent(q)}&count=12`, { timeout: API_TIMEOUT.default });
    return res.tracks || [];
  } catch (e) { return []; }
}

function buildRadioTrack(item) {
  return { title: item.title, artist: item.artist, scUrl: item.url || item.scUrl, scId: item.id || item.scId, source: 'soundcloud', thumbnail: item.thumbnail, duration: item.duration || 0, album: 'Umbrella Radio', color: '' };
}

async function startArtistRadio(artist) {
  artist = (artist || '').trim();
  if (!artist) return;
  toast('Радио: ищем треки исполнителя…');
  let results;
  try {
    results = await searchSC(artist, 25);
  } catch (e) {
    toast('Радио: ошибка поиска', 'error');
    return;
  }
  if (!results.length) { toast(`Треки для «${artist}» не найдены`, 'error'); return; }
  state.radioMode = true;
  state.radioKind = 'artist';
  state.radioQuery = artist;
  state.radioPlayedIds = new Set();
  state.radioQueue = results.map(buildRadioTrack);
  $('#npRadio')?.classList.add('active');
  $('#radioToggleBtn')?.classList.add('active');
  const first = state.radioQueue.shift();
  state.visibleTracks.push(first);
  playTrack(first, state.visibleTracks.length - 1);
  if (state.radioQueue.length) {
    state.visibleTracks.push(...state.radioQueue);
    renderQueue();
  }
  toast('Радио-режим включён', 'success');
}

async function playNextRadio() {
  if (!state.radioMode || !state.currentTrack) return;
  const cur = state.currentTrack;
  const curId = cur.scUrl || cur.scId;
  if (curId) state.radioPlayedIds.add(curId);
  if (state.radioQueue.length === 0) {
    if (state.radioKind === 'artist' && state.radioQuery) {
      toast('Радио: загружаем ещё треки…');
      let more = await searchSC(state.radioQuery, 25);
      if (!more.length) more = await searchSC(state.radioQuery, 25);
      state.radioQueue = more.map(buildRadioTrack).filter((t) => !state.radioPlayedIds.has(t.scUrl || t.scId));
    } else if (state.radioKind === 'related') {
      toast('Радио: загружаем похожие треки…');
      let related = await fetchRelatedTracksSC(cur.artist, cur.title);
      if (!related.length) related = await searchSC(cur.artist || cur.title, 12);
      state.radioQueue = related.map(buildRadioTrack).filter((t) => !state.radioPlayedIds.has(t.scUrl || t.scId));
    }
  }
  if (state.radioQueue.length === 0) {
    const more = state.visibleTracks.filter((t) => t !== cur);
    if (more.length) { nextTrack(); return; }
    toast('Радио: треки закончились');
    stopRadio();
    return;
  }
  const next = state.radioQueue.shift();
  if (!next || (!next.scUrl && !next.scId)) { nextTrack(); return; }
  state.visibleTracks.push(next);
  playTrack(next, state.visibleTracks.length - 1);
}

function stopRadio() {
  state.radioMode = false;
  state.radioKind = null;
  state.radioQuery = '';
  state.radioQueue = [];
  state.radioPlayedIds = new Set();
  $('#npRadio')?.classList.remove('active');
  $('#radioToggleBtn')?.classList.remove('active');
}

/* ============================================================
   Queue
   ============================================================ */

function renderQueue() {
  const panel = $('#npQueue');
  const list = $('#npQueueList');
  const count = $('#npQueueCount');
  if (!panel || !list) return;
  const cur = state.currentTrack;
  let tail = [];
  if (cur) {
    const idx = state.visibleTracks.indexOf(cur);
    if (idx >= 0) tail = state.visibleTracks.slice(idx + 1);
    else tail = state.visibleTracks;
  }
  state.queueTail = tail;
  let upcoming = tail.slice(0, 40);
  if (state.radioMode && state.radioQueue.length) {
    upcoming = upcoming.concat(state.radioQueue.filter((t) => !upcoming.includes(t)).slice(0, 40 - upcoming.length));
  }
  if (count) count.textContent = `${upcoming.length} ${plural(upcoming.length)}`;
  if (!upcoming.length) {
    list.innerHTML = '<div class="empty-search" style="padding:30px 12px"><p>Очередь пуста</p></div>';
    return;
  }
  list.innerHTML = upcoming.map((t, i) => {
    const isRadio = !tail.includes(t);
    return `
    <div class="np-queue-item" data-qidx="${i}" data-vidx="${isRadio ? -1 : i}" data-kind="${isRadio ? 'radio' : 'vt'}" ${isRadio ? '' : 'draggable="true"'}>
      ${t.thumbnail ? `<img src="${escapeHtml(t.thumbnail)}" alt="" loading="lazy" />` : `<span class="q-cover" style="--cover:${t.color || coverGradient(i)}"></span>`}
      <div class="q-meta"><b>${escapeHtml(t.title || 'Без названия')}</b><small>${escapeHtml(t.artist || '')}</small></div>
      <span class="q-dur">${formatDuration(t.duration)}</span>
    </div>`;
  }).join('');
}

function reorderQueueItem(fromIdx, toIdx) {
  const tail = state.queueTail;
  if (!tail || fromIdx === toIdx) return;
  const [item] = tail.splice(fromIdx, 1);
  tail.splice(toIdx, 0, item);
  const cur = state.currentTrack;
  if (cur && state.visibleTracks.indexOf(cur) >= 0) state.visibleTracks = [cur, ...tail];
  else state.visibleTracks = [...tail];
  renderQueue();
}

/* ============================================================
   Search / albums
   ============================================================ */

function switchView(view) {
  const meta = {
    library: ['Библиотека', 'Ваша музыка. Ваше пространство.'],
    search: ['Поиск', 'Найдите треки и альбомы в SoundCloud'],
    favorites: ['Избранное', 'Любимые треки и исполнители'],
    playlists: ['Плейлисты', 'Ваши подборки и Избранное'],
    radio: ['Радио', 'Бесконечный поток под ваше настроение'],
    settings: ['Настройки', 'Управление плеером'],
    stats: ['Статистика', 'Ваш год в Umbrella'],
    archaeo: ['Археология библиотеки', 'Раскопки вашей коллекции'],
  };
  if (!meta[view]) view = 'library';
  $$('.nav-link').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view !== 'search') {
    const detail = $('#albumDetail');
    if (!detail.hidden) { detail.hidden = true; cleanArtistScene(); }
    const plDetail = $('#playlistDetail');
    if (plDetail && !plDetail.hidden) closePlaylistPage();
    const artDetail = $('#artistDetail');
    if (artDetail && !artDetail.hidden) closeArtistPage();
  }
  $('#libraryContent').hidden = view !== 'library';
  $('#searchContent').hidden = view !== 'search';
  $('#favoritesContent').hidden = view !== 'favorites';
  $('#settingsContent').hidden = view !== 'settings';
  $('#statsContent').hidden = view !== 'stats';
  $('#archaeoContent').hidden = view !== 'archaeo';
  const plView = $('#playlistsContent');
  if (plView) plView.hidden = view !== 'playlists';
  const radioView = $('#radioContent');
  if (radioView) radioView.hidden = view !== 'radio';
  $('#stats').hidden = view !== 'library';
  const bannerRow = document.querySelector('.banner-row');
  if (bannerRow) bannerRow.hidden = view !== 'library';
  const addBtn = $('#dashAddTrack');
  if (addBtn) addBtn.hidden = !(view === 'library' || view === 'favorites');
  const viewBtn = $('#viewToggle');
  if (viewBtn) viewBtn.hidden = view !== 'library';
  $('#viewTitle').textContent = meta[view][0];
  $('#viewSubtitle').textContent = meta[view][1];
  if (view === 'favorites') renderFavorites();
  if (view === 'playlists') renderCustomPlaylists();
  if (view === 'radio') renderRadioSuggest();
  if (view === 'library') renderCustomPlaylists();
  if (view === 'stats') renderStatsDashboard();
  if (view === 'archaeo' && typeof renderArchaeo === 'function') renderArchaeo();
  if (view === 'search') setTimeout(() => $('#searchInput')?.focus(), 80);
  try { if (('#' + view) !== location.hash) history.replaceState(null, '', '#' + view); } catch (_) {}
}

window.addEventListener('hashchange', () => {
  if (!state.launched) return;
  const h = location.hash.slice(1);
  if (h) switchView(h);
});

async function search() {
  const query = $('#searchInput').value.trim();
  if (!query) return toast('Введите название трека, исполнителя или альбома');
  addSearchHistory(query);
  const button = $('#searchButton');
  button.disabled = true;
  const original = button.innerHTML;
  button.innerHTML = '<span>Поиск…</span>';
  const isAlbums = state.searchSource === 'albums';
  const isPlaylists = state.searchSource === 'playlists';
  const isSc = state.searchSource === 'soundcloud';
  $('#searchResults').hidden = isAlbums || isPlaylists;
  $('#albumResults').hidden = !isAlbums;
  $('#albumDetail').hidden = true;
  $('#searchEmpty').hidden = true;
  $('#searchHistory').hidden = true;
  // Старую выдачу убираем сразу: иначе пока грузится новая, на экране висят
  // альбомы от прошлого запроса и это читается как «показал случайные».
  clearSearchOutput();
  clearTimeout(window.searchTimeout);
  window.searchTimeout = setTimeout(() => {
    performSearch(query);
  }, 200);
}

/* Убирает результаты прошлого запроса из обеих сеток. */
function clearSearchOutput() {
  const res = $('#searchResults');
  if (res) res.innerHTML = '';
  const alb = $('#albumResults');
  if (alb) alb.innerHTML = '';
  state.searchResults = [];
  state.albumResults = [];
  state.playlistSearchResults = [];
}

/* Актуален ли ещё этот поиск? Ответы старых запросов не должны перерисовывать выдачу. */
function searchStale(gen, source) {
  return gen !== state.searchGen || (source && state.searchSource !== source);
}

async function performSearch(query) {
  const gen = ++state.searchGen;
  const source = state.searchSource;
  const isAlbums = source === 'albums';
  const isPlaylists = source === 'playlists';
  const isSc = source === 'soundcloud';
  const isZvuk = source === 'zvuk';
  $('#searchResults').hidden = isAlbums || isPlaylists;
  $('#albumResults').hidden = !isAlbums;
  $('#albumDetail').hidden = true;
  $('#searchEmpty').hidden = true;
  $('#searchHistory').hidden = true;

  try {
    if (isAlbums) {
      await searchAlbumsUnified(query, gen);
    } else if (isPlaylists) {
      await searchPlaylistsUnified(query, gen);
    } else if (isZvuk) {
      const data = await request(`/zvuk/search?q=${encodeURIComponent(query)}&count=18`, { timeout: API_TIMEOUT.search });
      if (searchStale(gen, source)) return;
      const tracks = (data.tracks || []).map((t) => ({ ...t, source: 'zvuk', zvukId: t.id }));
      state.searchResults = tracks;
      $('#searchEmpty').hidden = tracks.length > 0;
      $('#searchResults').innerHTML = tracks.length
        ? `<div class="track-list">${tracks.map((t, i) => trackRow(t, i, 'search')).join('')}</div>`
        : '<div class="empty-search"><h2>Ничего не найдено</h2><p>Попробуйте изменить запрос.</p></div>';
      if (window.gsap && tracks.length && !reduceMotion()) {
        gsap.fromTo('#searchResults .track-row', { opacity: 0, y: 14, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.3, ease: 'power2.out', stagger: 0.03, clearProps: 'transform' });
      }
    } else if (isSc) {
      const data = await request(`/sc/search?q=${encodeURIComponent(query)}&count=18`, { timeout: API_TIMEOUT.search });
      if (searchStale(gen, source)) return;
      const tracks = (data.tracks || []).map((t) => ({ ...t, source: 'soundcloud', scId: t.id, scUrl: t.url }));
      state.searchResults = tracks;
      $('#searchEmpty').hidden = tracks.length > 0;
      $('#searchResults').innerHTML = tracks.length
        ? `<div class="track-list">${tracks.map((t, i) => trackRow(t, i, 'search')).join('')}</div>`
        : '<div class="empty-search"><h2>Ничего не найдено</h2><p>Попробуйте изменить запрос.</p></div>';
      if (window.gsap && tracks.length && !reduceMotion()) {
        gsap.fromTo('#searchResults .track-row', { opacity: 0, y: 14, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.3, ease: 'power2.out', stagger: 0.03, clearProps: 'transform' });
      }
    } else {
      const data = await request(`/sc/search?q=${encodeURIComponent(query)}&count=18`, { timeout: API_TIMEOUT.search });
      if (searchStale(gen, source)) return;
      const tracks = (data.tracks || []).map((t) => ({ ...t, source: 'soundcloud', scId: t.id, scUrl: t.url }));
      state.searchResults = tracks;
      $('#searchEmpty').hidden = tracks.length > 0;
      $('#searchResults').innerHTML = tracks.length
        ? `<div class="track-list">${tracks.map((t, i) => trackRow(t, i, 'search')).join('')}</div>`
        : '<div class="empty-search"><h2>Ничего не найдено</h2><p>Попробуйте изменить запрос.</p></div>';
      if (window.gsap && tracks.length && !reduceMotion()) {
        gsap.fromTo('#searchResults .track-row', { opacity: 0, y: 14, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.3, ease: 'power2.out', stagger: 0.03, clearProps: 'transform' });
      }
    }
  } catch (error) {
    if (searchStale(gen, source)) return;
    toast(error.message, 'error');
    $('#searchEmpty').hidden = false;
  } finally {
    if (gen === state.searchGen) {
      const btn = $('#searchButton');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span>Найти</span>';
      }
    }
  }
}

async function searchAlbumsUnified(query, gen) {
  const el = $('#albumResults');
  const empty = $('#searchEmpty');
  el.innerHTML = '<div class="empty-search" style="padding:30px"><p>Поиск альбомов…</p></div>';
  try {
    // Настоящие альбомы — Deezer; подборки SoundCloud — дополнением.
    const [dzRes, scRes] = await Promise.allSettled([
      request(`/music/albums?q=${encodeURIComponent(query)}&limit=24`, { timeout: API_TIMEOUT.albums }),
      request(`/sc/search?q=${encodeURIComponent(query)}&count=15`, { timeout: API_TIMEOUT.searchLong }),
    ]);
    const albums = [];
    const seen = new Set();
    const add = (a) => {
      if (!a.title || seen.has(a._dedupKey)) return;
      seen.add(a._dedupKey);
      albums.push(a);
    };

    if (dzRes.status === 'fulfilled' && Array.isArray(dzRes.value.albums)) {
      dzRes.value.albums.forEach((a) => add({
        id: a.id,
        title: a.title,
        artist: a.artist || '',
        cover: a.cover || '',
        year: '',
        source: '',            // пусто -> открывается через showAlbumDetail (Deezer)
        trackCount: a.trackCount || 0,
        _dedupKey: albumKey(a.title, a.artist),
      }));
    }

    if (scRes.status === 'fulfilled' && scRes.value.tracks) {
      const words = (query || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const byUploader = new Map();
      scRes.value.tracks.forEach((t) => {
        const up = (t.artist || t.uploader || t.channel || 'SoundCloud').trim();
        if (!byUploader.has(up)) byUploader.set(up, []);
        byUploader.get(up).push(t);
      });
      byUploader.forEach((tracks, uploader) => {
        // Раньше сюда падал КАЖДЫЙ загрузчик из выдачи SoundCloud — отсюда и
        // «случайные альбомы». Оставляем только тех, кто реально связан с запросом.
        const hay = `${uploader} ${tracks.map((t) => t.title || '').join(' ')}`.toLowerCase();
        const relevant = !words.length || words.some((w) => hay.includes(w));
        if (!relevant || tracks.length < 2) return;
        add({
          id: `sc_${uploader.replace(/\s+/g, '_')}`,
          title: uploader,
          artist: tracks[0].artist || '',
          cover: tracks[0].thumbnail || '',
          year: '',
          source: 'soundcloud',
          trackCount: tracks.length,
          _tracks: tracks,
          _dedupKey: albumKey(uploader, tracks[0].artist || ''),
        });
      });
    }

    // Ответ устарел (пользователь успел изменить запрос или вкладку) — не рисуем.
    if (searchStale(gen, 'albums')) return;
    const ranked = rankByQuery(albums, query);
    state.albumResults = ranked;
    renderAlbums(ranked);
    empty.hidden = ranked.length > 0;
  } catch (error) {
    if (searchStale(gen, 'albums')) return;
    el.innerHTML = `<div class="empty-search"><h2>Ошибка поиска</h2><p>${escapeHtml(error.message || '')}</p></div>`;
    toast(error.message, 'error');
  }
}

/* Ключ для склейки дублей альбома из разных источников. */
function albumKey(title, artist) {
  const norm = (v) => (v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return `${norm(title)}|${norm(artist)}`;
}

/* Сначала то, что реально совпало с запросом, потом остальное. */
function rankByQuery(items, query) {
  const words = (query || '').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return items;
  const score = (a) => {
    const hay = `${a.title || ''} ${a.artist || a.owner || ''}`.toLowerCase();
    return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
  };
  return items
    .map((a, i) => ({ a, i, s: score(a) }))
    .sort((x, y) => (y.s - x.s) || (x.i - y.i))
    .map((x) => x.a);
}

async function searchPlaylistsUnified(query, gen) {
  const el = $('#searchResults');
  const empty = $('#searchEmpty');
  el.hidden = false;
  el.innerHTML = '<div class="empty-search" style="padding:30px"><p>Поиск плейлистов…</p></div>';
  try {
    const scRes = await request(`/sc/search?q=${encodeURIComponent(query)}&count=10`, { timeout: API_TIMEOUT.search });
    const playlists = [];
    if (scRes.tracks) {
      const sets = new Map();
      scRes.value.tracks.forEach((t) => {
        const setName = t.playlist || t.set || t.uploader || 'SoundCloud';
        if (!sets.has(setName)) sets.set(setName, []);
        sets.get(setName).push(t);
      });
      sets.forEach((tracks, setName) => {
        playlists.push({
          id: `sc_pl_${setName.replace(/\s+/g, '_')}`,
          title: setName,
          owner: tracks[0].uploader || '',
          cover: tracks[0].thumbnail || '',
          trackCount: tracks.length,
          source: 'soundcloud',
          type: 'playlist',
          _tracks: tracks,
        });
      });
    }
    if (searchStale(gen, 'playlists')) return;
    const ranked = rankByQuery(playlists, query);
    state.playlistSearchResults = ranked;
    renderUnifiedPlaylists(ranked);
    empty.hidden = ranked.length > 0;
  } catch (error) {
    if (searchStale(gen, 'playlists')) return;
    el.innerHTML = `<div class="empty-search"><h2>Ошибка поиска</h2><p>${escapeHtml(error.message || '')}</p></div>`;
    toast(error.message, 'error');
  }
}

function renderUnifiedPlaylists(playlists) {
  const el = $('#searchResults');
  const empty = $('#searchEmpty');
  if (!playlists.length) { el.innerHTML = ''; empty.hidden = false; return; }
  empty.hidden = true;
  el.innerHTML = playlists.map((p) => `
    <div class="album-card" data-type="playlist" data-id="${escapeHtml(p.id)}" data-source="${escapeHtml(p.source)}">
      <img src="${escapeHtml(p.cover || '')}" alt="" loading="lazy" />
      <h4>${escapeHtml(p.title)}</h4>
      <p>${[escapeHtml(p.owner || ''), p.trackCount ? `${p.trackCount} треков` : ''].filter(Boolean).join(' · ')}</p>
    </div>`).join('');
  if (window.gsap && !reduceMotion()) {
    gsap.fromTo('#searchResults .album-card', { opacity: 0, y: 16, scale: 0.95 }, { opacity: 1, y: 0, scale: 1, duration: 0.3, ease: 'power2.out', stagger: 0.03, clearProps: 'transform' });
  }
}

function renderAlbums(albums) {
  const el = $('#albumResults');
  const empty = $('#searchEmpty');
  if (!albums.length) { el.innerHTML = ''; empty.hidden = false; return; }
  empty.hidden = true;
  el.innerHTML = albums.map((a) => `<div class="album-card" data-id="${escapeHtml(a.id || '')}" data-source="${escapeHtml(a.source || '')}"><img src="${escapeHtml(a.cover || '')}" alt="" loading="lazy" /><h4>${escapeHtml(a.title || '')}</h4><p>${[escapeHtml(a.artist || ''), a.trackCount ? `${a.trackCount} треков` : ''].filter(Boolean).join(' · ')}</p></div>`).join('');
  if (window.gsap && !reduceMotion()) {
    gsap.fromTo('#albumResults .album-card', { opacity: 0, y: 16, scale: 0.95 }, { opacity: 1, y: 0, scale: 1, duration: 0.3, ease: 'power2.out', stagger: 0.03, clearProps: 'transform' });
  }
}

async function importSoundcloudSet(url) {
  url = (url || '').trim();
  if (!url) return toast('Вставьте ссылку на плейлист');
  const isScSet = /soundcloud\.com\/.+\/sets\//.test(url);
  if (!isScSet) {
    return toast('Это не похоже на ссылку на сет SoundCloud', 'error');
  }
  const banner = $('#playlistBanner');
  const results = $('#searchResults');
  results.innerHTML = '<div class="empty-search" style="padding:30px"><p>Загрузка плейлиста…</p></div>';
  banner.hidden = true;
  try {
    const setName = decodeURIComponent((url.split('/sets/')[1] || '').split('?')[0]).replace(/[-_]/g, ' ');
    const scData = await request(`/sc/search?q=${encodeURIComponent(setName)}&count=20`, { timeout: API_TIMEOUT.default });
    const data = { title: setName || 'SoundCloud Set', tracks: (scData.tracks || []).slice(0, 20) };
    const tracks = (data.tracks || []).map((t) => ({ ...t, source: 'soundcloud', scId: t.id, scUrl: t.url, album: 'SoundCloud' }));
    if (!tracks.length) {
      results.innerHTML = '<div class="empty-search"><h2>Плейлист пуст</h2><p>Не удалось получить треки.</p></div>';
      return;
    }
    state.playlistTracks = tracks;
    state.searchResults = tracks;
    const title = data.title || 'Плейлист';
    $('#playlistBannerTitle').textContent = title;
    $('#playlistBannerCount').textContent = `${tracks.length} ${plural(tracks.length)}`;
    banner.hidden = false;
    results.innerHTML = tracks.map((t, i) => trackRow(t, i, 'search')).join('');
    if (window.gsap && !reduceMotion()) {
      gsap.fromTo('#searchResults .track-row', { opacity: 0, y: 14, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.3, ease: 'power2.out', stagger: 0.02, clearProps: 'transform' });
    }
  } catch (error) {
    results.innerHTML = `<div class="empty-search"><h2>Не удалось загрузить плейлист</h2><p>${escapeHtml(error.message || '')}</p></div>`;
    toast(error.message, 'error');
  }
}

async function refreshScDownloaded() {
  try {
    const data = await request('/sc/library', { timeout: API_TIMEOUT.library });
    const map = {};
    (data.files || []).forEach((f) => { if (f.name) map[f.name.trim().toLowerCase()] = f.path; });
    state.scDownloaded = map;
    state.scLibTracks = (data.files || []).map((f) => ({
      title: f.title || f.name,
      artist: f.artist || '',
      name: f.name,
      path: f.path,
      size: f.size || 0,
      ext: f.ext || 'mp3',
      source: 'soundcloud',
      duration: 0,
    }));
    renderScLibrary();
  } catch (e) { /* keep old cache */ }
}

function renderScLibrary() {
  const el = $('#scLibrary');
  if (!el) return;
  const entries = state.scLibTracks;
  el.innerHTML = `
    <div class="section-title"><h2>SoundCloud</h2><button class="text-button" id="scLibRefresh">Обновить</button></div>
    ${entries.length ? `<div class="track-list">${entries.map((t, i) => {
      return `<article class="track-row" data-index="${i}" data-source="scLib" data-scp="${escapeHtml(t.path)}">
        <span class="track-number">${String(i + 1).padStart(2, '0')}</span>
        <div class="track-main"><span class="track-cover" style="--cover:${coverGradient(i)}"></span><span class="track-meta"><b>${escapeHtml(t.title)}</b><small class="track-artist">${escapeHtml(t.artist)}</small></span></div>
        <span class="album">SoundCloud</span><span class="duration"></span>
        <div class="track-btns"><button class="track-del" data-scdel="${escapeHtml(t.path)}" aria-label="Удалить" title="Удалить файл">${icons.trash}</button></div>
        <button class="track-action" aria-label="Играть" title="Играть">${icons.play}</button>
      </article>`;
    }).join('')}</div>` : '<div class="empty-search" style="padding:26px"><p>Скачанных треков нет. Найдите трек в SoundCloud и нажмите ▶.</p></div>'}`;
}

function toggleScLibrary() {
  const el = $('#scLibrary');
  if (!el) return;
  el.hidden = !el.hidden;
  if (!el.hidden) refreshScDownloaded();
}

async function waitSoundcloudJob(jobId, track) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = async () => {
      let s = null;
      try {
        s = await request(`/sc/status?id=${encodeURIComponent(jobId)}`, { timeout: API_TIMEOUT.update });
      } catch (e) { /* keep polling */ }
      if (s) {
        if (s.state === 'done') {
          if (s.files && s.files.length) {
            const path = s.files[0];
            const key = scKey(track);
            if (key) {
              state.scDownloaded[key] = path;
              scUrlMap[key] = path;
              saveJSON('umbrella_scmap', scUrlMap);
            }
            const [title = path, artist = ''] = path.split(' - ', 2);
            state.scLibTracks.push({ title, artist, name: path, path, size: 0, ext: 'mp3', source: 'soundcloud', duration: 0 });
            renderScLibrary();
            resolve({ path });
          } else resolve(null);
          return;
        }
        if (s.state === 'error' || s.state === 'canceled') {
          toast(s.message || s.error || 'Ошибка скачивания', 'error', 4000);
          resolve(null);
          return;
        }
      }
      if (Date.now() - started > 15 * 60 * 1000) { toast('Скачивание слишком долгое', 'error'); resolve(null); return; }
      setTimeout(tick, 1500);
    };
    tick();
  });
}

async function downloadSoundcloudTrack(track) {
  // scId is only a numeric identity; yt-dlp needs the canonical page URL.
  const key = scKey(track);
  if (!key) return toast('Нет ссылки на SoundCloud', 'error');
  if (isScDownloaded(track)) return toast('Уже скачано', 'info', 2200);
  try {
    const res = await request('/sc/download', {
      method: 'POST',
      body: JSON.stringify({ url: track.scUrl || track.url || key }),
      timeout: 20000,
    });
    toast(`Скачивание «${track.title}»…`, 'info', 2500);
    const result = await waitSoundcloudJob(res.id, track);
    if (result && result.path) {
      toast('Скачано', 'success', 2200);
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function openScUrl() {
  const input = $('#scUrlInput');
  const url = (input && input.value || '').trim();
  if (!url) return toast('Вставьте ссылку SoundCloud', 'error');
  if (!/soundcloud\.com/i.test(url)) return toast('Это не ссылка SoundCloud', 'error');
  let title = '';
  let duration = 0;
  try {
    const res = await request(`/sc/resolve?url=${encodeURIComponent(url)}`, { timeout: API_TIMEOUT.default });
    if (res && res.title) title = res.title;
    if (res && res.duration) duration = res.duration;
  } catch (e) { /* воспроизводим через /api/sc/stream даже без resolve */ }
  const track = {
    title: title || 'SoundCloud',
    artist: 'SoundCloud',
    source: 'soundcloud',
    scUrl: url,
    url,
    duration: duration || 0,
    thumbnail: '',
    color: '',
  };
  state.visibleTracks = [track];
  playTrack(track, 0);
  if (input) input.value = '';
  toast('Воспроизведение SoundCloud…', 'info', 1800);
}

function addAllPlaylistToQueue() {
  const tracks = state.playlistTracks || [];
  if (!tracks.length) return;
  const startIdx = state.visibleTracks.length;
  state.visibleTracks.push(...tracks);
  if (!state.currentTrack && tracks[0]) playTrack(tracks[0], startIdx);
  toast(`Добавлено в очередь: ${tracks.length}`);
}

function getDominantColor(imgUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || 300;
        c.height = img.naturalHeight || 300;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const s = 50;
        const small = document.createElement('canvas');
        small.width = s; small.height = s;
        const sctx = small.getContext('2d');
        sctx.drawImage(c, 0, 0, s, s);
        const d = sctx.getImageData(0, 0, s, s).data;
        const buckets = {};
        for (let i = 0; i < d.length; i += 16) {
          if (d[i + 3] < 128) continue;
          const r = Math.round(d[i] / 32) * 32, g = Math.round(d[i + 1] / 32) * 32, b = Math.round(d[i + 2] / 32) * 32;
          const key = `${r},${g},${b}`;
          buckets[key] = (buckets[key] || 0) + 1;
        }
        let maxCount = 0, bestKey = '139,92,246';
        for (const [key, count] of Object.entries(buckets)) {
          if (count > maxCount) { maxCount = count; bestKey = key; }
        }
        const [r, g, b_] = bestKey.split(',').map(Number);
        resolve({ rgb: `${r},${g},${b_}`, r, g, b: b_ });
      } catch (e) {
        resolve({ rgb: '139,92,246', r: 139, g: 92, b: 246 });
      }
    };
    img.onerror = () => resolve({ rgb: '139,92,246', r: 139, g: 92, b: 246 });
    img.src = imgUrl;
  });
}

function closeAlbumDetail() {
  const detail = $('#albumDetail');
  clearAlbumQueueLoading();
  teardownArtistScene();
  detail.hidden = true;
  const scene = $('#artistScene');
  if (scene) scene.remove();
  $('#albumResults').hidden = state.searchSource !== 'albums';
  $('#searchResults').hidden = state.searchSource === 'albums';
}

function detailLoadingMarkup(label = 'Ищем треки альбома') {
  return `<div class="detail-loading"><i class="detail-loading-spinner" aria-hidden="true"></i><b>${escapeHtml(label)}</b><small>Это может занять несколько секунд.</small></div>`;
}

async function showAlbumDetail(albumId) {
  const detail = $('#albumDetail');
  const grid = $('#albumResults');
  const tracksEl = $('#searchResults');
  detail.hidden = false;
  grid.hidden = true;
  tracksEl.hidden = true;
  detail.innerHTML = detailLoadingMarkup();
  cleanArtistScene();
  try {
    const data = await request(`/music/album-tracks?id=${albumId}`, { timeout: API_TIMEOUT.library });
    const tracks = data.tracks || [];
    const artistQS = [];
    if (data.albumArtist) artistQS.push('name=' + encodeURIComponent(data.albumArtist));
    if (data.artistId) artistQS.push('id=' + encodeURIComponent(data.artistId));
    const artistPicture = artistQS.length ? `${API}/artist-image?${artistQS.join('&')}` : data.cover;
    const color = await getDominantColor(artistPicture);
    const root = document.documentElement;
    root.style.setProperty('--artist-rgb', color.rgb);
    root.style.setProperty('--artist-r', color.r);
    root.style.setProperty('--artist-g', color.g);
    root.style.setProperty('--artist-b', color.b);

    let html = `
    <div class="album-detail-view">
      <canvas class="artist-waves" id="artistWaves"></canvas>
      <div class="album-detail-fade"></div>
      <div class="album-detail-left">
        <button class="btn-back" id="albumBack"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg>К альбомам</button>
        <div class="album-detail-header">
          <img src="${data.cover}" alt="" id="albumCoverImg" loading="lazy" />
          <div class="album-detail-info">
            <h2>${escapeHtml(data.albumTitle || 'Альбом')}</h2>
            <p>${data.albumArtist ? `<button class="link-artist" id="albumArtistLink">${escapeHtml(data.albumArtist)}</button>` : ''}${data.albumArtist ? ' · ' : ''}${tracks.length} треков</p>
            <button class="btn btn-primary btn-sm" id="albumPlayAll">${icons.play}<span>Воспроизвести</span></button>
          </div>
        </div>
        <div class="album-detail-tracks">`;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      html += `<div class="album-detail-row" data-idx="${i}"><span class="pos">${t.position || i + 1}</span><span class="name">${escapeHtml(t.artist)} — ${escapeHtml(t.title)}</span><span class="dur">${formatDuration(t.duration)}</span></div>`;
    }
    html += `</div></div>
      ${buildArtistBioScene(data.albumArtist || '', artistPicture)}
    </div>`;
    detail.innerHTML = html;

    $('#albumBack').onclick = closeAlbumDetail;
    const albumArtistLink = $('#albumArtistLink');
    if (albumArtistLink && data.albumArtist) albumArtistLink.onclick = () => showArtistPage(data.albumArtist);
    const playAll = $('#albumPlayAll');
    const artistName = data.albumArtist;
    playAll.onclick = () => playAlbumQueue(tracks, artistName);
    detail.querySelectorAll('.album-detail-row').forEach((row) => {
      row.onclick = () => playAlbumTrack(tracks[Number(row.dataset.idx)], artistName, tracks, Number(row.dataset.idx));
    });
    loadArtistBio(data.albumArtist || '');
    animateAlbumDetail();
  } catch (e) {
    detail.innerHTML = `<div class="empty-search"><h2>Не удалось загрузить альбом</h2><p>${escapeHtml(e.message || '')}</p></div>`;
    toast(e.message, 'error');
  }
}

async function showUnifiedAlbumDetail(source, id) {
  const detail = $('#albumDetail');
  const grid = $('#albumResults');
  const tracksEl = $('#searchResults');
  detail.hidden = false;
  grid.hidden = true;
  tracksEl.hidden = true;
  detail.innerHTML = detailLoadingMarkup();
  cleanArtistScene();
  try {
    let tracks = [];
    let albumTitle = 'Альбом';
    let albumArtist = '';
    let cover = '';
    const al = state.albumResults?.find((a) => a.id === id);
    if (al) { albumTitle = al.title || albumTitle; albumArtist = al.artist || albumArtist; cover = al.cover || cover; }
    if (source === 'soundcloud') {
      if (al && al._tracks) {
        tracks = al._tracks.map((t) => ({ ...t, source: 'soundcloud', scId: t.id, scUrl: t.url }));
        albumTitle = al.title;
        albumArtist = al.artist;
        cover = al.cover;
      }
    }
    if (!tracks.length) throw new Error('Треки не найдены (пустой ответ API)');
    const artistPicture = cover || '';
    const color = await getDominantColor(artistPicture);
    const root = document.documentElement;
    root.style.setProperty('--artist-rgb', color.rgb);
    root.style.setProperty('--artist-r', color.r);
    root.style.setProperty('--artist-g', color.g);
    root.style.setProperty('--artist-b', color.b);

    let html = `
    <div class="album-detail-view">
      <canvas class="artist-waves" id="artistWaves"></canvas>
      <div class="album-detail-fade"></div>
      <div class="album-detail-left">
        <button class="btn-back" id="albumBack"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg>К альбомам</button>
        <div class="album-detail-header">
          <img src="${cover}" alt="" id="albumCoverImg" loading="lazy" />
          <div class="album-detail-info">
            <h2>${escapeHtml(albumTitle)}</h2>
            <p>${albumArtist ? `<button class="link-artist" id="albumArtistLink">${escapeHtml(albumArtist)}</button>` : ''}${albumArtist ? ' · ' : ''}${tracks.length} треков</p>
            <button class="btn btn-primary btn-sm" id="albumPlayAll">${icons.play}<span>Воспроизвести</span></button>
          </div>
        </div>
        <div class="album-detail-tracks">`;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      html += `<div class="album-detail-row" data-idx="${i}"><span class="pos">${i + 1}</span><span class="name">${escapeHtml(t.artist)} — ${escapeHtml(t.title)}</span><span class="dur">${formatDuration(t.duration)}</span></div>`;
    }
    html += `</div></div>
      ${buildArtistBioScene(albumArtist, artistPicture)}
    </div>`;
    detail.innerHTML = html;

    $('#albumBack').onclick = closeAlbumDetail;
    const albumArtistLink = $('#albumArtistLink');
    if (albumArtistLink && albumArtist) albumArtistLink.onclick = () => showArtistPage(albumArtist);
    const playAll = $('#albumPlayAll');
    playAll.onclick = () => {
      state.visibleTracks = tracks; playTrack(tracks[0], 0);
    };
    detail.querySelectorAll('.album-detail-row').forEach((row) => {
      row.onclick = () => {
        const t = tracks[Number(row.dataset.idx)];
        state.visibleTracks = tracks; playTrack(t, Number(row.dataset.idx));
      };
    });
    loadArtistBio(albumArtist || '');
    animateAlbumDetail();
  } catch (e) {
    detail.innerHTML = `<div class="empty-search"><h2>Не удалось загрузить альбом</h2><p>${escapeHtml(e.message || '')}</p></div>`;
    toast(e.message, 'error');
  }
}

async function openUnifiedPlaylist(source, id) {
  const detail = $('#albumDetail');
  const grid = $('#albumResults');
  const tracksEl = $('#searchResults');
  detail.hidden = false;
  grid.hidden = true;
  tracksEl.hidden = true;
  detail.innerHTML = '<p style="color:var(--text-3);padding:50px 0">Загрузка…</p>';
  cleanArtistScene();
  try {
    let tracks = [];
    let playlistTitle = 'Плейлист';
    let playlistOwner = '';
    let cover = '';
    const pl = state.playlistSearchResults?.find((p) => p.id === id);
    if (pl) { playlistTitle = pl.title || playlistTitle; playlistOwner = pl.owner || pl.artist || ''; cover = pl.cover || ''; }
    if (source === 'soundcloud') {
      if (pl && pl._tracks) {
        tracks = pl._tracks.map((t) => ({ ...t, source: 'soundcloud', scId: t.id, scUrl: t.url }));
        playlistTitle = pl.title;
        playlistOwner = pl.owner;
        cover = pl.cover;
      }
    }
    if (!tracks.length) throw new Error('Треки не найдены (ошибка API)');
    const artistPicture = cover || '';
    const color = await getDominantColor(artistPicture);
    const root = document.documentElement;
    root.style.setProperty('--artist-rgb', color.rgb);
    root.style.setProperty('--artist-r', color.r);
    root.style.setProperty('--artist-g', color.g);
    root.style.setProperty('--artist-b', color.b);

    let html = `
    <div class="album-detail-view">
      <canvas class="artist-waves" id="artistWaves"></canvas>
      <div class="album-detail-fade"></div>
      <div class="album-detail-left">
        <button class="btn-back" id="albumBack"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg>К плейлистам</button>
        <div class="album-detail-header">
          <img src="${cover}" alt="" id="albumCoverImg" loading="lazy" />
          <div class="album-detail-info">
            <h2>${escapeHtml(playlistTitle)}</h2>
            <p>${playlistOwner ? `<button class="link-artist" id="albumArtistLink">${escapeHtml(playlistOwner)}</button>` : ''}${playlistOwner ? ' · ' : ''}${tracks.length} треков</p>
            <button class="btn btn-primary btn-sm" id="albumPlayAll">${icons.play}<span>Воспроизвести всё</span></button>
          </div>
        </div>
        <div class="album-detail-tracks">`;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      html += `<div class="album-detail-row" data-idx="${i}"><span class="pos">${i + 1}</span><span class="name">${escapeHtml(t.artist)} · ${escapeHtml(t.title)}</span><span class="dur">${formatDuration(t.duration)}</span></div>`;
    }
    html += `</div></div>
      ${buildArtistBioScene(playlistOwner, artistPicture)}
    </div>`;
    detail.innerHTML = html;

    $('#albumBack').onclick = closeAlbumDetail;
    const albumArtistLink = $('#albumArtistLink');
    if (albumArtistLink && playlistOwner) albumArtistLink.onclick = () => showArtistPage(playlistOwner);
    const playAll = $('#albumPlayAll');
    playAll.onclick = () => {
      state.visibleTracks = tracks; playTrack(tracks[0], 0);
    };
    detail.querySelectorAll('.album-detail-row').forEach((row) => {
      row.onclick = () => {
        const t = tracks[Number(row.dataset.idx)];
        state.visibleTracks = tracks; playTrack(t, Number(row.dataset.idx));
      };
    });
    loadArtistBio(playlistOwner || '');
    animateAlbumDetail();
  } catch (e) {
    detail.innerHTML = `<div class="empty-search"><h2>Не удалось загрузить плейлист</h2><p>${escapeHtml(e.message || '')}</p></div>`;
    toast(e.message, 'error');
  }
}

function cleanArtistScene() {
  teardownArtistScene();
  const old = $('#artistScene');
  if (old) old.remove();
}

function buildArtistBioScene(artist, picture) {
  return `<div class="album-detail-right" id="artistScene">
    <div class="album-bio-backdrop" id="albumBioBackdrop" style="background:radial-gradient(ellipse at 50% 50%, rgba(var(--artist-rgb),.16) 0%, transparent 70%)"></div>
    ${picture ? `<div class="artist-hero" id="artistHero"><img class="artist-hero-pic" id="artistHeroPic" src="${escapeHtml(picture)}" alt="" loading="lazy" onerror="this.closest('.artist-hero').classList.add('no-pic')" /></div>` : ''}
    <div class="artist-bio-panel" id="artistBioPanel">
      <span class="artist-bio-eyebrow">Об исполнителе</span>
      <h3 class="artist-bio-name" id="artistBioName">${escapeHtml(artist || '')}</h3>
      <p class="artist-bio-desc" id="artistBioDesc" hidden></p>
      <div class="artist-facts" id="artistFacts" hidden></div>
      <p class="artist-bio-text" id="artistBioText">Загружаем информацию…</p>
      <a class="artist-bio-link" id="artistBioLink" target="_blank" rel="noreferrer" hidden>Читать в Википедии →</a>
    </div>
  </div>`;
}

async function loadArtistBio(artist) {
  const text = $('#artistBioText');
  const link = $('#artistBioLink');
  const nameEl = $('#artistBioName');
  const descEl = $('#artistBioDesc');
  const factsEl = $('#artistFacts');
  if (!text || !artist) { if (text) text.textContent = ''; return; }
  try {
    const data = await request(`/artist/bio?name=${encodeURIComponent(artist)}`, { timeout: API_TIMEOUT.albums });
    if (data && data.ok && (data.extract || data.description)) {
      if (nameEl && data.title) nameEl.textContent = data.title;
      if (descEl && data.description) { descEl.textContent = data.description; descEl.hidden = false; }
      if (factsEl && Array.isArray(data.facts) && data.facts.length) {
        factsEl.innerHTML = data.facts.map((f) =>
          `<span class="artist-fact"><b>${escapeHtml(f.key)}</b>${escapeHtml(f.value)}</span>`).join('');
        factsEl.hidden = false;
      }
      text.textContent = data.extract || '';
      if (link && data.url) { link.href = data.url; link.hidden = false; }
      return;
    }
    text.textContent = 'Биографию найти не удалось';
  } catch (e) {
    text.textContent = '';
  }
}

/* Личная статистика по исполнителю из локальных данных плеера. */
function artistPersonalStats(artist) {
  const key = (artist || '').trim().toLowerCase();
  if (!key) return null;
  const mine = state.tracks.filter((t) => (t.artist || '').trim().toLowerCase() === key);
  const logs = listenLog.filter((r) => (r.artist || '').trim().toLowerCase() === key);
  const favs = favorites.filter((f) => (f.artist || '').trim().toLowerCase() === key);
  const inPlaylists = playlists.filter((p) => (p.tracks || []).some((t) => (t.artist || '').trim().toLowerCase() === key));
  const seconds = logs.reduce((sum, r) => sum + (r.duration || 0), 0);
  const times = logs.map((r) => r.at).filter(Boolean);
  return {
    tracks: mine.length,
    plays: logs.length,
    seconds,
    favorites: favs.length,
    playlists: inPlaylists.length,
    first: times.length ? Math.min(...times) : 0,
    last: times.length ? Math.max(...times) : 0,
  };
}

function renderArtistStats(artist) {
  const box = $('#artistStats');
  if (!box) return;
  const st = artistPersonalStats(artist);
  if (!st || (!st.tracks && !st.plays && !st.favorites)) { box.hidden = true; return; }
  const fmtDate = (ms) => ms ? new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const tiles = [];
  if (st.tracks) tiles.push([st.tracks, pluralRu(st.tracks, 'трек', 'трека', 'треков') + ' у вас']);
  if (st.plays) tiles.push([st.plays, pluralRu(st.plays, 'прослушивание', 'прослушивания', 'прослушиваний')]);
  if (st.seconds) tiles.push([fmtStatTime(st.seconds), 'вы слушали']);
  if (st.favorites) tiles.push([st.favorites, 'в избранном']);
  if (!tiles.length) { box.hidden = true; return; }
  const notes = [];
  if (st.first) notes.push(`Впервые — ${fmtDate(st.first)}`);
  if (st.last && st.last !== st.first) notes.push(`последний раз — ${fmtDate(st.last)}`);
  if (st.playlists) notes.push(`в ${st.playlists} ${pluralRu(st.playlists, 'плейлисте', 'плейлистах', 'плейлистах')}`);
  box.innerHTML = `
    <div class="artist-stats-head">Вы и этот исполнитель</div>
    <div class="artist-stats-grid">
      ${tiles.map(([v, l]) => `<div class="artist-stat"><b>${escapeHtml(String(v))}</b><small>${escapeHtml(l)}</small></div>`).join('')}
    </div>
    ${notes.length ? `<p class="artist-stats-note">${escapeHtml(notes.join(' · '))}</p>` : ''}`;
  box.hidden = false;
}

let artistWaveState = null;
function stopArtistWaves() {
  if (artistWaveState) {
    cancelAnimationFrame(artistWaveState.raf);
    window.removeEventListener('resize', artistWaveState.onResize);
    artistWaveState = null;
  }
}

function startArtistWaves() {
  stopArtistWaves();
  const canvas = document.getElementById('artistWaves');
  if (!canvas || !canvas.getContext) return;
  const reduce = reduceMotion();
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const r = parseInt(css.getPropertyValue('--artist-r'), 10) || 130;
  const g = parseInt(css.getPropertyValue('--artist-g'), 10) || 120;
  const b = parseInt(css.getPropertyValue('--artist-b'), 10) || 240;
  let W = 0, H = 0;
  const st = { raf: 0, onResize: null };
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  st.onResize = resize;
  window.addEventListener('resize', resize);
  const N = 6;
  const ribbons = [];
  for (let i = 0; i < N; i++) {
    ribbons.push({
      yf: 0.14 + 0.72 * (i / (N - 1)),
      amp: 24 + Math.random() * 30,
      k: (1.0 + Math.random() * 1.3) / 300,
      speed: 0.5 + Math.random() * 0.8,
      phase: Math.random() * Math.PI * 2,
      thick: 42 + Math.random() * 48,
      alpha: 0.06 + Math.random() * 0.06,
    });
  }
  function frame() {
    ctx.clearRect(0, 0, W, H);
    for (const rb of ribbons) {
      const baseY = rb.yf * H;
      const step = 16;
      ctx.beginPath();
      let first = true;
      for (let x = W + 40; x >= -40; x -= step) {
        const p = x / W;
        const y = baseY + Math.sin(x * rb.k + rb.phase) * rb.amp * (0.45 + 0.55 * p);
        if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
      }
      const grad = ctx.createLinearGradient(W, 0, 0, 0);
      grad.addColorStop(0.00, `rgba(${r},${g},${b},${rb.alpha})`);
      grad.addColorStop(0.38, `rgba(${r},${g},${b},${rb.alpha * 0.65})`);
      grad.addColorStop(0.72, `rgba(${r},${g},${b},0)`);
      grad.addColorStop(1.00, `rgba(${r},${g},${b},0)`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = rb.thick;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      rb.phase += 0.006 * rb.speed;
    }
    if (!reduce) st.raf = requestAnimationFrame(frame);
  }
  frame();
  artistWaveState = st;
}

function teardownArtistScene() {
  stopArtistWaves();
  if (window.gsap) gsap.killTweensOf('#artistPortrait, #artistGlow, #artistBg, #artistSweep, #artistWaves');
}

function animateAlbumDetail() {
  const reduce = reduceMotion();
  const rows = document.querySelectorAll('.album-detail-row');
  const bg = $('#artistBg'), glow = $('#artistGlow'), portrait = $('#artistPortrait');
  const sweep = $('#artistSweep'), waves = $('#artistWaves');
  const bioPanel = $('#artistBioPanel');
  if (!window.gsap) {
    if (portrait) document.querySelectorAll('.artist-bg, .artist-glow, .artist-portrait-wrap').forEach((el) => { el.style.opacity = '1'; });
    const heroFallback = $('#artistHero');
    if (heroFallback) heroFallback.style.opacity = '1';
    if (bioPanel) bioPanel.style.opacity = '1';
    const wv = document.getElementById('artistWaves'); if (wv) wv.style.opacity = '1';
    rows.forEach((el) => { el.style.opacity = '1'; });
    if (portrait) startArtistWaves();
    return;
  }
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
  if (bioPanel) {
    const hero = $('#artistHero');
    if (hero) tl.fromTo(hero, { opacity: 0, xPercent: 6, filter: 'blur(14px)' }, { opacity: 1, xPercent: 0, filter: 'blur(0px)', duration: 0.85, ease: 'power3.out' });
    tl.fromTo(bioPanel, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' }, hero ? '-=0.6' : 0);
    if (rows.length) tl.fromTo(rows, { opacity: 0, x: -16, filter: 'blur(4px)' }, { opacity: 1, x: 0, filter: 'blur(0px)', duration: 0.42, stagger: 0.03, ease: 'power3.out' }, '-=0.25');
    return;
  }
  tl.set(bg, { opacity: 0 });
  tl.set(glow, { opacity: 0, scale: 0.7 });
  tl.set(portrait, { opacity: 0, scale: 1.08, xPercent: 6, filter: 'blur(22px) brightness(0.5) contrast(0.9)' });
  tl.set(waves, { opacity: 0 });
  tl.set(sweep, { opacity: 0, xPercent: -32 });
  tl.to(bg, { opacity: 1, duration: 0.6 });
  tl.to(glow, { opacity: 0.6, scale: 1.06, duration: 0.9, ease: 'power2.out' }, '-=0.4');
  tl.to(glow, { scale: 1, duration: 1.1, ease: 'sine.inOut' }, '-=0.25');
  tl.to(portrait, { opacity: 1, scale: 1, xPercent: 0, filter: 'blur(0px) brightness(1.08) contrast(1.04)', duration: 1.15, ease: 'power3.out' }, '-=1.15');
  tl.to(sweep, { opacity: 1, xPercent: 8, duration: 0.55, ease: 'power2.in' }, '-=0.85');
  tl.to(sweep, { xPercent: 34, opacity: 0, duration: 0.7, ease: 'power2.out' }, '-=0.15');
  tl.to(waves, { opacity: 1, duration: 1.2, ease: 'power2.out' }, '-=1.0');
  if (rows.length) {
    tl.fromTo(rows, { opacity: 0, x: -16, filter: 'blur(4px)' }, { opacity: 1, x: 0, filter: 'blur(0px)', duration: 0.42, stagger: 0.03, ease: 'power3.out' }, '-=1.05');
  }
  if (!reduce) {
    gsap.to(portrait, { scale: 1.035, duration: 6, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 1.2 });
    gsap.to(glow, { opacity: 0.42, scale: 1.09, duration: 4.5, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 1.2 });
  }
  startArtistWaves();
}

async function playAlbumTrack(track, artistName, albumTracks, idx) {
  toast(`Поиск: ${artistName} — ${track.title}…`);
  try {
    const data = await request(`/sc/search?q=${encodeURIComponent(artistName + ' ' + track.title)}&count=1`, { timeout: API_TIMEOUT.default });
    const found = (data.tracks || [])[0];
    if (!found) { toast('Трек не найден в SoundCloud', 'error'); return; }
    const t = { title: found.title, artist: found.artist, scUrl: found.url, scId: found.id, source: 'soundcloud', thumbnail: found.thumbnail, duration: found.duration || track.duration, album: 'Deezer Альбом', color: '', _keepAlbumOpen: true, _albumRowIndex: idx };
    if (Array.isArray(albumTracks) && albumTracks.length && Number.isInteger(idx)) {
      const queue = albumTracks.map((x, i) => (i === idx ? t : {
        title: x.title, artist: x.artist || artistName, scUrl: null, scId: null, source: 'soundcloud',
        thumbnail: x.thumbnail || '', duration: x.duration || 0, album: 'Deezer Альбом', color: '',
        _needsLookup: `${artistName} ${x.title}`, _keepAlbumOpen: true, _albumRowIndex: i,
      }));
      state.visibleTracks = queue;
      playTrack(t, idx);
      return;
    }
    state.visibleTracks = [t];
    playTrack(t, 0);
  } catch (e) { toast('Ошибка поиска: ' + e.message, 'error'); }
}

function highlightAlbumTrack(index) {
  const detail = $('#albumDetail');
  if (!detail || detail.hidden) return;
  detail.querySelectorAll('.album-detail-row').forEach((row) => {
    row.classList.toggle('album-playing', Number(row.dataset.idx) === index);
  });
}

function showAlbumQueueLoading(total) {
  const detail = $('#albumDetail');
  if (!detail || detail.hidden) return null;
  clearAlbumQueueLoading();
  const cover = $('#albumCoverImg')?.src || '';
  const overlay = document.createElement('div');
  overlay.className = 'album-queue-loading';
  overlay.style.setProperty('--album-loading-cover', cover ? `url("${cover.replace(/"/g, '%22')}")` : 'none');
  overlay.innerHTML = `<i class="album-queue-loader" aria-hidden="true"></i><b>Альбом загружается</b><small id="albumQueueStatus">Ищем треки: 0 из ${total}</small><div class="album-queue-progress"><i></i></div>`;
  detail.appendChild(overlay);
  albumQueueLoadingOverlay = overlay;
  return overlay;
}

async function playAlbumQueue(deezerTracks, artistName) {
  const loading = showAlbumQueueLoading(deezerTracks.length);
  const scTracks = [];
  for (let i = 0; i < deezerTracks.length; i++) {
    const dt = deezerTracks[i];
    try {
      const data = await request(`/sc/search?q=${encodeURIComponent(artistName + ' ' + dt.title)}&count=1`, { timeout: API_TIMEOUT.default });
      const found = (data.tracks || [])[0];
      if (found) scTracks.push({ title: found.title, artist: found.artist, scUrl: found.url, scId: found.id, source: 'soundcloud', thumbnail: dt.cover || found.thumbnail, cover: dt.cover || '', duration: found.duration || dt.duration, album: 'Deezer Альбом', color: '', _keepAlbumOpen: true, _albumRowIndex: i });
    } catch (e) { /* skip */ }
    if (loading) {
      loading.style.setProperty('--album-progress', `${((i + 1) / deezerTracks.length) * 100}%`);
      const status = loading.querySelector('#albumQueueStatus');
      if (status) status.textContent = `Ищем треки: ${i + 1} из ${deezerTracks.length}`;
    }
  }
  if (!scTracks.length) { loading?.remove(); toast('Не удалось найти треки альбома в SoundCloud', 'error'); return; }
  state.visibleTracks = [...scTracks];
  highlightAlbumTrack(scTracks[0]._albumRowIndex);
  if (loading) {
    const status = loading.querySelector('#albumQueueStatus');
    if (status) status.textContent = 'Запускаем первый трек…';
  }
  playTrack(scTracks[0], 0);
}

/* ============================================================
   Artist page
   ============================================================ */

async function showArtistPage(artist) {
  artist = (artist || '').trim();
  if (!artist) return;
  if ($('#albumDetail') && !$('#albumDetail').hidden) closeAlbumDetail();
  if ($('#playlistDetail') && !$('#playlistDetail').hidden) closePlaylistPage();
  const detail = $('#artistDetail');
  if (!detail) return;
  detail.hidden = false;
  detail.innerHTML = '<p style="color:var(--text-3);padding:50px 0">Загрузка…</p>';
  cleanArtistScene();
  try {
    const picture = `${API}/artist-image?name=${encodeURIComponent(artist)}`;
    const [color, tracks] = await Promise.all([
      getDominantColor(picture),
      searchSC(artist, 25),
    ]);
    const root = document.documentElement;
    root.style.setProperty('--artist-rgb', color.rgb);
    root.style.setProperty('--artist-r', color.r);
    root.style.setProperty('--artist-g', color.g);
    root.style.setProperty('--artist-b', color.b);
    // По имени артиста поиск подмешивает мусор («GREAT PHARAOHS OF EGYPT…»),
    // поэтому сначала показываем то, где имя реально совпало.
    const scTracksRanked = rankArtistTracks(tracks.map((t) => ({ ...t, source: 'soundcloud', scUrl: t.url, scId: t.id, album: 'SoundCloud' })), artist);
    const listHtml = scTracksRanked.length
      ? scTracksRanked.map((t, i) => `
        <div class="album-detail-row" data-idx="${i}">
          ${t.thumbnail ? `<img class="sc-thumb-sm" src="${escapeHtml(t.thumbnail)}" alt="" loading="lazy" />` : `<span class="pos">${String(i + 1).padStart(2, '0')}</span>`}
          <span class="name">${escapeHtml(t.title)}</span>
          <span class="dur">${formatDuration(t.duration)}</span>
        </div>`).join('')
      : '<p style="color:var(--text-3);padding:20px 0">Треки не найдены</p>';
    detail.innerHTML = `
    <div class="album-detail-view">
      <canvas class="artist-waves" id="artistWaves"></canvas>
      <div class="album-detail-fade"></div>
      <div class="album-detail-left">
        <button class="btn-back" id="artistBack"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg>Назад</button>
        <div class="album-detail-header">
          <img src="${picture}" alt="" id="artistCoverImg" loading="lazy" onerror="this.style.display='none'" />
          <div class="album-detail-info">
            <h2>${escapeHtml(artist)}</h2>
            <p>${scTracksRanked.length} ${plural(scTracksRanked.length)} на SoundCloud</p>
            <div class="artist-actions">
              <button class="btn btn-primary btn-sm" id="artistPlayAll">${icons.play}<span>Слушать все</span></button>
              <button class="btn btn-ghost btn-sm" id="artistRadioBtn"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/></svg><span>Радио</span></button>
            </div>
          </div>
        </div>
        <div class="artist-stats" id="artistStats" hidden></div>
        <div class="section-title artist-tracks-title"><h2>Популярные треки</h2></div>
        <div class="album-detail-tracks">${listHtml}</div>
      </div>
      ${buildArtistBioScene(artist, picture)}
    </div>`;

    renderArtistStats(artist);
    $('#artistBack').onclick = closeArtistPage;
    $('#artistPlayAll').onclick = () => playArtistAll(scTracksRanked, artist);
    $('#artistRadioBtn').onclick = () => { closeArtistPage(); startArtistRadio(artist); };
    detail.querySelectorAll('.album-detail-row').forEach((row) => {
      row.onclick = () => playArtistTrack(scTracksRanked[Number(row.dataset.idx)], scTracksRanked, Number(row.dataset.idx));
    });
    loadArtistBio(artist);
    animateAlbumDetail();
  } catch (e) {
    detail.innerHTML = `<div class="empty-search"><h2>Не удалось загрузить артиста</h2><p>${escapeHtml(e.message || '')}</p></div>`;
    toast(e.message, 'error');
  }
}

function closeArtistPage() {
  teardownArtistScene();
  const detail = $('#artistDetail');
  if (!detail) return;
  detail.hidden = true;
  detail.innerHTML = '';
}

/* Наверх — настоящие треки артиста; документалки и часовые миксы вниз.
   Поле artist у SoundCloud — это аплоадер, поэтому главный признак —
   имя артиста в НАЧАЛЕ названия («PHARAOH - ДИКО, НАПРИМЕР»). */
function rankArtistTracks(tracks, artist) {
  const name = (artist || '').trim().toLowerCase();
  if (!name) return tracks;
  const score = (t) => {
    const ta = (t.artist || '').toLowerCase();
    const ti = (t.title || '').trim().toLowerCase();
    const dur = t.duration || 0;
    let s = 0;
    if (ti.startsWith(name)) s += 4;
    else if (ti.includes(name)) s += 1;
    if (ta === name) s += 3;
    else if (ta.includes(name)) s += 2;
    if (dur > 1200) s -= 4;        // документалки, сборники, лайв-сеты
    else if (dur > 600) s -= 2;
    else if (dur && dur < 90) s -= 1;
    return s;
  };
  return tracks
    .map((t, i) => ({ t, i, s: score(t) }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map((x) => x.t);
}

function playArtistTrack(track, list, idx) {
  if (!track || (!track.scUrl && !track.scId)) return;
  // Очередь — весь список артиста, иначе «следующий» некуда листать.
  if (Array.isArray(list) && list.length) {
    state.visibleTracks = list;
    playTrack(track, Number.isInteger(idx) ? idx : list.indexOf(track));
    return;
  }
  state.visibleTracks = [track];
  playTrack(track, 0);
}

function playArtistAll(tracks, artist) {
  if (!tracks.length) { toast('Нет треков для воспроизведения', 'error'); return; }
  state.visibleTracks = [...tracks];
  playTrack(tracks[0], 0);
  toast(`Играет: ${artist}`);
}

/* ============================================================
   Dynamic theme / colors
   ============================================================ */

function extractHue(color) {
  if (!color) return 250;
  const m = color.match(/hsl\((\d+)/);
  if (m) return parseInt(m[1], 10);
  const hm = color.match(/#([0-9a-fA-F]{6})/);
  if (hm) {
    const r = parseInt(hm[1].slice(0, 2), 16) / 255, g = parseInt(hm[1].slice(2, 4), 16) / 255, b = parseInt(hm[1].slice(4, 6), 16) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let h = 0;
    if (mx !== mn) {
      const d = mx - mn;
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return Math.round(h);
  }
  return 250;
}

function applyDynamicTheme(track) {
  const hue = !settings.themeAuto && settings.themeHue != null ? settings.themeHue : extractHue(track?.color);
  const root = document.documentElement;
  root.style.setProperty('--dyn-h', hue);
  root.style.setProperty('--dyn-accent', `hsl(${hue}, 78%, 62%)`);
  root.style.setProperty('--dyn-glow', `hsla(${hue}, 78%, 55%, 0.16)`);
  root.style.setProperty('--dyn-glow-strong', `hsla(${hue}, 85%, 58%, 0.32)`);
  if (window.gsap) gsap.to(root, { '--dyn-h': hue, duration: 1.2, ease: 'power1.inOut' });
}

function updatePlayingGlow() {
  applyHue(effectiveHue());
}

function spawnPlayParticles() {
  if (!window.gsap || reduceMotion()) return;
  const btn = $('#npPlay');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const hue = extractHue(state.currentTrack?.color);
  for (let i = 0; i < 16; i++) {
    const dot = document.createElement('div');
    dot.className = 'play-particle';
    dot.style.cssText = `position:fixed;width:6px;height:6px;border-radius:50%;pointer-events:none;z-index:9999;left:${cx}px;top:${cy}px;background:hsl(${(hue + i * 22) % 360}, 85%, 68%);`;
    document.body.appendChild(dot);
    const angle = (i / 16) * Math.PI * 2;
    const dist = 34 + Math.random() * 54;
    gsap.to(dot, {
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      opacity: 0,
      scale: 0,
      duration: 0.5 + Math.random() * 0.35,
      ease: 'power2.out',
      onComplete: () => dot.remove(),
    });
  }
}

/* ============================================================
   Library management
   ============================================================ */

async function addLocalTrack(file) {
  if (!file) return;
  if (!file.type.startsWith('audio') && !/\.(mp3|ogg|wav|m4a|flac|aac|webm|opus)$/i.test(file.name)) {
    return toast('Выберите аудиофайл', 'error');
  }
  const name = file.name.replace(/\.[^.]+$/, '');
  const parts = name.split(' - ');
  const artist = parts.length > 1 ? parts[0].trim() : 'Локальный файл';
  const title = parts.length > 1 ? parts.slice(1).join(' - ').trim() : name;
  const hue = Math.floor(Math.random() * 360);
  const meta = {
    title, artist, album: 'Мои треки', duration: 0,
    color: `linear-gradient(135deg,hsl(${hue} 50% 42%),hsl(${(hue + 70) % 360} 62% 34%))`,
  };
  try {
    const dbId = await idbSave(meta, file);
    const track = { ...meta, id: dbId, dbId, source: 'local' };
    state.tracks.unshift(track);
    state.sortNewest = true;
    $('#filterInput').value = '';
    renderTracks();
    toast('Трек добавлен в библиотеку', 'success');
    const idx = state.visibleTracks.indexOf(track);
    playTrack(track, idx);
  } catch (e) {
    toast('Не удалось сохранить файл: ' + e.message, 'error');
  }
}

async function deleteTrack(id) {
  const track = state.tracks.find((t) => t.id === id);
  if (!track) return;
  const ok = await confirmDialog({
    title: 'Удалить трек?',
    body: `«${track.title}» будет удалён из библиотеки.`,
    confirmText: 'Удалить',
  });
  if (!ok) return;
  await idbDelete(id);
  state.tracks = state.tracks.filter((t) => t.id !== id);
  if (state.currentTrack && state.currentTrack.id === id) { audio.pause(); audioB.pause(); state.currentTrack = null; renderPlayerBar(null); }
  renderTracks();
  toast('Трек удалён', 'success');
}

/* ============================================================
   Row interactions (delegated)
   ============================================================ */

function listForMode(mode) {
  if (mode === 'search') return state.searchResults;
  if (mode === 'favorites') return favorites.map(favRecordToTrack);
  if (mode === 'scLib') return state.scLibTracks;
  return state.visibleTracks;
}

function closeTrackMenus(except) {
  $$('.track-menu').forEach((m) => {
    if (m === except) return;
    m.hidden = true;
    m.parentElement?.querySelector('.track-more')?.classList.remove('open');
  });
}

document.addEventListener('click', async (e) => {
  const moreBtn = e.target.closest('.track-more');
  if (moreBtn) {
    e.stopPropagation();
    const menu = moreBtn.parentElement?.querySelector('.track-menu');
    if (!menu) return;
    const willOpen = menu.hidden;
    closeTrackMenus(menu);
    menu.hidden = !willOpen;
    moreBtn.classList.toggle('open', willOpen);
    return;
  }
  const inTrackMenu = e.target.closest('.track-menu');
  closeTrackMenus();
  if (inTrackMenu && !e.target.closest('.track-menu > button')) { e.stopPropagation(); return; }

  const artistEl = e.target.closest('.track-artist');
  if (artistEl) {
    e.stopPropagation();
    const row = artistEl.closest('.track-row');
    const list = listForMode(row?.dataset.source);
    const track = list[Number(row?.dataset.index)];
    if (track && track.artist) showArtistPage(track.artist);
    return;
  }
  const favBtn = e.target.closest('.track-fav');
  if (favBtn) {
    e.stopPropagation();
    const row = favBtn.closest('.track-row');
    const list = listForMode(row?.dataset.source);
    const track = list[Number(row?.dataset.index)];
    if (track) toggleFav(track);
    return;
  }
  const dlBtn = e.target.closest('.track-dl');
  if (dlBtn) {
    e.stopPropagation();
    const row = dlBtn.closest('.track-row');
    const list = listForMode(row?.dataset.source);
    const track = list[Number(row?.dataset.index)];
    if (track) downloadSoundcloudTrack(track);
    return;
  }
  const plBtn = e.target.closest('.track-pl');
  if (plBtn) {
    e.stopPropagation();
    const row = plBtn.closest('.track-row');
    const list = listForMode(row?.dataset.source);
    const track = list[Number(row?.dataset.index)];
    if (track) openAddToPlaylist(track);
    return;
  }
  const delBtn = e.target.closest('.track-del');
  if (delBtn) {
    e.stopPropagation();
    const id = Number(delBtn.dataset.del);
    if (id && Number.isFinite(id)) deleteTrack(id);
    return;
  }
  const row = e.target.closest('.track-row');
  if (!row) return;
  const list = listForMode(row.dataset.source);
  const index = Number(row.dataset.index);
  const track = list[index];
  if (!track) return;

  if (row.dataset.source === 'favorites') {
    state.visibleTracks = favorites.map(favRecordToTrack);
    playTrack(track, index);
  } else if (row.dataset.source === 'search') {
    state.visibleTracks = state.searchResults;
    playTrack(track, index);
  } else {
    state.visibleTracks = list;
    playTrack(track, index);
  }
});

/* ============================================================
   Launch
   ============================================================ */

async function launchLocalPlayer() {
  const btn = $('#launchLocal');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span>Загрузка…</span>'; }
  // Show the player immediately so the button always works,
  // even if IndexedDB is slow/unavailable in this webview.
  document.body.classList.add('app-on');
  state.launched = true;
  if ($('#loginView')) $('#loginView').hidden = true;
  if ($('#dashboard')) $('#dashboard').hidden = false;
  setUser({ first_name: 'Гость', last_name: '' });
  renderTracks();
  if (window.gsap && !reduceMotion()) {
    // clearProps обязателен: остаточный transform на .dashboard делает его
    // точкой отсчёта для position:fixed и ломает полноэкранные оверлеи.
    gsap.fromTo('.dashboard', { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out', clearProps: 'transform' });
    gsap.fromTo('#dashboard .stats article', { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out', stagger: 0.06, delay: 0.1, clearProps: 'transform' });
  }
  // Load saved tracks in the background (non-blocking).
  loadTracksFromIDB().then((tracks) => {
    if (tracks && tracks.length) {
      state.tracks = tracks;
      renderTracks();
      toast(`Загружено треков: ${tracks.length}`, 'success', 2600);
    }
  }).catch(() => {});
  const deep = location.hash.slice(1);
  if (deep) switchView(deep);
}

function setUser(user) {
  const name = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Гость';
  const avatar = user.photo || avatarData(name);
  $('#miniName').textContent = name;
  $('#miniAvatar').src = avatar;
  $('#settingsAvatar').src = avatar;
  $('#settingsName').textContent = name;
  $('#settingsId').textContent = 'Локальный профиль';
  $('#profileButton').hidden = false;
}

function avatarData(name) {
  const initials = name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><defs><linearGradient id="g"><stop stop-color="#8b5cf6"/><stop offset="1" stop-color="#3b82f6"/></linearGradient></defs><rect width="80" height="80" rx="40" fill="url(#g)"/><text x="40" y="50" fill="white" font-size="27" text-anchor="middle" font-family="Arial" font-weight="700">${escapeHtml(initials)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/* ============================================================
   Lyrics
   ============================================================ */

const lyricsState = { synced: null, lines: [], activeIdx: -1, trackKey: '' };

function parseLrc(text) {
  if (!text) return [];
  return text.split('\n').reduce((acc, line) => {
    const m = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)/);
    if (m) {
      const ts = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + parseInt(m[3].padEnd(3, '0'), 10) / 1000;
      acc.push({ time: ts, text: m[4] });
    }
    return acc;
  }, []);
}

function fetchLyrics(track) {
  if (!track) return;
  const key = `${track.title || ''}|${track.artist || ''}|${track.album || ''}|${track.duration || 0}`;
  if (key === lyricsState.trackKey) return;
  lyricsState.trackKey = key;
  lyricsState.synced = null;
  lyricsState.lines = [];
  lyricsState.activeIdx = -1;
  const body = $('#lyricsBody');
  const head = $('#lyricsHead');
  if (body) body.innerHTML = '<p class="lyrics-empty">Текст загружается…</p>';
  if (head) head.innerHTML = `<span class="lyrics-fs-title">${escapeHtml(track.title || '—')}</span><span class="lyrics-fs-artist">${escapeHtml(track.artist || '')}</span>`;
  const params = new URLSearchParams({
    track_name: track.title || '',
    artist_name: track.artist || '',
    album_name: track.album || '',
    duration: String(track.duration || 0),
  });
  fetch(`${API}/lyrics?${params.toString()}`)
    .then((r) => r.json())
    .then((data) => {
      if (data.instrumental) {
        if (body) body.innerHTML = '<p class="lyrics-instrumental">Инструментальная композиция</p>';
        return;
      }
      const synced = data.syncedLyrics || '';
      const plain = data.plainLyrics || '';
      if (!synced && !plain) {
        if (body) body.innerHTML = '<p class="lyrics-notfound">Текст не найден</p>';
        return;
      }
      if (synced) {
        lyricsState.synced = true;
        lyricsState.lines = parseLrc(synced);
      } else {
        lyricsState.synced = false;
        lyricsState.lines = plain.split('\n').map((t) => ({ time: -1, text: t }));
      }
      renderLyricsLines();
    })
    .catch(() => {
      if (body) body.innerHTML = '<p class="lyrics-notfound">Ошибка загрузки</p>';
    });
}

function renderLyricsLines() {
  const body = $('#lyricsBody');
  if (!body) return;
  body.innerHTML = '';
  lyricsState.lines.forEach((line, i) => {
    const div = document.createElement('div');
    div.className = 'lyrics-line';
    div.textContent = line.text || '\u00A0';
    div.dataset.idx = i;
    if (line.time >= 0) {
      div.addEventListener('click', () => { djActiveElement().currentTime = line.time; });
    }
    body.appendChild(div);
  });
}

function updateLyricsHighlight() {
  if (!lyricsState.synced || !lyricsState.lines.length) return;
  const t = audio.currentTime;
  let idx = -1;
  for (let i = lyricsState.lines.length - 1; i >= 0; i--) {
    if (t >= lyricsState.lines[i].time - 0.1) { idx = i; break; }
  }
  if (idx === lyricsState.activeIdx) return;
  lyricsState.activeIdx = idx;
  const body = $('#lyricsBody');
  if (!body) return;
  body.querySelectorAll('.lyrics-line').forEach((el) => {
    const ji = Number(el.dataset.idx);
    el.classList.remove('active', 'past');
    if (ji === idx) el.classList.add('active');
    else if (ji < idx) el.classList.add('past');
  });
  if (idx >= 0) smoothScrollToActive(body, idx);
}

function smoothScrollToActive(body, idx) {
  const active = body.querySelector('.lyrics-line.active');
  if (!active) return;
  const bRect = body.getBoundingClientRect();
  const aRect = active.getBoundingClientRect();
  const offset = aRect.top - bRect.top - (bRect.height / 2) + (aRect.height / 2);
  body.scrollTo({ top: body.scrollTop + offset, behavior: 'smooth' });
}

const lyricsAnim = { opening: false, closing: false };

function openLyrics() {
  const overlay = $('#lyricsOverlay');
  if (!overlay || lyricsAnim.opening) return;
  lyricsAnim.opening = true;
  overlay.hidden = false;
  overlay.style.opacity = '0';
  overlay.style.pointerEvents = 'auto';
  if (state.currentTrack) fetchLyrics(state.currentTrack);
  if (window.gsap && !reduceMotion()) {
    const lines = overlay.querySelectorAll('.lyrics-line');
    const tl = gsap.timeline({ onComplete: () => { lyricsAnim.opening = false; } });
    tl.fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: 0.4, ease: 'power3.out' });
    const head = $('#lyricsHead');
    const close = $('#lyricsClose');
    if (head) tl.fromTo(head, { opacity: 0, y: -20 }, { opacity: 1, y: 0, duration: 0.35, ease: 'power2.out' }, '-=0.2');
    if (close) tl.fromTo(close, { opacity: 0, scale: 0.7, rotation: -90 }, { opacity: 1, scale: 1, rotation: 0, duration: 0.3, ease: 'back.out(2)' }, '-=0.25');
    if (lines.length) {
      tl.fromTo(lines, { opacity: 0, y: 30, filter: 'blur(6px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.5, ease: 'power2.out', stagger: 0.015 }, '-=0.15');
    }
  } else {
    overlay.style.opacity = '1';
    lyricsAnim.opening = false;
  }
}

function closeLyrics() {
  const overlay = $('#lyricsOverlay');
  if (!overlay || lyricsAnim.closing || overlay.hidden) return;
  lyricsAnim.closing = true;
  overlay.style.pointerEvents = 'none';
  if (window.gsap && !reduceMotion()) {
    const tl = gsap.timeline({ onComplete: () => { overlay.hidden = true; lyricsState.activeIdx = -1; lyricsAnim.closing = false; } });
    tl.to(overlay, { opacity: 0, duration: 0.3, ease: 'power3.in' });
  } else {
    overlay.hidden = true;
    lyricsState.activeIdx = -1;
    lyricsAnim.closing = false;
  }
}

/* ============================================================
   Vinyl shelf & record modes
   ============================================================ */

const CONDITION_ORDER = ['new', 'worn', 'dirty'];
const CONDITION_LABELS = { new: 'Новая', worn: 'Потёртая', dirty: 'Грязная' };

/* Проигрывание каждый раз портит пластинку: при таком числе завершённых
   прослушиваний состояние опускается до следующего уровня. После 'dirty'
   звук продолжает деградировать до самого низкого качества. */
const VINYL_DEGRADES = [
  { cond: 'new', need: 3 },
  { cond: 'worn', need: 6 },
  { cond: 'dirty', need: 10 },
];

function vinylConditionForPlays(plays) {
  let cond = 'new';
  for (const d of VINYL_DEGRADES) if (plays >= d.need) cond = d.cond;
  return cond;
}

function vinylConditionForScratches(count) {
  if (count >= 6) return 'dirty';
  if (count >= 2) return 'worn';
  return 'new';
}

function vinylScratchStats(rec) {
  const list = rec && Array.isArray(rec.scratches) ? rec.scratches : [];
  let sum = 0, max = 0;
  list.forEach((s) => { const sp = s.sp || 0; sum += sp; if (sp > max) max = sp; });
  return { count: list.length, avg: list.length ? sum / list.length : 0, max };
}

/* Насколько сильно портится звук: базовое состояние + накопившаяся порча. */
function vinylPlaySeverity(rec) {
  if (!rec) return 0;
  let sev = CONDITION_ORDER.indexOf(rec.condition || 'new');
  const maxNeed = VINYL_DEGRADES[VINYL_DEGRADES.length - 1].need;
  sev += Math.min(0.4, (rec.plays || 0) / maxNeed * 0.4);
  const stats = vinylScratchStats(rec);
  if (stats.count) sev += Math.min(0.4, 0.12 + stats.count * 0.05);
  return Math.max(0, Math.min(1, sev / 2.4));
}

function vinylBadges(rec) {
  if (!rec) return [];
  const out = [];
  const scr = (rec.scratches || []).length;
  if (scr > 0) out.push(`Царапин: ${scr}`);
  out.push(`Прослушиваний: ${rec.plays || 0}`);
  return out;
}

const VINYL_KEY = 'umbrella_vinyl';

function defaultVinylState() {
  return {
    shelves: [{ id: makePlaylistId(), name: 'Моя полка', records: [] }],
    settings: { needle: true, fxVol: 55 },
    deck: null,
    cue: null,
    dj: { pitchA: 1, pitchB: 1, master: 'a', xfade: 0 },
  };
}

function normalizeVinylRecord(r) {
  const scratches = Array.isArray(r.scratches) ? r.scratches.filter((s) => s && typeof s.d === 'string' && s.d.length > 2) : [];
  return {
    key: r.key || '',
    title: r.title || 'Без названия',
    artist: r.artist || 'Неизвестный исполнитель',
    source: r.source || 'local',
    videoId: r.videoId || null,
    dbId: r.dbId || null,
    thumbnail: r.thumbnail || '',
    duration: r.duration || 0,
    color: r.color || '',
    condition: CONDITION_ORDER.includes(r.condition) ? r.condition : 'new',
    plays: Number.isFinite(r.plays) ? Math.max(0, Math.floor(r.plays)) : 0,
    scratches,
    flipped: !!r.flipped,
  };
}

function normalizeVinylState(raw) {
  const def = defaultVinylState();
  if (!raw || !Array.isArray(raw.shelves)) return def;
  const out = {
    shelves: raw.shelves.map((s) => ({
      id: s.id || makePlaylistId(),
      name: s.name || 'Полка',
      records: (s.records || []).map(normalizeVinylRecord),
    })),
    settings: Object.assign({ needle: true, fxVol: 55 }, raw.settings || {}),
    deck: raw.deck ? normalizeVinylRecord(raw.deck) : null,
    cue: raw.cue ? normalizeVinylRecord(raw.cue) : null,
    dj: Object.assign({ pitchA: 1, pitchB: 1, master: 'a', xfade: 0 }, raw.dj || {}),
  };
  if (!out.shelves.length) out.shelves = def.shelves;
  return out;
}

let vinylState = normalizeVinylState(loadJSON(VINYL_KEY, null));

function saveVinylState() { saveJSON(VINYL_KEY, vinylState); }

function vinylFindShelf(shelfId) {
  return vinylState.shelves.find((s) => s.id === shelfId);
}

/* ---------- VinylFX (generated vinyl sound) ---------- */

function createVinylFX(getInput, getOutput) {
  const CONDITION_CUTOFF = { new: 20000, worn: 5200, dirty: 3400 };
  const s = {
    built: false, active: false, connected: false,
    ctx: null, inGain: null, outGain: null, lowpass: null,
    noiseBuf: null, crackleGain: null, hissGain: null, rumbleGain: null,
    scratchBuf: null, scratchNode: null, grainGain: null,
    timer: null, nextNoise: 0,
    condition: 'new', vol: 0.55, needleOn: true,
    playbackSev: 0, nextGrain: 0,
  };
  function build() {
    if (s.built) return true;
    if (!AudioCtx || !audioCtx) return false;
    try {
      const ctx = audioCtx;
      s.ctx = ctx;
      s.inGain = ctx.createGain();
      s.outGain = ctx.createGain();
      s.lowpass = ctx.createBiquadFilter();
      s.lowpass.type = 'lowpass';
      s.lowpass.frequency.value = CONDITION_CUTOFF[s.condition] || 20000;
      s.lowpass.Q.value = 0.5;
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      s.noiseBuf = buf;
      const crackleSrc = ctx.createBufferSource();
      crackleSrc.buffer = buf;
      crackleSrc.loop = true;
      const cf = ctx.createBiquadFilter();
      cf.type = 'highpass'; cf.frequency.value = 1400;
      s.crackleGain = ctx.createGain();
      s.crackleGain.gain.value = 0;
      crackleSrc.connect(cf); cf.connect(s.crackleGain); s.crackleGain.connect(s.inGain);
      crackleSrc.start();
      const hissSrc = ctx.createBufferSource();
      hissSrc.buffer = buf;
      hissSrc.loop = true;
      hissSrc.playbackRate.value = 0.55;
      const hf = ctx.createBiquadFilter();
      hf.type = 'bandpass'; hf.frequency.value = 4600; hf.Q.value = 0.5;
      s.hissGain = ctx.createGain();
      s.hissGain.gain.value = 0;
      hissSrc.connect(hf); hf.connect(s.hissGain); s.hissGain.connect(s.inGain);
      hissSrc.start();
      const rumble = ctx.createOscillator();
      rumble.type = 'triangle'; rumble.frequency.value = 34;
      s.rumbleGain = ctx.createGain();
      s.rumbleGain.gain.value = 0;
      rumble.connect(s.rumbleGain); s.rumbleGain.connect(s.inGain);
      rumble.start();
      const sb = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.14), ctx.sampleRate);
      const sd = sb.getChannelData(0);
      for (let i = 0; i < sd.length; i++) sd[i] = (Math.random() * 2 - 1) * Math.exp(-5 * (i / sd.length));
      s.scratchBuf = sb;
      s.grainGain = ctx.createGain();
      s.grainGain.gain.value = 0;
      s.grainGain.connect(s.inGain);
      s.timer = setInterval(schedule, 90);
      s.built = true;
      return true;
    } catch (e) { return false; }
  }
  function connect() {
    if (s.connected || !s.built || !audioCtx) return;
    try {
      const input = getInput();
      const output = getOutput();
      if (!input || !output) return;
      input.disconnect();
      input.connect(s.lowpass);
      s.lowpass.connect(s.inGain);
      s.inGain.connect(s.outGain);
      s.outGain.connect(output);
      s.connected = true;
    } catch (e) { /* ignore */ }
  }
  function disconnect() {
    if (!s.connected || !audioCtx) return;
    try {
      const input = getInput();
      const output = getOutput();
      if (!input || !output) return;
      input.disconnect();
      input.connect(output);
      s.connected = false;
    } catch (e) { /* ignore */ }
  }
  function schedule() {
    if (!s.active || !s.ctx) return;
    const now = s.ctx.currentTime;
    if (now >= s.nextNoise) {
      const rates = { new: 0.5, worn: 1.5, dirty: 2.8 };
      const gains = { new: 0.05, worn: 0.16, dirty: 0.32 };
      s.nextNoise = now + (1 / (rates[s.condition] || 1)) * (0.6 + Math.random() * 0.8);
      const g = (gains[s.condition] || 0.1) * s.vol * (0.5 + Math.random() * 0.9);
      const t = now;
      s.crackleGain.gain.cancelScheduledValues(t);
      s.crackleGain.gain.setValueAtTime(0, t);
      s.crackleGain.gain.linearRampToValueAtTime(g, t + 0.002);
      s.crackleGain.gain.linearRampToValueAtTime(0, t + 0.04 + Math.random() * 0.07);
    }
    const hiss = ({ new: 0.012, worn: 0.06, dirty: 0.14 })[s.condition] || 0.05;
    s.hissGain.gain.setTargetAtTime(hiss * s.vol, now, 0.25);
    const rumble = (s.needleOn ? 0.02 : 0) * (s.condition === 'dirty' ? 1.6 : 1);
    s.rumbleGain.gain.setTargetAtTime(rumble, now, 0.25);
    if (s.playbackSev > 0 && now >= s.nextGrain) {
      const sev = s.playbackSev;
      s.nextGrain = now + (0.45 - sev * 0.28) * (0.7 + Math.random() * 0.9);
      try {
        const src = s.ctx.createBufferSource();
        src.buffer = s.scratchBuf;
        src.playbackRate.value = 0.85 + Math.random() * 0.55;
        const gg = s.ctx.createGain();
        const g = (0.14 + sev * 0.38) * s.vol;
        gg.gain.setValueAtTime(0, now);
        gg.gain.linearRampToValueAtTime(g, now + 0.006);
        gg.gain.linearRampToValueAtTime(0, now + 0.03 + Math.random() * 0.06);
        src.connect(gg); gg.connect(s.grainGain);
        src.start(now);
        src.stop(now + 0.14);
      } catch (e) { /* ignore */ }
    }
  }
  function scratchEnd() {
    if (!s.scratchNode || !s.ctx) { s.scratchNode = null; return; }
    try {
      const t = s.ctx.currentTime;
      s.scratchNode.g.gain.setTargetAtTime(0, t, 0.06);
      s.scratchNode.src.stop(t + 0.5);
    } catch (e) { /* ignore */ }
    s.scratchNode = null;
  }
  return {
    start() {
      if (s.active) return;
      if (!build()) return;
      connect();
      s.active = true;
      try { audioCtx.resume(); } catch (e) { /* ignore */ }
      schedule();
    },
    stop() {
      if (!s.active) return;
      s.active = false;
      s.playbackSev = 0;
      if (s.ctx && s.crackleGain) {
        try {
          s.crackleGain.gain.cancelScheduledValues(s.ctx.currentTime);
          s.crackleGain.gain.setValueAtTime(0, s.ctx.currentTime);
          s.hissGain.gain.setValueAtTime(0, s.ctx.currentTime);
          s.rumbleGain.gain.setValueAtTime(0, s.ctx.currentTime);
        } catch (e) { /* ignore */ }
      }
      disconnect();
      scratchEnd();
    },
    setCondition(c) {
      s.condition = c;
      if (s.lowpass && s.ctx) {
        const cutoff = CONDITION_CUTOFF[c] || 20000;
        s.lowpass.frequency.setTargetAtTime(cutoff, s.ctx.currentTime, 0.08);
      }
      if (s.ctx) schedule();
    },
    setFxVol(v) { s.vol = Math.max(0, Math.min(1, v)); },
    setNeedle(on) { s.needleOn = !!on; if (s.ctx) schedule(); },
    syncPlayback(sev) {
      s.playbackSev = Math.max(0, Math.min(1, sev || 0));
      if (s.ctx) schedule();
    },
    scratchStart() {
      if (!s.built || !s.ctx || s.scratchNode) return;
      if (!s.needleOn) return;
      try {
        const src = s.ctx.createBufferSource();
        src.buffer = s.scratchBuf;
        src.loop = true;
        const g = s.ctx.createGain();
        g.gain.value = 0.6 * s.vol;
        src.connect(g); g.connect(s.outGain);
        src.start();
        s.scratchNode = { src, g };
      } catch (e) { /* ignore */ }
    },
    scratchEnd,
    get isActive() { return s.active; },
  };
}

const vinylFx = createVinylFX(() => djAnalyserA, () => djGainA);
const vinylFxB = createVinylFX(() => djAnalyserB, () => djGainB);

/* ---------- DJ deck model ---------- */

const djDecks = {
  a: { el: audio, track: null },
  b: { el: audioB, track: null },
};

function djDeckEl(side) {
  return (side === 'b' ? audioB : audio);
}

function djDeckTrack(side) {
  const d = djDecks[side];
  return d ? d.track : null;
}

function djDeckPlaying(side) {
  const d = djDecks[side];
  if (!d || !d.track) return false;
  const el = d.el;
  return !!el.src && !el.paused;
}

function djPitchOf(side) {
  return (side === 'b' ? vinylState.dj.pitchB : vinylState.dj.pitchA);
}

function djActiveElement() {
  try {
    const ov = $('#vinylOverlay');
    if (ov && !ov.hidden) return vinylState.dj.master === 'b' ? audioB : audio;
  } catch (e) { /* ignore */ }
  return activeAudio();
}

function revokeDeckURL(side) {
  const d = djDecks[side];
  if (d && d.track && d.track._blobUrl) {
    URL.revokeObjectURL(d.track._blobUrl);
    d.track._blobUrl = null;
  }
  if (side === 'a') {
    const cur = state.currentTrack;
    if (cur && cur !== (d && d.track) && cur._blobUrl) {
      URL.revokeObjectURL(cur._blobUrl);
      cur._blobUrl = null;
    }
  }
}

/* ---------- Record rendering helpers ---------- */

function cssUrl(u) {
  return 'url("' + String(u || '').replace(/["\\]/g, '') + '")';
}

function recordCoverStyle(rec) {
  return rec.thumbnail ? `--cover:${cssUrl(rec.thumbnail)}` : `--cover:${rec.color || coverGradient(0)}`;
}

function recordDiscHtml(rec) {
  return `<div class="vs-disc-inner${rec.flipped ? ' flipped' : ''}">
    <div class="vs-disc-face"><div class="vs-disc-label" style="${recordCoverStyle(rec)}"></div><div class="vs-disc-hole"></div></div>
    <div class="vs-disc-face back"></div>
  </div>`;
}

function recordElHtml(rec, shelfIdx) {
  const cond = CONDITION_ORDER.includes(rec.condition) ? rec.condition : 'new';
  const scr = (rec.scratches || []).length;
  const plays = rec.plays || 0;
  const badgeText = scr > 0 ? String(scr) : (plays > 0 ? String(plays) : '');
  const badge = badgeText
    ? `<span class="vs-rec-badge${scr > 0 ? ' sc' : ''}" title="${escapeHtml(`Царапин: ${scr}, прослушиваний: ${plays}`)}">${badgeText}</span>`
    : '';
  return `<div class="vs-record c-${cond}${rec.flipped ? ' flipped' : ''}" data-key="${escapeHtml(rec.key)}" data-shelf="${shelfIdx}" title="${escapeHtml(rec.title)}">
    ${recordDiscHtml(rec)}
    ${badge}
    <span class="vs-rec-name">${escapeHtml(rec.title)}</span>
  </div>`;
}

function vinylRecordToTrack(rec) {
  return {
    title: rec.title, artist: rec.artist, album: '',
    source: rec.source, videoId: rec.videoId, dbId: rec.dbId,
    thumbnail: rec.thumbnail, duration: rec.duration, color: rec.color || coverGradient(0),
  };
}

function isSameRecord(a, b) {
  if (!a || !b) return false;
  return favKey(a) === favKey(b);
}

/* ---------- Shelf rendering ---------- */

/* Количество ячеек в ряду полки по ширине контейнера */
function vinylShelfCols() {
  const wrap = $('#vsShelves');
  const avail = ((wrap ? wrap.clientWidth : 1200) || 1200) - 68 - 48;
  return Math.max(1, Math.floor(avail / (128 + 16)));
}

function vinylGhostCount(count) {
  const cols = vinylShelfCols();
  if (count <= 0) return cols;
  const rem = count % cols;
  return rem === 0 ? 0 : cols - rem;
}

function renderVinylShelf() {
  const wrap = $('#vsShelves');
  if (!wrap) return;
  const addSvg = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';
  const delSvg = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  if (!vinylState.shelves.length) {
    const vinylIcon = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5" stroke-width="1.1"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/></svg>';
    wrap.innerHTML = `<div class="vs-empty-shelf">
      <span class="vs-empty-icon">${vinylIcon}</span>
      <b>Полок пока нет</b>
      <span>Создайте первую полку — и расставьте на ней пластинки из библиотеки, избранного или истории.</span>
    </div>`;
    return;
  }
  wrap.innerHTML = vinylState.shelves.map((shelf, si) => {
    const ghosts = Array.from({ length: vinylGhostCount(shelf.records.length) },
      () => `<div class="vs-slot empty-slot" data-shelf="${si}" title="Добавить пластинку">${addSvg}</div>`).join('');
    return `
    <div class="vs-shelf" data-shelf="${si}">
      <div class="vs-shelf-head">
        <b>${escapeHtml(shelf.name)}</b>
        <small>${shelf.records.length} ${plural(shelf.records.length)}</small>
        <div class="vs-shelf-actions">
          <button class="vs-shelf-add" data-shelf="${si}" title="Добавить пластинку">${addSvg}</button>
          <button class="vs-shelf-del" data-shelf="${si}" title="Удалить полку">${delSvg}</button>
        </div>
      </div>
      <div class="vs-shelf-row">
        ${shelf.records.map((rec) => `<div class="vs-slot" data-shelf="${si}" data-key="${escapeHtml(rec.key)}">${recordElHtml(rec, si)}</div>`).join('')}
        ${ghosts}
      </div>
    </div>`;
  }).join('');
}

/* ---------- Shelf CRUD ---------- */

function addVinylShelf() {
  promptDialog({ title: 'Новая полка', placeholder: 'Название полки', confirmText: 'Создать' }).then((name) => {
    if (!name) return;
    vinylState.shelves.push({ id: makePlaylistId(), name, records: [] });
    saveVinylState();
    renderVinylShelf();
  });
}

function deleteVinylShelf(idx) {
  const shelf = vinylState.shelves[idx];
  if (!shelf) return;
  confirmDialog({ title: 'Удалить полку?', body: `«${shelf.name}» и её пластинки будут убраны.`, confirmText: 'Удалить' }).then((ok) => {
    if (!ok) return;
    vinylState.shelves.splice(idx, 1);
    if (!vinylState.shelves.length) vinylState.shelves.push({ id: makePlaylistId(), name: 'Моя полка', records: [] });
    saveVinylState();
    renderVinylShelf();
  });
}

function chooseRecordForShelf(shelfId) {
  const pick = [];
  const rows = [];
  const sources = [];
  if (state.tracks.length) sources.push({ label: 'Библиотека', tracks: state.tracks });
  if (favorites.length) sources.push({ label: 'Избранное', tracks: favorites.map(favRecordToTrack) });
  if (history.length) sources.push({ label: 'История', tracks: history.map((h) => ({ title: h.title, artist: h.artist, source: h.source, videoId: h.videoId, thumbnail: h.thumbnail, duration: h.duration })) });
  sources.forEach((src) => {
    src.tracks.slice(0, 40).forEach((t) => {
      rows.push({ label: escapeHtml(t.title), sublabel: escapeHtml(`${src.label} · ${t.artist}`) });
      pick.push(t);
    });
  });
  if (!rows.length) return toast('Нет треков для добавления — добавьте их в библиотеку или избранное', 'info');
  chooseFromList({ title: 'Добавить пластинку', rows }).then((res) => {
    if (!res || typeof res !== 'object' || res.idx == null) return;
    const track = pick[res.idx];
    if (track) vinylAddRecord(shelfId, track);
  });
}

function vinylAddRecord(shelfId, track) {
  const shelf = vinylState.shelves[shelfId];
  if (!shelf) return;
  const key = favKey(track);
  if (shelf.records.some((r) => r.key === key)) return toast('Такая пластинка уже на этой полке', 'info', 2000);
  shelf.records.push({
    key,
    title: track.title || 'Без названия',
    artist: track.artist || 'Неизвестный исполнитель',
    source: track.source || 'local',
    videoId: track.videoId || null,
    dbId: track.dbId || track.id || null,
    thumbnail: track.thumbnail || '',
    duration: track.duration || 0,
    color: track.color || '',
    condition: 'new',
    plays: 0,
    scratches: [],
    flipped: false,
  });
  saveVinylState();
  renderVinylShelf();
  toast(`«${track.title}» на полке`, 'success', 1800);
}

function moveRecord(key, fromShelf, toShelf, beforeKey) {
  const fs = vinylState.shelves[fromShelf];
  const ts = vinylState.shelves[toShelf];
  if (!fs || !ts) { renderVinylShelf(); return; }
  if (fs === ts && beforeKey === key) { renderVinylShelf(); return; }
  const idx = fs.records.findIndex((r) => r.key === key);
  if (idx < 0) { renderVinylShelf(); return; }
  let targetIdx = beforeKey ? ts.records.findIndex((r) => r.key === beforeKey) : ts.records.length;
  if (targetIdx < 0) targetIdx = ts.records.length;
  if (fs === ts && targetIdx > idx) targetIdx -= 1;
  const [rec] = fs.records.splice(idx, 1);
  ts.records.splice(Math.max(0, targetIdx), 0, rec);
  saveVinylState();
  renderVinylShelf();
}

/* ---------- Deck ---------- */

function renderDeckRecord() {
  const el = $('#vsDeckRecord');
  if (!el) return;
  const rec = vinylState.deck;
  if (!rec) { el.hidden = true; el.innerHTML = ''; el.style.animation = ''; return; }
  el.hidden = false;
  el.className = 'vs-deck-record' + (CONDITION_ORDER.includes(rec.condition) ? ' c-' + rec.condition : '');
  el.innerHTML = recordDiscHtml(rec);
  updateDeckPlayingUI();
}

function updateDeckInfo() {
  const title = $('#vsDeckTitle');
  if (!title) return;
  const rec = vinylState.deck;
  const artist = $('#vsDeckArtist');
  const cond = $('#vsDeckCond');
  const condLabel = $('#vsCondLabel');
  if (!rec) {
    title.textContent = '—';
    if (artist) artist.textContent = '—';
    if (cond) cond.textContent = '—';
    if (condLabel) condLabel.textContent = 'Состояние';
    return;
  }
  title.textContent = rec.title;
  if (artist) artist.textContent = rec.artist;
  if (cond) cond.textContent = CONDITION_LABELS[rec.condition] || '—';
  if (condLabel) condLabel.textContent = CONDITION_LABELS[rec.condition] || 'Состояние';
  const badges = $('#vsDeckBadges');
  if (badges) badges.innerHTML = vinylBadges(rec).map((b) => `<span class="vs-badge">${escapeHtml(b)}</span>`).join('');
}

function djDeckStatus(side, rec) {
  if (!rec) return 'ГОТОВА';
  const el = djDeckEl(side);
  const has = !!el && !!el.src;
  if (djDeckPlaying(side)) return 'ИГРАЕТ';
  if (has && (el.currentTime || 0) > 0) return 'ПАУЗА';
  return 'ГОТОВА';
}

function updateDeckPlayingUI() {
  const elA = $('#vsDeckRecord');
  const elB = $('#vsDeckRecordB');
  const iconA = $('#vsPlayIcon');
  const iconB = $('#vsPlayIconB');
  const deckEl = $('#vsDeck');
  const recA = vinylState.deck;
  const recB = vinylState.cue;
  const playingA = recA && djDeckPlaying('a');
  const playingB = recB && djDeckPlaying('b');
  if (elA) elA.style.animation = playingA ? 'vmspin 1.6s linear infinite' : '';
  if (elB) elB.style.animation = playingB ? 'vmspin 1.6s linear infinite' : '';
  if (deckEl) deckEl.classList.toggle('playing', playingA || playingB);
  const da = $('#vsDeckA');
  const db = $('#vsDeckB');
  const master = vinylState.dj.master;
  if (da) {
    da.classList.toggle('active', master === 'a');
    da.classList.toggle('has-record', !!recA);
  }
  if (db) {
    db.classList.toggle('active', master === 'b');
    db.classList.toggle('has-record', !!recB);
  }
  const hintA = $('#vsHintA');
  const hintB = $('#vsHintB');
  if (hintA) hintA.classList.toggle('hidden', !!recA);
  if (hintB) hintB.classList.toggle('hidden', !!recB);
  const statusA = $('#vsStatusA');
  const statusB = $('#vsStatusB');
  const sA = djDeckStatus('a', recA);
  const sB = djDeckStatus('b', recB);
  if (statusA) {
    statusA.textContent = sA;
    statusA.classList.toggle('live', master === 'a' && sA === 'ИГРАЕТ');
    statusA.classList.toggle('pause', !!recA && sA === 'ПАУЗА');
  }
  if (statusB) {
    statusB.textContent = sB;
    statusB.classList.toggle('live', master === 'b' && sB === 'ИГРАЕТ');
    statusB.classList.toggle('pause', !!recB && sB === 'ПАУЗА');
  }
  const xa = $('#xfScaleA');
  const xb = $('#xfScaleB');
  if (xa) xa.classList.toggle('on-a', master === 'a');
  if (xb) xb.classList.toggle('on-b', master === 'b');
  const pauseSvg = '<rect x="7.5" y="5" width="3.5" height="14" rx="1"/><rect x="13" y="5" width="3.5" height="14" rx="1"/>';
  const playSvg = '<polygon points="8,5 20,12 8,19"/>';
  if (iconA) iconA.innerHTML = playingA ? pauseSvg : playSvg;
  if (iconB) iconB.innerHTML = playingB ? pauseSvg : playSvg;
}

function deckLoadAndPlay(rec) {
  vinylState.deck = rec;
  vinylState.dj.master = 'a';
  saveVinylState();
  renderDeckRecord();
  updateDeckInfo();
  vinylFx.setCondition(rec.condition);
  vinylFx.syncPlayback(vinylPlaySeverity(rec));
  ensureAnalyser();
  try { audioCtx.resume(); } catch (e) { /* ignore */ }
  const track = vinylRecordToTrack(rec);
  state.visibleTracks = [track];
  playTrackOn(track, 0, 'a');
  djApplyPitch('a');
  updateDeckPlayingUI();
}

function vinylDeckListenCompleteFor(side) {
  const rec = djDeckRecord(side);
  if (!rec || !djDeckPlaying(side)) return;
  rec.plays = (rec.plays || 0) + 1;
  const cond = vinylConditionForPlays(rec.plays);
  if (cond !== rec.condition) {
    rec.condition = cond;
    toast(`Пластинка «${rec.title}» — состояние: ${CONDITION_LABELS[cond]}`, 'info', 2400);
  }
  saveVinylState();
  renderDeckRecord();
  renderDeckB();
  updateDeckInfo();
  updateDeckInfoB();
  const fx = side === 'b' ? vinylFxB : vinylFx;
  fx.setCondition(rec.condition);
  fx.syncPlayback(vinylPlaySeverity(rec));
}

function vinylDeckListenComplete() {
  vinylDeckListenCompleteFor('a');
}

/* Зажевывание при проигрывании поцарапанной пластинки: сбрасываем аудио
   чуть назад и подмешиваем треск. Вызывается из timeupdate. */
function vinylStutterTick(side) {
  const el = djDeckEl(side);
  const rec = djDeckRecord(side);
  const cur = djDeckTrack(side);
  const fx = side === 'b' ? vinylFxB : vinylFx;
  if (!rec || el.paused || !cur) return false;
  const stats = vinylScratchStats(rec);
  if (!stats.count) return false;
  const sev = vinylPlaySeverity(rec);
  if (Math.random() > 0.03 + sev * 0.07) return false;
  if (el.currentTime < 0.7) return false;
  try {
    el.currentTime = Math.max(0, el.currentTime - (0.2 + sev * 0.35));
  } catch (e) { /* ignore */ }
  fx.scratchStart();
  setTimeout(() => fx.scratchEnd(), 110);
  const which = side === 'b' ? '#vsDeckRecordB' : '#vsDeckRecord';
  const deck = $(which);
  if (deck && !deck.classList.contains('jitter')) {
    deck.classList.add('jitter');
    setTimeout(() => deck.classList.remove('jitter'), 260);
  }
  const disc = side === 'b' ? $('#recDiscB') : $('#recDisc');
  if (disc && !disc.classList.contains('jitter')) {
    disc.classList.add('jitter');
    setTimeout(() => disc.classList.remove('jitter'), 300);
  }
  return true;
}

function pushRecordBackToShelf(rec) {
  if (!rec) return;
  const fromShelf = (Number.isInteger(rec.fromShelf) && vinylState.shelves[rec.fromShelf]) ? rec.fromShelf : 0;
  vinylState.shelves[fromShelf].records.push(rec);
}

function loadRecordToDeck(key, shelfIdx, side) {
  const shelf = vinylState.shelves[shelfIdx];
  if (!shelf) return;
  const idx = shelf.records.findIndex((r) => r.key === key);
  if (idx < 0) return;
  const [rec] = shelf.records.splice(idx, 1);
  rec.fromShelf = shelfIdx;
  saveVinylState();
  renderVinylShelf();
  if (side === 'b') {
    if (vinylState.cue) pushRecordBackToShelf(vinylState.cue);
    vinylState.cue = rec;
    saveVinylState();
    renderDeckB();
    updateDeckInfoB();
    updateDeckPlayingUI();
  } else {
    if (vinylState.deck && !isSameRecord(vinylState.deck, rec)) pushRecordBackToShelf(vinylState.deck);
    deckLoadAndPlay(rec);
  }
}

function moveRecordToDeck(key, shelfIdx, side) {
  loadRecordToDeck(key, shelfIdx, side);
}

function deckReturnToShelf() {
  const rec = vinylState.deck;
  if (!rec) { toast('На вертушке нет пластинки', 'info', 2000); return; }
  if (djDeckPlaying('a')) {
    try { audio.pause(); } catch (e) { /* ignore */ }
  }
  pushRecordBackToShelf(rec);
  vinylState.deck = null;
  if (vinylState.dj.master === 'a' && vinylState.cue) vinylState.dj.master = 'b';
  saveVinylState();
  vinylFx.syncPlayback(0);
  renderVinylShelf();
  renderDeckRecord();
  updateDeckInfo();
  updateDeckPlayingUI();
  djFxForCurrent();
  toast(`«${rec.title}» вернулась на полку`, 'success', 1800);
}

function flipDeckRecord() {
  if (!vinylState.deck) return;
  vinylState.deck.flipped = !vinylState.deck.flipped;
  saveVinylState();
  renderDeckRecord();
}

function deckTogglePlay() {
  const rec = vinylState.deck;
  if (!rec) { toast('Положите пластинку на вертушку', 'info', 2200); return; }
  if (djDeckPlaying('a') || (vinylState.dj.master === 'a' && djDeckTrack('a'))) {
    togglePlay();
    updateDeckPlayingUI();
  } else {
    djPlaySide('a');
  }
}

function deckToggleNeedle() {
  vinylState.settings.needle = !vinylState.settings.needle;
  saveVinylState();
  $('#vsNeedle')?.classList.toggle('off', !vinylState.settings.needle);
  $('#vsNeedleB')?.classList.toggle('off', !vinylState.settings.needle);
  $('#vsNeedleBtn')?.classList.toggle('active', !!vinylState.settings.needle);
  vinylFx.setNeedle(!!vinylState.settings.needle);
  vinylFxB.setNeedle(!!vinylState.settings.needle);
}

function deckCycleCondition() {
  if (!vinylState.deck) { toast('Сначала поставьте пластинку', 'info', 2200); return; }
  const rec = vinylState.deck;
  const i = CONDITION_ORDER.indexOf(rec.condition);
  rec.condition = CONDITION_ORDER[(i + 1) % CONDITION_ORDER.length];
  saveVinylState();
  renderDeckRecord();
  updateDeckInfo();
  vinylFx.setCondition(rec.condition);
  vinylFx.syncPlayback(vinylPlaySeverity(rec));
  toast(`Состояние: ${CONDITION_LABELS[rec.condition]}`, 'info', 1500);
}

/* ---------- DJ: вертушка B, питч, синк, скретч ---------- */

function djDeckRecord(side) {
  return side === 'b' ? vinylState.cue : vinylState.deck;
}

function djActivePitch() {
  return vinylState.dj.master === 'b' ? vinylState.dj.pitchB : vinylState.dj.pitchA;
}

function djApplyPitch(side) {
  side = side || (vinylState.dj.master === 'b' ? 'b' : 'a');
  const el = djDeckEl(side);
  el.preservesPitch = false;
}

function djSoundingSide() {
  const recA = vinylState.deck;
  const recB = vinylState.cue;
  if (recA && djDeckPlaying('a')) return 'a';
  if (recB && djDeckPlaying('b')) return 'b';
  return null;
}

function djFxForCurrent() {
  const recA = vinylState.deck;
  const recB = vinylState.cue;
  if (recA) {
    vinylFx.setCondition(recA.condition);
    vinylFx.syncPlayback(vinylPlaySeverity(recA));
  }
  if (recB) {
    vinylFxB.setCondition(recB.condition);
    vinylFxB.syncPlayback(vinylPlaySeverity(recB));
  }
}

function renderDeckB() {
  const el = $('#vsDeckRecordB');
  if (!el) return;
  const rec = vinylState.cue;
  if (!rec) { el.hidden = true; el.innerHTML = ''; el.style.animation = ''; return; }
  el.hidden = false;
  el.className = 'vs-deck-record' + (CONDITION_ORDER.includes(rec.condition) ? ' c-' + rec.condition : '');
  el.innerHTML = recordDiscHtml(rec);
  updateDeckPlayingUI();
}

function updateDeckInfoB() {
  const title = $('#vsDeckTitleB');
  if (!title) return;
  const rec = vinylState.cue;
  const artist = $('#vsDeckArtistB');
  const cond = $('#vsDeckCondB');
  if (!rec) {
    title.textContent = '—';
    if (artist) artist.textContent = '—';
    if (cond) cond.textContent = '—';
    return;
  }
  title.textContent = rec.title;
  if (artist) artist.textContent = rec.artist;
  if (cond) cond.textContent = CONDITION_LABELS[rec.condition] || '—';
  const badges = $('#vsDeckBadgesB');
  if (badges) badges.innerHTML = vinylBadges(rec).map((b) => `<span class="vs-badge">${escapeHtml(b)}</span>`).join('');
}

function djPlaySide(side) {
  const rec = djDeckRecord(side);
  if (!rec) {
    toast(side === 'b' ? 'Положите пластинку на вертушку B' : 'Положите пластинку на вертушку', 'info', 2200);
    return;
  }
  const fx = side === 'b' ? vinylFxB : vinylFx;
  vinylState.dj.master = side;
  saveVinylState();
  fx.setCondition(rec.condition);
  fx.syncPlayback(vinylPlaySeverity(rec));
  ensureAnalyser();
  try { audioCtx.resume(); } catch (e) { /* ignore */ }
  const track = vinylRecordToTrack(rec);
  state.visibleTracks = [track];
  playTrackOn(track, 0, side);
  djApplyPitch(side);
  updateDeckPlayingUI();
  updateDeckInfo();
  updateDeckInfoB();
}

function deckTogglePlayB() {
  const rec = vinylState.cue;
  if (!rec) { toast('Положите пластинку на вертушку B', 'info', 2200); return; }
  if (djDeckPlaying('b') || (vinylState.dj.master === 'b' && djDeckTrack('b'))) {
    togglePlay();
    updateDeckPlayingUI();
  } else {
    djPlaySide('b');
  }
}

function djSetPitch(side, val) {
  val = Math.max(-20, Math.min(20, Number(val) || 0));
  const rate = Math.round((1 + val / 100) * 1000) / 1000;
  if (side === 'b') vinylState.dj.pitchB = rate;
  else vinylState.dj.pitchA = rate;
  saveVinylState();
  const label = $(side === 'b' ? '#vsPitchLabelB' : '#vsPitchLabelA');
  if (label) label.textContent = (val >= 0 ? '+' : '') + val + '%';
  djApplyPitch(side);
}

function djSync() {
  if (!vinylState.deck && !vinylState.cue) return toast('Положите пластинки на вертушки', 'info', 2000);
  if (!vinylState.cue) return toast('Положите пластинку на вертушку B', 'info', 2000);
  vinylState.dj.pitchB = vinylState.dj.pitchA;
  const pct = Math.round((vinylState.dj.pitchB - 1) * 100);
  const s = $('#vsPitchB');
  if (s) s.value = pct;
  const lb = $('#vsPitchLabelB');
  if (lb) lb.textContent = (pct >= 0 ? '+' : '') + pct + '%';
  saveVinylState();
  djApplyPitch('b');
  djRestartBeatRing('a');
  djRestartBeatRing('b');
  const aligned = djPhaseAlign();
  toast(aligned ? 'Треки в одном темпе и фазе' : 'Синхронизировано', 'success', 1500);
}

let cuePreview = null;

function cuePreviewStart() {
  const rec = vinylState.cue;
  if (!rec || cuePreview) return;
  if (djDeckPlaying('b')) return;
  cuePreview = {
    prevTrack: state.currentTrack,
    prevSide: djSoundingSide(),
    wasPlaying: !audio.paused,
    resumePos: audio.currentTime || 0,
    prevMaster: vinylState.dj.master,
  };
  $('#vsCueBtn')?.classList.add('active');
  djPlaySide('b');
}

function cuePreviewEnd() {
  if (!cuePreview) return;
  const cp = cuePreview;
  cuePreview = null;
  $('#vsCueBtn')?.classList.remove('active');
  vinylState.dj.master = cp.prevMaster;
  saveVinylState();
  const restoreDeck = cp.prevSide && cp.prevSide !== 'b' ? cp.prevSide : 'a';
  if (cp.prevSide === 'b') {
    try { audioB.pause(); } catch (e) { /* ignore */ }
  }
  if (cp.prevTrack && cp.prevSide !== 'b') {
    playTrackOn(cp.prevTrack, 0, restoreDeck).then(() => {
      const el = djDeckEl(restoreDeck);
      if (cp.wasPlaying) {
        try { el.currentTime = cp.resumePos; } catch (e) { /* ignore */ }
        el.play().catch(() => {});
      }
    });
  } else {
    try { audio.pause(); } catch (e) { /* ignore */ }
  }
  djApplyPitch('a');
  djApplyPitch('b');
  djFxForCurrent();
  updateDeckPlayingUI();
  updateDeckInfo();
  updateDeckInfoB();
}

function deckBReturnToShelf() {
  const rec = vinylState.cue;
  if (!rec) { toast('На вертушке B нет пластинки', 'info', 2000); return; }
  if (djDeckPlaying('b')) {
    try { audioB.pause(); } catch (e) { /* ignore */ }
  }
  pushRecordBackToShelf(rec);
  vinylState.cue = null;
  if (vinylState.dj.master === 'b') vinylState.dj.master = 'a';
  saveVinylState();
  renderVinylShelf();
  renderDeckB();
  updateDeckInfoB();
  updateDeckPlayingUI();
  djFxForCurrent();
  toast(`«${rec.title}» вернулась на полку`, 'success', 1800);
}

function flipDeckRecordB() {
  if (!vinylState.cue) return;
  vinylState.cue.flipped = !vinylState.cue.flipped;
  saveVinylState();
  renderDeckB();
}

function djJitterRecord(which) {
  const el = $(which === 'b' ? '#vsDeckRecordB' : '#vsDeckRecord');
  if (el && !el.classList.contains('jitter')) {
    el.classList.add('jitter');
    setTimeout(() => el.classList.remove('jitter'), 260);
  }
}

/* ---------- Beat sync ---------- */

let djBeatRAF = null;
const djBeatState = {
  a: { bpm: 0, lastT: 0, lastAudioT: null },
  b: { bpm: 0, lastT: 0, lastAudioT: null },
};

function djRestartBeatRing(side) {
  const st = side ? djBeatState[side] : djBeatState.a;
  const dur = (st.bpm > 0 ? 60 / st.bpm : 1.2).toFixed(3) + 's';
  const ids = side ? [side === 'b' ? 'vsBeatB' : 'vsBeatA'] : ['vsBeatA', 'vsBeatB'];
  ids.forEach((id) => {
    const el = $('#' + id);
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = `beatRing ${dur} linear infinite`;
  });
}

function djBassLevel(data) {
  let b = 0;
  for (let i = 1; i < 7; i++) b += data[i];
  return b / 6 / 255;
}

function djBeatTick(side, bass, now) {
  const st = djBeatState[side];
  if (bass > 0.6 && now - st.lastT > 260) {
    const gap = now - st.lastT;
    if (gap > 280 && gap < 1600) {
      const bpm = Math.round(60000 / gap);
      if (st.bpm === 0 || Math.abs(bpm - st.bpm) <= 6) st.bpm = bpm;
    }
    const el = djDeckEl(side);
    try { st.lastAudioT = el.currentTime || null; } catch (e) { /* ignore */ }
    st.lastT = now;
    djRestartBeatRing(side);
  }
}

function startDjLoop() {
  if (djBeatRAF) return;
  const dataA = djAnalyserA ? new Uint8Array(djAnalyserA.frequencyBinCount) : null;
  const dataB = djAnalyserB ? new Uint8Array(djAnalyserB.frequencyBinCount) : null;
  const loop = () => {
    djBeatRAF = requestAnimationFrame(loop);
    const now = performance.now();
    if (djAnalyserA && dataA && djDeckPlaying('a')) {
      djAnalyserA.getByteFrequencyData(dataA);
      djBeatTick('a', djBassLevel(dataA), now);
    }
    if (djAnalyserB && dataB && djDeckPlaying('b')) {
      djAnalyserB.getByteFrequencyData(dataB);
      djBeatTick('b', djBassLevel(dataB), now);
    }
    djRenderBpm();
  };
  loop();
}

function djRenderBpm(blank) {
  const set = (id, st) => {
    const el = $(id);
    if (!el) return;
    if (blank) { el.textContent = 'BPM —'; el.classList.add('blank'); return; }
    el.textContent = st.bpm > 0 ? 'BPM ' + st.bpm : 'BPM —';
    el.classList.toggle('blank', st.bpm <= 0);
  };
  set('#vsBpmA', djBeatState.a);
  set('#vsBpmB', djBeatState.b);
}

/* Подгоняет фазу B под фазу A по последним детектированным ударам */
function djPhaseAlign() {
  const sa = djBeatState.a, sb = djBeatState.b;
  if (!djDeckPlaying('a') || !djDeckPlaying('b')) return false;
  if (sa.lastAudioT == null || sb.lastAudioT == null) return false;
  const bpm = sa.bpm || sb.bpm;
  if (!(bpm > 0)) return false;
  const beat = 60 / bpm;
  const pa = ((audio.currentTime || 0) - sa.lastAudioT) % beat;
  const pb = ((audioB.currentTime || 0) - sb.lastAudioT) % beat;
  let d = pa - pb;
  if (d > beat / 2) d -= beat;
  if (d < -beat / 2) d += beat;
  try { audioB.currentTime = Math.max(0, (audioB.currentTime || 0) + d); } catch (e) { /* ignore */ }
  return true;
}

function stopDjLoop() {
  if (djBeatRAF) { cancelAnimationFrame(djBeatRAF); djBeatRAF = null; }
  djBeatState.a = { bpm: 0, lastT: 0, lastAudioT: null };
  djBeatState.b = { bpm: 0, lastT: 0, lastAudioT: null };
  djRenderBpm(true);
}

/* ---------- Shelf drag & drop ---------- */

let dragInfo = null;
let pendingClick = null;
let scratchInfo = null;
let djScratchTimer = null;

function djScratchDown(side, e) {
  const rec = djDeckRecord(side);
  if (!rec) return;
  const el = djDeckEl(side);
  const dur = (el.duration && isFinite(el.duration)) ? el.duration : 300;
  const rect = e.currentTarget && e.currentTarget.getBoundingClientRect ? e.currentTarget.getBoundingClientRect() : null;
  scratchInfo = {
    x: e.clientX, y: e.clientY,
    side,
    wasPlaying: !el.paused,
    startPos: el.currentTime || 0,
    startRate: el.playbackRate || 1,
    moved: false,
    width: Math.max(1, (rect && rect.width) || 200),
    dur,
  };
  djJitterRecord(side);
}

function djScratchMove(e) {
  if (!scratchInfo) return;
  if (!scratchInfo.moved && Math.hypot(e.clientX - scratchInfo.x, e.clientY - scratchInfo.y) > 8) scratchInfo.moved = true;
  if (!scratchInfo.moved) return;
  const si = scratchInfo;
  const el = djDeckEl(si.side);
  const frac = (e.clientX - si.x) / si.width;
  const target = Math.max(0, Math.min(si.dur - 0.05, si.startPos + frac * 12));
  try { el.currentTime = target; } catch (err) { /* ignore */ }
  el.playbackRate = 3;
  el.preservesPitch = false;
  if (el.paused) el.play().catch(() => {});
  if (djScratchTimer) clearTimeout(djScratchTimer);
  djScratchTimer = setTimeout(() => { try { el.pause(); } catch (err) { /* ignore */ } }, 70);
}

function djScratchUp() {
  if (!scratchInfo) return;
  const si = scratchInfo;
  scratchInfo = null;
  if (djScratchTimer) { clearTimeout(djScratchTimer); djScratchTimer = null; }
  const el = djDeckEl(si.side);
  el.playbackRate = si.startRate;
  if (!si.wasPlaying) { try { el.pause(); } catch (err) { /* ignore */ } }
  updateDeckPlayingUI();
}

function clearDropTargets() {
  $('#vsPlatter')?.classList.remove('drop-target');
  $('#vsPlatterB')?.classList.remove('drop-target');
  $$('.vs-slot.drop-target').forEach((el) => el.classList.remove('drop-target'));
}

function updateDropTargets(e) {
  clearDropTargets();
  const under = document.elementsFromPoint ? (document.elementsFromPoint(e.clientX, e.clientY) || []) : [];
  for (const el of under) {
    if (el.closest && el.closest('#vsDeckA')) { $('#vsPlatter')?.classList.add('drop-target'); return; }
    if (el.closest && el.closest('#vsDeckB')) { $('#vsPlatterB')?.classList.add('drop-target'); return; }
    const slot = el.closest && el.closest('.vs-slot');
    if (slot) { slot.classList.add('drop-target'); return; }
  }
}

function findDropTarget(e) {
  const under = document.elementsFromPoint ? (document.elementsFromPoint(e.clientX, e.clientY) || []) : [];
  for (const el of under) {
    if (el.closest && el.closest('#vsDeckA')) return { kind: 'deck', side: 'a' };
    if (el.closest && el.closest('#vsDeckB')) return { kind: 'deck', side: 'b' };
    const slot = el.closest && el.closest('.vs-slot');
    if (slot) return { kind: 'slot', shelfIdx: Number(slot.dataset.shelf), key: slot.dataset.key || null };
  }
  return null;
}

/* ---------- Drag & drop трека из библиотеки сразу на вертушку ---------- */

let djDragState = null;

function wireLibraryDrag() {
  document.addEventListener('dragstart', (e) => {
    const row = e.target.closest && e.target.closest('.track-row');
    if (!row) return;
    const list = listForMode(row.dataset.source);
    const track = list[Number(row.dataset.index)];
    if (!track) return;
    djDragState = { track };
    try {
      e.dataTransfer.setData('text/plain', track.title || '');
      e.dataTransfer.effectAllowed = 'copy';
    } catch (err) { /* ignore */ }
  });

  document.addEventListener('dragend', () => {
    djDragState = null;
    clearDropTargets();
  });

  document.addEventListener('dragover', (e) => {
    if (!djDragState) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    updateDropTargets(e);
  });

  document.addEventListener('drop', (e) => {
    if (!djDragState) return;
    e.preventDefault();
    const track = djDragState.track;
    djDragState = null;
    clearDropTargets();
    const target = findDropTarget(e);
    if (!target || target.kind !== 'deck') return;
    djDropTrackOn(track, target.side);
  });
}

function djDropTrackOn(track, side) {
  if (!track) return;
  if (!vinylState.shelves.length) vinylState.shelves.push({ id: makePlaylistId(), name: 'Моя полка', records: [] });
  const sh = vinylState.shelves[0];
  const key = favKey(track);
  const loaded = side === 'b' ? vinylState.cue : vinylState.deck;
  if (loaded && favKey(loaded) === key) {
    toast(`«${track.title}» уже на вертушке ${side.toUpperCase()}`, 'info', 2000);
    return;
  }
  let rec = sh.records.find((r) => r.key === key);
  if (!rec) {
    rec = {
      key,
      title: track.title || 'Без названия',
      artist: track.artist || 'Неизвестный исполнитель',
      source: track.source || 'local',
      videoId: track.videoId || null,
      dbId: track.dbId || track.id || null,
      thumbnail: track.thumbnail || '',
      duration: track.duration || 0,
      color: track.color || '',
      condition: 'new',
      plays: 0,
      scratches: [],
      flipped: false,
    };
    sh.records.push(rec);
    saveVinylState();
  }
  const idx = sh.records.findIndex((r) => r.key === key);
  if (idx < 0) return;
  const [r] = sh.records.splice(idx, 1);
  r.fromShelf = 0;
  saveVinylState();
  if (side === 'b') {
    if (vinylState.cue) pushRecordBackToShelf(vinylState.cue);
    vinylState.cue = r;
    saveVinylState();
    renderDeckB();
    updateDeckInfoB();
    updateDeckPlayingUI();
    djFxForCurrent();
    djRestartBeatRing('b');
  } else {
    if (vinylState.deck && !isSameRecord(vinylState.deck, r)) pushRecordBackToShelf(vinylState.deck);
    deckLoadAndPlay(r);
  }
  renderVinylShelf();
  djMixBurst();
  toast(`«${r.title}» на вертушке ${side.toUpperCase()}`, 'success', 1700);
}

function djMixBurst() {
  const burst = $('#vsMixBurst');
  if (burst) {
    burst.classList.remove('burst');
    void burst.offsetWidth;
    burst.classList.add('burst');
  }
  const deck = $('#vsDeck');
  if (deck) {
    deck.classList.remove('mix-burst');
    void deck.offsetWidth;
    deck.classList.add('mix-burst');
  }
}

/* ---------- First-run tour ---------- */

const DJ_TOUR_STEPS = [
  {
    t: 'Перетащите трек на вертушку A',
    b: 'Любой трек из библиотеки, избранного или поиска можно <b>перетащить</b> прямо на левую вертушку — пластинка сама встанет и заиграет.',
  },
  {
    t: 'Второй трек — на вертушку B',
    b: 'Точно так же поставьте ещё один трек на <b>правую вертушку B</b> и нажмите ▶ под ней. Теперь у вас две пластинки.',
  },
  {
    t: 'Сводите фейдером',
    b: 'Двигайте <b>фейдер</b> между A и B — кто громче, тот и в звуке. Кнопка <b>SYNC</b> подгонит темп и фазу, чтобы треки звучали вместе. Царапайте пластинку мышкой!',
  },
];

let djTourStep = 0;

function djTourRender(i) {
  const tour = $('#djTour');
  if (!tour) return;
  djTourStep = i;
  const s = DJ_TOUR_STEPS[i];
  const text = $('#djTourText');
  if (text) text.innerHTML = `<b>${s.t}</b><p>${s.b}</p>`;
  const dots = $('#djTourDots');
  if (dots) dots.innerHTML = DJ_TOUR_STEPS.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('');
  const prev = $('#djTourPrev');
  if (prev) prev.style.visibility = i === 0 ? 'hidden' : 'visible';
  const next = $('#djTourNext');
  if (next) next.textContent = i === DJ_TOUR_STEPS.length - 1 ? 'Понятно!' : 'Дальше';
}

function djTourShow() {
  const tour = $('#djTour');
  if (!tour || tour.hidden === false) return;
  djTourRender(0);
  tour.hidden = false;
}

function djTourHide() {
  const tour = $('#djTour');
  if (tour) tour.hidden = true;
  settings.djTourSeen = true;
  saveSettings();
}

function wireDjTour() {
  const tour = $('#djTour');
  if (!tour) return;
  $('#djTourNext')?.addEventListener('click', () => {
    if (djTourStep >= DJ_TOUR_STEPS.length - 1) { djTourHide(); return; }
    djTourRender(djTourStep + 1);
  });
  $('#djTourPrev')?.addEventListener('click', () => {
    if (djTourStep > 0) djTourRender(djTourStep - 1);
  });
  $('#djTourSkip')?.addEventListener('click', djTourHide);
  $('#djTourDemo')?.addEventListener('click', () => {
    if (!state.tracks.length) { toast('Сначала добавьте треки в библиотеку', 'info', 2400); return; }
    djTourHide();
    const src = state.tracks;
    djDropTrackOn(src[0], 'a');
    const b = src[1] || src[0];
    setTimeout(() => { djDropTrackOn(b, 'b'); djRestartBeatRing('a'); djRestartBeatRing('b'); }, 500);
    toast('Сводите фейдером между A и B!', 'success', 2400);
  });
}

function wireShelfUi() {
  const shelvesEl = $('#vsShelves');
  if (!shelvesEl) return;
  shelvesEl.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.vs-shelf-add');
    if (addBtn) { chooseRecordForShelf(Number(addBtn.dataset.shelf)); return; }
    const delBtn = e.target.closest('.vs-shelf-del');
    if (delBtn) { deleteVinylShelf(Number(delBtn.dataset.shelf)); return; }
    const empty = e.target.closest('.vs-slot.empty-slot');
    if (empty) { chooseRecordForShelf(Number(empty.dataset.shelf)); return; }
  });
  shelvesEl.addEventListener('dblclick', (e) => {
    const recEl = e.target.closest('.vs-record');
    if (!recEl) return;
    if (pendingClick && pendingClick.timer) { clearTimeout(pendingClick.timer); pendingClick = null; }
    const shelfIdx = Number(recEl.dataset.shelf);
    const rec = vinylState.shelves[shelfIdx]?.records.find((r) => r.key === recEl.dataset.key);
    if (rec) openRecordView(rec);
  });
  shelvesEl.addEventListener('pointerdown', (e) => {
    const recEl = e.target.closest('.vs-record');
    if (!recEl) return;
    e.preventDefault();
    dragInfo = {
      el: recEl,
      key: recEl.dataset.key,
      shelfIdx: Number(recEl.dataset.shelf),
      startX: e.clientX, startY: e.clientY,
      moved: false,
      width: recEl.offsetWidth || 76,
      height: recEl.offsetHeight || 76,
    };
    recEl.classList.add('lifted');
  });
}

function handleModePointerMove(e) {
  if (dragInfo && !dragInfo.moved && Math.hypot(e.clientX - dragInfo.startX, e.clientY - dragInfo.startY) > 7) {
    dragInfo.moved = true;
    dragInfo.el.classList.remove('lifted');
    dragInfo.el.classList.add('follow');
    document.body.appendChild(dragInfo.el);
    if (pendingClick && pendingClick.timer) { clearTimeout(pendingClick.timer); pendingClick = null; }
  }
  if (dragInfo && dragInfo.moved) {
    dragInfo.el.style.left = (e.clientX - dragInfo.width / 2) + 'px';
    dragInfo.el.style.top = (e.clientY - dragInfo.height / 2) + 'px';
    updateDropTargets(e);
  }
  djScratchMove(e);
}

function handleModePointerUp(e) {
  if (dragInfo) {
    const info = dragInfo;
    dragInfo = null;
    clearDropTargets();
    if (!info.moved) {
      info.el.classList.remove('lifted');
      if (pendingClick && pendingClick.timer) { clearTimeout(pendingClick.timer); pendingClick = null; }
      pendingClick = {
        key: info.key, shelfIdx: info.shelfIdx,
        timer: setTimeout(() => { pendingClick = null; loadRecordToDeck(info.key, info.shelfIdx); }, 300),
      };
      return;
    }
    const target = findDropTarget(e);
    if (target && target.kind === 'slot') moveRecord(info.key, info.shelfIdx, target.shelfIdx, target.key);
    else if (target && target.kind === 'deck') moveRecordToDeck(info.key, info.shelfIdx, target.side);
    else renderVinylShelf();
    if (info.el) info.el.remove();
    return;
  }
  djScratchUp();
}

/* ---------- Overlays open/close ---------- */

function openVinylShelf() {
  const ov = $('#vinylOverlay');
  if (!ov || !ov.hidden) return;
  if (!$('#recOverlay').hidden) closeRecordView();
  ensureAnalyser();
  renderVinylShelf();
  renderDeckRecord();
  renderDeckB();
  updateDeckInfo();
  updateDeckInfoB();
  $('#vsNeedle')?.classList.toggle('off', !vinylState.settings.needle);
  $('#vsNeedleB')?.classList.toggle('off', !vinylState.settings.needle);
  $('#vsNeedleBtn')?.classList.toggle('active', !!vinylState.settings.needle);
  const fv = $('#vmFxVol');
  if (fv) fv.value = vinylState.settings.fxVol;
  const fxVol = Number.isFinite(vinylState.settings.fxVol) ? vinylState.settings.fxVol : 55;
  vinylFx.setFxVol(fxVol / 100);
  vinylFxB.setFxVol(fxVol / 100);
  vinylFx.setNeedle(!!vinylState.settings.needle);
  vinylFxB.setNeedle(!!vinylState.settings.needle);
  vinylFx.start();
  vinylFxB.start();
  const paVal = Math.round((vinylState.dj.pitchA - 1) * 100);
  const pbVal = Math.round((vinylState.dj.pitchB - 1) * 100);
  const paEl = $('#vsPitchA');
  const pbEl = $('#vsPitchB');
  if (paEl) paEl.value = paVal;
  if (pbEl) pbEl.value = pbVal;
  const la = $('#vsPitchLabelA');
  const lb = $('#vsPitchLabelB');
  if (la) la.textContent = (paVal >= 0 ? '+' : '') + paVal + '%';
  if (lb) lb.textContent = (pbVal >= 0 ? '+' : '') + pbVal + '%';
  const xf = $('#vsXfade');
  if (xf) xf.value = Number.isFinite(vinylState.dj.xfade) ? vinylState.dj.xfade : 0;
  djFxForCurrent();
  applyDjCrossfade(vinylState.dj.xfade || 0);
  updateDeckPlayingUI();
  startDjLoop();
  ov.hidden = false;
  document.querySelector('[data-view="vinyl"]')?.classList.add('active');
  if (!settings.djTourSeen) djTourShow();
}

function resetDjMixer() {
  if (!audioCtx || !djGainA || !djGainB) return;
  djLastX = -1;
  const now = audioCtx.currentTime;
  djGainA.gain.cancelScheduledValues(now);
  djGainB.gain.cancelScheduledValues(now);
  djGainA.gain.setTargetAtTime(1, now, 0.05);
  djGainB.gain.setTargetAtTime(0, now, 0.05);
  const base = (Number(vinylState && vinylState.settings && vinylState.settings.fxVol) || 55) / 100;
  vinylFx.setFxVol(base);
  vinylFxB.setFxVol(0);
}

function closeVinylShelf() {
  const ov = $('#vinylOverlay');
  if (!ov || ov.hidden) return;
  vinylFx.stop();
  vinylFxB.stop();
  stopDjLoop();
  if (djScratchTimer) { clearTimeout(djScratchTimer); djScratchTimer = null; }
  scratchInfo = null;
  resetDjMixer();
  ov.hidden = true;
  document.querySelector('[data-view="vinyl"]')?.classList.remove('active');
}

/* ---------- Fullscreen record view ---------- */

let recViewRec = null;
let recScratchMode = false;
let recScratchCount = 0;
let recCurPath = null;
let recCurPathPoint = null;
let recScratchDirty = false;
let recLastMoveT = 0;
let recGlitchTimer = null;
let recLastSpeed = 0;

function renderRecordView(rec) {
  const disc = $('#recDisc');
  if (!disc) return;
  recViewRec = rec;
  const scratches = rec.scratches || [];
  recScratchCount = scratches.length;
  $('#recTitle').textContent = rec.title || '—';
  $('#recArtist').textContent = rec.artist || '—';
  $('#recCount').textContent = `Царапин: ${recScratchCount}`;
  const cond = $('#recCond');
  if (cond) cond.textContent = CONDITION_LABELS[rec.condition] || '—';
  const pl = $('#recPlays');
  if (pl) pl.textContent = `Прослушиваний: ${rec.plays || 0}`;
  disc.innerHTML = recordDiscHtml(rec);
  disc.classList.toggle('playing', !audio.paused && isSameRecord(rec, state.currentTrack));
  const svg = $('#recScratches');
  if (svg) {
    svg.innerHTML = '';
    const ns = 'http://www.w3.org/2000/svg';
    scratches.forEach((s) => {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('class', 'rec-mark');
      path.setAttribute('d', s.d);
      svg.appendChild(path);
    });
  }
  if (vinylState.deck && isSameRecord(vinylState.deck, rec)) {
    vinylFx.setCondition(rec.condition);
    vinylFx.syncPlayback(vinylPlaySeverity(rec));
  }
}

function openRecordView(rec) {
  if (!rec) return;
  if (!$('#vinylOverlay').hidden) closeVinylShelf();
  const ov = $('#recOverlay');
  if (!ov) return;
  renderRecordView(rec);
  ov.hidden = false;
}

function closeRecordView() {
  const ov = $('#recOverlay');
  if (!ov || ov.hidden) return;
  finishRecScratch();
  ov.hidden = true;
  recViewRec = null;
  const glitch = $('#recGlitch');
  if (glitch) glitch.classList.remove('on');
}

function recToLocalPos(e) {
  const disc = $('#recDisc');
  if (!disc) return null;
  const rect = disc.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return null;
  return {
    x: ((e.clientX - rect.left) / rect.width) * 100,
    y: ((e.clientY - rect.top) / rect.height) * 100,
  };
}

function updateRecNeedle(x, y) {
  const needle = $('#recNeedle');
  if (!needle) return;
  needle.style.transform = `translate(${x}%, ${y}%) rotate(${Math.atan2(y - 55, x - 90) * 180 / Math.PI}deg)`;
}

function recTriggerStutter() {
  const disc = $('#recDisc');
  if (disc && !disc.classList.contains('jitter')) {
    disc.classList.add('jitter');
    setTimeout(() => disc.classList.remove('jitter'), 420);
  }
  const glitch = $('#recGlitch');
  if (glitch && !glitch.classList.contains('on')) {
    glitch.classList.add('on');
    if (recGlitchTimer) { clearTimeout(recGlitchTimer); recGlitchTimer = null; }
    recGlitchTimer = setTimeout(() => glitch.classList.remove('on'), 240);
  }
  vinylFx.scratchStart();
  const t = state.currentTrack;
  if (t && isSameRecord(recViewRec, t) && !audio.paused) {
    try { audio.pause(); } catch (e) { /* ignore */ }
    setTimeout(() => {
      try { if (!audio.paused) audio.play(); } catch (e) { /* ignore */ }
    }, 130);
  }
}

function startRecScratch(e) {
  if (!recViewRec) return;
  const p = recToLocalPos(e);
  if (!p) return;
  recScratchMode = true;
  recLastMoveT = performance.now();
  updateRecNeedle(p.x, p.y);
  const svg = $('#recScratches');
  if (!svg) return;
  const ns = 'http://www.w3.org/2000/svg';
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('class', 'rec-mark');
  path.setAttribute('d', `M${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
  svg.appendChild(path);
  recCurPath = path;
  recCurPathPoint = p;
  recScratchDirty = false;
}

function moveRecScratch(e) {
  if (!recScratchMode || !recViewRec) return;
  const p = recToLocalPos(e);
  if (!p) return;
  const now = performance.now();
  const dt = Math.max(1, now - recLastMoveT);
  const prev = recCurPathPoint || p;
  const dist = Math.hypot(p.x - prev.x, p.y - prev.y);
  const speed = (dist * 10) / (dt / 1000);
  updateRecNeedle(p.x, p.y);
  if (recCurPath && (dist > 0.25 || recScratchDirty)) {
    recCurPath.setAttribute('d', `${recCurPath.getAttribute('d')} L${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
    recScratchDirty = true;
  }
  recCurPathPoint = p;
  recLastMoveT = now;
  recLastSpeed = speed;
  if (speed > 50) {
    const svg = $('#recScratches');
    recScratchCount = svg ? svg.querySelectorAll('path.rec-mark').length : recScratchCount;
    const c = $('#recCount');
    if (c) c.textContent = `Царапин: ${recScratchCount}`;
    recTriggerStutter();
  }
}

function finishRecScratch() {
  if (!recScratchMode) return;
  recScratchMode = false;
  const path = recCurPath;
  recCurPath = null;
  recCurPathPoint = null;
  recScratchDirty = false;
  if (recViewRec && path) {
    const d = path.getAttribute('d');
    if (d && d.length > 2 && !recViewRec.scratches.some((s) => s.d === d)) {
      recViewRec.scratches.push({ d, sp: Math.max(60, Math.min(400, recLastSpeed || 60)) });
      const prevCond = recViewRec.condition;
      recViewRec.condition = vinylConditionForScratches(recViewRec.scratches.length);
      saveVinylState();
      recScratchCount = recViewRec.scratches.length;
      const c = $('#recCount');
      if (c) c.textContent = `Царапин: ${recScratchCount}`;
      const cc = $('#recCond');
      if (cc) cc.textContent = CONDITION_LABELS[recViewRec.condition] || '—';
      if (recViewRec.condition !== prevCond) {
        toast(`Пластинка «${recViewRec.title}» — состояние: ${CONDITION_LABELS[recViewRec.condition]}`, 'info', 2200);
      }
    }
  }
  vinylFx.scratchEnd();
}

function updateRecPlayingClass() {
  const disc = $('#recDisc');
  if (disc && recViewRec) {
    disc.classList.toggle('playing', !audio.paused && isSameRecord(recViewRec, state.currentTrack));
  }
}

function wireRecViewer() {
  const ov = $('#recOverlay');
  if (!ov) return;
  $('#recClose')?.addEventListener('click', closeRecordView);
  const stage = $('#recStage');
  if (stage) {
    stage.addEventListener('pointerdown', (e) => {
      if (e.target === stage || !e.target.closest('#recDisc')) {
        closeRecordView();
        return;
      }
      startRecScratch(e);
    });
    window.addEventListener('pointermove', moveRecScratch);
    window.addEventListener('pointerup', finishRecScratch);
  }
  ov.addEventListener('pointerdown', (e) => {
    if (e.target === ov) closeRecordView();
  });
}

audio.addEventListener('play', () => {
  updateDeckPlayingUI();
  updateRecPlayingClass();
});
audio.addEventListener('pause', () => {
  updateDeckPlayingUI();
  updateRecPlayingClass();
});

/* ---------- Mode rail wiring ---------- */

function wireModeUi() {
  wireShelfUi();
  wireRecViewer();
  wireLibraryDrag();
  wireDjTour();
  $('#vmClose')?.addEventListener('click', closeVinylShelf);
  $('#vsBackBtn')?.addEventListener('click', deckReturnToShelf);
  $('#vmAddShelf')?.addEventListener('click', addVinylShelf);
  $('#vmFxVol')?.addEventListener('input', (e) => {
    vinylState.settings.fxVol = Number(e.target.value);
    saveVinylState();
    vinylFx.setFxVol(Number(e.target.value) / 100);
  });
  $('#vsPlay')?.addEventListener('click', deckTogglePlay);
  $('#vsNeedleBtn')?.addEventListener('click', deckToggleNeedle);
  $('#vsCondBtn')?.addEventListener('click', deckCycleCondition);
  $('#vsDeckRecord')?.addEventListener('dblclick', flipDeckRecord);
  $('#vsDeckRecord')?.addEventListener('pointerdown', (e) => { if (vinylState.deck) djScratchDown('a', e); });
  $('#vsDeckRecordB')?.addEventListener('dblclick', flipDeckRecordB);
  $('#vsDeckRecordB')?.addEventListener('pointerdown', (e) => { if (vinylState.cue) djScratchDown('b', e); });
  $('#vsPlayB')?.addEventListener('click', deckTogglePlayB);
  $('#vsBackBtnB')?.addEventListener('click', deckBReturnToShelf);
  $('#vsCueBtn')?.addEventListener('pointerdown', (e) => { e.preventDefault(); cuePreviewStart(); });
  window.addEventListener('pointerup', cuePreviewEnd);
  $('#vsSyncBtn')?.addEventListener('click', djSync);
  $('#vsPitchA')?.addEventListener('input', (e) => djSetPitch('a', Number(e.target.value)));
  $('#vsPitchB')?.addEventListener('input', (e) => djSetPitch('b', Number(e.target.value)));
  $('#vsXfade')?.addEventListener('input', (e) => {
    const x = Number(e.target.value);
    vinylState.dj.xfade = x;
    saveVinylState();
    applyDjCrossfade(x);
  });
  window.addEventListener('pointermove', handleModePointerMove);
  window.addEventListener('pointerup', handleModePointerUp);
}

/* ============================================================
   Event wiring
   ============================================================ */

function wireEvents() {
  $('#launchLocal')?.addEventListener('click', launchLocalPlayer);

  $$('.nav-link').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('.brand')?.addEventListener('click', () => { if (state.launched) switchView('library'); });
  $('#profileButton')?.addEventListener('click', () => switchView('settings'));

  $('#dashAddTrack')?.addEventListener('click', () => $('#trackFileInput')?.click());
  $('#addTrackButton')?.addEventListener('click', () => $('#trackFileInput')?.click());
  $('#trackFileInput')?.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) addLocalTrack(file);
    e.target.value = '';
  });

  $('#showAll')?.addEventListener('click', () => {
    state.heroExpanded = !state.heroExpanded;
    renderPlaylists();
  });
  let filterDebounce = null;
  $('#filterInput')?.addEventListener('input', () => {
    clearTimeout(filterDebounce);
    filterDebounce = setTimeout(() => renderTracks(false), 140);
  });
  $('#sortButton')?.addEventListener('click', () => {
    state.sortNewest = !state.sortNewest;
    const btn = $('#sortButton');
    btn.classList.toggle('asc', !state.sortNewest);
    btn.title = state.sortNewest ? 'Сначала новые' : 'Сначала старые';
    renderTracks();
  });

  // Широкий / компактный вид библиотеки
  (() => {
    const btn = $('#viewToggle');
    if (!btn) return;
    const apply = (wide) => {
      document.body.classList.toggle('lib-wide', wide);
      btn.classList.toggle('active', wide);
    };
    apply(localStorage.getItem('umbrella_lib_wide') === '1');
    btn.addEventListener('click', () => {
      const wide = !document.body.classList.contains('lib-wide');
      apply(wide);
      localStorage.setItem('umbrella_lib_wide', wide ? '1' : '0');
    });
  })();

  // Утилиты сайдбара: яркость интерфейса и остановка сервера
  (() => {
    const light = $('#utilLight');
    const dark = $('#utilDark');
    const apply = (mode) => {
      document.body.classList.toggle('dim-ui', mode === 'dark');
      light?.classList.toggle('active', mode === 'light');
      dark?.classList.toggle('active', mode === 'dark');
    };
    apply(localStorage.getItem('umbrella_ui_mode') || 'dark');
    light?.addEventListener('click', () => { apply('light'); localStorage.setItem('umbrella_ui_mode', 'light'); });
    dark?.addEventListener('click', () => { apply('dark'); localStorage.setItem('umbrella_ui_mode', 'dark'); });
    $('#utilExit')?.addEventListener('click', () => $('#btnShutdown')?.click());
  })();

  $('#playlistGrid')?.addEventListener('click', (e) => {
    const card = e.target.closest('.playlist-card');
    const btn = e.target.closest('.card-play');
    if (!card) return;
    if (btn) {
      const artist = btn.dataset.artist;
      const tracks = state.tracks;
      const list = tracks;
      const first = list.find((t) => t.artist === artist);
      if (first) {
        state.visibleTracks = list;
        const idx = list.indexOf(first);
        playTrack(first, idx);
        toast(`Играет: ${artist}`);
      }
      return;
    }
    showArtistPage(card.dataset.artist);
  });

  function onPlaylistGridClick(e) {
    const card = e.target.closest('.playlist-card');
    const del = e.target.closest('.card-del');
    if (!card) return;
    const sys = card.dataset.plsys;
    if (sys === 'fav') { switchView('favorites'); return; }
    if (sys === 'new') { createPlaylistFlow(); return; }
    const plid = card.dataset.plid;
    if (del) {
      const pl = playlists.find((p) => p.id === plid);
      if (!pl) return;
      confirmDialog({ title: 'Удалить плейлист?', body: `«${pl.name}» будет удалён безвозвратно.`, confirmText: 'Удалить' }).then((ok) => {
        if (ok) deletePlaylist(plid);
      });
      return;
    }
    if (e.target.closest('.card-play')) {
      playPlaylist(plid);
      return;
    }
    showPlaylistPage(plid);
  }
  $('#customPlaylistGrid')?.addEventListener('click', onPlaylistGridClick);
  $('#allPlaylistGrid')?.addEventListener('click', onPlaylistGridClick);

  $('#topArtistsRow')?.addEventListener('click', (e) => {
    const bubble = e.target.closest('.artist-bubble');
    if (bubble && bubble.dataset.artist) showArtistPage(bubble.dataset.artist);
  });
  $('#showAllArtists')?.addEventListener('click', () => {
    state.artistsExpanded = !state.artistsExpanded;
    renderTopArtists();
  });

  $('#newPlaylistBtn')?.addEventListener('click', createPlaylistFlow);
  $('#newPlaylistBtn2')?.addEventListener('click', createPlaylistFlow);

  $('#searchButton')?.addEventListener('click', search);
  $('#searchInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  $('#playlistAddAll')?.addEventListener('click', addAllPlaylistToQueue);
  $('#searchInput')?.addEventListener('focus', () => {
    if (!searchHistory.length) return;
    renderSearchHistory();
    $('#searchHistory').hidden = false;
  });
  $('#searchHistoryRow')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-q]');
    if (!chip) return;
    $('#searchInput').value = chip.querySelector('span').textContent;
    $('#searchHistory').hidden = true;
    search();
  });
  $('#clearHistory')?.addEventListener('click', () => { searchHistory = []; saveJSON(SCH_KEY, []); renderSearchHistory(); });

  $$('.search-tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.search-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.searchSource = tab.dataset.source;
    const src = tab.dataset.source;
    const isPl = src === 'playlists';
    const isAlbums = src === 'albums';
    const isSc = src === 'soundcloud';
    $('#searchInput').placeholder = isPl
      ? 'Название плейлиста или исполнителя…'
      : (isAlbums ? 'Исполнитель для поиска альбомов…' : 'Трек, исполнитель или альбом');
    // Ответы поиска для прошлой вкладки больше не актуальны.
    state.searchGen++;
    clearTimeout(window.searchTimeout);
    clearSearchOutput();
    $('#searchResults').hidden = isAlbums || isPl;
    $('#albumResults').hidden = !isAlbums;
    $('#playlistBanner').hidden = true;
    $('#albumDetail').hidden = true;
    $('#searchEmpty').hidden = false;
    const tc = $('#scToolbar');
    if (tc) tc.hidden = !isSc;
    const scl = $('#scLibrary');
    if (scl) scl.hidden = true;
    if (isSc) {
      refreshScDownloaded();
    }
  }));

  $('#albumResults')?.addEventListener('click', (e) => {
    const card = e.target.closest('.album-card');
    if (card) {
      if (card.dataset.source) {
        showUnifiedAlbumDetail(card.dataset.source, card.dataset.id);
      } else {
        showAlbumDetail(card.dataset.id);
      }
    }
  });

  $('#searchResults')?.addEventListener('click', (e) => {
    const card = e.target.closest('.album-card[data-type="playlist"]');
    if (!card) return;
    e.stopPropagation();
    if (card.dataset.type === 'playlist' && card.dataset.source) {
      openUnifiedPlaylist(card.dataset.source, card.dataset.id);
    }
  });

  // SoundCloud events
  $('#scUrlGo')?.addEventListener('click', openScUrl);
  $('#scUrlInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') openScUrl(); });
  $('#scLibraryBtn')?.addEventListener('click', toggleScLibrary);
  $('#scLibrary')?.addEventListener('click', async (e) => {
    if (e.target.closest('#scLibRefresh')) { await refreshScDownloaded(); return; }
    const del = e.target.closest('[data-scdel]');
    if (del) {
      const path = del.dataset.scdel;
      const ok = await confirmDialog({ title: 'Удалить файл?', body: 'Файл будет удалён с диска безвозвратно.', confirmText: 'Удалить' });
      if (!ok) return;
      try {
    const r = await fetch(`${API}/sc/file?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
      headers: apiToken ? { 'X-Umbrella-Token': apiToken } : {},
    });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || 'Не удалось удалить');
        toast('Файл удалён', 'success', 2200);
      } catch (err) { toast(err.message, 'error'); }
      refreshScDownloaded();
    }
  });

  $('#recentRow')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-h]');
    if (!chip) return;
    const rec = history[0]; // find by index
    const chips = [...$$('#recentRow [data-h]')];
    const record = history[chips.indexOf(chip)];
    if (!record) return;
    const track = {
      title: record.title, artist: record.artist, source: record.source,
      videoId: record.videoId, scUrl: record.scUrl, scId: record.scId, thumbnail: record.thumbnail, duration: record.duration, color: '',
      _needsLookup: (!record.scUrl && !record.scId) ? `${record.artist} ${record.title}` : null,
      url: record.scUrl,
    };
    if (track.source === 'local') {
      const found = state.tracks.find((t) => t.title === track.title && t.artist === track.artist);
      if (found) track.dbId = found.dbId;
    }
    state.visibleTracks = [track];
    playTrack(track, 0);
  });

  // Player bar
  $('#playerBar')?.addEventListener('click', (e) => {
    if (e.target.closest('.pb-btn') || e.target.closest('.pb-fav') || e.target.closest('.pb-lyrics') || e.target.closest('.pb-seek') || e.target.closest('.pb-progress') || e.target.closest('.pb-right')) return;
    if (state.currentTrack) openNowPlaying();
  });
  $('#pbFav')?.addEventListener('click', () => {
    if (state.currentTrack) toggleFav(state.currentTrack);
  });
  $('#pbPrev')?.addEventListener('click', prevTrack);
  $('#pbPlay')?.addEventListener('click', togglePlay);
  $('#pbNext')?.addEventListener('click', nextTrack);
  $('#pbLyrics')?.addEventListener('click', () => openLyrics());

  $('#npClose')?.addEventListener('click', () => closeNowPlaying());
  $('#npPlay')?.addEventListener('click', togglePlay);
  $('#npNext')?.addEventListener('click', nextTrack);
  $('#npPrev')?.addEventListener('click', prevTrack);
  $('#npShuffle')?.addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    $$('#pbShuffle, #npShuffle').forEach((b) => b.classList.toggle('active', state.shuffle));
    toast(state.shuffle ? 'Перемешивание включено' : 'Перемешивание выключено', 'info', 1800);
  });
  $('#npRepeat')?.addEventListener('click', () => {
    state.repeat = !state.repeat;
    $$('#pbRepeat, #npRepeat').forEach((b) => b.classList.toggle('active', state.repeat));
    audio.loop = state.repeat;
    toast(state.repeat ? 'Повтор включён' : 'Повтор выключен', 'info', 1800);
  });
  $('#npSeek')?.addEventListener('input', (e) => {
    const pct = Number(e.target.value) / 10;
    e.target.style.setProperty('--sc-fill', pct + '%');
    const dur = effectiveDuration();
    if (dur) djActiveElement().currentTime = (Number(e.target.value) / 1000) * dur;
  });
  $('#npFull')?.addEventListener('click', () => {
    const el = $('#nowPlaying');
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => toast('Полный экран недоступен', 'error'));
    else document.exitFullscreen?.();
  });
  $('#npAddLibrary')?.addEventListener('click', async () => {
    const track = state.currentTrack;
    if (!track) {
      toast('Нет активного трека', 'info');
      return;
    }
    
    // Если трек уже имеет dbId (локальный)
    if (track.dbId) {
      toast('Трек уже в библиотеке', 'info');
      return;
    }

    // Для других источников (SoundCloud и т.д.) — скачиваем в библиотеку.
    if (track.source === 'soundcloud' || track.previewUrl || track.link) {
      await downloadSoundcloudTrack(track);
      updateLibraryButtonState();
      return;
    }

    toast('Этот трек недоступен для добавления', 'info');
  });
  $('#npLyrics')?.addEventListener('click', openLyrics);
  $('#npRadio')?.addEventListener('click', () => {
    if (state.radioMode) { stopRadio(); toast('Радио-режим выключен'); return; }
    if (!state.currentTrack || (!state.currentTrack.scUrl && !state.currentTrack.scId)) { toast('Сначала включите трек из SoundCloud', 'info'); return; }
    state.radioMode = true;
    state.radioKind = 'related';
    state.radioPlayedIds = new Set();
    state.radioQueue = [];
    audio.loop = false;
    $('#npRadio').classList.add('active');
    toast('Радио-режим включён', 'success');
  });

  $('#npQueueToggle')?.addEventListener('click', () => {
    const panel = $('#npQueue');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderQueue();
  });
  $('#npQueueClose')?.addEventListener('click', () => {
    $('#npQueue').hidden = true;
  });
  $('#npQueueList')?.addEventListener('click', (e) => {
    const item = e.target.closest('.np-queue-item');
    if (!item) return;
    const idx = Number(item.dataset.qidx);
    let target = state.visibleTracks[idx + (state.currentTrack ? state.visibleTracks.indexOf(state.currentTrack) + 1 : 0)];
    if (!target && state.radioQueue.length) target = state.radioQueue[0];
    if (target) {
      const list = state.visibleTracks;
      const realIdx = list.indexOf(target);
      if (realIdx >= 0) playTrack(target, realIdx);
      else { state.visibleTracks.push(target); playTrack(target, state.visibleTracks.length - 1); }
    }
  });

  // Drag & drop reorder
  (() => {
    const list = $('#npQueueList');
    if (!list) return;
    let dragFrom = -1;
    let dropBefore = -1;
    function clearIndicators() {
      list.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    }
    list.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.np-queue-item');
      if (!item || item.dataset.kind !== 'vt') { e.preventDefault(); return; }
      dragFrom = Number(item.dataset.vidx);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(dragFrom));
      requestAnimationFrame(() => item.classList.add('dragging'));
    });
    list.addEventListener('dragover', (e) => {
      const item = e.target.closest('.np-queue-item');
      if (dragFrom < 0 || !item) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearIndicators();
      const rect = item.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      item.classList.add(before ? 'drop-before' : 'drop-after');
      const base = item.dataset.kind === 'vt' ? Number(item.dataset.vidx) : (state.queueTail ? state.queueTail.slice(0, 40).length : 0);
      dropBefore = before ? base : base + 1;
    });
    list.addEventListener('drop', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      clearIndicators();
      const from = dragFrom;
      let to = dropBefore;
      if (to > from) to -= 1;
      reorderQueueItem(from, to);
      dragFrom = -1;
      dropBefore = -1;
    });
    list.addEventListener('dragleave', (e) => {
      if (!list.contains(e.relatedTarget)) clearIndicators();
    });
    list.addEventListener('dragend', () => {
      list.querySelectorAll('.np-queue-item.dragging').forEach((el) => el.classList.remove('dragging'));
      clearIndicators();
      dragFrom = -1;
      dropBefore = -1;
    });
  })();

  // Stats dashboard
  $('#statPeriodChips')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    statPeriod = chip.dataset.period || 'all';
    $$('#statPeriodChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderStatsDashboard();
  });
  $('#statClearBtn')?.addEventListener('click', async () => {
    const ok = await confirmDialog('Очистить статистику?', 'Все данные прослушиваний будут удалены безвозвратно.');
    if (!ok) return;
    clearListenLog();
    renderStatsDashboard();
    toast('Статистика очищена', 'success');
  });

  // Waveform seek
  (() => {
    const canvas = $('#npWave');
    if (!canvas) return;
    let dragging = false;
    canvas.addEventListener('pointerdown', (e) => { dragging = true; seekFromWave(e.clientX); });
    canvas.addEventListener('pointermove', (e) => { if (dragging) seekFromWave(e.clientX); });
    window.addEventListener('pointerup', () => { dragging = false; });
    const np = $('#nowPlaying');
    canvas.addEventListener('pointerenter', () => np.classList.add('focus-wave'));
    canvas.addEventListener('pointerleave', () => np.classList.remove('focus-wave'));
  })();

  // Volume (полноэкранный плеер + нижняя панель)
  (() => {
    let savedVol = 1;
    function applyVol(ratio) {
      preferredVolume = ratio;
      audio.volume = ratio;
      audioB.volume = ratio;
      if (!coreTransition && audioCtx && djGainA && djGainB) {
        const now = audioCtx.currentTime;
        const active = deckGain(state._activeAudioSide);
        const idle = deckGain(state._activeAudioSide === 'a' ? 'b' : 'a');
        active.gain.cancelScheduledValues(now);
        idle.gain.cancelScheduledValues(now);
        active.gain.setTargetAtTime(1, now, 0.04);
        idle.gain.setTargetAtTime(0, now, 0.04);
      }
      updateVolUI(ratio);
      if (settings.keepVolume) localStorage.setItem('umbrella_volume', String(ratio));
    }
    ['#volTrack', '#pbVolTrack'].forEach((sel) => {
      const track = $(sel);
      if (!track) return;
      let dragging = false;
      const setVol = (e) => {
        const rect = track.getBoundingClientRect();
        if (!rect.width) return;
        applyVol(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
      };
      track.addEventListener('pointerdown', (e) => { dragging = true; track.setPointerCapture?.(e.pointerId); setVol(e); });
      track.addEventListener('pointermove', (e) => { if (dragging) setVol(e); });
      track.addEventListener('pointerup', () => { dragging = false; });
      track.addEventListener('pointercancel', () => { dragging = false; });
    });
    ['#volIcon', '#pbVolIcon'].forEach((sel) => {
      $(sel)?.addEventListener('click', () => {
        if (activeAudio().volume > 0) { savedVol = activeAudio().volume; applyVol(0); }
        else applyVol(savedVol || 1);
      });
    });
    const saved = parseFloat(localStorage.getItem('umbrella_volume') || '1');
    preferredVolume = settings.keepVolume && Number.isFinite(saved) ? saved : 1;
    audio.volume = preferredVolume;
    audioB.volume = audio.volume;
    updateVolUI(preferredVolume);
  })();

  // Перемотка в нижней панели — throttled, без лага на стриме
  (() => {
    const bar = $('#pbProgress');
    if (!bar) return;
    let dragging = false;
    let pendingRatio = null;
    let raf = null;
    const commitSeek = (ratio) => {
      const dur = effectiveDuration();
      if (dur) {
        const el = djActiveElement();
        try { if (el.fastSeek) el.fastSeek(ratio * dur); else el.currentTime = ratio * dur; } catch(_) { el.currentTime = ratio * dur; }
      }
    };
    const seekTo = (e, commit=false) => {
      const rect = bar.getBoundingClientRect();
      if (!rect.width) return;
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const fill = $('#pbProgressFill');
      if (fill) fill.style.width = `${ratio * 100}%`;
      const knob = $('#pbKnob');
      if (knob) knob.style.left = `${ratio * 100}%`;
      if (commit) commitSeek(ratio);
      else pendingRatio = ratio;
    };
    bar.addEventListener('pointerdown', (e) => {
      dragging = true;
      bar.classList.add('dragging');
      bar.setPointerCapture?.(e.pointerId);
      seekTo(e, true);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      pendingRatio = null;
      seekTo(e, false);
      if (!raf) raf = requestAnimationFrame(()=>{ raf=null; });
    });
    const stop = (e) => {
      if (dragging && pendingRatio !== null) commitSeek(pendingRatio);
      dragging = false; pendingRatio = null; bar.classList.remove('dragging');
    };
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);
    bar.addEventListener('keydown', (e) => {
      const dur = effectiveDuration();
      if (!dur) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); djActiveElement().currentTime = Math.min(dur, djActiveElement().currentTime + 5); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); djActiveElement().currentTime = Math.max(0, djActiveElement().currentTime - 5); }
    });
  })();

  // Перемешать / повтор в нижней панели
  $('#pbShuffle')?.addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    $$('#pbShuffle, #npShuffle').forEach((b) => b.classList.toggle('active', state.shuffle));
    toast(state.shuffle ? 'Перемешивание включено' : 'Перемешивание выключено', 'info', 1800);
  });
  $('#pbRepeat')?.addEventListener('click', () => {
    state.repeat = !state.repeat;
    $$('#pbRepeat, #npRepeat').forEach((b) => b.classList.toggle('active', state.repeat));
    audio.loop = state.repeat;
    toast(state.repeat ? 'Повтор включён' : 'Повтор выключен', 'info', 1800);
  });
  $('#pbQueue')?.addEventListener('click', () => {
    openNowPlaying();
    const panel = $('#npQueue');
    if (panel) { panel.hidden = false; renderQueue(); }
  });

  // Speed
  (() => {
    const speedBtn = $('#npSpeed');
    const popup = $('#npSpeedPopup');
    if (!speedBtn || !popup) return;
    const saved = parseFloat(localStorage.getItem('umbrella_speed') || '1');
    setSpeed(saved);
    speedBtn.addEventListener('click', (e) => { e.stopPropagation(); popup.hidden = !popup.hidden; });
    popup.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn) { setSpeed(parseFloat(btn.dataset.rate)); popup.hidden = true; }
    });
    document.addEventListener('click', () => { popup.hidden = true; });
  })();

  // Custom cover
  (() => {
    const coverBtn = $('#npCoverBtn');
    const popup = $('#npCoverPopup');
    const fileInput = $('#npCoverFile');
    if (!coverBtn || !popup || !fileInput) return;
    coverBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!state.customCover) { fileInput.click(); return; }
      popup.hidden = !popup.hidden;
    });
    popup.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.closest('#npCoverReplace')) { popup.hidden = true; fileInput.click(); }
      else if (e.target.closest('#npCoverRemove')) { popup.hidden = true; removeCustomCover(); }
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) setCustomCoverFile(file);
      fileInput.value = '';
    });
    document.addEventListener('click', () => { popup.hidden = true; });
  })();

  // Radio banner
  $('#radioToggleBtn')?.addEventListener('click', () => {
    const wrap = $('#radioSearchWrap');
    if (wrap.hidden) { wrap.hidden = false; $('#radioArtistInput')?.focus(); }
    else if (state.radioMode) { stopRadio(); toast('Радио выключено'); wrap.hidden = true; }
    else { wrap.hidden = true; }
  });
  $('#radioStartBtn')?.addEventListener('click', () => {
    const val = $('#radioArtistInput')?.value || '';
    if (!val.trim()) return toast('Введите имя исполнителя', 'info');
    startArtistRadio(val);
  });
  $('#radioArtistInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#radioStartBtn')?.click(); } });

  // Radio view
  $('#radioViewStart')?.addEventListener('click', () => {
    const val = $('#radioViewInput')?.value || '';
    if (!val.trim()) return toast('Введите имя исполнителя', 'info');
    startArtistRadio(val);
  });
  $('#radioViewInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#radioViewStart')?.click(); } });
  $('#radioSuggest')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const input = $('#radioViewInput');
    if (input) input.value = btn.textContent;
    startArtistRadio(btn.textContent);
  });

  // Infinite mix
  $('#infBanner')?.addEventListener('click', () => { window.location.href = '/eternalbox.html'; });
  $('#infBanner')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.location.href = '/eternalbox.html'; } });

  // Lyrics overlay
  $('#lyricsClose')?.addEventListener('click', closeLyrics);
  $('#lyricsBackdrop')?.addEventListener('click', closeLyrics);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').hidden) { closeModal(false); return; }
    if (e.key === 'Escape' && !$('#recOverlay').hidden) { closeRecordView(); return; }
    if (e.key === 'Escape' && !$('#vinylOverlay').hidden) { closeVinylShelf(); return; }
    if (e.key === 'Escape' && !$('#lyricsOverlay').hidden) { closeLyrics(); return; }
    if (e.key === 'Escape' && !$('#playlistDetail').hidden) { closePlaylistPage(); return; }
    if (e.key === 'Escape' && !$('#artistDetail').hidden) { closeArtistPage(); return; }
    if (e.key === 'Escape' && !$('#npQueue').hidden) $('#npQueue').hidden = true;
  });

  // Modal
  $('#modalCancel')?.addEventListener('click', () => closeModal(false));
  $('#modalConfirm')?.addEventListener('click', () => closeModal(true));
  $('#modalBackdrop')?.addEventListener('click', () => closeModal(false));
  $('#modalList')?.addEventListener('click', (e) => {
    const row = e.target.closest('.modal-list-row');
    if (!row) return;
    closeModal({ idx: Number(row.dataset.idx) });
  });
  $('#modalInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') closeModal(true); });

  // Settings toggles
  const toggleDefs = [
    ['#setVisualizer', 'visualizer'],
    ['#setLed', 'led'],
    ['#setAmbient', 'ambient'],
    ['#setLowFx', 'lowFx'],
    ['#setKeepVolume', 'keepVolume'],
    ['#setAutoAdd', 'autoAdd'],
    ['#setOffline', 'offline'],
  ];
  toggleDefs.forEach(([sel, key]) => {
    const el = $(sel);
    if (!el) return;
    el.classList.toggle('on', !!settings[key]);
    el.setAttribute('aria-checked', !!settings[key]);
    el.addEventListener('click', () => {
      settings[key] = !settings[key];
      el.classList.toggle('on', settings[key]);
      el.setAttribute('aria-checked', settings[key]);
      saveSettings();
    });
  });

  // Theme auto toggle
  const themeAutoBtn = $('#setThemeAuto');
  if (themeAutoBtn) {
    themeAutoBtn.classList.toggle('on', !!settings.themeAuto);
    themeAutoBtn.setAttribute('aria-checked', !!settings.themeAuto);
    themeAutoBtn.addEventListener('click', () => {
      settings.themeAuto = !settings.themeAuto;
      if (!settings.themeAuto && settings.themeHue == null) settings.themeHue = Math.round(extractHue(state.currentTrack?.color));
      themeAutoBtn.classList.toggle('on', settings.themeAuto);
      themeAutoBtn.setAttribute('aria-checked', settings.themeAuto);
      saveSettings();
      applyHue(effectiveHue(), true);
      syncThemeSwatches();
    });
  }

  // Theme swatches
  $$('#themeSwatches .swatch').forEach((el) => {
    el.addEventListener('click', () => {
      settings.themeHue = Number(el.dataset.hue);
      settings.themeAuto = false;
      themeAutoBtn?.classList.remove('on');
      themeAutoBtn?.setAttribute('aria-checked', 'false');
      saveSettings();
      applyHue(settings.themeHue, true);
      syncThemeSwatches();
    });
  });
  syncThemeSwatches();

  $('#btnClearCache')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Очистить библиотеку?',
      body: 'Все сохранённые треки и офлайн-загрузки будут удалены безвозвратно.',
      confirmText: 'Очистить всё',
    });
    if (!ok) return;
    try {
      await idbClear();
      await idbClearOffline();
    } catch (e) { /* ignore */ }
    state.tracks = [];
    state.currentTrack = null;
    audio.pause();
    audioB.pause();
    renderPlayerBar(null);
    renderTracks();
    toast('Кэш и библиотека очищены', 'success');
  });

  $('#btnShutdown')?.addEventListener('click', async () => {
    toast('Сервер останавливается…');
    try {
      await request('/shutdown', { method: 'POST', timeout: API_TIMEOUT.shutdown });
    } catch (e) { /* server stops anyway */ }
    setTimeout(() => {
      document.body.innerHTML = '<div style="display:grid;place-items:center;height:100vh;color:#f5f5f7;font-family:Inter,system-ui,sans-serif;background:#08080c"><div style="text-align:center"><h1 style="font-size:28px;margin-bottom:12px">Сервер остановлен</h1><p style="color:#858890;font-size:14px">Можно закрыть окно</p></div></div>';
    }, 800);
  });
}

/* ============================================================
   Keyboard shortcuts
   ============================================================ */

function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

document.addEventListener('keydown', (e) => {
  if (isTyping()) return;
  if ($('#modal').hidden === false) return;
  const key = e.key.toLowerCase();
  switch (key) {
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'arrowright':
      if (e.shiftKey) nextTrack(); else { const el = djActiveElement(); el.currentTime = Math.min(effectiveDuration(), el.currentTime + 5); }
      break;
    case 'arrowleft':
      if (e.shiftKey) prevTrack(); else { const el = djActiveElement(); el.currentTime = Math.max(0, el.currentTime - 5); }
      break;
    case 'arrowup':
      e.preventDefault();
      {
        const volume = Math.min(1, activeAudio().volume + 0.05);
        audio.volume = volume;
        audioB.volume = volume;
        updateVolUI(volume);
      }
      break;
    case 'arrowdown':
      e.preventDefault();
      {
        const volume = Math.max(0, activeAudio().volume - 0.05);
        audio.volume = volume;
        audioB.volume = volume;
        updateVolUI(volume);
      }
      break;
    case 'm':
      if (activeAudio().volume > 0) { audio.dataset.prevVol = activeAudio().volume; audio.volume = 0; audioB.volume = 0; }
      else { const mv = parseFloat(audio.dataset.prevVol) || 1; audio.volume = mv; audioB.volume = mv; }
      updateVolUI(activeAudio().volume);
      break;
    case 'n':
      nextTrack();
      break;
    case 'p':
      prevTrack();
      break;
    case 'l':
      openLyrics();
      break;
    case 'f':
      const el = $('#nowPlaying');
      if (!document.fullscreenElement) el.requestFullscreen?.();
      else document.exitFullscreen?.();
      break;
  }
});

/* ============================================================
   Ambient background (silk aurora)
   ============================================================ */

function initAmbient() {
  if (!window.initSilkAurora) return;
  const container = $('#ambient');
  if (!container) return;
  container.style.position = 'fixed';
  container.style.inset = '0';
  const instance = initSilkAurora(container, {
    baseColor: '#0a0b16', midColor: '#1a1c36',
    sheenColor: '#a78bfa', accentColor: '#60a5fa',
    speed: 0.9, intensity: 1.0, grain: 0, vignette: 0.5, mouseInfluence: 1.0,
  });
  window.__silk = instance;
  document.addEventListener('visibilitychange', () => {
    if (!window.__silk) return;
    if (document.hidden) window.__silk.pause();
    else if (settings.ambient && !$('#nowPlaying')?.hidden) window.__silk.pause();
    else if (settings.ambient) window.__silk.resume();
  });
  const origOpen = openNowPlaying;
  const origClose = closeNowPlaying;
  openNowPlaying = function () {
    if (settings.ambient && window.__silk) window.__silk.pause();
    container.style.opacity = '0.25';
    return origOpen.apply(this, arguments);
  };
  closeNowPlaying = function () {
    const r = origClose.apply(this, arguments);
    setTimeout(() => {
      if (settings.ambient && window.__silk) window.__silk.resume();
      container.style.opacity = '1';
    }, 550);
    return r;
  };
}

/* ============================================================
   Init
   ============================================================ */

function init() {
  // Attach all UI listeners FIRST so the player works even if a later
  // render step throws. Guarded so one bad listener never kills the rest
  // of the wiring (see the openScUrl crash).
  try { wireEvents(); } catch (e) { console.error('wireEvents failed:', e); }
  try { renderPlaylists(); } catch (e) {}
  try { renderTopArtists(); } catch (e) {}
  try { renderCustomPlaylists(); } catch (e) {}
  try { renderRecent(); } catch (e) {}
  try { renderSearchHistory(); } catch (e) {}
  try { wireModeUi(); } catch (e) {}
  try { initAmbient(); } catch (e) {}
  try { applySettings(); } catch (e) {}
  try { applyHue(effectiveHue()); } catch (e) {}
  try { setSpeed(parseFloat(localStorage.getItem('umbrella_speed') || '1')); } catch (e) {}
  try { loadCustomCover(); } catch (e) {}
  try { renderRecent(); } catch (e) {}
  checkForApplicationUpdate();
}

async function refreshAppVersion() {
  try {
    const info = await request('/version', { timeout: API_TIMEOUT.version });
    if (info && info.version) {
      const el = $('#appVersion');
      if (el) el.textContent = String(info.version).replace(/^v/, '');
    }
  } catch (e) {}
}

async function checkForApplicationUpdate() {
  try {
    await refreshAppVersion();
    const update = await request('/update', { timeout: API_TIMEOUT.update });
    if (!update || update.version === undefined || update.available === false) return;
    const banner = $('#updateBanner');
    if (!banner) return;
    const title = $('#updateTitle');
    const notes = $('#updateNotes');
    if (title) title.textContent = `Доступна версия ${update.version}`;
    if (notes) notes.textContent = update.releaseNotes || 'Доступно обновление приложения';
    banner.hidden = false;
    $('#updateLater')?.addEventListener('click', () => { banner.hidden = true; }, { once: true });
    $('#updateApply')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'Подготовка…';
      try {
        await request('/update/apply', { method: 'POST', timeout: 15000 });
        document.body.innerHTML = '<div style="display:grid;place-items:center;height:100vh;color:#f5f5f7;font-family:Inter,system-ui,sans-serif;background:#08080c"><div style="text-align:center"><h1 style="font-size:28px;margin-bottom:12px">Приложение обновляется</h1><p style="color:#858890;font-size:14px">Окно запустится снова автоматически</p></div></div>';
      } catch (error) {
        button.disabled = false;
        button.textContent = 'Обновить';
        toast(error.message || 'Не удалось запустить обновление', 'error');
      }
    }, { once: true });
  } catch (e) { /* update checks must never block startup */ }
}

let _booted = false;
async function bootApp() {
  if (_booted) return;
  _booted = true;
  try {
    const response = await fetch(`${API}/session`, { cache: 'no-store' });
    if (response.ok) apiToken = (await response.json()).token || '';
  } catch (e) { /* local API may be unavailable during startup */ }
  init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootApp);
} else {
  bootApp();
}
// Safety net: some webview environments don't fire DOMContentLoaded reliably.
window.addEventListener('load', bootApp);
setTimeout(bootApp, 300);

// Fail-safe launch-button wiring: attaches the listener independently of
// init()/bootApp() and touches only DOM + the hoisted launchLocalPlayer()
// (no module-scope `let` bindings), so it works even if init() never runs.
(function () {
  function attachLaunch() {
    var b = document.getElementById('launchLocal');
    if (b && !b.dataset.wired) {
      b.dataset.wired = '1';
      b.addEventListener('click', launchLocalPlayer);
    }
    // Страховка на случай, если init() не отработал: Enter в поле поиска.
    // Поиск на каждое нажатие клавиши НЕ вешаем — он порождал гонку запросов
    // по префиксам запроса, и в выдачу попадали случайные альбомы.
    var s = document.getElementById('searchInput');
    if (s && !s.dataset.wired) {
      s.dataset.wired = '1';
      s.addEventListener('keydown', function (e) { if (e.key === 'Enter') search(); });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachLaunch);
    window.addEventListener('load', attachLaunch);
    setTimeout(attachLaunch, 300);
  } else {
    attachLaunch();
  }
})();


/* ============================================================
   Umbrella Player — Living UI v1.2
   Реактивный слой + стартовая заставка + переключатели в настройках.
   Дописан в конец app2.js специально: сборка .exe идёт по списку
   файлов в .spec, отдельные файлы туда не попадают.

   v1.2:
   • анализатор поднимается сам (ensureAnalyser + resume AudioContext),
     не завися от настройки «Визуализация»;
   • если анализатор молчит (нули) — включается синтетический ритм,
     чтобы интерфейс всё равно дышал;
   • каждая группа эффектов переключается в Настройках, на лету;
   • диагностика: Настройки → «Диагностика реактивности».
   ============================================================ */

(() => {
  'use strict';
  if (window.LivingUI) return;

  const root = document.documentElement;
  const reduceMotion = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)')) || { matches: false };
  const qs = (s, r) => (r || document).querySelector(s);
  const qsa = (s, r) => [...(r || document).querySelectorAll(s)];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const safe = (fn) => { try { return fn(); } catch (e) { return undefined; } };

  /* ============================================================
     Конфигурация
     ============================================================ */

  const GROUPS = [
    ['cover', 'Живая обложка', 'Дыхание по басу, наклон к курсору, рассыпание при смене трека'],
    ['aura', 'Энергетическое поле', 'Свечение вокруг панели плеера и полноэкранного режима'],
    ['depth', 'Глубина интерфейса', 'Размытие дашборда, подъём карточек, перспектива сеток'],
    ['bg', 'Реактивный фон', 'Зерно, хроматический сдвиг в пиках, морфинг живого фона'],
    ['states', 'Пауза, старт и финал', 'Виньетка на паузе, вспышка на старте, «сгорание» в конце'],
    ['cursor', 'Курсор и обложка', 'Орбитальные частицы и перетаскивание большой обложки'],
    ['extras', 'Мини-эффекты', 'Частицы у избранного, контур загрузки, анимация счётчиков'],
    ['boot', 'Стартовая заставка', 'Анимация сборки света на экране запуска'],
    ['synth', 'Ритм без анализатора', 'Если звук не анализируется — двигать интерфейс по синтетическому ритму'],
    ['debug', 'Диагностика реактивности', 'Панель с FPS, уровнем баса и состоянием аудио-графа'],
    ['beatSensitivity', 'Чувствительность к биту', 'Насколько сильно все beat-реакции отвечают на удары; диапазон расширен для тонкой настройки.'],
  ];

  const DEFAULTS = {};
  GROUPS.forEach(([k]) => { DEFAULTS[k] = k === 'beatSensitivity' ? 2.2 : k !== 'debug'; });

  let config;
  try { config = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('umbrella_living') || '{}')); }
  catch (e) { config = Object.assign({}, DEFAULTS); }
  // Removed effects stay disabled even if an older localStorage config enabled them.
  delete config.text;
  delete config.micro;
  delete config.trail;
  const saveConfig = () => safe(() => localStorage.setItem('umbrella_living', JSON.stringify(config)));
  saveConfig();

  function applyConfig() {
    root.classList.add('lv-on');
    GROUPS.forEach(([k]) => { if (k !== 'beatSensitivity') root.classList.toggle('lv-' + k, !!config[k]); });
    if (grain) grain.style.display = config.bg ? '' : 'none';
    if (aberration) aberration.style.display = config.bg ? '' : 'none';
    if (vignette) vignette.style.display = config.states ? '' : 'none';
    if (flash) flash.style.display = config.states ? '' : 'none';
    if (auraBar) auraBar.style.display = config.aura ? '' : 'none';
    const auraNp = qs('#lvAuraNp');
    if (auraNp) auraNp.style.display = config.aura ? '' : 'none';
    // Listening trail and progress tail were removed.
    if (!config.cover) { const w = qs('#npArtWrap'); if (w) w.style.transform = ''; }
    if (!config.depth) qsa('.lv-depth-grid > *').forEach((c) => c.style.removeProperty('--lv-far'));
    toggleDebug(!!config.debug);
    syncSettingsUI();
  }

  /* ============================================================
     Опоры на app2.js
     ============================================================ */

  function lowFx() { return !!safe(() => settings && settings.lowFx); }
  function getAnalyser() { return safe(() => (typeof analyser !== 'undefined' && analyser) ? analyser : null) || null; }
  function getCtx() { return safe(() => (typeof audioCtx !== 'undefined' && audioCtx) ? audioCtx : null) || null; }
  function activeAudio() { return safe(() => typeof djActiveElement === 'function' ? djActiveElement() : null) || qs('audio'); }
  function isPlaying() { const el = activeAudio(); return !!(el && !el.paused && !el.ended); }

  /** Поднимаем аудио-граф сами: настройка «Визуализация» на нас не влияет. */
  function ensureAudioGraph() {
    safe(() => { if (typeof ensureAnalyser === 'function') ensureAnalyser(); });
    const c = getCtx();
    if (c && c.state === 'suspended') safe(() => c.resume());
  }

  let hueCache = 262;
  function refreshHue() {
    const v = parseFloat(getComputedStyle(root).getPropertyValue('--dyn-h'));
    if (isFinite(v)) hueCache = v;
  }
  const hue = () => hueCache;

  /* ============================================================
     Слои
     ============================================================ */

  const fx = document.createElement('canvas');
  fx.id = 'lvFx';
  fx.setAttribute('aria-hidden', 'true');

  const mkLayer = (id) => {
    const d = document.createElement('div');
    d.id = id; d.className = 'lv-layer';
    d.setAttribute('aria-hidden', 'true');
    return d;
  };
  const grain = mkLayer('lvGrain');
  const aberration = mkLayer('lvAberration');
  const vignette = mkLayer('lvVignette');
  const flash = mkLayer('lvFlash');

  const auraBar = document.createElement('div');
  auraBar.id = 'lvAuraBar';
  auraBar.setAttribute('aria-hidden', 'true');

  const trail = document.createElement('div');
  trail.id = 'lvTrail';
  trail.setAttribute('aria-hidden', 'true');

  let ctx = null, varTargets = [];

  function mountLayers() {
    const body = document.body;
    [grain, aberration, vignette, flash, auraBar, fx].forEach((el) => body.appendChild(el));
    ctx = fx.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas, { passive: true });

    const wrap = qs('#npArtWrap');
    if (wrap && wrap.parentElement && !qs('#lvAuraNp')) {
      const a = document.createElement('div');
      a.id = 'lvAuraNp';
      a.setAttribute('aria-hidden', 'true');
      wrap.parentElement.insertBefore(a, wrap);
    }
    // Переменные пишем в несколько контейнеров, а не в :root —
    // иначе каждый кадр пересчитывается стиль всего документа.
    varTargets = ['#playerBar', '#nowPlaying', '#sidebar', '#lyricsBody']
      .map((s) => qs(s)).filter(Boolean).concat([auraBar]);
  }

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    fx.width = Math.floor(innerWidth * dpr);
    fx.height = Math.floor(innerHeight * dpr);
    fx.style.width = innerWidth + 'px';
    fx.style.height = innerHeight + 'px';
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const varCache = new Map();
  function setVar(name, value) {
    if (varCache.get(name) === value) return;
    varCache.set(name, value);
    for (const el of varTargets) el.style.setProperty(name, value);
  }

  /* ============================================================
     Анализ звука (+ синтетический ритм, если анализатор молчит)
     ============================================================ */

  const A = { bass: 0, mid: 0, hi: 0, rms: 0, energy: 0, beat: 0 };
  const diag = { analyser: false, ctx: '—', source: 'нет', silentMs: 0, synth: false, sum: 0 };

  let freqData = null;
  const bassHistory = [];
  let lastBeat = 0;
  let lastGraphTry = 0;

  /* Автоматическая нормализация (AGC). Без нее фиксированный множитель
     упирался в потолок почти на любом треке: bass почти сразу становился
     1.00 и оставался там — детектор бита сравнивает текущий удар со
     средним (bass > avg*1.3), а если и текущее, и среднее упираются в
     единицу, повышенных ударов просто не существует. Обложка, рамка и
     волны из мини-обложки все завязаны на бит — поэтому не двигались.
     Каждая полоса следит за своим недавним пиком: пик захватывается
     мгновенно, потом медленно "остывает" (~5–8 c), а текущее значение
     выражается как доля от него. Так и тихие, и громкие треки дают
     полный диапазон 0..1 с реальными перепадами. */
  const agc = { bass: 0.10, mid: 0.10, hi: 0.10, rms: 0.10 };
  function agcNorm(raw, key, floor) {
    const cur = agc[key];
    if (raw > cur) agc[key] = lerp(cur, raw, 0.12);
    else agc[key] = Math.max(floor, lerp(cur, raw, 0.006));
    return clamp(raw / Math.max(agc[key], 0.02), 0, 1);
  }

  function analyse(now) {
    const playing = isPlaying();
    let an = getAnalyser();

    if (playing && (!an || diag.synth) && now - lastGraphTry > 1500) {
      lastGraphTry = now;
      ensureAudioGraph();
      an = getAnalyser();
    }
    const c = getCtx();
    diag.analyser = !!an;
    diag.ctx = c ? c.state : '—';

    if (!playing) {
      decay();
      diag.source = 'пауза';
      diag.silentMs = 0;
      diag.synth = false;
      return;
    }

    let sum = 0;
    if (an) {
      if (!freqData || freqData.length !== an.frequencyBinCount) freqData = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(freqData);
      for (let i = 0; i < freqData.length; i++) sum += freqData[i];
      diag.sum = sum;
    }

    if (an && sum > 0) {
      diag.silentMs = 0;
      diag.synth = false;
      diag.source = 'анализатор';
      feedFromSpectrum(now, sum);
      return;
    }

    // Анализатор есть, но отдаёт нули (или его нет вовсе)
    diag.silentMs += 16;
    diag.source = an ? 'анализатор молчит' : 'нет анализатора';
    if (config.synth && diag.silentMs > 1200) {
      diag.synth = true;
      feedSynth(now);
    } else {
      decay();
    }
  }

  function decay() {
    A.bass = lerp(A.bass, 0, 0.06); A.mid = lerp(A.mid, 0, 0.06);
    A.hi = lerp(A.hi, 0, 0.06); A.rms = lerp(A.rms, 0, 0.06);
    A.energy = lerp(A.energy, 0, 0.02); A.beat *= 0.9;
    // На паузе/смене трека отпускаем потолки AGC быстрее, чтобы следующий
    // трек не наследовал громкость предыдущего.
    agc.bass = Math.max(0.05, agc.bass * 0.985);
    agc.mid = Math.max(0.05, agc.mid * 0.985);
    agc.hi = Math.max(0.04, agc.hi * 0.985);
    agc.rms = Math.max(0.05, agc.rms * 0.985);
  }

  function feedFromSpectrum(now, sum) {
    let b = 0, m = 0, h = 0;
    for (let i = 0; i < 6; i++) b += freqData[i];
    for (let i = 6; i < 22; i++) m += freqData[i];
    for (let i = 22; i < 56; i++) h += freqData[i];

    const bassRaw = b / 6 / 255, midRaw = m / 16 / 255, hiRaw = h / 34 / 255, rmsRaw = sum / freqData.length / 255;
    const bass = agcNorm(bassRaw, 'bass', 0.05);
    A.bass = lerp(A.bass, bass, 0.35);
    A.mid = lerp(A.mid, agcNorm(midRaw, 'mid', 0.05), 0.3);
    A.hi = lerp(A.hi, agcNorm(hiRaw, 'hi', 0.04), 0.3);
    A.rms = lerp(A.rms, agcNorm(rmsRaw, 'rms', 0.05), 0.12);
    A.energy = lerp(A.energy, clamp(A.rms * 0.6 + A.mid * 0.25 + A.hi * 0.3, 0, 1), 0.01);
    detectBeat(now, bass);
  }

  /** Псевдо-ритм ~112 BPM с лёгкой «дышащей» модуляцией. */
  function feedSynth(now) {
    const period = 60000 / 112;
    const phase = (now % period) / period;
    const env = Math.pow(1 - phase, 2.6);
    const swell = 0.5 + Math.sin(now / 5200) * 0.18;
    const bass = clamp(env * swell + 0.06, 0, 1);
    A.bass = lerp(A.bass, bass, 0.3);
    A.mid = lerp(A.mid, clamp(0.28 + Math.sin(now / 900) * 0.12, 0, 1), 0.08);
    A.hi = lerp(A.hi, clamp(0.2 + Math.sin(now / 640) * 0.1, 0, 1), 0.08);
    A.rms = lerp(A.rms, 0.34 + Math.sin(now / 3100) * 0.08, 0.05);
    A.energy = lerp(A.energy, 0.42, 0.01);
    detectBeat(now, bass);
  }

  const beatListeners = [];
  let prevBass = 0;
  function detectBeat(now, bass) {
    bassHistory.push(bass);
    if (bassHistory.length > 48) bassHistory.shift();
    const avg = bassHistory.reduce((s, v) => s + v, 0) / bassHistory.length;
    const delta = bass - prevBass;
    prevBass = bass;
    A.beat *= 0.86;
    if ((bass > avg * 1.15 && bass > 0.15 && delta > 0.04) || (bass > 0.92 && delta > 0.02)) {
      if (now - lastBeat > 130) {
        lastBeat = now;
        const sensitivity = clamp(Number(config.beatSensitivity) || 2.2, 0.1, 8);
        A.beat = clamp(Math.max(bass * sensitivity, delta * sensitivity * 3), 0.3, 4);
        for (const fn of beatListeners) safe(() => fn(clamp(A.beat, 0, 4)));
      }
    }
  }

  /* ============================================================
     Канвас
     ============================================================ */

  const particles = [], ripples = [], orbits = [];

  function maxParticles() {
    if (quality === 2) return 0;
    if (quality === 1) return 90;
    return lowFx() ? 120 : 340;
  }

  function spawnParticle(p) {
    const cap = maxParticles();
    if (!cap) return;
    if (particles.length >= cap) particles.shift();
    particles.push(Object.assign({
      x: 0, y: 0, vx: 0, vy: 0, life: 1, decay: 0.012,
      size: 2, hue: hue(), alpha: 0.9, gravity: 0, drag: 0.985, target: null,
    }, p));
  }

  function ripple(x, y, opts = {}) {
    if (!ctx || quality >= 2 || ripples.length > 20) return;
    ripples.push({
      x, y, r: opts.r0 || 6, vr: opts.vr || 5.2, life: 1,
      decay: opts.decay || 0.016, width: opts.width || 2,
      hue: opts.hue != null ? opts.hue : hue(),
      alpha: opts.alpha != null ? opts.alpha : 0.5,
    });
  }

  function burst(x, y, count = 40, opts = {}) {
    const h = opts.hue != null ? opts.hue : hue();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const sp = (opts.speed || 2.6) * (0.4 + Math.random());
      spawnParticle({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        size: (opts.size || 2.2) * (0.5 + Math.random()),
        hue: h + (Math.random() * 40 - 20),
        decay: opts.decay || 0.014, gravity: opts.gravity || 0, alpha: 0.95,
      });
    }
  }

  function implode(x, y, count = 40, radius = 220, opts = {}) {
    const h = opts.hue != null ? opts.hue : hue();
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = radius * (0.5 + Math.random() * 0.8);
      spawnParticle({
        x: x + Math.cos(a) * r, y: y + Math.sin(a) * r,
        size: 1.6 + Math.random() * 2, hue: h + (Math.random() * 40 - 20),
        decay: 0.011, alpha: 0.9, drag: 1,
        target: { x, y, k: 0.045 + Math.random() * 0.035 },
      });
    }
  }

  function centerOf(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }
  const npOpen = () => { const np = qs('#nowPlaying'); return !!(np && !np.hidden); };
  const coverCenter = () => npOpen() ? centerOf(qs('#npArtWrap')) : centerOf(qs('#playerCover'));

  function drawFx() {
    if (!ctx) return;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (quality >= 2) return;
    const slow = paused ? 0.45 : 1;

    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.r += r.vr * slow; r.vr *= 0.985; r.life -= r.decay * slow;
      if (r.life <= 0) { ripples.splice(i, 1); continue; }
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${hueCache}, 92%, 72%, ${r.life * r.alpha * 0.55})`;
      ctx.lineWidth = r.width * r.life;
      ctx.stroke();
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      if (p.target) {
        p.vx += (p.target.x - p.x) * p.target.k;
        p.vy += (p.target.y - p.y) * p.target.k;
        p.vx *= 0.86; p.vy *= 0.86;
      }
      p.vy += p.gravity;
      p.x += p.vx * slow; p.y += p.vy * slow;
      p.vx *= p.drag; p.vy *= p.drag;
      p.life -= p.decay * slow;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.2, p.size * p.life), 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue}, 92%, 70%, ${p.alpha * p.life})`;
      ctx.fill();
    }

    if (quality === 0 && config.cursor) {
      for (let i = orbits.length - 1; i >= 0; i--) {
        const o = orbits[i];
        const c = centerOf(o.el);
        o.alpha = lerp(o.alpha, o.on ? 1 : 0, 0.08);
        if (!c || o.alpha < 0.02) { if (!o.on) orbits.splice(i, 1); continue; }
        const sens = clamp(Number(config.beatSensitivity) || 2.2, 0.1, 8);
        const reactiveBass = clamp(A.bass * sens, 0, 3);
        o.a += o.speed * slow * (1 + reactiveBass * 0.8);
        const rad = (Math.max(c.w, c.h) / 2) * o.r + reactiveBass * 10;
        ctx.beginPath();
        ctx.arc(c.x + Math.cos(o.a) * rad, c.y + Math.sin(o.a) * rad * 0.62, o.size, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hueCache + o.dh}, 95%, 76%, ${0.55 * o.alpha})`;
        ctx.fill();
      }
    }

  }

  /* ============================================================
     Обложка
     ============================================================ */

  const tilt = { tx: 0, ty: 0, x: 0, y: 0 };
  const drag = { active: false, ox: 0, oy: 0, x: 0, y: 0, vx: 0, vy: 0, sx: 0, sy: 0 };

  function initCover() {
    const wrap = qs('#npArtWrap');
    if (!wrap) return;
    wrap.classList.add('lv-grab');
    const stage = wrap.closest('.np-stage') || wrap.parentElement || document;

    stage.addEventListener('pointermove', (e) => {
      if (!config.cover) return;
      const r = wrap.getBoundingClientRect();
      if (!r.width) return;
      tilt.tx = clamp(-((e.clientY - (r.top + r.height / 2)) / (r.height / 2)), -1, 1) * 4.5;
      tilt.ty = clamp((e.clientX - (r.left + r.width / 2)) / (r.width / 2), -1, 1) * 4.5;
    }, { passive: true });
    stage.addEventListener('pointerleave', () => { tilt.tx = 0; tilt.ty = 0; }, { passive: true });

    const hookOrbits = (el, n) => {
      if (!el) return;
      el.addEventListener('pointerenter', () => { if (config.cursor) startOrbits(el, n); });
      el.addEventListener('pointerleave', () => stopOrbits(el));
    };
    hookOrbits(wrap, 10);
    hookOrbits(qs('#playerCover'), 6);

    wrap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !config.cursor) return;
      drag.active = true; drag.ox = e.clientX; drag.oy = e.clientY;
      wrap.classList.add('lv-grabbing');
      safe(() => wrap.setPointerCapture(e.pointerId));
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!drag.active) return;
      drag.x = clamp((e.clientX - drag.ox) * 0.35, -70, 70);
      drag.y = clamp((e.clientY - drag.oy) * 0.35, -70, 70);
    });
    const release = () => { if (drag.active) { drag.active = false; wrap.classList.remove('lv-grabbing'); } };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => wrap.addEventListener(ev, release));

  }

  const rmsHistory = [];
  let lastRmsBeat = 0;
  function tickPbCoverRipples(now) {
    if (!config.cover || lowFx() || quality > 0 || npOpen()) return;
    rmsHistory.push(A.rms);
    if (rmsHistory.length > 48) rmsHistory.shift();
    const avg = rmsHistory.reduce((s, v) => s + v, 0) / rmsHistory.length;
    if (A.rms > avg * 1.15 && A.rms > 0.08 && now - lastRmsBeat > 200) {
      lastRmsBeat = now;
      const c = centerOf(qs('#playerCover'));
      if (!c) return;
      const sc = Math.pow(clamp(A.rms * 1.5, 0.1, 1), 0.6);
      ripple(c.x, c.y, { vr: 3 + sc * 9, decay: 0.010 + (1 - sc) * 0.014, width: 0.8 + sc * 2.8, alpha: 0.18 + sc * 0.45 });
    }
  }

  function startOrbits(el, n = 10) {
    if (quality > 0) return;
    if (orbits.some((o) => o.el === el)) { orbits.forEach((o) => { if (o.el === el) o.on = true; }); return; }
    const count = lowFx() ? Math.min(4, n) : n;
    for (let i = 0; i < count; i++) {
      orbits.push({
        el, on: true, alpha: 0, a: (i / count) * Math.PI * 2,
        r: 0.62 + Math.random() * 0.5, speed: 0.012 + Math.random() * 0.02,
        size: 1.2 + Math.random() * 2, dh: Math.random() * 50 - 25,
      });
    }
  }
  const stopOrbits = (el) => orbits.forEach((o) => { if (o.el === el) o.on = false; });

  function updateCoverTransform() {
    const wrap = qs('#npArtWrap');
    if (!wrap) return;
    if (!npOpen()) {
      if (wrap.style.transform) {
        wrap.style.transform = '';
        tilt.x = tilt.y = tilt.tx = tilt.ty = 0;
        drag.sx = drag.sy = drag.vx = drag.vy = drag.x = drag.y = 0;
      }
      return;
    }
    const np = qs('#nowPlaying');
    if (np.classList.contains('gsap-active')) return;
    if (safe(() => window.gsap && gsap.isTweening(wrap))) return;

    tilt.x = lerp(tilt.x, drag.active ? 0 : tilt.tx, 0.08);
    tilt.y = lerp(tilt.y, drag.active ? 0 : tilt.ty, 0.08);
    drag.vx += ((drag.active ? drag.x : 0) - drag.sx) * 0.14;
    drag.vy += ((drag.active ? drag.y : 0) - drag.sy) * 0.14;
    drag.vx *= 0.76; drag.vy *= 0.76;
    drag.sx += drag.vx; drag.sy += drag.vy;

    const sens = clamp(Number(config.beatSensitivity) || 2.2, 0.1, 8);
    const reactiveBass = clamp(A.bass * sens, 0, 3);
    const breathe = 1 + Math.sin(performance.now() / 1000 * 0.55) * 0.012 + reactiveBass * 0.05;
    wrap.style.transform =
      `translate3d(${drag.sx.toFixed(2)}px, ${drag.sy.toFixed(2)}px, 0) ` +
      `rotateX(${tilt.x.toFixed(2)}deg) rotateY(${tilt.y.toFixed(2)}deg) scale(${breathe.toFixed(4)})`;
  }

  /* Живой текст удалён: заголовки и строки текста остаются статичными. */

  /* ============================================================
     Прогресс и глубина
     ============================================================ */

  function initDepth() {
    const np = qs('#nowPlaying');
    if (np) {
      const sync = () => root.classList.toggle('lv-np', !np.hidden);
      new MutationObserver(sync).observe(np, { attributes: true, attributeFilter: ['hidden'] });
      sync();
    }
    const mark = () => ['.hero-grid', '.playlist-grid', '.artist-row']
      .forEach((sel) => qsa(sel).forEach((g) => g.classList.add('lv-depth-grid')));
    mark();
    const content = qs('#content');
    if (content) new MutationObserver(mark).observe(content, { childList: true, subtree: true });
  }

  let depthTick = 0;
  function updateDepth() {
    if (lowFx() || quality > 0) return;
    if (depthTick++ % 12) return;
    const mid = innerHeight * 0.42;
    qsa('.lv-depth-grid > *').forEach((card) => {
      const r = card.getBoundingClientRect();
      if (r.bottom < -200 || r.top > innerHeight + 200) return;
      card.style.setProperty('--lv-far', clamp(((r.top + r.height / 2) - mid) / (innerHeight * 0.9), 0, 1).toFixed(2));
    });
  }

  /* ============================================================
     Фон
     ============================================================ */

  let lastGrain = -1, lastAb = -1;
  function updateBackground() {
    const g = +(0.10 - A.rms * 0.06).toFixed(3);
    if (Math.abs(g - lastGrain) > 0.004) { lastGrain = g; grain.style.opacity = String(g); }
    const ab = quality > 0 ? 0 : +clamp((A.beat - 0.6) * 0.45, 0, 0.26).toFixed(3);
    if (Math.abs(ab - lastAb) > 0.006) { lastAb = ab; aberration.style.opacity = String(ab); }
    safe(() => {
      if (window.__silk && typeof window.__silk.set === 'function') {
        window.__silk.set({ speed: 0.7 + A.energy * 1.2, intensity: 0.85 + A.energy * 0.55, grain: A.energy * 0.12 });
      }
    });
  }

  /* ============================================================
     Состояния и смена трека
     ============================================================ */

  let paused = true;
  function setPaused(v) {
    if (paused === v) return;
    paused = v;
    root.classList.toggle('lv-paused', v && config.states);
  }

  function flashStart() {
    if (!config.states || reduceMotion.matches) return;
    flash.classList.remove('on');
    void flash.offsetWidth;
    flash.classList.add('on');
    setTimeout(() => flash.classList.remove('on'), 950);
  }

  function trackEndCeremony() {
    if (!config.states) return;
    const wrap = qs('#npArtWrap');
    if (wrap) { wrap.classList.add('lv-fadeout'); setTimeout(() => wrap.classList.remove('lv-fadeout'), 1300); }
    const pr = qs('#pbProgress');
    if (pr) { pr.classList.add('lv-burn'); setTimeout(() => pr.classList.remove('lv-burn'), 1300); }
    const c = coverCenter();
    if (c && !lowFx()) {
      for (let i = 0; i < 40; i++) {
        spawnParticle({
          x: c.x + (Math.random() - 0.5) * c.w, y: c.y + (Math.random() - 0.5) * c.h,
          vx: (Math.random() - 0.5) * 0.8, vy: -(0.6 + Math.random() * 1.8),
          size: 1 + Math.random() * 2.4, decay: 0.008, gravity: -0.006, alpha: 0.85,
        });
      }
    }
  }

  let lastTrackKey = '';
  function onTrackChange() {
    // Track changes stay clean: no cover scattering/dissolve,
    // no live-text animation, no progress tail and no listening trail.
    flashStart();
  }

  function trackKey() {
    const t = qs('#playerTitle'), a = qs('#playerArtist');
    return ((t && (t.dataset.lvPlain || t.textContent)) || '') + '|' + ((a && a.textContent) || '');
  }

  function initTrackWatch() {
    const bar = qs('#playerBar');
    if (!bar) return;
    lastTrackKey = trackKey();
    new MutationObserver(() => {
      const k = trackKey();
      if (k === lastTrackKey || !k.replace('|', '')) return;
      lastTrackKey = k;
      safe(onTrackChange);
    }).observe(bar, { subtree: true, childList: true, characterData: true });
  }

  /* ============================================================
     Простой пользователя
     ============================================================ */

  let lastInteraction = performance.now();
  let idleVal = 0;
  function initInteraction() {
    ['pointermove', 'keydown', 'pointerdown', 'wheel'].forEach((ev) =>
      document.addEventListener(ev, () => { lastInteraction = performance.now(); }, { passive: true }));
  }
  function updateIdle() {
    const idle = isPlaying() && (performance.now() - lastInteraction > 20000) ? 1 : 0;
    idleVal = lerp(idleVal, idle, 0.05);
    setVar('--lv-idle', idleVal.toFixed(2));
  }

  /* ============================================================
     Мини-эффекты
     ============================================================ */

  function initExtras() {
    document.addEventListener('click', (e) => {
      if (!config.extras) return;
      const fav = e.target.closest && e.target.closest('#pbFav, .track-fav');
      if (!fav) return;
      setTimeout(() => {
        if (!fav.classList.contains('active')) return;
        fav.classList.remove('lv-pop');
        void fav.offsetWidth;
        fav.classList.add('lv-pop');
        setTimeout(() => fav.classList.remove('lv-pop'), 500);
        const c = centerOf(fav);
        if (c && !lowFx()) burst(c.x, c.y, 24, { speed: 2.2, decay: 0.028, size: 2, gravity: 0.04, hue: 350 });
      }, 30);
    }, true);

    document.addEventListener('click', (e) => {
      if (!config.extras) return;
      const dl = e.target.closest && e.target.closest('.track-dl');
      if (!dl) return;
      const card = dl.closest('.track-row');
      if (card) contour(card, null);
    }, true);

    ['#statTracks', '#statArtists', '#statDuration', '#statFavorites',
      '#lstatPlays', '#lstatTime', '#lstatArtists', '#lstatTracks'].forEach(watchOdometer);
  }

  function contour(card, pct) {
    if (!card) return;
    let svg = card.querySelector(':scope > .lv-contour');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'lv-contour');
      svg.setAttribute('preserveAspectRatio', 'none');
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', '1'); rect.setAttribute('y', '1'); rect.setAttribute('rx', '10');
      svg.appendChild(rect);
      card.appendChild(svg);
    }
    const r = card.getBoundingClientRect();
    const rect = svg.firstChild;
    svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    rect.setAttribute('width', Math.max(1, r.width - 2));
    rect.setAttribute('height', Math.max(1, r.height - 2));
    const len = (r.width + r.height) * 2;
    if (pct == null) {
      rect.style.strokeDasharray = `${len * 0.22} ${len}`;
      safe(() => rect.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 1400, iterations: Infinity }));
      const stop = setInterval(() => {
        if (!card.isConnected || !card.querySelector('.track-dl')) { clearInterval(stop); svg.remove(); }
      }, 700);
      setTimeout(() => { clearInterval(stop); svg.remove(); }, 120000);
    } else {
      rect.style.strokeDasharray = `${len} ${len}`;
      rect.style.strokeDashoffset = String(len * (1 - clamp(pct, 0, 1)));
      if (pct >= 1) setTimeout(() => svg.remove(), 600);
    }
  }

  const odoBusy = new WeakSet();
  function watchOdometer(sel) {
    const el = qs(sel);
    if (!el) return;
    let prev = el.textContent;
    new MutationObserver(() => {
      if (odoBusy.has(el) || !config.extras) { prev = el.textContent; return; }
      const txt = el.textContent;
      if (txt === prev) return;
      prev = txt;
      if (reduceMotion.matches) return;
      odoBusy.add(el);
      const wrapEl = document.createElement('span');
      wrapEl.className = 'lv-odo';
      [...txt].forEach((ch, i) => {
        const s = document.createElement('i');
        s.textContent = ch;
        s.style.animationDelay = (i * 45) + 'ms';
        wrapEl.appendChild(s);
      });
      el.textContent = '';
      el.appendChild(wrapEl);
      requestAnimationFrame(() => odoBusy.delete(el));
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }

  /* ============================================================
     Аудио-события
     ============================================================ */

  function initAudioEvents() {
    const attach = (el) => {
      if (!el || el.__lvBound) return;
      el.__lvBound = true;
      el.addEventListener('play', () => { setPaused(false); ensureAudioGraph(); flashStart(); });
      el.addEventListener('playing', ensureAudioGraph);
      el.addEventListener('pause', () => setPaused(!isPlaying()));
      el.addEventListener('ended', () => { setPaused(true); safe(trackEndCeremony); });
    };
    safe(() => attach(typeof audio !== 'undefined' ? audio : null));
    safe(() => attach(typeof audioB !== 'undefined' ? audioB : null));
    qsa('audio').forEach(attach);
    ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, ensureAudioGraph, { passive: true }));
  }

  function initVinylWatch() {
    const vinyl = qs('#vinylOverlay');
    if (!vinyl) return;
    const sync = () => root.classList.toggle('lv-vinyl', !vinyl.hidden);
    new MutationObserver(sync).observe(vinyl, { attributes: true, attributeFilter: ['hidden'] });
    sync();
  }

  /* ============================================================
     Настройки: переключатели для каждой группы
     ============================================================ */

  function initSettingsUI() {
    const panel = qs('#settingsContent');
    if (!panel || qs('#lvSettingsGroup')) return;
    const group = document.createElement('div');
    group.className = 'settings-group';
    group.id = 'lvSettingsGroup';
    group.innerHTML =
      '<h3>Живой интерфейс</h3>' +
      '<p class="lv-settings-note">Реакция интерфейса на музыку. Каждый пункт включается отдельно и применяется сразу. ' +
      'При падении FPS слой сам себя ужимает — текущее состояние видно в диагностике.</p>' +
      GROUPS.map(([key, title, desc]) => key === 'beatSensitivity'
        ? `<div class="lv-sensitivity"><div class="setting-row"><div><b>${title}</b><p>${desc}</p></div><output id="lvBeatOut">${Number(config.beatSensitivity || 2.2).toFixed(1)}×</output></div><div class="lv-range-row"><label for="lvBeatSensitivity">Реакция</label><output id="lvBeatOut2">${Number(config.beatSensitivity || 2.2).toFixed(1)}×</output><input id="lvBeatSensitivity" type="range" min="0.1" max="8" step="0.1" value="${Number(config.beatSensitivity || 2.2)}" /></div></div>`
        : `<div class="setting-row">
           <div><b>${title}</b><p>${desc}</p></div>
           <button class="toggle" data-lv="${key}" type="button" role="switch" aria-label="${title}" aria-checked="false"></button>
         </div>`).join('');

    const groups = qsa('.settings-group', panel);
    const anchor = groups.length ? groups[groups.length - 1] : null;
    if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(group, anchor.nextSibling);
    else panel.appendChild(group);

    group.addEventListener('click', (e) => {
      const btn = e.target.closest('.toggle[data-lv]');
      if (!btn) return;
      const key = btn.dataset.lv;
      config[key] = !config[key];
      saveConfig();
      applyConfig();
      if (key === 'boot') safe(() => toast(config.boot ? 'Заставка включится при следующем запуске' : 'Заставка отключена', 'info', 2600));
    });
    const beatRange = group.querySelector('#lvBeatSensitivity');
    const beatOut = group.querySelector('#lvBeatOut2');
    if (beatRange) beatRange.addEventListener('input', () => {
      config.beatSensitivity = Number(beatRange.value);
      if (beatOut) beatOut.value = config.beatSensitivity.toFixed(1) + '×';
      if (group.querySelector('#lvBeatOut')) group.querySelector('#lvBeatOut').textContent = config.beatSensitivity.toFixed(1) + '×';
      saveConfig();
    });
    syncSettingsUI();
  }

  function syncSettingsUI() {
    qsa('#lvSettingsGroup .toggle[data-lv]').forEach((btn) => {
      const on = !!config[btn.dataset.lv];
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-checked', String(on));
    });
  }

  /* ============================================================
     Диагностика
     ============================================================ */

  let debugEl = null;
  function toggleDebug(on) {
    if (on && !debugEl) {
      debugEl = document.createElement('div');
      debugEl.id = 'lvDebug';
      debugEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(debugEl);
    } else if (!on && debugEl) {
      debugEl.remove();
      debugEl = null;
    }
  }

  let debugTick = 0;
  function updateDebug() {
    if (!debugEl || debugTick++ % 6) return;
    debugEl.innerHTML =
      `<b>Living UI ${LV_VERSION}</b>\n` +
      `fps ${Math.round(1000 / frameAvg)}   качество ${quality}\n` +
      `источник: ${diag.source}${diag.synth ? ' → синтетика' : ''}\n` +
      `analyser ${diag.analyser ? 'есть' : 'нет'}   ctx ${diag.ctx}   сумма ${diag.sum}\n` +
      `bass ${A.bass.toFixed(2)}  beat ${A.beat.toFixed(2)}  energy ${A.energy.toFixed(2)}\n` +
      `AGC-потолок баса: ${agc.bass.toFixed(2)}` +
      `<span class="lv-meter" style="width:${Math.round(A.bass * 180)}px"></span>`;
  }

  /* ============================================================
     Волны от мини-обложки
     ============================================================ */

  let pbWaveCtx = null, pbWaveW = 0, pbWaveH = 0;
  function resizePbWaves() {
    const c = qs('#pbCoverWaves');
    if (!c) return;
    const r = c.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    pbWaveW = Math.max(1, r.width); pbWaveH = Math.max(1, r.height);
    c.width = Math.floor(pbWaveW * dpr); c.height = Math.floor(pbWaveH * dpr);
    pbWaveCtx = c.getContext('2d'); pbWaveCtx.setTransform(dpr,0,0,dpr,0,0);
  }
  function drawPbWaves(now) {
    const c = qs('#pbCoverWaves');
    const bar = qs('#playerBar');
    if (!c || !bar || bar.hidden) return;
    if (!pbWaveCtx || Math.abs(pbWaveW - c.clientWidth) > 2 || Math.abs(pbWaveH - c.clientHeight) > 2) resizePbWaves();
    const x0 = Math.min(120, Math.max(64, (qs('#playerCover')?.getBoundingClientRect().right || 76) - bar.getBoundingClientRect().left + 8));
    const beat = clamp(A.beat * 0.34, 0, 2.2);
    const amp = 2.5 + A.bass * 5 + beat * 9;
    pbWaveCtx.clearRect(0,0,pbWaveW,pbWaveH);
    for (let lane=0; lane<3; lane++) {
      pbWaveCtx.beginPath();
      const base = pbWaveH * (0.28 + lane*0.22);
      for (let x=x0; x<pbWaveW+20; x+=4) {
        const travel=(x-x0)/Math.max(1,pbWaveW-x0);
        const y=base + Math.sin(x*0.025 - now*0.0045 - lane*0.9) * amp * (0.35 + travel*0.8);
        if(x===x0) pbWaveCtx.moveTo(x,y); else pbWaveCtx.lineTo(x,y);
      }
      pbWaveCtx.strokeStyle=`hsla(${hue()},88%,70%,${0.12 + A.bass*0.16 + beat*0.08})`;
      pbWaveCtx.lineWidth=1.1 + beat*0.35; pbWaveCtx.stroke();
    }
  }
  addEventListener('resize', resizePbWaves, {passive:true});

  /* ============================================================
     Цикл
     ============================================================ */

  const LV_VERSION = '1.2.0';
  let raf = 0, last = performance.now(), lastTick = performance.now();
  let frameAvg = 16, quality = 0, qualitySince = performance.now();

  function governor(now, dt) {
    frameAvg = frameAvg * 0.92 + dt * 0.08;
    if (frameAvg > 34 && quality < 2 && now - qualitySince > 2500) {
      quality++; qualitySince = now;
      if (quality >= 2) { particles.length = 0; ripples.length = 0; orbits.length = 0; }
    } else if (frameAvg < 19 && quality > 0 && now - qualitySince > 8000) {
      quality--; qualitySince = now;
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(64, now - last);
    last = now; lastTick = now;
    governor(now, dt);

    safe(refreshHue);
    safe(() => analyse(now));
    safe(() => setPaused(!isPlaying()));

    const sens = clamp(Number(config.beatSensitivity) || 2.2, 0.1, 8);
    const reactiveBass = clamp(A.bass * sens, 0, 3);
    setVar('--lv-bass', reactiveBass.toFixed(2));
    setVar('--lv-beat', clamp(A.beat, 0, 4).toFixed(2));
    setVar('--lv-energy', A.energy.toFixed(2));
    setVar('--lv-ring-in', reactiveBass.toFixed(2));
    setVar('--lv-ring-out', A.rms.toFixed(2));
    setVar('--lv-pbcover', config.cover ? (1 + reactiveBass * 0.06).toFixed(3) : '1');

    if (config.cover) safe(updateCoverTransform);
    if (config.aura) {
      const bar = qs('#playerBar');
      auraBar.style.opacity = bar && !bar.hidden ? '1' : '0';
    }
    if (config.depth) safe(updateDepth);
    if (config.bg) safe(updateBackground);
    safe(updateIdle);
    safe(drawFx);
    safe(updateDebug);
    safe(() => drawPbWaves(now));
    safe(() => tickPbCoverRipples(now));
  }

  function start() { if (!raf) { last = lastTick = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  setInterval(() => {
    if (document.hidden) return;
    if (performance.now() - lastTick > 2000) { raf = 0; start(); }   // сторож
  }, 2000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });

  /* ============================================================
     Старт
     ============================================================ */

  function init() {
    safe(mountLayers);
    safe(initCover);
    safe(initDepth);
    safe(initInteraction);
    safe(initExtras);
    safe(initTrackWatch);
    safe(initAudioEvents);
    safe(initVinylWatch);
    safe(initSettingsUI);
    safe(applyConfig);
    start();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.LivingUI = {
    config, audio: A, diag,
    set(key, value) { config[key] = !!value; saveConfig(); applyConfig(); },
    ripple, burst, implode, contour,
    onBeat(fn) { beatListeners.push(fn); },
    start, stop, ensureAudioGraph,
    get quality() { return quality; },
    get fps() { return Math.round(1000 / frameAvg); },
    version: LV_VERSION,
  };
})();


/* ============================================================
   Umbrella Player — стартовая заставка
   Встроена в экран запуска (#loginView): сперва свет собирается
   из пыли, потом проявляется обычный launch-экран с кнопкой.
   Включается/выключается в Настройках → Живой интерфейс.
   ============================================================ */

(() => {
  'use strict';
  if (window.__umbrellaBoot) return;
  window.__umbrellaBoot = true;

  let enabled = true;
  try {
    const saved = JSON.parse(localStorage.getItem('umbrella_living') || '{}');
    if (saved && saved.boot === false) enabled = false;
  } catch (e) {}
  if (!enabled) return;

  const reduce = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) || false;

  const run = () => {
    const view = document.getElementById('loginView');
    if (!view || view.hidden) return;              // плеер уже открыт — заставка не нужна
    if (view.querySelector('#bootCanvas')) return;

    const canvas = document.createElement('canvas');
    canvas.id = 'bootCanvas';
    canvas.setAttribute('aria-hidden', 'true');
    view.insertBefore(canvas, view.firstChild);

    const word = document.createElement('div');
    word.className = 'boot-word';
    word.setAttribute('aria-hidden', 'true');
    word.innerHTML = '<b>' + [...'UMBRELLA'].map((c, i) =>
      `<i style="animation-delay:${2600 + i * 55}ms">${c}</i>`).join('') + '</b><small>umbrella player</small>';
    view.appendChild(word);

    view.classList.add('boot-run');

    const ctx = canvas.getContext('2d');
    let W = 0, H = 0;
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = view.getBoundingClientRect();
      W = r.width; H = r.height;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    addEventListener('resize', resize, { passive: true });

    const COUNT = reduce ? 60 : Math.min(460, Math.round(W * 0.32) || 260);
    const parts = [];
    for (let i = 0; i < COUNT; i++) {
      const a = Math.random() * Math.PI * 2;
      parts.push({
        a,
        br: Math.pow(Math.random(), 0.6) * Math.max(W, H) * 0.62,
        size: 0.5 + Math.random() * 1.6,
        drift: (Math.random() - 0.5) * 0.0016,
        delay: Math.random() * 0.35,
        warm: Math.random() < 0.12,
      });
    }

    const T = reduce
      ? { dust: 150, pull: 350, flash: 450, title: 600, out: 1000 }
      : { dust: 900, pull: 2150, flash: 2380, title: 3550, out: 4300 };

    const start = performance.now();
    let raf = 0, done = false;
    const easeIn = (t) => t * t * t;
    const easeOut = (t) => 1 - Math.pow(1 - t, 3);

    chime();

    function loop(now) {
      raf = requestAnimationFrame(loop);
      const t = now - start;
      const cx = W / 2, cy = H / 2;
      ctx.clearRect(0, 0, W, H);
      // Transparent canvas: the launch surface remains the same screen throughout the animation.

      const appear = Math.min(1, t / T.dust);
      const pull = t < T.dust ? 0 : Math.min(1, (t - T.dust) / (T.pull - T.dust));

      for (const p of parts) {
        p.a += p.drift * (1 + pull * 22);
        const k = easeIn(Math.max(0, pull - p.delay) / (1 - p.delay || 1));
        const r = p.br * (1 - k * 0.995);
        const alpha = appear * (0.25 + k * 0.75);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(p.a) * r, cy + Math.sin(p.a) * r * 0.86, p.size * (1 + k * 0.7), 0, Math.PI * 2);
        ctx.fillStyle = p.warm ? `rgba(198,214,255,${alpha * 0.9})` : `rgba(255,255,255,${alpha * 0.75})`;
        ctx.fill();
      }

      if (pull > 0.15) {
        const core = easeIn((pull - 0.15) / 0.85);
        const rad = 4 + core * 90;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
        g.addColorStop(0, `rgba(255,255,255,${0.85 * core})`);
        g.addColorStop(0.35, `rgba(190,205,255,${0.35 * core})`);
        g.addColorStop(1, 'rgba(120,140,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);

        const lw = core * W * 0.62;
        const lg = ctx.createLinearGradient(cx - lw / 2, 0, cx + lw / 2, 0);
        lg.addColorStop(0, 'rgba(255,255,255,0)');
        lg.addColorStop(0.5, `rgba(255,255,255,${0.75 * core})`);
        lg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = lg;
        ctx.fillRect(cx - lw / 2, cy - 0.9, lw, 1.8);
      }

      if (t > T.pull) {
        if (t < T.flash) {
          ctx.fillStyle = `rgba(255,255,255,${0.9 * (1 - (t - T.pull) / (T.flash - T.pull))})`;
          ctx.fillRect(0, 0, W, H);
        }
        const ringT = Math.min(1, (t - T.pull) / 900);
        if (ringT < 1) {
          ctx.beginPath();
          ctx.arc(cx, cy, easeOut(ringT) * Math.max(W, H) * 0.7, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(200,215,255,${0.5 * (1 - ringT)})`;
          ctx.lineWidth = 2 * (1 - ringT) + 0.4;
          ctx.stroke();
        }
        const sT = Math.min(1, (t - T.pull) / 1400);
        if (sT < 1 && !reduce) {
          for (let i = 0; i < 26; i++) {
            const a = (i / 26) * Math.PI * 2 + i * 0.13;
            const r0 = easeOut(sT) * 260, r1 = r0 + 60 * (1 - sT);
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0 * 0.9);
            ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1 * 0.9);
            ctx.strokeStyle = `rgba(255,255,255,${0.35 * (1 - sT)})`;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }

      if (t > T.title) finish();
    }

    /** Заставка растворяется, обычный launch-экран проявляется поверх. */
    function finish() {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      word.classList.add('boot-gone');
      canvas.classList.add('boot-fade');
      view.classList.add('boot-lit');
      setTimeout(() => {
        canvas.remove();
        word.remove();
        view.classList.remove('boot-run', 'boot-lit');
      }, 1400);
      removeEventListener('resize', resize);
      document.removeEventListener('pointerdown', finish, true);
      document.removeEventListener('keydown', finish, true);
    }

    document.addEventListener('pointerdown', finish, true);
    document.addEventListener('keydown', finish, true);
    raf = requestAnimationFrame(loop);
    setTimeout(finish, T.out + 2000);   // страховка от залипания
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();

  /** Короткий нарастающий тон, если браузер разрешил звук без жеста. */
  function chime() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const c = new AC();
      if (c.state === 'suspended') { c.close(); return; }
      const now = c.currentTime;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.08, now + 1.8);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 3.4);
      g.connect(c.destination);
      [110, 220, 329.6, 440].forEach((f, i) => {
        const o = c.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(f * 0.995, now);
        o.frequency.linearRampToValueAtTime(f, now + 2.1);
        const og = c.createGain();
        og.gain.value = 1 / (i + 1.4);
        o.connect(og); og.connect(g);
        o.start(now); o.stop(now + 3.6);
      });
      setTimeout(() => safeClose(c), 4000);
    } catch (e) {}
    function safeClose(c) { try { c.close(); } catch (e) {} }
  }
})();
