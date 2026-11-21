/* M3U Player - cliente web (PWA). Sin dependencias en tiempo de compilación.
 * Los motores de vídeo (hls.js / mpegts.js) se cargan bajo demanda desde CDN
 * solo cuando el navegador no reproduce el formato de forma nativa (p. ej. Windows). */
'use strict';

const HLS_CDN = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
const MPEGTS_CDN = 'https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.min.js';
const PAGE = 150;

const UA = navigator.userAgent;
const IS_IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_SAFARI = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(UA);

// ---------------- utilidades ----------------
const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin espacio o modo privado */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
};

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

function show(id) {
  for (const v of ['#view-key', '#view-login', '#view-main']) $(v).classList.toggle('hidden', v !== id);
}

function hashId(s) {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (Math.imul(31, x) + s.charCodeAt(i)) | 0;
  return (x >>> 0).toString(36);
}

function normalizeServer(s) {
  s = (s || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    return u.origin; // quita /player_api.php, /get.php, barras finales, etc.
  } catch { return s.replace(/\/+$/, ''); }
}

function extOf(url) {
  const m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url.split('?')[0] + '?');
  return m ? m[1].toLowerCase() : '';
}

function decodeB64(s) {
  if (!s) return '';
  try { return decodeURIComponent(escape(atob(s))); } catch { return s; }
}

function fmtTime(d) { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function loadScript(src) {
  loadScript.cache = loadScript.cache || {};
  if (!loadScript.cache[src]) {
    loadScript.cache[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = res;
      s.onerror = () => { delete loadScript.cache[src]; rej(new Error('No se pudo cargar ' + src)); };
      document.head.append(s);
    });
  }
  return loadScript.cache[src];
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------------- estado ----------------
const state = {
  profile: null,
  account: null,
  data: {},              // live / vod / series -> { cats: [], items: [] }
  tab: 'live',
  cat: '*',
  query: '',
  view: null,            // lista mostrada actualmente (para siguiente/anterior)
  playing: null,         // { item, index, list }
};

function proxy(url) { return location.origin + '/proxy?u=' + encodeURIComponent(url); }
function mediaUrl(url) { return state.profile.direct ? url : proxy(url); }

async function getJSON(url) {
  const r = await fetch(proxy(url), { cache: 'no-store' });
  if (r.status === 401) { location.reload(); throw new Error('No autorizado'); }
  if (!r.ok) throw new Error((await r.text()) || 'HTTP ' + r.status);
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new Error('Respuesta no válida del servidor IPTV'); }
}

// ---------------- Xtream Codes API ----------------
const xt = {
  base() { const p = state.profile; return `${p.server}/player_api.php?username=${encodeURIComponent(p.user)}&password=${encodeURIComponent(p.pass)}`; },
  call(action, params = {}) {
    let u = this.base();
    if (action) u += '&action=' + action;
    for (const [k, v] of Object.entries(params)) u += `&${k}=${encodeURIComponent(v)}`;
    return getJSON(u);
  },
  path(kind) { return { live: 'live', vod: 'movie', episode: 'series' }[kind]; },
  streamUrl(kind, id, ext) {
    const p = state.profile;
    return `${p.server}/${this.path(kind)}/${encodeURIComponent(p.user)}/${encodeURIComponent(p.pass)}/${id}.${ext}`;
  },
  liveFormats() {
    const allowed = (state.account?.user_info?.allowed_output_formats || []).map(String);
    const order = IS_IOS || IS_SAFARI ? ['m3u8'] : ['m3u8', 'ts'];
    const list = order.filter((f) => !allowed.length || allowed.includes(f));
    return list.length ? list : ['m3u8'];
  },
  async load(section) {
    const map = {
      live: ['get_live_categories', 'get_live_streams'],
      vod: ['get_vod_categories', 'get_vod_streams'],
      series: ['get_series_categories', 'get_series'],
    }[section];
    const [cats, items] = await Promise.all([this.call(map[0]), this.call(map[1])]);
    const norm = (Array.isArray(items) ? items : []).map((s) => {
      if (section === 'live') return { kind: 'live', id: s.stream_id, name: s.name, logo: s.stream_icon, cat: String(s.category_id), num: s.num };
      if (section === 'vod') return { kind: 'vod', id: s.stream_id, name: s.name, logo: s.stream_icon, cat: String(s.category_id), ext: s.container_extension || 'mp4', rating: s.rating };
      return { kind: 'series', id: s.series_id, name: s.name, logo: s.cover, cat: String(s.category_id), plot: s.plot, rating: s.rating };
    });
    return {
      cats: (Array.isArray(cats) ? cats : []).map((c) => ({ id: String(c.category_id), name: c.category_name })),
      items: norm,
    };
  },
};

