// Plays full Night Shift games through the shared room logic.
// Run: npm test   (Node 20+)
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomCore } from '../src/room.js';
import * as E from '../src/engine.js';

// ---------- a tiny in-memory "server" with fake phones ----------

function seeded(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

function makeRoom(seed = 1) {
  const open = new Set();
  let saved = 0;
  let closed = 0;
  let cid = 0;
  const state = RoomCore.fresh('KZQW');
  const room = new RoomCore(state, { conns: () => [...open], save: () => { saved++; }, rng: seeded(seed), onClosed: () => { closed++; } });
  const phone = () => {
    const p = {
      inbox: [], meta: { cid: ++cid }, token: null, kind: null, view: null, gone: null, errors: [],
      send(m) {
        m = JSON.parse(JSON.stringify(m)); // what really crosses the wire
        p.inbox.push(m);
        if (m.t === 'seat') { p.token = m.token; p.kind = m.kind; }
        if (m.t === 'view') p.view = m.view;
        if (m.t === 'gone') p.gone = m.reason;
        if (m.t === 'error') p.errors.push(m.msg);
      },
      getMeta: () => p.meta, setMeta: (m) => { p.meta = m; }, close: () => open.delete(p),
      say: (m) => room.onMessage(p, JSON.stringify(m)),
      cmd: (c) => { const before = p.errors.length; p.say({ t: 'cmd', token: p.token, cmd: c }); return p.errors.slice(before)[0] || null; },
      drop: () => { open.delete(p); room.onClose(p); },
    };
    open.add(p);
    return p;
  };
  const { token } = room.createHost();
  const host = phone();
  host.say({ t: 'hello', token });
  return { room, state, phone, host, open, saves: () => saved, closes: () => closed };
}

function withPlayers(n, seed) {
  const env = makeRoom(seed);
  const names = ['Alex', 'Sam', 'Priya', 'Jo', 'Mei', 'Tomás', 'Ravi', 'Nadia', 'Kofi', 'Lena', 'Ana', 'Bo', 'Cy', 'Di', 'Ed', 'Flo'];
  env.players = names.slice(0, n).map((name) => { const p = env.phone(); p.say({ t: 'join', name }); return p; });
  return env;
}

const roleOf = (env, p) => env.state.game.roles[env.room.seatByToken(p.token).id];

// Privacy: a player's view may only contain their own role, Mafia teammates (if Mafia) and the Police log (if Police).
function assertPrivate(env) {
  const g = env.state.game;
  for (const p of env.players) {
    const v = p.view;
    if (!v) continue;
    const strings = []; // every string value in the view (keys like "mafia: true" don't count)
    JSON.stringify(v, (k, x) => { if (typeof x === 'string') strings.push(x); return x; });
    if (v.stage === 'over') continue; // everything is revealed at the end
    const mine = g && env.room.seatByToken(p.token) && g.roles[env.room.seatByToken(p.token).id];
    if (v.stage === 'game') {
      assert.equal(v.card.role, mine);
      if (mine !== 'mafia') assert.ok(!('teammates' in v.card), 'non-Mafia sees teammates');
      if (mine !== 'police') assert.ok(!('policeLog' in v.card), 'non-Police sees Police log');
      for (const r of ['mafia', 'doctor', 'police', 'citizen']) {
        if (r === mine) continue;
        assert.ok(!strings.includes(r), `${p.view.me} can see the role "${r}" in their view`);
      }
    } else {
      for (const r of ['mafia', 'doctor', 'police', 'citizen']) assert.ok(!strings.includes(r), 'out/lobby view leaks a role');
    }
  }
}

function snapshot(env) {
  // what every phone shows, minus online dots
  const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'online' ? undefined : x)));
  return JSON.stringify([strip(env.host.view), ...env.players.map((p) => strip(p.view))]);
}

// One random but valid host action. Returns false when the game is over.
function randomMove(env, rnd) {
  const v = env.host.view;
  if (v.stage === 'over') return false;
  const st = v.game.step;
  const at = v.game.at;
  if (st.phase === 'night') {
    if (v.game.canBack && rnd() < 0.08) { assert.equal(env.host.cmd({ type: 'back', at }), null); return true; }
    let target = null;
    if (!st.skipped && st.step !== 'dawn') {
      const ok = st.options.filter((o) => o.ok);
      if (ok.length && rnd() < 0.85) target = ok[Math.floor(rnd() * ok.length)].id;
    }
    assert.equal(env.host.cmd({ type: 'step', step: st.step, target, at }), null);
  } else {
    const target = rnd() < 0.8 ? st.options[Math.floor(rnd() * st.options.length)].id : null;
    assert.equal(env.host.cmd({ type: 'trial', target, at }), null);
  }
  return true;
}

