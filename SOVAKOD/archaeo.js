/* Umbrella Player — Археология библиотеки (v1)
   Коллекция как карта раскопок: связи артистов, коллаборации,
   «пропущенные находки» и семейные деревья. */

const ARCHAEO_KEY = 'umbrella_archaeo';
const ARCHAEO_TTL = 7 * 86400000;

let archaeo = null;
let archaeoTracks = [];
const archaeoCfg = { scope: 30, digging: false, cancel: false };
let archaeoWired = false;

/* ============================================================
   Вспомогательные
   ============================================================ */

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function normArtist(name) {
  return String(name || '').trim().toLowerCase().replace(/[\u2018\u2019'`]/g, '').replace(/[^a-zа-яё0-9&×+\s]/gi, '').replace(/\s+/g, ' ').trim() || 'неизвестный исполнитель';
}

function initial(name) {
  const s = String(name || '').trim();
  return s ? s.charAt(0).toUpperCase() : '?';
}

function shortArtist(name) {
  const s = String(name || '').trim();
  return s.length > 16 ? s.slice(0, 15) + '…' : s;
}

function nodeDisplay(key) {
  if (archaeo) {
    const n = archaeo.nodes.all.find((nn) => nn.key === key);
    if (n) return n.artist;
  }
  return key.split(' ').map((w) => w ? w.charAt(0).toUpperCase() + w.slice(1) : w).join(' ');
}

function getActiveTab() {
  const t = document.querySelector('#archaeoTabs .archaeo-tab.active');
  return t ? t.dataset.tab : 'map';
}

function loadArchaeo() {
  try {
    const v = JSON.parse(localStorage.getItem(ARCHAEO_KEY));
    archaeo = v && v.builtAt ? v : null;
  } catch (e) { archaeo = null; }
}

function saveArchaeo() {
  try { localStorage.setItem(ARCHAEO_KEY, JSON.stringify(archaeo)); } catch (e) {}
}

function seedOf(t) {
  return `${(t.artist || '').trim()} — ${(t.title || '').trim()}`;
}

function nameKeyOf(t) {
  return `${(t.title || '').trim().toLowerCase()}|${(t.artist || '').trim().toLowerCase()}`;
}

async function loadArchaeoTracks() {
  let rows = [];
  try {
    rows = await idbGetAll();
  } catch (e) { rows = []; }
  const local = rows.map((r) => ({
    id: r.id, title: r.title, artist: r.artist, album: r.album,
    duration: r.duration, color: r.color, dbId: r.id,
    source: r.source || 'local', scUrl: null, scId: null, path: null, thumbnail: r.thumbnail || null,
  }));
  let sc = [];
  try {
    if (typeof refreshScDownloaded === 'function') await refreshScDownloaded();
    const lib = (typeof state !== 'undefined' && state.scLibTracks) || [];
    sc = lib.map((f) => ({
      id: 'sc:' + f.path, title: f.title, artist: f.artist, album: 'SoundCloud',
      duration: f.duration || 0, color: '', dbId: null,
      source: 'soundcloud', scUrl: null, scId: null, path: f.path, thumbnail: null,
    }));
  } catch (e) { sc = []; }
  return [...local, ...sc];
}

function tracksHash(tracks) {
  const keys = tracks.map((t) => nameKeyOf(t)).sort();
  const sel = keys.slice(0, 50).join('\u0001');
  let h = 2166136261;
  for (let i = 0; i < sel.length; i++) {
    h ^= sel.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function computePlays(tracks) {
  const map = new Array(tracks.length).fill(0);
  const idxByKey = new Map();
  tracks.forEach((t, i) => {
    const k = nameKeyOf(t);
    idxByKey.set(k, i);
  });
  listenLog.forEach((h) => {
    const k = `${(h.title || '').toLowerCase()}|${(h.artist || '').toLowerCase()}`;
    const i = idxByKey.get(k);
    if (i != null) map[i]++;
  });
  return map;
}

/* ============================================================
   Анализ
   ============================================================ */

async function digArchive() {
  const cfg = archaeoCfg;
  if (cfg.digging) return;
  if (!archaeoTracks.length) {
    toast('Библиотека пуста — сначала добавьте треки', 'error');
    return;
  }
  cfg.digging = true; cfg.cancel = false;
  const digBtn = $('#archaeoDigBtn');
  const label = $('#archaeoDigLabel');
  if (digBtn) digBtn.disabled = true;
  if (label) label.textContent = 'Копаем…';
  $('#archaeoProgress').hidden = false;
  const setStage = (name, pct) => {
    $('#archaeoStageName').textContent = name;
    $('#archaeoStagePct').textContent = `${Math.round(pct)}%`;
    $('#archaeoBarFill').style.width = `${pct}%`;
  };
  try {
    setStage('Читаем пласты коллекции…', 4);
    await sleep(60);
    const tracks = archaeoTracks;
    const plays = computePlays(tracks);
    const seeded = tracks
      .map((t, i) => ({ t, i, p: plays[i] }))
      .filter((x) => (x.t.title || '').trim())
      .sort((a, b) => b.p - a.p);
    const seeds = seeded.slice(0, cfg.scope);
    if (!seeds.length) {
      throw new Error('В коллекции нет треков для раскопок — добавьте музыку и копайте.');
    }
    setStage(`Снимаем отпечатки (${seeds.length} треков)…`, 22);
    const fp = await fetchFingerprints(seeds.map((s) => seedOf(s.t)));
    if (cfg.cancel) { cancelDig(); return; }
    setStage('Просеиваем связи…', 60);
    await sleep(30);
    const { edges, collabs } = buildEdges(tracks, plays, seeds, fp);
    const bridges = buildBridges(tracks, plays, seeds, fp);
    const nodes = buildNodes(tracks, plays, edges, bridges, seeds);
    layoutNodes(nodes.drawn, tracks.length * 1000003);
    const clusters = buildClusters(nodes.all, edges);
    setStage('Фиксируем находки…', 85);
    await sleep(40);
    const diary = [
      `Слой снят: ${tracks.length} ${plural(tracks.length)} в коллекции, ${plays.filter((p) => p > 0).length} уже играли.`,
      `Отпечатки сняты с ${seeds.length} любимых треков.`,
      edges.length ? `Обнаружено связей: ${edges.length} (коллабораций — ${collabs.length}).` : 'Явных связей между артистами не найдено.',
      bridges.length ? `Найдено пропущенных сокровищ: ${bridges.length}.` : 'Пропущенных сокровищ не обнаружено.',
      clusters.length ? `Выделено семейных деревьев: ${clusters.length}.` : 'Семейных деревьев не выделено.',
      'Слой зафиксирован. Копайте ещё, когда захотите.',
    ];
    archaeo = {
      builtAt: Date.now(), scope: cfg.scope, hash: tracksHash(tracks), trackCount: tracks.length,
      nodes, edges, collabs, bridges, clusters, diary,
      plays: plays.slice(),
    };
    saveArchaeo();
    setStage('Готово', 100);
    $('#archaeoEmpty').hidden = true;
    $('#archaeoBody').hidden = false;
    toast('Раскопки завершены', 'success', 2600);
    const status = $('#archaeoStatus');
    if (status) status.textContent = `Копано только что · ${tracks.length} треков · ${edges.length} связей · ${bridges.length} находок`;
    renderArchaeoBody();
  } catch (e) {
    if (cfg.cancel) { cancelDig(); return; }
    toast(e.message || 'Ошибка раскопок', 'error');
    if (archaeo && archaeo.nodes.length) $('#archaeoBody').hidden = false;
  } finally {
    cfg.digging = false;
    if (digBtn) digBtn.disabled = false;
    if (label) label.textContent = 'Копать';
    $('#archaeoProgress').hidden = true;
  }
}

function cancelDig() {
  toast('Раскопки отменены', 'info', 2200);
}

async function fetchFingerprints(seeds) {
  if (!seeds.length) return new Map();
  const qs = seeds.map((s) => `s=${encodeURIComponent(s)}`).join('&');
  const res = await request(`/archaeo/related?${qs}&limit=10`, { timeout: 180000 });
  const map = new Map();
  Object.entries(res.map || {}).forEach(([id, arr]) => map.set(id, new Set((arr || []).map((r) => r.key).filter(Boolean))));
  return map;
}

function parseCollab(track) {
  const title = track.title || '';
  const artist = track.artist || '';
  const re = /(?:feat\.?|ft\.?|featuring|при участии)/i;
  const m = title.match(re);
  if (m) {
    const parts = title.split(re).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const primary = artist || parts[0];
      const feats = parts[1].split(/[()\[\]–—-]/)[0].trim();
      if (feats) return [normArtist(primary), normArtist(feats)];
    }
  }
  if (/&/.test(artist) && !/^&$/.test(artist)) {
    const parts = artist.split(/\s*&\s*/).filter(Boolean);
    if (parts.length >= 2) return parts.map(normArtist);
  }
  if (/[×✕]/.test(artist)) {
    const parts = artist.split(/\s*[×✕]\s*/).filter(Boolean);
    if (parts.length >= 2) return parts.map(normArtist);
  }
  return [];
}

function buildEdges(tracks, plays, seeds, fp) {
  const edges = [];
  const seen = new Set();
  const addEdge = (aKey, bKey, kind, w, shared) => {
    if (!aKey || !bKey || aKey === bKey) return;
    const key = aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ a: aKey, b: bKey, kind, w, shared });
  };
  for (let i = 0; i < seeds.length; i++) {
    for (let j = i + 1; j < seeds.length; j++) {
      const A = seeds[i].t, B = seeds[j].t;
      const rA = fp.get(seedOf(A)), rB = fp.get(seedOf(B));
      if (!rA || !rB || !rA.size || !rB.size) continue;
      let shared = 0;
      rA.forEach((id) => { if (rB.has(id)) shared++; });
      if (shared < 2) continue;
      const jaccard = shared / (rA.size + rB.size - shared);
      if (jaccard < 0.15) continue;
      addEdge(normArtist(A.artist), normArtist(B.artist), 'related', jaccard, shared);
    }
  }
  const collabs = [];
  tracks.forEach((t, i) => {
    const parts = parseCollab(t);
    if (parts.length >= 2) {
      collabs.push({ i, raw: t.title, parts });
      addEdge(parts[0], parts[1], 'collab', 1, 1);
    }
  });
  return { edges, collabs };
}

function buildBridges(tracks, plays, seeds, fp) {
  const seenX = new Map();
  const top = seeds.slice(0, 8);
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const A = top[i].t, B = top[j].t;
      if (seedOf(A) === seedOf(B)) continue;
      const rA = fp.get(seedOf(A)), rB = fp.get(seedOf(B));
      if (!rA || !rB) continue;
      const common = [];
      rA.forEach((id) => { if (rB.has(id)) common.push(id); });
      if (!common.length) continue;
      tracks.forEach((x, xi) => {
        if (plays[xi] > 1) return;
        if (seedOf(x) === seedOf(A) || seedOf(x) === seedOf(B)) return;
        if (!common.includes(nameKeyOf(x))) return;
        const prev = seenX.get(xi);
        if (!prev || common.length > prev.common) {
          seenX.set(xi, { a: normArtist(A.artist), b: normArtist(B.artist), xKey: normArtist(x.artist), common: common.length });
        }
      });
    }
  }
  const bridges = [];
  seenX.forEach((v, xi) => bridges.push({ x: xi, ...v }));
  bridges.sort((p, q) => q.common - p.common);
  return bridges.slice(0, 40);
}