// ---------------- listas M3U ----------------
function parseM3U(text) {
  const out = { live: [], vod: [], series: [] };
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      line.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { attrs[k.toLowerCase()] = v; });
      const rest = line.replace(/([\w-]+)="[^"]*"/g, '');
      const comma = rest.indexOf(',');
      cur = {
        name: (comma >= 0 ? rest.slice(comma + 1) : '').trim() || attrs['tvg-name'] || 'Sin nombre',
        logo: attrs['tvg-logo'] || '',
        cat: attrs['group-title'] || 'Sin categoría',
      };
    } else if (line.startsWith('#EXTGRP:') && cur) {
      cur.cat = line.slice(8).trim() || cur.cat;
    } else if (!line.startsWith('#')) {
      const item = cur || { name: line.split('/').pop(), logo: '', cat: 'Sin categoría' };
      item.url = line;
      item.id = hashId(line);
      if (/\/movie\//i.test(line)) { item.kind = 'vod'; out.vod.push(item); }
      else if (/\/series\//i.test(line)) { item.kind = 'episode'; out.series.push(item); }
      else { item.kind = 'live'; out.live.push(item); }
      cur = null;
    }
  }
  const build = (items) => {
    const names = [...new Set(items.map((i) => i.cat))];
    return { cats: names.map((n) => ({ id: n, name: n })), items };
  };
  return { live: build(out.live), vod: build(out.vod), series: build(out.series) };
}

// Si la URL M3U es la típica get.php de Xtream, usamos la API (mucho más completa).
function m3uToXtream(url) {
  try {
    const u = new URL(url);
    const user = u.searchParams.get('username');
    const pass = u.searchParams.get('password');
    if (/get\.php$/i.test(u.pathname) && user && pass) return { server: u.origin, user, pass };
  } catch { /* */ }
  return null;
}

// ---------------- sesión ----------------
async function login(profile) {
  state.profile = profile;
  state.data = {};
  if (profile.mode === 'xtream') {
    const info = await xt.call('');
    if (!info || !info.user_info) throw new Error('Respuesta inesperada. Revisa el servidor.');
    if (String(info.user_info.auth) === '0') throw new Error('Usuario o contraseña incorrectos');
    if (info.user_info.status && info.user_info.status !== 'Active') throw new Error('Cuenta ' + info.user_info.status);
    state.account = info;
  } else {
    const r = await fetch(proxy(profile.m3uUrl), { cache: 'no-store' });
    if (!r.ok) throw new Error((await r.text()) || 'HTTP ' + r.status);
    const text = await r.text();
    if (!text.trimStart().replace(/^﻿/, '').startsWith('#EXTM3U')) throw new Error('El archivo no parece una lista M3U');
    state.data = parseM3U(text);
    state.account = null;
  }
  saveProfile(profile);
  store.set('lastProfile', profile.id);
}

function profiles() { return store.get('profiles', []); }
function saveProfile(p) {
  const list = profiles().filter((x) => x.id !== p.id);
  list.unshift(p);
  store.set('profiles', list.slice(0, 10));
}
function removeProfile(id) { store.set('profiles', profiles().filter((x) => x.id !== id)); }