// ---------- tests ----------

test('suggested role mix follows the brief', () => {
  const rows = { 4: 1, 5: 1, 6: 2, 9: 2, 10: 3, 13: 3, 14: 4, 16: 4 };
  for (const [n, m] of Object.entries(rows)) {
    const mix = E.suggestedMix(+n);
    assert.deepEqual(mix, { mafia: m, doctor: 1, police: 1 });
    assert.equal(E.mixProblem(mix, +n), null, `suggested mix invalid for ${n}`);
  }
  assert.match(E.mixProblem({ mafia: 2, doctor: 1, police: 1 }, 4), /fewer/);
  assert.match(E.mixProblem({ mafia: 0, doctor: 1, police: 1 }, 6), /at least one/);
  assert.match(E.mixProblem({ mafia: 1, doctor: 1, police: 1 }, 3), /at least 4/);
});

test('lobby: join, unique names, remove, start needs 4', () => {
  const env = withPlayers(3, 7);
  assert.equal(env.host.view.players.length, 3);
  const dup = env.phone(); dup.say({ t: 'join', name: '  alex ' });
  assert.match(dup.errors[0], /already called/);
  assert.match(env.host.cmd({ type: 'start' }), /at least 4/);
  const jo = env.phone(); jo.say({ t: 'join', name: 'Jo' }); env.players.push(jo);
  const extra = env.phone(); extra.say({ t: 'join', name: 'Oops' });
  assert.equal(env.host.view.players.length, 5);
  const oopsId = env.host.view.players.find((p) => p.name === 'Oops').id;
  assert.equal(env.host.cmd({ type: 'remove', seat: oopsId }), null);
  assert.equal(extra.gone, 'removed');
  assert.equal(env.host.view.players.length, 4);
  assert.equal(env.host.cmd({ type: 'start' }), null);
  assert.equal(env.host.view.stage, 'night');
  const late = env.phone(); late.say({ t: 'join', name: 'Late' });
  assert.match(late.errors[0], /in progress/);
  assertPrivate(env);
});

test('players never press anything, and only the host seat can command', () => {
  const env = withPlayers(5, 3);
  const p = env.players[0];
  p.say({ t: 'cmd', token: p.token, cmd: { type: 'start' } });
  assert.match(p.errors[0], /Only the host/);
  env.host.say({ t: 'cmd', token: 'wrong', cmd: { type: 'start' } });
  assert.match(env.host.errors.at(-1), /Only the host/);
  assert.equal(env.host.view.stage, 'lobby');
});

test('a scripted game: Mafia card, Doctor save, Police log, trial, Citizens win', () => {
  const env = withPlayers(6, 11);
  env.host.cmd({ type: 'mix', mix: { mafia: 1, doctor: 1, police: 1 } });
  env.host.cmd({ type: 'start' });
  const by = (role) => env.players.filter((p) => roleOf(env, p) === role);
  const [maf] = by('mafia'), [doc] = by('doctor'), [cop] = by('police');
  const cits = by('citizen');
  const id = (p) => env.room.seatByToken(p.token).id;
  const at = () => env.host.view.game.at;

  assert.deepEqual(maf.view.card.teammates, []);
  // Night 1: Mafia attack a citizen, Doctor saves them, Police check the Mafia.
  assert.equal(env.host.cmd({ type: 'step', step: 'kill', target: id(maf), at: at() }) !== null, true, 'Mafia cannot target Mafia');
  env.host.cmd({ type: 'step', step: 'kill', target: id(cits[0]), at: at() });
  env.host.cmd({ type: 'step', step: 'save', target: id(cits[0]), at: at() });
  assert.deepEqual(cop.view.card.policeLog, [], 'nothing reaches the Police phone before the check is confirmed');
  env.host.cmd({ type: 'step', step: 'check', target: id(maf), at: at() });
  assert.deepEqual(cop.view.card.policeLog, [{ n: 1, name: maf.view.me, mafia: true }]);
  assert.equal(env.host.view.game.step.summary, `${cits[0].view.me} was attacked but saved.`);
  env.host.cmd({ type: 'step', step: 'dawn', at: at() });
  assert.equal(env.host.view.stage, 'day');
  assert.equal(cits[0].view.stage, 'game');
  // Doctor can't save the same person two nights running
  env.host.cmd({ type: 'trial', target: null, at: at() });
  env.host.cmd({ type: 'step', step: 'kill', target: id(cits[1]), at: at() });
  const saveOpts = env.host.view.game.step.options;
  assert.equal(saveOpts.find((o) => o.id === id(cits[0])).ok, false);
  assert.match(env.host.cmd({ type: 'step', step: 'save', target: id(cits[0]), at: at() }), /Saved last night/);
  env.host.cmd({ type: 'step', step: 'save', target: id(doc), at: at() }); // Doctor saves themselves: allowed
  env.host.cmd({ type: 'step', step: 'check', target: id(cits[2]), at: at() });
  env.host.cmd({ type: 'step', step: 'dawn', at: at() });
  assert.equal(cits[1].view.stage, 'out');
  assert.deepEqual(cop.view.card.policeLog.map((x) => x.mafia), [true, false]);
  assertPrivate(env);
  // Day 2: vote the Mafia out. Citizens win.
  env.host.cmd({ type: 'trial', target: id(maf), at: at() });
  assert.equal(env.host.view.stage, 'over');
  assert.equal(env.host.view.game.winLine, 'Citizens win');
  for (const p of env.players) {
    assert.equal(p.view.stage, 'over');
    assert.equal(p.view.reveal.length, 6);
  }
});