function buildNodes(tracks, plays, edges, bridges, seeds) {
  const seedKeys = new Set(seeds.map((s) => normArtist(s.t.artist)));
  const edgeKeys = new Set();
  edges.forEach((e) => { edgeKeys.add(e.a); edgeKeys.add(e.b); });
  const nodeMap = new Map();
  tracks.forEach((t, i) => {
    const key = normArtist(t.artist);
    if (!nodeMap.has(key)) {
      nodeMap.set(key, {
        key, artist: (t.artist || '').trim() || 'Неизвестный исполнитель',
        tracks: [], plays: 0, hue: null, color: '', isSeed: false,
      });
    }
    const n = nodeMap.get(key);
    n.tracks.push(i);
    n.plays += plays[i];
    if (!n.color && t.color) { n.color = t.color; n.hue = extractHue(t.color); }
  });
  seeds.forEach((s) => { const n = nodeMap.get(normArtist(s.t.artist)); if (n) n.isSeed = true; });
  const all = [...nodeMap.values()];
  const related = all.filter((n) => edgeKeys.has(n.key) || n.isSeed);
  const others = all.filter((n) => !edgeKeys.has(n.key) && !n.isSeed);
  const drawn = related.concat(others).sort((a, b) => b.plays - a.plays).slice(0, 60);
  drawn.forEach((n) => { if (n.hue == null) n.hue = hashStr(n.key) % 360; });
  const drawnKeys = new Set(drawn.map((n) => n.key));
  return { all, drawn, drawnKeys };
}