function renderProfiles() {
  const box = $('#profiles');
  box.replaceChildren();
  const list = profiles();
  if (!list.length) return;
  box.append(h('div', { class: 'muted', text: 'Cuentas guardadas' }));
  for (const p of list) {
    box.append(h('div', { class: 'profile', onclick: () => doLogin(p) },
      h('div', {}, p.name, h('small', { text: p.mode === 'xtream' ? p.server : 'Lista M3U' })),
      h('button', { type: 'button', title: 'Olvidar', onclick: (e) => { e.stopPropagation(); removeProfile(p.id); renderProfiles(); } }, '✕'),
    ));
  }
}

async function doLogin(p) {
  const btn = $('#login-btn');
  const err = $('#login-error');
  err.textContent = '';
  if (!state.profile || $('#view-main').classList.contains('hidden')) show('#view-login');
  btn.disabled = true; btn.textContent = 'Conectando…';
  try {
    await login(p);
    show('#view-main');
    const last = store.get('ui:' + p.id, {});
    selectTab(last.tab || 'live', last.cat);
  } catch (e) {
    err.textContent = e.message;
    show('#view-login');
  } finally {
    btn.disabled = false; btn.textContent = 'Conectar';
  }
}

function setupLogin() {
  let mode = 'xtream';
  document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    $('.mode-xtream').classList.toggle('hidden', mode !== 'xtream');
    $('.mode-m3u').classList.toggle('hidden', mode !== 'm3u');
  }));
  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const direct = $('#f-direct').checked;
    let p;
    if (mode === 'xtream') {
      const server = normalizeServer($('#f-server').value);
      const user = $('#f-user').value.trim();
      const pass = $('#f-pass').value;
      if (!server || !user || !pass) { $('#login-error').textContent = 'Rellena servidor, usuario y contraseña'; return; }
      p = { mode: 'xtream', server, user, pass, direct };
    } else {
      const url = $('#f-m3u').value.trim();
      if (!url) { $('#login-error').textContent = 'Introduce la URL de la lista'; return; }
      const asXt = m3uToXtream(url);
      p = asXt ? { mode: 'xtream', ...asXt, direct } : { mode: 'm3u', m3uUrl: url, direct };
    }
    p.id = hashId(p.mode === 'xtream' ? `${p.server}|${p.user}` : p.m3uUrl);
    p.name = p.mode === 'xtream' ? `${p.user} @ ${new URL(p.server).host}` : new URL(p.m3uUrl).host;
    doLogin(p);
  });
  renderProfiles();
}

// ---------------- navegación ----------------
async function ensureSection(section) {
  if (state.data[section]) return state.data[section];
  if (state.profile.mode !== 'xtream') return (state.data[section] = { cats: [], items: [] });
  $('#list-status').textContent = 'Cargando…';
  state.data[section] = await xt.load(section);
  return state.data[section];
}

function favKey() { return 'fav:' + state.profile.id; }
function favorites() { return store.get(favKey(), []); }
function isFav(item) { return favorites().some((f) => f.kind === item.kind && String(f.id) === String(item.id)); }
function toggleFav(item) {
  let list = favorites();
  if (isFav(item)) list = list.filter((f) => !(f.kind === item.kind && String(f.id) === String(item.id)));
  else list.unshift(item);
  store.set(favKey(), list);
}

async function selectTab(tab, cat) {
  state.tab = tab;
  state.cat = cat || '*';
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#crumbs').replaceChildren();
  $('#list').style.display = '';
  try {
    if (tab !== 'fav') await ensureSection(tab);
  } catch (e) {
    $('#list').replaceChildren();
    $('#list-status').textContent = 'Error: ' + e.message;
    return;
  }
  renderCategories();
  renderItems();
}