test('Mafia win when they equal everyone else', () => {
  const env = withPlayers(4, 5);
  env.host.cmd({ type: 'start' });
  const g = env.state.game;
  const ids = Object.keys(g.roles);
  const town = ids.filter((x) => g.roles[x] !== 'mafia');
  const at = () => env.host.view.game.at;
  env.host.cmd({ type: 'step', step: 'kill', target: town[0], at: at() });
  env.host.cmd({ type: 'step', step: 'save', target: null, at: at() });
  env.host.cmd({ type: 'step', step: 'check', target: null, at: at() });
  env.host.cmd({ type: 'step', step: 'dawn', at: at() });
  // 1 Mafia v 2 others: not over. Vote out a town player: 1 v 1, Mafia win.
  assert.equal(env.host.view.stage, 'day');
  env.host.cmd({ type: 'trial', target: town[1], at: at() });
  assert.equal(env.host.view.game.winner, 'mafia');
  assert.equal(env.players[0].view.winLine, 'Mafia win');
});

test('steps for an eliminated Doctor and Police are still read, but skipped', () => {
  const env = withPlayers(5, 9);
  env.host.cmd({ type: 'mix', mix: { mafia: 1, doctor: 1, police: 1 } });
  env.host.cmd({ type: 'start' });
  const g = env.state.game;
  const docId = Object.keys(g.roles).find((x) => g.roles[x] === 'doctor');
  const at = () => env.host.view.game.at;
  env.host.cmd({ type: 'step', step: 'kill', target: docId, at: at() });
  env.host.cmd({ type: 'step', step: 'save', target: null, at: at() });
  env.host.cmd({ type: 'step', step: 'check', target: null, at: at() });
  env.host.cmd({ type: 'step', step: 'dawn', at: at() });
  env.host.cmd({ type: 'trial', target: null, at: at() });
  env.host.cmd({ type: 'step', step: 'kill', target: null, at: at() });
  const st = env.host.view.game.step;
  assert.equal(st.step, 'save');
  assert.equal(st.skipped, true);
  assert.match(st.note, /Read the line anyway/);
  assert.ok(st.line.includes('Doctor, open your eyes'));
  assert.ok(env.host.cmd({ type: 'step', step: 'save', target: Object.keys(g.roles)[0], at: at() }));
  assert.equal(env.host.cmd({ type: 'step', step: 'save', target: null, at: at() }), null);
});

test('Back within the night, and stale double-taps are refused', () => {
  const env = withPlayers(6, 2);
  env.host.cmd({ type: 'start' });
  const at0 = env.host.view.game.at;
  const t = env.host.view.game.step.options.find((o) => o.ok).id;
  assert.equal(env.host.cmd({ type: 'step', step: 'kill', target: t, at: at0 }), null);
  assert.match(env.host.cmd({ type: 'step', step: 'kill', target: t, at: at0 }), /moved on/);
  assert.equal(env.host.view.game.step.step, 'save');
  assert.equal(env.host.cmd({ type: 'back', at: env.host.view.game.at }), null);
  assert.equal(env.host.view.game.step.step, 'kill');
  assert.match(env.host.cmd({ type: 'back', at: env.host.view.game.at }), /Nothing to go back to/);
});

