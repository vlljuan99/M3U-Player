#!/usr/bin/env node
/*
 * M3U Player - servidor/proxy sin dependencias (Node 18+).
 *
 * - Sirve la app web (carpeta /public).
 * - /proxy?u=<url>        reenvía peticiones a tu servidor IPTV (API Xtream, listas M3U, streams).
 * - /proxy?u=<url>&s=<f>  URLs firmadas generadas al reescribir listas HLS (.m3u8).
 *
 * Resuelve: CORS, contenido mixto (app en HTTPS y servidor IPTV en HTTP) y redirecciones
 * a balanceadores de carga que hacen muchos proveedores Xtream.
 *
 * Variables de entorno:
 *   PORT           Puerto (por defecto 8080)
 *   HOST           Interfaz (por defecto 0.0.0.0 para que el iPhone lo vea en tu red local)
 *   IPTV_HOSTS     Lista separada por comas de hosts permitidos, p.ej. "mi-proveedor.com:8080".
 *                  Si está vacío se permite cualquier host (no recomendable si expones el servidor).
 *   ACCESS_KEY     Clave opcional para proteger el acceso a la app/proxy.
 *   SECRET         Secreto para firmar URLs (si no, se genera uno aleatorio al arrancar).
 *   TRUST_PROXY    "1" si va detrás de un proxy inverso (Caddy/Nginx): usa X-Forwarded-For
 *                  para limitar intentos de clave por IP.
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ACCESS_KEY = process.env.ACCESS_KEY || '';
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
const ALLOWED = (process.env.IPTV_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_REDIRECTS = 5;
const UA = process.env.USER_AGENT || 'Mozilla/5.0 (M3U-Player)';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// Límite de intentos de clave: 10 fallos por IP cada 15 minutos.
const AUTH_WINDOW = 15 * 60 * 1000;
const AUTH_MAX_FAILS = 10;
const authFails = new Map();
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
  return req.socket.remoteAddress || '';
}
function authBlocked(ip) {
  const e = authFails.get(ip);
  if (!e) return false;
  if (Date.now() - e.first > AUTH_WINDOW) { authFails.delete(ip); return false; }
  return e.count >= AUTH_MAX_FAILS;
}
function authFailed(ip) {
  const e = authFails.get(ip);
  if (!e || Date.now() - e.first > AUTH_WINDOW) authFails.set(ip, { first: Date.now(), count: 1 });
  else e.count++;
  if (authFails.size > 10000) authFails.clear();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------- utilidades ----------

function sign(u) {
  return crypto.createHmac('sha256', SECRET).update(u).digest('base64url').slice(0, 22);
}

function hostAllowed(u) {
  if (ALLOWED.length === 0) return true;
  const host = u.host.toLowerCase();
  const hostname = u.hostname.toLowerCase();
  return ALLOWED.includes(host) || ALLOWED.includes(hostname);
}

function proxied(absUrl) {
  return '/proxy?u=' + encodeURIComponent(absUrl) + '&s=' + sign(absUrl);
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function authorized(req) {
  if (!ACCESS_KEY) return true;
  return safeEqual(parseCookies(req).ak || '', ACCESS_KEY);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

function isPlaylist(urlObj, contentType) {
  const ct = (contentType || '').toLowerCase();
  return (
    ct.includes('mpegurl') ||
    ct.includes('x-mpegurl') ||
    /\.m3u8?$/i.test(urlObj.pathname)
  );
}

function looksLikeHls(text) {
  return text.startsWith('#EXTM3U') && /#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE|VERSION)/.test(text);
}

// Reescribe una lista HLS para que segmentos, sublistas y claves pasen por el proxy.
function rewriteHls(text, baseUrl) {
  const abs = (ref) => {
    try { return new URL(ref, baseUrl).toString(); } catch { return ref; }
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, ref) => `URI="${proxied(abs(ref))}"`);
      }
      return proxied(abs(t));
    })
    .join('\n');
}

// Petición al servidor de origen siguiendo redirecciones.
function upstream(urlStr, req, redirects = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': UA, Accept: '*/*', Connection: 'keep-alive' };
    if (req.headers.range) headers.Range = req.headers.range;
    const r = mod.request(u, { method: 'GET', headers, timeout: 20000 }, (up) => {
      if ([301, 302, 303, 307, 308].includes(up.statusCode) && up.headers.location) {
        up.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error('Demasiadas redirecciones'));
        const next = new URL(up.headers.location, u).toString();
        return resolve(upstream(next, req, redirects + 1));
      }
      resolve({ res: up, finalUrl: u.toString(), abort: () => r.destroy() });
    });
    r.on('timeout', () => r.destroy(new Error('Tiempo de espera agotado')));
    r.on('error', reject);
    r.end();
  });
}

// ---------- manejadores ----------