function layoutNodes(nodes, seed) {
  const rnd = mulberry32(seed);
  nodes.forEach((n) => { n.x = 7 + rnd() * 86; n.y = 8 + rnd() * 84; });
  for (let it = 0; it < 70; it++) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) { a.x += (rnd() - 0.5) * 2; a.y += (rnd() - 0.5) * 2; dx = a.x - b.x; dy = a.y - b.y; d2 = dx * dx + dy * dy; }
        const d = Math.sqrt(d2);
        const min = 10;
        if (d < min && d > 0) {
          const push = (min - d) / 2;
          const ux = dx / d, uy = dy / d;
          a.x += ux * push; a.y += uy * push;
          b.x -= ux * push; b.y -= uy * push;
        }
      }
    }
    nodes.forEach((n) => { n.x = Math.max(6, Math.min(94, n.x)); n.y = Math.max(8, Math.min(92, n.y)); });
  }
}

function buildClusters(allNodes, edges) {
  const parent = new Map();
  allNodes.forEach((n) => parent.set(n.key, n.key));
  const find = (k) => {
    while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); }
    return k;
  };
  edges.forEach((e) => {
    if (!parent.has(e.a) || !parent.has(e.b)) return;
    const ra = find(e.a), rb = find(e.b);
    if (ra !== rb) parent.set(ra, rb);
  });
  const deg = new Map();
  edges.forEach((e) => { deg.set(e.a, (deg.get(e.a) || 0) + 1); deg.set(e.b, (deg.get(e.b) || 0) + 1); });
  const groups = new Map();
  allNodes.forEach((n) => {
    const r = find(n.key);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(n.key);
  });
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      let hub = g[0];
      g.forEach((k) => { if ((deg.get(k) || 0) > (deg.get(hub) || 0)) hub = k; });
      return { members: g, hub, size: g.length };
    })
    .sort((a, b) => b.size - a.size);
}