test('undo rewinds every phone to exactly how it looked, Police log included (200 random games)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rnd = seeded(seed * 7919);
    const n = 4 + (seed % 13);
    const env = withPlayers(n, seed);
    if (seed % 5 === 0) env.host.cmd({ type: 'setting', key: 'openWith', value: 'day' });
    assert.equal(env.host.cmd({ type: 'start' }), null);
    const snaps = [snapshot(env)]; // snaps[i] = phones when the log had i events
    let guard = 0;
    while (randomMove(env, rnd)) {
      const len = env.state.game.log.length;
      snaps.length = len;
      snaps[len] = snapshot(env);
      assertPrivate(env);
      // Sometimes undo to a random earlier point and check every phone matches.
      if (rnd() < 0.1 && len > 0) {
        const i = Math.floor(rnd() * len);
        assert.equal(env.host.cmd({ type: 'undo', index: i }), null);
        assert.equal(snapshot(env), snaps[i], `seed ${seed}: undo to ${i} doesn't match`);
        snaps.length = i + 1;
      }
      assert.ok(++guard < 2000, 'game never ends');
    }
    assert.equal(env.host.view.stage, 'over');
    // Undo from the end brings the game back to life.
    const len = env.state.game.log.length;
    assert.equal(env.host.cmd({ type: 'undo', index: len - 1 }), null);
    assert.notEqual(env.host.view.stage, 'over');
    assert.equal(snapshot(env), snaps[len - 1]);
    assertPrivate(env);
  }
});

test('rejoin: a phone that drops gets the same seat and card back', () => {
  const env = withPlayers(6, 4);
  env.host.cmd({ type: 'start' });
  const p = env.players[2];
  const before = JSON.stringify(p.view);
  p.drop();
  assert.equal(env.host.view.players[2].online, false);
  const again = env.phone();
  again.say({ t: 'hello', token: p.token });
  assert.equal(JSON.stringify(again.view), before);
  assert.equal(env.host.view.players[2].online, true);
  const stranger = env.phone();
  stranger.say({ t: 'hello', token: 'not-a-token' });
  assert.equal(stranger.gone, 'unknown-seat');
});

test('host recovery code moves hosting to a new phone and is rate limited', () => {
  const env = withPlayers(4, 6);
  const thief = env.phone();
  for (let i = 0; i < 5; i++) thief.say({ t: 'recover', recovery: 'WRONG' + i });
  thief.say({ t: 'recover', recovery: env.state.recovery });
  assert.match(thief.errors.at(-1), /Too many wrong tries/);
  assert.equal(thief.kind, null);
  const newPhone = env.phone();
  newPhone.say({ t: 'recover', recovery: env.state.recovery.toLowerCase() });
  assert.equal(newPhone.kind, 'host');
  assert.equal(env.host.gone, 'host-moved');
  assert.equal(newPhone.view.kind, 'host');
  assert.equal(newPhone.cmd({ type: 'start' }), null);
});

test('play again and hand over hosting (between games only)', () => {
  const env = withPlayers(5, 8);
  env.host.cmd({ type: 'mix', mix: { mafia: 1, doctor: 0, police: 1 } });
  env.host.cmd({ type: 'start' });
  const target = env.players[0];
  const tid = env.room.seatByToken(target.token).id;
  assert.match(env.host.cmd({ type: 'handover', seat: tid, name: 'Hal' }), /between games/);
  // finish fast: vote out the Mafia
  const g = env.state.game;
  const mafia = Object.keys(g.roles).find((x) => g.roles[x] === 'mafia');
  const at = () => env.host.view.game.at;
  for (const step of ['kill', 'save', 'check', 'dawn']) env.host.cmd({ type: 'step', step, target: null, at: at() });
  env.host.cmd({ type: 'trial', target: mafia, at: at() });
  assert.equal(env.host.view.stage, 'over');
  const firstRoles = JSON.stringify(env.state.game.roles);
  assert.equal(env.host.cmd({ type: 'again' }), null);
  assert.equal(env.host.view.gameNo, 2);
  assert.equal(env.host.view.mix.doctor, 0, 'mix kept');
  assert.equal(Object.keys(env.state.game.roles).length, 5, 'same players');
  void firstRoles;
  env.host.cmd({ type: 'lobby' });
  assert.equal(env.host.cmd({ type: 'handover', seat: tid, name: 'Alex' }) !== null, true, 'name clash');
  assert.equal(env.host.cmd({ type: 'handover', seat: tid, name: 'Hal' }), null);
  assert.equal(target.kind, 'host');
  assert.equal(target.view.kind, 'host');
  assert.equal(env.host.kind, 'player');
  assert.equal(env.host.view.kind, 'player');
  assert.equal(env.host.view.me, 'Hal');
  assert.ok(target.view.players.some((p) => p.name === 'Hal'));
  assert.ok(!target.view.players.some((p) => p.name === 'Alex'));
  // old host can no longer command
  env.host.say({ t: 'cmd', token: env.host.token, cmd: { type: 'start' } });
  assert.match(env.host.errors.at(-1), /Only the host/);
});

