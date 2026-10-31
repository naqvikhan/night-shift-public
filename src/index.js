// Night Shift room server: a Cloudflare Worker with one Durable Object per room.
// It also serves the standalone site: files in public/ are served first (see [assets] in wrangler.toml),
// and anything that isn't a file reaches the routes below.
//
//   POST /api/rooms {theme}      create a room   → { code, token, recovery }
//   GET  /api/rooms/:code        does it exist?  → 200 | 404 | 429 (too many wrong codes)
//   GET  /api/rooms/:code/ws     WebSocket into the room (see room.js for messages);
//                                ?seat=<token> on a reconnect, which skips the wrong-code limit
//   GET  /api/health             → { ok: true }
//
// Each room keeps its state in Durable Object storage and deletes it all after
// ROOM_TTL_MS without activity. No accounts, no logs of names.

import { RoomCore, randomCode, isCode, ROOM_TTL_MS } from './room.js';

const WRONG_CODE_LIMIT = 10;          // wrong room codes per network...
const WRONG_CODE_WINDOW_MS = 5 * 60e3; // ...in this window, then refuse for the rest of it

function allowedOrigin(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin) return null;
  // The standalone site is served by this same worker, so its own address is always allowed.
  if (origin === new URL(req.url).origin) return origin;
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  // localhost pages are allowed only when ALLOW_LOCALHOST is "true" (wrangler dev sets it via .dev.vars).
  const local = env.ALLOW_LOCALHOST === 'true' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return list.includes('*') || list.includes(origin) || local ? origin : null;
}

function cors(req, env) {
  const o = allowedOrigin(req, env);
  return o ? { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' } : {};
}

const json = (data, status, headers) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const h = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    // Browsers on other sites can't use this server.
    if (req.headers.get('Origin') && !allowedOrigin(req, env)) return json({ error: 'origin' }, 403, {});

    const path = url.pathname.replace(/\/+$/, '');
    if (path === '/api/health') return json({ ok: true }, 200, h);

    if (path === '/api/rooms' && req.method === 'POST') {
      let theme = 'city';
      try { theme = String((await req.json()).theme || 'city'); } catch (e) { /* no body: default theme */ }
      for (let i = 0; i < 8; i++) {
        const code = randomCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch('https://room/create', { method: 'POST', body: JSON.stringify({ code, theme }) });
        if (res.status === 201) return json(await res.json(), 201, h);
      }
      return json({ error: 'busy' }, 503, h);
    }

    const m = path.match(/^\/api\/rooms\/([A-Za-z]{4})(\/ws)?$/);
    if (m) {
      const code = m[1].toUpperCase();
      const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
      const limiter = env.LIMITER.get(env.LIMITER.idFromName(ip));
      const blocked = await (await limiter.fetch('https://limiter/check')).json();
      // A phone that already has a seat (it sends ?seat=<token> when reconnecting) is never locked out
      // of its own game, even when someone on the same Wi-Fi has guessed too many codes.
      const seat = m[2] ? url.searchParams.get('seat') : null;
      if (blocked.blocked && !seat) return json({ error: 'too-many-tries' }, 429, h);
      const fail = () => limiter.fetch('https://limiter/fail', { method: 'POST' });
      if (!isCode(code)) { await fail(); return json({ error: 'no-room' }, 404, h); }

      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      if (m[2]) {
        if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426, h);
        const res = await stub.fetch(new Request('https://room/ws' + (seat ? '?seat=' + encodeURIComponent(seat) : ''), req));
        if (res.status === 404 || res.status === 403) await fail();
        return res;
      }
      const res = await stub.fetch('https://room/exists');
      if (res.status === 404) { await fail(); return json({ error: 'no-room' }, 404, h); }
      return json({ ok: true }, 200, h);
    }
    return json({ error: 'not-found' }, 404, h);
  },
};

// ---------- one Durable Object per room ----------

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.core = null;
    // Phones ping every 20s; answer without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    ctx.blockConcurrencyWhile(async () => {
      const state = await ctx.storage.get('state');
      if (state) this.core = this.makeCore(state);
    });
  }

  makeCore(state) {
    return new RoomCore(state, {
      conns: () => this.ctx.getWebSockets().filter((ws) => ws.readyState === 1).map(adapter),
      save: (s) => this.persist(s),
      // The host closed the room: forget it now rather than waiting for the 4-hour alarm.
      onClosed: () => {
        this.core = null;
        this.ctx.storage.deleteAlarm();
        this.ctx.storage.deleteAll();
      },
    });
  }

  persist(state = this.core.s) {
    // Fire and forget: storage writes are ordered and the output gate holds replies until they land.
    this.ctx.storage.put('state', state);
    this.ctx.storage.setAlarm(state.touched + ROOM_TTL_MS);
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/create') {
      if (this.core) return new Response('taken', { status: 409 });
      const { code, theme } = await req.json();
      this.core = this.makeCore(RoomCore.fresh(code, Date.now(), theme));
      const seat = this.core.createHost();
      this.persist();
      return Response.json({ code, ...seat }, { status: 201 });
    }
    if (!this.core) return new Response('no room', { status: 404 });
    if (url.pathname === '/exists') return Response.json({ ok: true });
    if (url.pathname === '/ws') {
      const seat = url.searchParams.get('seat');
      if (seat && !this.core.seatByToken(seat)) return new Response('unknown seat', { status: 403 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ cid: crypto.randomUUID() });
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws, data) {
    if (!this.core) { ws.close(4410, 'room closed'); return; }
    if (typeof data !== 'string' || data.length > 4000) return;
    this.core.onMessage(adapter(ws), data);
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch (e) { /* already closed */ }
    if (this.core) this.core.onClose(adapter(ws));
  }

  async webSocketError() { if (this.core) this.core.onClose(); }

  async alarm() {
    if (!this.core) { await this.ctx.storage.deleteAll(); return; }
    const due = this.core.s.touched + ROOM_TTL_MS;
    if (Date.now() < due) { await this.ctx.storage.setAlarm(due); return; }
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(JSON.stringify({ t: 'gone', reason: 'unknown-seat' })); ws.close(4410, 'room closed'); } catch (e) { /* */ }
    }
    this.core = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll(); // names and roles are gone for good
  }
}

function adapter(ws) {
  return {
    send(obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* closed */ } },
    getMeta() { return ws.deserializeAttachment() || {}; },
    setMeta(m) { ws.serializeAttachment(m); },
    close(code, reason) { try { ws.close(code, reason); } catch (e) { /* */ } },
  };
}

// ---------- wrong-code limiter: one tiny object per network address ----------

export class Limiter {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(req) {
    const now = Date.now();
    const fails = ((await this.ctx.storage.get('fails')) || []).filter((t) => now - t < WRONG_CODE_WINDOW_MS);
    if (new URL(req.url).pathname === '/fail') {
      fails.push(now);
      await this.ctx.storage.put('fails', fails);
      await this.ctx.storage.setAlarm(now + WRONG_CODE_WINDOW_MS);
    }
    return Response.json({ blocked: fails.length >= WRONG_CODE_LIMIT });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}