/* ============================================================
   Рендер
   ============================================================ */

function renderArchaeo() {
  wireArchaeo();
  const body = $('#archaeoBody'), empty = $('#archaeoEmpty');
  const status = $('#archaeoStatus');
  loadArchaeoTracks().then((data) => {
    archaeoTracks = data;
    const hash = tracksHash(data);
    const stale = !archaeo || archaeo.builtAt + ARCHAEO_TTL < Date.now();
    const changed = !archaeo || archaeo.hash !== hash;
    if (archaeo && archaeo.nodes && archaeo.nodes.drawn && archaeo.nodes.drawn.length) {
      body.hidden = false;
      empty.hidden = true;
      const stamp = new Date(archaeo.builtAt).toLocaleString('ru-RU');
      status.textContent = `Копано ${stamp} · ${archaeo.trackCount} треков · ${archaeo.edges.length} связей · ${archaeo.bridges.length} находок`;
      if (changed || stale) status.textContent += ' · коллекция изменилась — перекопайте';
      renderArchaeoBody();
    } else {
      body.hidden = true;
      empty.hidden = false;
      status.textContent = 'Ничего не раскопано';
      const t = $('#archaeoEmptyText');
      if (!data.length) t.textContent = 'Библиотека пуста — добавьте треки через поиск SoundCloud, а потом копайте.';
      else if (!data.some((x) => x.title)) t.textContent = 'В коллекции нет треков с названиями — добавьте музыку и копайте.';
      else t.textContent = 'Нажмите «Копать», чтобы изучить связи между артистами и найти скрытые находки.';
    }
  });
}

function renderArchaeoBody() {
  const tab = getActiveTab();
  const mapWrap = $('#archaeoMapWrap'), list = $('#archaeoList');
  if (!archaeo || !archaeo.nodes || !archaeo.nodes.drawn) return;
  if (tab === 'map') {
    mapWrap.hidden = false;
    list.hidden = true;
    renderMap();
  } else {
    mapWrap.hidden = true;
    list.hidden = false;
    $('#archaeoDetail').hidden = true;
    if (tab === 'bridges') renderBridges();
    else if (tab === 'trees') renderTrees();
    else renderDiary();
  }
}