test('room codes avoid easy-to-confuse letters', async () => {
  const { randomCode, isCode } = await import('../src/room.js');
  for (let i = 0; i < 500; i++) {
    const c = randomCode();
    assert.ok(isCode(c));
    assert.ok(!/[ILOUV01]/.test(c));
  }
});

test('every theme names every role, side and line', async () => {
  const { THEMES, THEME_ORDER, ROLE_ORDER } = await import('../src/themes.js');
  assert.deepEqual(Object.keys(THEMES).sort(), [...THEME_ORDER].sort());
  for (const k of THEME_ORDER) {
    const T = THEMES[k];
    assert.ok(T.name && T.game && T.tagline, `${k} needs a name, game and tagline`);
    for (const r of ROLE_ORDER) for (const f of ['name', 'group', 'plural', 'blurb']) assert.ok(T.roles[r][f], `${k}.${r}.${f}`);
    for (const t of ['mafia', 'town']) assert.ok(T.teams[t].win, `${k}.teams.${t}`);
    for (const l of ['kill', 'save', 'check', 'dawn', 'trial', 'trialOpening']) assert.ok(T.text.lines[l], `${k}.lines.${l}`);
    assert.equal(typeof T.text.dawnOut('X'), 'string');
  }
});

test('the setting only changes in the lobby, and the narrator speaks it', () => {
  const env = withPlayers(5, 21);
  assert.equal(env.host.view.theme, 'city');
  assert.match(env.host.cmd({ type: 'theme', theme: 'nowhere' }), /Unknown theme/);
  assert.equal(env.host.cmd({ type: 'theme', theme: 'city' }), null);
  env.host.cmd({ type: 'mix', mix: { mafia: 1, doctor: 1, police: 1 } });
  env.host.cmd({ type: 'start' });
  assert.match(env.host.cmd({ type: 'theme', theme: 'city' }), /lobby/);
  const st = env.host.view.game.step;
  assert.match(st.line, /Mafia, open your eyes/);
  const g = env.state.game;
  const boss = Object.keys(g.roles).find((x) => g.roles[x] === 'mafia');
  const at = () => env.host.view.game.at;
  env.host.cmd({ type: 'step', step: 'kill', target: null, at: at() });
  env.host.cmd({ type: 'step', step: 'save', target: null, at: at() });
  env.host.cmd({ type: 'step', step: 'check', target: boss, at: at() });
  assert.match(env.host.view.game.log.at(-1).text, /Detective checked .* is Mafia/);
  env.host.cmd({ type: 'step', step: 'dawn', at: at() });
  env.host.cmd({ type: 'trial', target: boss, at: at() });
  assert.equal(env.host.view.game.winLine, 'Citizens win');
});

test('the host can exit the room from the lobby, and everyone is sent home', () => {
  const env = withPlayers(4, 31);
  const p = env.players[0];
  p.say({ t: 'cmd', token: p.token, cmd: { type: 'close' } });
  assert.match(p.errors.at(-1), /Only the host/);
  env.host.cmd({ type: 'start' });
  env.host.say({ t: 'cmd', token: env.host.token, cmd: { type: 'close' } });
  assert.match(env.host.errors.at(-1), /end the game/);
  assert.equal(env.closes(), 0);
  env.host.cmd({ type: 'lobby' });
  env.host.say({ t: 'cmd', token: env.host.token, cmd: { type: 'close' } });
  assert.equal(env.closes(), 1);
  assert.equal(env.host.gone, 'closed');
  for (const pl of env.players) assert.equal(pl.gone, 'closed');
  assert.equal(env.open.size, 0, 'every connection is closed');
});