function renderCategories() {
  const box = $('#categories');
  box.replaceChildren();
  if (state.tab === 'fav') { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const { cats, items } = state.data[state.tab];
  const counts = {};
  for (const i of items) counts[i.cat] = (counts[i.cat] || 0) + 1;
  const all = [{ id: '*', name: 'Todas' }, ...cats.filter((c) => counts[c.id])];
  if (!all.some((c) => c.id === state.cat)) state.cat = '*';
  for (const c of all) {
    box.append(h('button', {
      class: 'cat' + (c.id === state.cat ? ' active' : ''),
      onclick: () => {
        state.cat = c.id;
        store.set('ui:' + state.profile.id, { tab: state.tab, cat: state.cat });
        renderCategories(); renderItems();
        $('.content').scrollTop = 0;
      },
    }, h('span', { text: c.name }), h('span', { text: c.id === '*' ? items.length : counts[c.id] })));
  }
  box.querySelector('.cat.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  store.set('ui:' + state.profile.id, { tab: state.tab, cat: state.cat });
}

function currentItems() {
  let items = state.tab === 'fav' ? favorites() : state.data[state.tab].items;
  const q = state.query.trim().toLowerCase();
  if (q) return items.filter((i) => (i.name || '').toLowerCase().includes(q));
  if (state.tab !== 'fav' && state.cat !== '*') items = items.filter((i) => i.cat === state.cat);
  return items;
}

let observer;
function renderItems(items = currentItems()) {
  const list = $('#list');
  const poster = state.tab === 'vod' || state.tab === 'series';
  list.classList.toggle('posters', poster && state.profile.mode === 'xtream');
  list.replaceChildren();
  state.view = items;
  let shown = 0;
  const more = () => {
    const frag = document.createDocumentFragment();
    for (const it of items.slice(shown, shown + PAGE)) frag.append(itemEl(it, items));
    shown += PAGE;
    list.append(frag);
    $('#list-status').textContent = items.length ? (shown < items.length ? '' : `${items.length} elementos`) : 'No hay elementos';
  };
  more();
  observer?.disconnect();
  observer = new IntersectionObserver((e) => { if (e[0].isIntersecting && shown < items.length) more(); }, { root: $('.content'), rootMargin: '600px' });
  observer.observe($('#list-sentinel'));
}

function itemEl(it, list) {
  const initials = (it.name || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 2).toUpperCase() || '?';
  const img = it.logo
    ? h('img', { src: it.logo, loading: 'lazy', alt: '', referrerpolicy: 'no-referrer', onerror: (e) => e.target.replaceWith(h('div', { class: 'ph', text: initials })) })
    : h('div', { class: 'ph', text: initials });
  const fav = h('button', {
    class: 'fav-btn' + (isFav(it) ? ' on' : ''), title: 'Favorito',
    onclick: (e) => {
      e.stopPropagation(); toggleFav(it); e.currentTarget.classList.toggle('on', isFav(it));
      if (state.tab === 'fav') renderItems();
    },
  }, '★');
  const sub = it.kind === 'live' && it.num ? `#${it.num}` : it.rating ? `★ ${it.rating}` : it.sub || '';
  return h('div', { class: 'item', role: 'button', tabindex: '0', onclick: () => openItem(it, list), onkeydown: (e) => { if (e.key === 'Enter') openItem(it, list); } },
    img,
    h('div', { class: 'meta' }, h('div', { class: 'name', text: it.name }), sub ? h('div', { class: 'sub', text: sub }) : null),
    fav,
  );
}

function openItem(it, list) {
  if (it.kind === 'series') return openSeries(it);
  play(it, list);
}

async function openSeries(s) {
  const list = $('#list');
  list.classList.remove('posters');
  list.replaceChildren();
  observer?.disconnect();
  $('#list-status').textContent = 'Cargando…';
  const back = h('button', { class: 'btn', onclick: () => { $('#crumbs').replaceChildren(); renderItems(); } }, '← Volver');
  $('#crumbs').replaceChildren(back);
  let info;
  try { info = await xt.call('get_series_info', { series_id: s.id }); } catch (e) { $('#list-status').textContent = 'Error: ' + e.message; return; }
  const meta = info.info || {};
  const episodes = info.episodes || {};
  const seasons = Object.keys(episodes).sort((a, b) => Number(a) - Number(b));
  $('#list-status').textContent = seasons.length ? '' : 'Sin episodios';

  const head = h('div', { class: 'series-head' },
    meta.cover || s.logo ? h('img', { src: meta.cover || s.logo, alt: '', referrerpolicy: 'no-referrer' }) : null,
    h('div', {}, h('h2', { text: meta.name || s.name }), h('p', { text: [meta.releaseDate, meta.genre, meta.rating && '★ ' + meta.rating].filter(Boolean).join(' · ') }), h('p', { text: meta.plot || '' })),
  );
  const seasonBar = h('div', { class: 'seasons' });
  const eps = h('div', { class: 'list' });
  const selectSeason = (n) => {
    seasonBar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.n === n));
    const items = (episodes[n] || []).map((e) => ({
      kind: 'episode', id: e.id, ext: e.container_extension || 'mp4',
      name: `${e.episode_num}. ${e.title || ''}`.trim(),
      logo: e.info?.movie_image || meta.cover, sub: [e.info?.duration, `T${n}`].filter(Boolean).join(' · '),
      series: meta.name || s.name,
    }));
    eps.replaceChildren(...items.map((it) => itemEl(it, items)));
  };
  for (const n of seasons) seasonBar.append(h('button', { 'data-n': n, onclick: () => selectSeason(n) }, `Temporada ${n}`));
  list.replaceChildren(head, seasonBar, eps);
  list.style.display = 'block';
  back.addEventListener('click', () => { list.style.display = ''; });
  if (seasons.length) selectSeason(seasons[0]);
}