function tileSize(n) {
  return Math.max(44, Math.min(64, 44 + (n.plays || 0)));
}

function buildPebbles(W, H) {
  const rnd = mulberry32(777);
  let out = '';
  for (let i = 0; i < 30; i++) {
    const x = rnd() * W, y = rnd() * H, r = 1 + rnd() * 3;
    out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="rgba(255,235,200,${(0.03 + rnd() * 0.05).toFixed(3)})"/>`;
  }
  return out;
}

function renderMap() {
  const scene = $('#archaeoScene');
  const detail = $('#archaeoDetail');
  if (detail) detail.hidden = true;
  const drawn = archaeo.nodes.drawn;
  if (drawn.length < 2) {
    scene.innerHTML = '<div class="archaeo-map-empty">Пока слишком мало артистов для карты. Добавьте больше треков и перекопайте.</div>';
    return;
  }
  const W = scene.clientWidth || 860;
  const H = scene.clientHeight || 480;
  const pts = new Map(drawn.map((n) => [n.key, { x: (n.x / 100) * W, y: (n.y / 100) * H }]));
  const lines = [];
  archaeo.edges.forEach((e) => {
    const pA = pts.get(e.a), pB = pts.get(e.b);
    if (!pA || !pB) return;
    lines.push(`<line x1="${pA.x.toFixed(1)}" y1="${pA.y.toFixed(1)}" x2="${pB.x.toFixed(1)}" y2="${pB.y.toFixed(1)}" data-ea="${escapeHtml(e.a)}" data-eb="${escapeHtml(e.b)}"/>`);
  });
  const bridgeKeys = bridgeNodeKeys();
  const svg = `<svg class="archaeo-lines" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${buildPebbles(W, H)}${lines.join('')}</svg>`;
  const tiles = drawn.map((n) => {
    const rep = n.tracks[0];
    const t = rep != null ? archaeoTracks[rep] : null;
    const thumb = t && t.thumbnail ? t.thumbnail : '';
    const size = tileSize(n);
    const found = bridgeKeys.has(n.key);
    const plays = n.plays ? `<i class="archaeo-tile-plays">${n.plays}</i>` : '';
    const star = n.isSeed ? '<i class="archaeo-star" title="Любимый">★</i>' : '';
    const badge = found ? '<i class="archaeo-found-badge">находка</i>' : '';
    return `<div class="archaeo-tile${found ? ' is-found' : ''}" data-key="${escapeHtml(n.key)}" style="left:${n.x}%;top:${n.y}%;width:${size}px;height:${size}px;--thue:${n.hue}" title="${escapeHtml(n.artist)}">
      ${thumb ? `<img class="archaeo-tile-img" src="${escapeHtml(thumb)}" alt="" loading="lazy"/>` : `<span class="archaeo-tile-initial">${escapeHtml(initial(n.artist))}</span>`}
      <i class="archaeo-tile-label">${escapeHtml(shortArtist(n.artist))}</i>
      ${star}${plays}${badge}
    </div>`;
  }).join('');
  scene.innerHTML = svg + tiles;
  if (window.gsap && !reduceMotion()) {
    const edgeEls = scene.querySelectorAll('line');
    edgeEls.forEach((el) => {
      const len = el.getTotalLength ? el.getTotalLength() : 800;
      gsap.fromTo(el, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 0.8, ease: 'power2.out', delay: 0.1 + Math.random() * 0.35 });
    });
    gsap.fromTo(scene.querySelectorAll('.archaeo-tile'),
      { y: 46, opacity: 0, scale: 0.5 },
      { y: 0, opacity: 1, scale: 1, duration: 0.5, ease: 'back.out(1.6)', stagger: 0.02 });
  }
}

function bridgeNodeKeys() {
  if (!archaeo) return new Set();
  return new Set(archaeo.bridges.map((b) => b.xKey).filter(Boolean));
}

function highlightEdges(key) {
  clearEdgeHighlight();
  const scene = $('#archaeoScene');
  scene.querySelectorAll('line').forEach((el) => {
    if (el.dataset.ea === key || el.dataset.eb === key) el.classList.add('is-hot');
  });
}

function clearEdgeHighlight() {
  const scene = $('#archaeoScene');
  if (!scene) return;
  scene.querySelectorAll('line.is-hot').forEach((el) => el.classList.remove('is-hot'));
}

function nodeByKey(key) {
  if (!archaeo) return null;
  return archaeo.nodes.all.find((n) => n.key === key) || null;
}

function renderDetail(n) {
  const detail = $('#archaeoDetail');
  const tracks = n.tracks.slice().sort((a, b) => (archaeo.plays[b] || 0) - (archaeo.plays[a] || 0));
  const top = tracks.slice(0, 6);
  const edgeList = archaeo.edges.filter((e) => e.a === n.key || e.b === n.key);
  const conns = edgeList.map((e) => {
    const other = e.a === n.key ? e.b : e.a;
    const name = nodeDisplay(other);
    const tag = e.kind === 'collab' ? 'коллаборация' : `${e.shared} общих · ${Math.round(e.w * 100)}%`;
    return `<li><b>${escapeHtml(name)}</b> <span>${escapeHtml(tag)}</span></li>`;
  }).join('');
  const found = bridgeNodeKeys().has(n.key);
  detail.innerHTML = `
    <button class="archaeo-detail-close" id="archaeoDetailClose" aria-label="Закрыть">×</button>
    <div class="archaeo-detail-head">
      <span class="archaeo-detail-avatar" style="--thue:${n.hue}">${escapeHtml(initial(n.artist))}</span>
      <div><b>${escapeHtml(n.artist)}</b><small>${n.plays || 0} прослушиваний · ${n.tracks.length} ${plural(n.tracks.length)}${found ? ' · находка' : ''}</small></div>
    </div>
    ${top.length ? `<div class="archaeo-detail-tracks">${top.map((ti) => {
      const t = archaeoTracks[ti];
      return `<div class="archaeo-tr" data-x="${ti}"><i class="archaeo-tr-play">▶</i><span><b>${escapeHtml(t.title || '—')}</b><small>${escapeHtml(t.artist || '')}</small></span><em>${t.duration ? formatDuration(t.duration) : ''}</em></div>`;
    }).join('')}</div>` : ''}
    ${conns ? `<div class="archaeo-detail-conns"><h5>Связи</h5><ul>${conns}</ul></div>` : ''}
    <div class="archaeo-detail-actions">
      <button class="btn btn-ghost btn-sm" data-archaeo-artist="${tracks[0]}">Страница артиста</button>
      <button class="btn btn-ghost btn-sm" data-archaeo-fav="${tracks[0]}">В избранное</button>
    </div>`;
  detail.hidden = false;
}

function playArchaeoTrack(idx) {
  const t = archaeoTracks[idx];
  if (!t) return;
  state.visibleTracks = archaeoTracks.length ? archaeoTracks : [t];
  playTrack(t, Math.max(0, archaeoTracks.indexOf(t)));
}

function renderBridges() {
  const list = $('#archaeoList');
  if (!archaeo.bridges.length) {
    list.innerHTML = '<div class="archaeo-list-empty">Находок пока нет — слушайте любимое чаще и копайте глубже.</div>';
    return;
  }
  list.innerHTML = `<div class="archaeo-bridges">${archaeo.bridges.map((b, i) => {
    const x = archaeoTracks[b.x];
    const cover = x && x.thumbnail
      ? `<img src="${escapeHtml(x.thumbnail)}" alt="" loading="lazy"/>`
      : `<span class="archaeo-bcover">${escapeHtml(initial(x ? x.artist : '?'))}</span>`;
    return `<article class="archaeo-bridge" data-bridge="${i}">
      <div class="archaeo-bcover-wrap">${cover}</div>
      <div class="archaeo-bridge-meta">
        <b>${escapeHtml(x ? x.title : '—')}</b>
        <span>${escapeHtml(x ? x.artist : '—')}${x && x.duration ? ` · ${formatDuration(x.duration)}` : ''}</span>
        <p>Если любите <b>${escapeHtml(nodeDisplay(b.a))}</b> и <b>${escapeHtml(nodeDisplay(b.b))}</b> — этот трек стоит ровно между ними.</p>
      </div>
      <button class="btn btn-ghost btn-sm archaeo-bridge-play" data-x="${b.x}">Играть</button>
    </article>`;
  }).join('')}</div>`;
}

function renderTrees() {
  const list = $('#archaeoList');
  if (!archaeo.clusters.length) {
    list.innerHTML = '<div class="archaeo-list-empty">Семейных деревьев не выделено — пока нет ни одной связи между артистами.</div>';
    return;
  }
  const bridgeKeys = bridgeNodeKeys();
  list.innerHTML = `<div class="archaeo-trees">${archaeo.clusters.map((c, ci) => {
    const nodes = c.members.map((k) => nodeByKey(k)).filter(Boolean);
    const hub = nodes.find((n) => n.key === c.hub) || nodes[0];
    const rows = nodes.map((n) => {
      const found = bridgeKeys.has(n.key);
      return `<span class="archaeo-tree-node${n.key === c.hub ? ' hub' : ''}${found ? ' found' : ''}">${escapeHtml(n.artist)}<small>${n.plays || 0} п.</small></span>`;
    }).join('');
    return `<article class="archaeo-tree">
      <h4>Род ${ci + 1} <small>${nodes.length} артист(а)</small></h4>
      <div class="archaeo-tree-body">${rows}</div>
      <p class="archaeo-tree-hub">Центр: <b>${escapeHtml(hub ? hub.artist : '—')}</b></p>
    </article>`;
  }).join('')}</div>`;
}

function renderDiary() {
  const list = $('#archaeoList');
  if (!archaeo.diary || !archaeo.diary.length) {
    list.innerHTML = '<div class="archaeo-list-empty">Дневник пуст.</div>';
    return;
  }
  list.innerHTML = `<div class="archaeo-diary">${archaeo.diary.map((line, i) => `
    <div class="archaeo-diary-line"><span class="archaeo-diary-num">${i + 1}</span><p>${escapeHtml(line)}</p></div>`).join('')}</div>`;
}

/* ============================================================
   События
   ============================================================ */

function wireArchaeo() {
  if (archaeoWired) return;
  archaeoWired = true;
  loadArchaeo();
  $('#archaeoDigBtn')?.addEventListener('click', () => digArchive());
  $('#archaeoCancelBtn')?.addEventListener('click', () => { archaeoCfg.cancel = true; });
  $('#archaeoScope')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $$('#archaeoScope .chip').forEach((c) => c.classList.toggle('active', c === chip));
    archaeoCfg.scope = Number(chip.dataset.scope) || 12;
  });
  $('#archaeoTabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.archaeo-tab');
    if (!tab) return;
    $$('#archaeoTabs .archaeo-tab').forEach((t) => t.classList.toggle('active', t === tab));
    renderArchaeoBody();
  });
  $('#archaeoScene')?.addEventListener('click', (e) => {
    const tile = e.target.closest('.archaeo-tile');
    if (!tile) return;
    const n = nodeByKey(tile.dataset.key);
    if (n) renderDetail(n);
  });
  $('#archaeoScene')?.addEventListener('mouseover', (e) => {
    const tile = e.target.closest('.archaeo-tile');
    if (tile) highlightEdges(tile.dataset.key);
  });
  $('#archaeoScene')?.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('#archaeoScene')) clearEdgeHighlight();
  });
  $('#archaeoList')?.addEventListener('click', (e) => {
    const play = e.target.closest('.archaeo-bridge-play');
    if (play) { const x = Number(play.dataset.x); if (Number.isFinite(x)) playArchaeoTrack(x); return; }
    const row = e.target.closest('.archaeo-tr');
    if (row) { const x = Number(row.dataset.x); if (Number.isFinite(x)) playArchaeoTrack(x); }
  });
  $('#archaeoDetail')?.addEventListener('click', (e) => {
    const play = e.target.closest('[data-archaeo-play]');
    if (play) { const x = Number(play.dataset.archaeoPlay); if (Number.isFinite(x)) playArchaeoTrack(x); return; }
    const artist = e.target.closest('[data-archaeo-artist]');
    if (artist) {
      const x = Number(artist.dataset.archaeoArtist);
      const t = archaeoTracks[x];
      if (t && t.artist) showArtistPage(t.artist);
      return;
    }
    const fav = e.target.closest('[data-archaeo-fav]');
    if (fav) {
      const x = Number(fav.dataset.archaeoFav);
      const t = archaeoTracks[x];
      if (t) toggleFav(t);
      return;
    }
    if (e.target.closest('#archaeoDetailClose')) $('#archaeoDetail').hidden = true;
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (archaeo && !$('#archaeoBody').hidden && getActiveTab() === 'map') renderMap();
    }, 160);
  });
}
