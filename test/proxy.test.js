// Pruebas del proxy contra un servidor Xtream simulado.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

let upPort, lbPort, appPort, app, upstream, lb;

test.before(async () => {
  // "Balanceador" en otro puerto (host distinto para la lista blanca)
  lb = http.createServer((req, res) => {
    if (req.url.startsWith('/hls/1.m3u8')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:10,\nseg1.ts\n#EXTINF:10,\n/abs/seg2.ts\n');
    }
    if (req.url.startsWith('/hls/seg1.ts')) { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end('TSDATA'); }
    res.writeHead(404); res.end();
  });
  lbPort = await listen(lb);
  upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/player_api.php') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ user_info: { auth: 1, status: 'Active' }, action: u.searchParams.get('action') }));
    }
    if (u.pathname === '/live/u/p/1.m3u8') {
      res.writeHead(302, { Location: `http://localhost:${lbPort}/hls/1.m3u8?token=abc` });
      return res.end();
    }
    if (u.pathname === '/movie/u/p/5.mp4') {
      const body = Buffer.from('0123456789');
      if (req.headers.range === 'bytes=2-5') {
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 2-5/10', 'Content-Length': 4 });
        return res.end(body.subarray(2, 6));
      }
      res.writeHead(200, { 'Content-Type': 'video/mp4' }); return res.end(body);
    }
    res.writeHead(404); res.end();
  });
  upPort = await listen(upstream);
  appPort = 18000 + Math.floor(Math.random() * 1000);
  app = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', IPTV_HOSTS: `127.0.0.1:${upPort}` },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${appPort}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});

test.after(() => { app.kill(); upstream.close(); lb.close(); });

const P = (u) => `http://127.0.0.1:${appPort}/proxy?u=${encodeURIComponent(u)}`;

test('sirve la app', async () => {
  const r = await fetch(`http://127.0.0.1:${appPort}/`);
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /M3U Player/);
});

test('reenvía la API Xtream', async () => {
  const r = await fetch(P(`http://127.0.0.1:${upPort}/player_api.php?username=u&password=p&action=get_live_categories`));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
  assert.strictEqual((await r.json()).action, 'get_live_categories');
});

test('rechaza hosts fuera de la lista blanca', async () => {
  const r = await fetch(P(`http://localhost:${lbPort}/hls/seg1.ts`));
  assert.strictEqual(r.status, 403);
});

test('sigue redirecciones y reescribe HLS con URLs firmadas', async () => {
  const r = await fetch(P(`http://127.0.0.1:${upPort}/live/u/p/1.m3u8`));
  assert.strictEqual(r.status, 200);
  const text = await r.text();
  const lines = text.split('\n');
  const seg = lines.find((l) => l.startsWith('/proxy') && l.includes('seg1'));
  assert.ok(seg, text);
  assert.ok(decodeURIComponent(seg).includes(`http://localhost:${lbPort}/hls/seg1.ts`));
  assert.ok(decodeURIComponent(text).includes(`http://localhost:${lbPort}/abs/seg2.ts`));
  assert.match(text, /URI="\/proxy\?u=[^"]*key\.bin[^"]*&s=/);
  // El segmento firmado se puede descargar aunque su host no esté en la lista blanca
  const s = await fetch(`http://127.0.0.1:${appPort}${seg}`);
  assert.strictEqual(s.status, 200);
  assert.strictEqual(await s.text(), 'TSDATA');
  // Una firma manipulada se rechaza
  const bad = await fetch(`http://127.0.0.1:${appPort}${seg.replace(/s=[^&]+$/, 's=xxxx')}`);
  assert.strictEqual(bad.status, 403);
});

test('respeta peticiones Range para VOD', async () => {
  const r = await fetch(P(`http://127.0.0.1:${upPort}/movie/u/p/5.mp4`), { headers: { Range: 'bytes=2-5' } });
  assert.strictEqual(r.status, 206);
  assert.strictEqual(r.headers.get('content-range'), 'bytes 2-5/10');
  assert.strictEqual(await r.text(), '2345');
});

test('evita salir de la carpeta pública', async () => {
  const r = await fetch(`http://127.0.0.1:${appPort}/..%2fserver%2fserver.js`);
  assert.notStrictEqual(r.status, 200);
});

test('con ACCESS_KEY: exige clave y limita intentos', async () => {
  const port = appPort + 1;
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ACCESS_KEY: 'clave-de-prueba-larga' }, stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const base = `http://127.0.0.1:${port}`;
    assert.strictEqual((await fetch(`${base}/proxy?u=http://example.com/`)).status, 401);
    const ok = await fetch(`${base}/auth`, { method: 'POST', body: JSON.stringify({ key: 'clave-de-prueba-larga' }) });
    assert.strictEqual(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    const cfg = await (await fetch(`${base}/config`, { headers: { cookie } })).json();
    assert.deepStrictEqual(cfg, { needsKey: true, authorized: true });
    let last;
    for (let i = 0; i < 11; i++) last = await fetch(`${base}/auth`, { method: 'POST', body: JSON.stringify({ key: 'mal' }) });
    assert.strictEqual(last.status, 429);
  } finally { p.kill(); }
});