// ---------------- reproductor ----------------
const video = $('#video');
let engine = null;   // instancia hls.js o mpegts.js
let posTimer = null;
let epgTimer = null;

function destroyEngine() {
  if (engine) { try { engine.destroy(); } catch { /* */ } engine = null; }
  video.removeAttribute('src');
  video.load();
}

function playerMsg(text) {
  const m = $('#pl-msg');
  m.textContent = text || '';
  m.classList.toggle('hidden', !text);
}

function candidates(item) {
  if (item.url) {
    // Lista M3U: si es un enlace Xtream .ts y estamos en iPhone, probamos también .m3u8
    const urls = [item.url];
    if (/\.ts$/i.test(item.url)) {
      const alt = item.url.replace(/\.ts$/i, '.m3u8');
      if (IS_IOS || IS_SAFARI) urls.unshift(alt); else urls.push(alt);
    }
    return urls;
  }
  if (item.kind === 'live') return xt.liveFormats().map((f) => xt.streamUrl('live', item.id, f));
  return [xt.streamUrl(item.kind, item.id, item.ext || 'mp4')];
}

async function attach(url, live) {
  destroyEngine();
  const src = mediaUrl(url);
  const ext = extOf(url);
  const nativeHls = !!video.canPlayType('application/vnd.apple.mpegurl');

  if (ext === 'm3u8' || (live && !ext)) {
    if (nativeHls && (IS_IOS || IS_SAFARI)) { video.src = src; return; }
    await loadScript(HLS_CDN);
    if (!window.Hls || !Hls.isSupported()) {
      if (nativeHls) { video.src = src; return; }
      throw new Error('Este navegador no soporta HLS');
    }
    return new Promise((resolve, reject) => {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30 });
      engine = hls;
      let ok = false;
      hls.on(Hls.Events.MANIFEST_PARSED, () => { ok = true; resolve(); });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (!ok) return reject(new Error('HLS: ' + d.details));
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else playerMsg('Error de reproducción: ' + d.details);
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    });
  }

  if (ext === 'ts') {
    await loadScript(MPEGTS_CDN);
    if (!window.mpegts || !mpegts.getFeatureList().mseLivePlayback) throw new Error('Formato .ts no soportado en este dispositivo');
    return new Promise((resolve, reject) => {
      const p = mpegts.createPlayer({ type: 'mpegts', isLive: live, url: src }, {
        enableStashBuffer: false, liveBufferLatencyChasing: true, lazyLoad: false,
      });
      engine = p;
      let done = false;
      p.on(mpegts.Events.ERROR, (type, detail) => {
        if (!done) { done = true; reject(new Error(`TS: ${type} ${detail}`)); }
        else playerMsg('Error de reproducción: ' + detail);
      });
      p.on(mpegts.Events.MEDIA_INFO, () => { if (!done) { done = true; resolve(); } });
      p.attachMediaElement(video);
      p.load();
      setTimeout(() => { if (!done) { done = true; resolve(); } }, 8000);
    });
  }

  // VOD (mp4, mkv, etc.): reproducción nativa con soporte de Range.
  video.src = src;
}

