// Night Shift room: seats, host commands, and what each phone is allowed to see.
// Transport-agnostic: the Durable Object and the simulator both drive it.
//
// A connection ("conn") is any object with:
//   send(obj)            deliver a message to that phone
//   getMeta() / setMeta(obj)   small per-connection record ({cid, seat, bad})
//   close(code, reason)
// The room is given conns() which lists the currently open connections.

import { THEMES, themeOf } from './themes.js';
import * as E from './engine.js';

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ'; // no I, L, O, U, V: easy to misread
export const ROOM_TTL_MS = 4 * 60 * 60 * 1000;
const RECOVERY_TRIES_PER_CONN = 5;
const RECOVERY_TRIES_PER_ROOM = 20;

function randomInts(n) {
  const a = new Uint32Array(n);
  globalThis.crypto.getRandomValues(a);
  return a;
}
export function cryptoRandom() { return randomInts(1)[0] / 2 ** 32; }
export function randomCode(len = 4) {
  return Array.from(randomInts(len), (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
}
export function randomToken() {
  return Array.from(randomInts(4), (x) => x.toString(36).padStart(7, '0')).join('');
}
export function isCode(s) {
  return typeof s === 'string' && new RegExp(`^[${CODE_ALPHABET}]{4}$`).test(s);
}
export function cleanName(raw) {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return s.length >= 1 && s.length <= 16 ? s : null;
}

export class RoomCore {
  /**
   * @param state  plain JSON room state (persisted by the caller)
   * @param opts   { conns: () => conn[], save: (state) => void, rng, now }
   */
  constructor(state, opts = {}) {
    this.s = state;
    this.conns = opts.conns || (() => []);
    this.save = opts.save || (() => {});
    this.rng = opts.rng || cryptoRandom;
    this.now = opts.now || Date.now;
    // Called once when the host closes the room; the caller deletes everything it stored.
    this.onClosed = opts.onClosed || (() => {});
  }

  static fresh(code, now = Date.now(), theme = 'city') {
    return {
      v: 1, code, seats: {}, order: [], host: null, nextId: 1,
      recovery: randomCode(6), recoveryFails: 0,
      theme: themeOf(theme).key,
      mix: null, settings: { openWith: 'night', glanceGuard: false },
      game: null, gameNo: 0, touched: now,
    };
  }

  /** Creates the host seat for a fresh room. Returns { token, recovery }. */
  createHost() {
    const seat = this.addSeat('host', null);
    this.s.host = seat.id;
    this.touch();
    return { token: seat.token, recovery: this.s.recovery };
  }

  addSeat(kind, name) {
    const id = 's' + this.s.nextId++;
    const seat = { id, kind, name, token: randomToken() };
    this.s.seats[id] = seat;
    if (kind === 'player') this.s.order.push(id);
    return seat;
  }

  touch() { this.s.touched = this.now(); }

  // ---------- derived state ----------

  name(id) { return this.s.seats[id]?.name ?? 'Someone'; }
  rep() {
    if (!this.s.game) return null;
    return E.replay(this.s.game, (id) => this.name(id));
  }
  inGame(r = this.rep()) { return !!r && !r.winner; }
  currentMix() { return this.s.mix ?? E.suggestedMix(this.s.order.length); }
  seatByToken(t) {
    if (typeof t !== 'string' || !t) return null;
    return Object.values(this.s.seats).find((x) => x.token === t) || null;
  }
  onlineSeats() {
    const on = new Set();
    for (const c of this.conns()) { const m = c.getMeta(); if (m && m.seat) on.add(m.seat); }
    return on;
  }

  // ---------- connections ----------

  /** Handles one raw message from a phone. Returns nothing; replies and broadcasts itself. */
  onMessage(conn, raw) {
    let msg;
    try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const changed = this.handle(conn, msg);
    if (changed) {
      this.touch();
      this.save(this.s);
      this.broadcast();
    }
  }

  onClose() {
    this.broadcastHost(); // the host sees who has dropped off
  }

  err(conn, text, extra = {}) { conn.send({ t: 'error', msg: text, ...extra }); return false; }

  handle(conn, msg) {
    const meta = conn.getMeta() || {};
    switch (msg.t) {
      case 'ping': conn.send({ t: 'pong' }); return false;

      case 'hello': {
        const seat = this.seatByToken(msg.token);
        if (!seat) { conn.send({ t: 'gone', reason: 'unknown-seat' }); return false; }
        conn.setMeta({ ...meta, seat: seat.id });
        conn.send({ t: 'seat', kind: seat.kind, token: seat.token, code: this.s.code });
        return true; // presence changed
      }

      case 'join': {
        if (meta.seat) return this.err(conn, 'This phone already has a seat.');
        if (this.inGame()) return this.err(conn, 'A game is in progress. Join when it ends.', { code: 'in-progress' });
        const name = cleanName(msg.name);
        if (!name) return this.err(conn, 'Type a name, up to 16 characters.', { code: 'bad-name' });
        if (this.s.order.length >= E.MAX_PLAYERS) return this.err(conn, `This room is full (${E.MAX_PLAYERS} players).`, { code: 'full' });
        const taken = Object.values(this.s.seats).some((x) => x.name && x.name.toLowerCase() === name.toLowerCase());
        if (taken) return this.err(conn, `Someone here is already called ${name}. Try another name.`, { code: 'name-taken' });
        const seat = this.addSeat('player', name);
        conn.setMeta({ ...meta, seat: seat.id });
        conn.send({ t: 'seat', kind: 'player', token: seat.token, code: this.s.code });
        return true;
      }

      case 'recover': {
        const bad = meta.bad || 0;
        if (bad >= RECOVERY_TRIES_PER_CONN || this.s.recoveryFails >= RECOVERY_TRIES_PER_ROOM) {
          return this.err(conn, 'Too many wrong tries. Ask the host to read their recovery code again later.', { code: 'locked' });
        }
        if (String(msg.recovery || '').trim().toUpperCase() !== this.s.recovery) {
          conn.setMeta({ ...meta, bad: bad + 1 });
          this.s.recoveryFails++;
          this.save(this.s);
          return this.err(conn, "That recovery code doesn't match.", { code: 'bad-recovery' });
        }
        const host = this.s.seats[this.s.host];
        host.token = randomToken();
        this.s.recoveryFails = 0;
        for (const c of this.conns()) {
          const m = c.getMeta();
          if (m && m.seat === host.id && m.cid !== meta.cid) {
            c.send({ t: 'gone', reason: 'host-moved' });
            c.setMeta({ cid: m.cid });
            c.close(4001, 'host moved');
          }
        }
        conn.setMeta({ ...meta, seat: host.id, bad: 0 });
        conn.send({ t: 'seat', kind: 'host', token: host.token, code: this.s.code });
        return true;
      }

      case 'cmd': {
        const seat = this.s.seats[meta.seat];
        if (!seat || seat.kind !== 'host' || msg.token !== seat.token) return this.err(conn, 'Only the host can do that.');
        if (msg.cmd && msg.cmd.type === 'close') {
          if (this.inGame()) return this.err(conn, 'Finish or end the game before closing the room.');
          this.closeRoom();
          return false;
        }
        const problem = this.command(msg.cmd || {});
        if (problem) return this.err(conn, problem);
        return true;
      }
    }
    return false;
  }

  /** The host closes the room: every phone is sent home, and the room's data is deleted. */
  closeRoom() {
    for (const cn of this.conns()) {
      const m = cn.getMeta() || {};
      cn.send({ t: 'gone', reason: 'closed' });
      cn.setMeta({ cid: m.cid });
      cn.close(4410, 'room closed');
    }
    this.s.closed = true;
    this.onClosed();
  }

  // ---------- host commands ----------

  /** Runs one host command. Returns an error message, or null when it worked. */
  command(c) {
    const s = this.s;
    const r = this.rep();
    const live = this.inGame(r);
    // Stale-screen guard: commands that touch the game log say how long they think it is.
    if (['step', 'back', 'trial', 'undo'].includes(c.type)) {
      if (!live && c.type !== 'undo') return 'There is no game running.';
      if (!s.game) return 'There is no game running.';
      if (typeof c.at === 'number' && c.at !== s.game.log.length) return 'The game moved on. Check the screen and try again.';
    }
    switch (c.type) {
      case 'remove': {
        if (s.game) return 'Players can only be removed in the lobby.';
        const seat = s.seats[c.seat];
        if (!seat || seat.kind !== 'player') return 'That player has already left.';
        delete s.seats[c.seat];
        s.order = s.order.filter((x) => x !== c.seat);
        for (const cn of this.conns()) {
          const m = cn.getMeta();
          if (m && m.seat === c.seat) { cn.send({ t: 'gone', reason: 'removed' }); cn.setMeta({ cid: m.cid }); cn.close(4002, 'removed'); }
        }
        return null;
      }
      case 'mix': {
        if (live) return "The role mix can't change during a game.";
        s.mix = c.mix ? E.cleanMix(c.mix) : null;
        return null;
      }
      case 'theme': {
        if (s.game) return 'Change the theme in the lobby, before the cards are dealt.';
        if (!THEMES[c.theme]) return 'Unknown theme.';
        s.theme = c.theme;
        return null;
      }
      case 'setting': {
        if (c.key === 'openWith') {
          if (live) return 'This applies from the next game.';
          s.settings.openWith = c.value === 'day' ? 'day' : 'night';
        } else if (c.key === 'glanceGuard') {
          s.settings.glanceGuard = !!c.value;
        } else return 'Unknown setting.';
        return null;
      }
      case 'start':
      case 'again': {
        if (c.type === 'start' && s.game) return 'A game has already been dealt.';
        if (c.type === 'again' && (!s.game || live)) return 'Finish this game first.';
        const mix = this.currentMix();
        const p = E.mixProblem(mix, s.order.length, themeOf(s.theme));
        if (p) return p;
        s.game = E.newGame([...s.order], mix, s.settings.openWith, this.rng, themeOf(s.theme).key);
        s.gameNo++;
        return null;
      }
      case 'lobby': {
        s.game = null;
        return null;
      }
      case 'step': {
        const target = c.target ?? null;
        const p = E.checkStep(s.game, r, c.step, target);
        if (p) return p;
        s.game.log.push(c.step === 'dawn' ? { type: 'dawn', n: r.night } : { type: c.step, n: r.night, target });
        return null;
      }
      case 'back': {
        if (!E.canBack(s.game, r)) return 'Nothing to go back to. Use the game log to undo.';
        s.game.log.pop();
        return null;
      }
      case 'trial': {
        const target = c.target ?? null;
        const p = E.checkTrial(s.game, r, target);
        if (p) return p;
        s.game.log.push({ type: 'trial', n: r.day, target });
        return null;
      }
      case 'undo': {
        const i = c.index;
        if (!Number.isInteger(i) || i < 0 || i >= s.game.log.length) return 'That event is no longer in the log.';
        s.game.log.length = i;
        return null;
      }
      case 'handover': {
        if (live) return 'Hosting can only be handed over between games.';
        const next = s.seats[c.seat];
        if (!next || next.kind !== 'player') return 'Pick a player to take over.';
        const old = s.seats[s.host];
        const name = cleanName(c.name ?? old.name);
        if (!name) return 'Type your name, so you can join as a player.';
        const clash = Object.values(s.seats).some((x) => x.id !== old.id && x.name && x.name.toLowerCase() === name.toLowerCase());
        if (clash) return `Someone here is already called ${name}. Try another name.`;
        if (s.order.length - 1 + 1 > E.MAX_PLAYERS) return 'The room is full.';
        s.order = s.order.filter((x) => x !== next.id);
        next.kind = 'host';
        old.kind = 'player';
        old.name = name;
        s.order.push(old.id);
        s.host = next.id;
        s.recovery = randomCode(6);
        s.recoveryFails = 0;
        s.game = null;
        for (const cn of this.conns()) {
          const m = cn.getMeta();
          if (!m) continue;
          if (m.seat === next.id) cn.send({ t: 'seat', kind: 'host', token: next.token, code: s.code });
          if (m.seat === old.id) cn.send({ t: 'seat', kind: 'player', token: old.token, code: s.code });
        }
        return null;
      }
    }
    return 'Unknown command.';
  }

  // ---------- views: each phone gets only what it may see ----------

  broadcast() {
    const r = this.rep();
    const online = this.onlineSeats();
    for (const c of this.conns()) {
      const m = c.getMeta();
      const seat = m && this.s.seats[m.seat];
      if (seat) c.send({ t: 'view', view: this.viewFor(seat, r, online) });
    }
  }

  broadcastHost() {
    const r = this.rep();
    const online = this.onlineSeats();
    for (const c of this.conns()) {
      const m = c.getMeta();
      if (m && m.seat === this.s.host) c.send({ t: 'view', view: this.hostView(r, online) });
    }
  }

  viewFor(seat, r = this.rep(), online = this.onlineSeats()) {
    return seat.kind === 'host' ? this.hostView(r, online) : this.playerView(seat, r);
  }

  playerView(seat, r = this.rep()) {
    const s = this.s, g = s.game;
    const base = { kind: 'player', code: s.code, theme: themeOf(g ? g.theme : s.theme).key, me: seat.name, gameNo: s.gameNo };
    if (!g || !(seat.id in g.roles)) {
      return {
        ...base, stage: 'lobby',
        players: s.order.map((id) => this.name(id)),
        inProgress: !!g && !r.winner,
      };
    }
    if (r.winner) {
      return {
        ...base, stage: 'over', winner: r.winner, winLine: E.winLine(r.winner, themeOf(g.theme)), myRole: g.roles[seat.id],
        reveal: Object.keys(g.roles).map((id) => ({ name: this.name(id), role: g.roles[id], alive: r.alive.has(id), me: id === seat.id })),
      };
    }
    if (!r.alive.has(seat.id)) {
      return { ...base, stage: 'out', out: r.out[seat.id], phase: r.phase, night: r.night, day: r.day };
    }
    const role = g.roles[seat.id];
    const card = { role };
    if (role === 'mafia') {
      card.teammates = Object.keys(g.roles)
        .filter((id) => id !== seat.id && g.roles[id] === 'mafia')
        .map((id) => ({ name: this.name(id), alive: r.alive.has(id) }));
    }
    if (role === 'police') {
      card.policeLog = r.policeLog.map((x) => ({ n: x.n, name: this.name(x.target), mafia: x.mafia }));
    }
    return { ...base, stage: 'game', phase: r.phase, night: r.night, day: r.day, card };
  }

  hostView(r = this.rep(), online = this.onlineSeats()) {
    const s = this.s, g = s.game;
    const n = s.order.length;
    const mix = this.currentMix();
    const players = s.order.map((id) => ({
      id, name: this.name(id), online: online.has(id),
      inGame: !!g && id in g.roles,
      role: g && id in g.roles ? g.roles[id] : null,
      alive: g && id in g.roles ? r.alive.has(id) : null,
      out: g && r.out[id] ? r.out[id] : null,
    }));
    const view = {
      kind: 'host', code: s.code, theme: themeOf(g ? g.theme : s.theme).key, recovery: s.recovery, settings: s.settings, gameNo: s.gameNo,
      players, hostName: this.s.seats[s.host]?.name ?? null,
      mix, mixAuto: !s.mix, suggested: E.suggestedMix(n), citizens: Math.max(0, E.citizensFor(mix, n)),
      mixProblem: E.mixProblem(mix, n, themeOf(s.theme)), minPlayers: E.MIN_PLAYERS, maxPlayers: E.MAX_PLAYERS,
      stage: 'lobby', game: null,
    };
    if (g) {
      view.stage = r.winner ? 'over' : r.phase;
      view.game = {
        night: r.night, day: r.day, at: g.log.length, openWith: g.openWith,
        step: E.hostStep(g, r, (id) => this.name(id)),
        canBack: E.canBack(g, r),
        log: r.lines.map((l, i) => ({ i, ...l })),
        winner: r.winner, winLine: E.winLine(r.winner, themeOf(g.theme)),
        lastDawn: r.lastDawn ? E.dawnText(r.lastDawn, (id) => this.name(id), themeOf(g.theme)) : null,
        dealtTo: Object.keys(g.roles).length,
      };
    }
    return view;
  }
}

export { THEMES, themeOf };