async function handleProxy(req, res, query) {
  const target = query.get('u');
  const sig = query.get('s');
  if (!target) return send(res, 400, 'Falta el parámetro u');

  let u;
  try { u = new URL(target); } catch { return send(res, 400, 'URL no válida'); }
  if (!/^https?:$/.test(u.protocol)) return send(res, 400, 'Protocolo no permitido');

  const signedOk = sig && safeEqual(sig, sign(target));
  if (!signedOk && !hostAllowed(u)) {
    return send(res, 403, `Host no permitido: ${u.host}. Añádelo a IPTV_HOSTS.`);
  }

  let up;
  try {
    up = await upstream(target, req);
  } catch (e) {
    return send(res, 502, 'Error conectando con el servidor IPTV: ' + e.message);
  }
  const { res: ures, finalUrl, abort } = up;
  const finalObj = new URL(finalUrl);
  const ct = ures.headers['content-type'] || '';

  // Cortar la conexión al origen si el cliente se va (importante en directos).
  res.on('close', () => { if (!res.writableEnded) abort(); });

  const baseHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };

  // Listas HLS: leer completas y reescribir.
  const binaryPath = /\.(ts|mp4|mkv|avi|m4s|aac|mp3|mov|webm)$/i.test(finalObj.pathname);
  const maybeText =
    isPlaylist(finalObj, ct) ||
    (/text|json|plain/i.test(ct) && !req.headers.range && !binaryPath);

  if (maybeText && ures.statusCode < 400) {
    const chunks = [];
    let size = 0;
    const LIMIT = 64 * 1024 * 1024; // listas M3U grandes pueden ocupar decenas de MB
    ures.on('data', (c) => {
      size += c.length;
      if (size > LIMIT) { abort(); return; }
      chunks.push(c);
    });
    ures.on('end', () => {
      let body = Buffer.concat(chunks);
      const head = body.subarray(0, 64).toString('utf8').replace(/^﻿/, '');
      if (head.startsWith('#EXTM3U')) {
        const text = body.toString('utf8').replace(/^﻿/, '');
        if (looksLikeHls(text)) {
          body = Buffer.from(rewriteHls(text, finalUrl), 'utf8');
          return send(res, ures.statusCode, body, {
            ...baseHeaders,
            'Content-Type': 'application/vnd.apple.mpegurl',
          });
        }
      }
      send(res, ures.statusCode, body, { ...baseHeaders, 'Content-Type': ct || 'application/octet-stream' });
    });
    ures.on('error', () => res.destroy());
    return;
  }

  // Resto (segmentos .ts, vídeo VOD con Range, etc.): streaming directo.
  const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
  const headers = { ...baseHeaders };
  for (const h of pass) if (ures.headers[h]) headers[h] = ures.headers[h];
  res.writeHead(ures.statusCode, headers);
  ures.pipe(res);
  ures.on('error', () => res.destroy());
}

function handleStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Prohibido');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'No encontrado');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function handleAuth(req, res) {
  const ip = clientIp(req);
  if (authBlocked(ip)) return send(res, 429, 'Demasiados intentos. Espera 15 minutos.');
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    let key = '';
    try { key = JSON.parse(body).key || ''; } catch { /* vacío */ }
    if (ACCESS_KEY && !safeEqual(key, ACCESS_KEY)) { authFailed(ip); return send(res, 401, 'Clave incorrecta'); }
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    send(res, 200, 'ok', {
      'Set-Cookie': `ak=${encodeURIComponent(key)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`,
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/health') return send(res, 200, 'ok');
  if (p === '/config') {
    return send(res, 200, JSON.stringify({ needsKey: !!ACCESS_KEY, authorized: authorized(req) }), {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
  }
  if (p === '/auth' && req.method === 'POST') return handleAuth(req, res);

  if (p === '/proxy') {
    if (!authorized(req)) return send(res, 401, 'No autorizado');
    if (req.method === 'OPTIONS') {
      return send(res, 204, '', {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range',
      });
    }
    return handleProxy(req, res, url.searchParams).catch((e) => {
      if (!res.headersSent) send(res, 500, 'Error interno: ' + e.message);
      else res.destroy();
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido');
  return handleStatic(req, res, p);
});

server.listen(PORT, HOST, () => {
  const nets = require('os').networkInterfaces();
  const ips = Object.values(nets).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  console.log(`\nM3U Player escuchando en el puerto ${PORT}`);
  console.log(`  En este equipo:      http://localhost:${PORT}`);
  const localOnly = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
  if (localOnly) {
    console.log('  Solo accesible desde este equipo.');
  } else {
    ips.forEach((ip) => console.log(`  En tu red (iPhone):  http://${ip}:${PORT}`));
    if (!ACCESS_KEY) console.log('  Aviso: sin ACCESS_KEY -> cualquiera en tu red puede usar la app.');
  }
  if (!ALLOWED.length) console.log('\n  Aviso: IPTV_HOSTS vacío -> el proxy acepta cualquier host.');
  console.log('');
});

module.exports = { rewriteHls, sign };