async function play(item, list) {
  state.playing = { item, list: list || state.view || [item], index: (list || []).indexOf(item) };
  $('#player').classList.remove('hidden');
  $('#pl-title').textContent = item.series ? `${item.series} — ${item.name}` : item.name;
  $('#pl-epg').textContent = '';
  const multi = state.playing.list.length > 1;
  $('#pl-prev').classList.toggle('hidden', !multi);
  $('#pl-next').classList.toggle('hidden', !multi);
  playerMsg('Cargando…');
  clearInterval(posTimer); clearInterval(epgTimer);

  const live = item.kind === 'live';
  let lastErr;
  for (const url of candidates(item)) {
    try {
      await attach(url, live);
      lastErr = null;
      break;
    } catch (e) { lastErr = e; }
  }
  if (lastErr) { playerMsg('No se pudo reproducir: ' + lastErr.message); return; }

  video.play().catch(() => playerMsg('Pulsa ▶ para reproducir'));

  if (live && state.profile.mode === 'xtream') {
    loadEpg(item);
    epgTimer = setInterval(() => loadEpg(item), 60000);
  }
  if (!live) setupResume(item);
}

async function loadEpg(item) {
  try {
    const r = await xt.call('get_short_epg', { stream_id: item.id, limit: 2 });
    const l = (r.epg_listings || []).map((e) => ({
      title: decodeB64(e.title),
      start: new Date(Number(e.start_timestamp) * 1000),
      end: new Date(Number(e.stop_timestamp) * 1000),
    }));
    if (state.playing?.item !== item) return;
    $('#pl-epg').textContent = l.map((e, i) => `${i === 0 ? 'Ahora' : 'Después'}: ${e.title} (${fmtTime(e.start)}–${fmtTime(e.end)})`).join('  ·  ');
  } catch { /* EPG opcional */ }
}

function posKey(item) { return `pos:${state.profile.id}:${item.kind}:${item.id}`; }
function setupResume(item) {
  const saved = store.get(posKey(item), 0);
  const onMeta = () => {
    video.removeEventListener('loadedmetadata', onMeta);
    if (saved > 30 && video.duration && saved < video.duration - 60) video.currentTime = saved;
  };
  video.addEventListener('loadedmetadata', onMeta);
  posTimer = setInterval(() => {
    if (!video.paused && video.currentTime > 0) {
      const done = video.duration && video.currentTime > video.duration - 60;
      if (done) store.del(posKey(item)); else store.set(posKey(item), Math.floor(video.currentTime));
    }
  }, 5000);
}

function step(d) {
  const p = state.playing;
  if (!p || p.list.length < 2) return;
  let i = p.list.indexOf(p.item);
  i = (i + d + p.list.length) % p.list.length;
  play(p.list[i], p.list);
}

function closePlayer() {
  clearInterval(posTimer); clearInterval(epgTimer);
  destroyEngine();
  state.playing = null;
  playerMsg('');
  $('#player').classList.add('hidden');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

video.addEventListener('playing', () => playerMsg(''));
video.addEventListener('waiting', () => playerMsg('Cargando…'));
video.addEventListener('error', () => {
  const err = video.error;
  if (err && !engine) playerMsg('No se pudo reproducir (código ' + err.code + '). El formato puede no ser compatible con este dispositivo.');
});

// ---------------- cuenta ----------------
function showAccount() {
  const box = $('#account-info');
  box.replaceChildren();
  const add = (k, v) => { if (v != null && v !== '') box.append(h('dt', { text: k }), h('dd', { text: String(v) })); };
  const p = state.profile;
  if (p.mode === 'xtream') {
    const u = state.account?.user_info || {};
    add('Servidor', p.server);
    add('Usuario', p.user);
    add('Estado', u.status);
    add('Caduca', u.exp_date ? new Date(Number(u.exp_date) * 1000).toLocaleDateString() : 'Sin fecha');
    add('Conexiones', u.active_cons != null ? `${u.active_cons} / ${u.max_connections}` : u.max_connections);
    add('Formatos', (u.allowed_output_formats || []).join(', '));
  } else {
    add('Lista', p.m3uUrl);
  }
  add('Modo', p.direct ? 'Directo (sin proxy)' : 'A través del proxy');
  $('#account').showModal();
}

// ---------------- arranque ----------------
async function init() {
  setupLogin();

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) { $('#search').value = ''; state.query = ''; selectTab(b.dataset.tab); }
  });
  $('#search').addEventListener('input', debounce((e) => { state.query = e.target.value; $('#crumbs').replaceChildren(); $('#list').style.display = ''; renderItems(); }, 200));
  $('#btn-account').addEventListener('click', showAccount);
  $('#btn-close-account').addEventListener('click', () => $('#account').close());
  $('#btn-reload').addEventListener('click', async () => {
    $('#account').close();
    if (state.profile.mode === 'xtream') { state.data = {}; selectTab(state.tab, state.cat); }
    else doLogin(state.profile);
  });
  $('#btn-logout').addEventListener('click', () => {
    $('#account').close();
    store.del('lastProfile');
    state.profile = null;
    renderProfiles();
    show('#view-login');
  });
  $('#pl-close').addEventListener('click', closePlayer);
  $('#pl-prev').addEventListener('click', () => step(-1));
  $('#pl-next').addEventListener('click', () => step(1));
  document.addEventListener('keydown', (e) => {
    if ($('#player').classList.contains('hidden')) return;
    if (e.key === 'Escape' && !document.fullscreenElement) closePlayer();
    if (e.key === 'PageDown' || (e.key === 'ArrowDown' && e.ctrlKey)) step(1);
    if (e.key === 'PageUp' || (e.key === 'ArrowUp' && e.ctrlKey)) step(-1);
    if (e.key === 'f') (document.fullscreenElement ? document.exitFullscreen() : $('#player').requestFullscreen?.())?.catch?.(() => {});
  });

  $('#key-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await fetch('/auth', { method: 'POST', body: JSON.stringify({ key: $('#key-input').value }) });
    if (r.ok) location.reload(); else $('#key-error').textContent = r.status === 429 ? await r.text() : 'Clave incorrecta';
  });

  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});

  try {
    const cfg = await (await fetch('/config', { cache: 'no-store' })).json();
    if (cfg.needsKey && !cfg.authorized) { show('#view-key'); return; }
  } catch { /* servidor sin /config: seguimos */ }

  const lastId = store.get('lastProfile');
  const last = profiles().find((p) => p.id === lastId);
  if (last) doLogin(last); else show('#view-login');
}

init();
