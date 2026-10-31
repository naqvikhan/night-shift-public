// Night Shift game engine. Pure functions, no I/O.
//
// A game is { roles: {seatId: roleKey}, log: [event], openWith: 'night'|'day' }.
// Everything else (who is alive, the Police log, the phase, the winner) is derived by
// replaying the log, so undo is just "cut the log" and every phone follows automatically.
//
// Events:
//   { type: 'kill'|'save'|'check', n, target|null }   one per confirmed night step
//   { type: 'dawn', n }                               night result announced
//   { type: 'trial', n, target|null }                 day vote

import { themeOf } from './themes.js';

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 16;
export const STEPS = ['kill', 'save', 'check', 'dawn'];
const STEP_ROLE = { kill: 'mafia', save: 'doctor', check: 'police' };

const TH = (game) => themeOf(game && game.theme);

// ---------- role mix ----------

export function suggestedMix(n) {
  const mafia = n >= 14 ? 4 : n >= 10 ? 3 : n >= 6 ? 2 : 1;
  return { mafia, doctor: 1, police: 1 };
}

export function citizensFor(mix, n) {
  return n - mix.mafia - mix.doctor - mix.police;
}

export function cleanMix(mix) {
  const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
  return { mafia: int(mix.mafia, 0, 8), doctor: int(mix.doctor, 0, 1), police: int(mix.police, 0, 1) };
}

export function mixProblem(mix, n, T = themeOf()) {
  const M = T.roles.mafia.group;
  if (n < MIN_PLAYERS) return `Waiting for players: at least ${MIN_PLAYERS} needed, ${n} here.`;
  if (n > MAX_PLAYERS) return `Too many players: ${MAX_PLAYERS} at most.`;
  if (mix.mafia < 1) return `Add at least one ${T.roles.mafia.name}.`;
  if (mix.mafia * 2 >= n) return `There must be fewer ${M} than everyone else.`;
  if (citizensFor(mix, n) < 0) return 'More special roles than players.';
  return null;
}

// ---------- dealing ----------

export function deal(ids, mix, rng = Math.random) {
  const pool = [];
  for (const k of ['mafia', 'doctor', 'police']) for (let i = 0; i < mix[k]; i++) pool.push(k);
  while (pool.length < ids.length) pool.push('citizen');
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const roles = {};
  ids.forEach((id, i) => { roles[id] = pool[i]; });
  return roles;
}

export function newGame(ids, mix, openWith, rng, theme = 'city') {
  return { roles: deal(ids, mix, rng), log: [], openWith: openWith === 'day' ? 'day' : 'night', theme };
}

// ---------- replay ----------

function hasLiving(s, roles, role) {
  for (const id of s.alive) if (roles[id] === role) return true;
  return false;
}

export function dawnResult(picks) {
  const kill = picks.kill ?? null;
  const save = picks.save ?? null;
  return { kill, save, victim: kill && kill !== save ? kill : null };
}

export function dawnText(d, nm, T = themeOf()) {
  if (!d.kill) return T.text.dawnQuiet;
  if (d.victim) return T.text.dawnOut(nm(d.victim));
  return T.text.dawnSaved(nm(d.kill));
}

function describe(s, ev, roles, nm, T) {
  const R = T.roles, X = T.text;
  const who = ev.target ? nm(ev.target) : null;
  switch (ev.type) {
    case 'kill':
      return `${X.night} ${ev.n}: ${R.mafia.group} chose ${who ?? 'no one (no kill)'}`;
    case 'save':
      if (!hasLiving(s, roles, 'doctor')) return `${X.night} ${ev.n}: ${R.doctor.name} line read (${R.doctor.name} is out)`;
      return `${X.night} ${ev.n}: ${R.doctor.name} protected ${who ?? 'no one'}`;
    case 'check':
      if (!hasLiving(s, roles, 'police')) return `${X.night} ${ev.n}: ${R.police.name} line read (${R.police.name} is out)`;
      if (!who) return `${X.night} ${ev.n}: ${R.police.name} checked no one`;
      return `${X.night} ${ev.n}: ${R.police.name} checked ${who}: ${roles[ev.target] === 'mafia' ? X.isBad(who) : X.isNotBad(who)}`;
    case 'dawn':
      return `${X.morning} ${ev.n}: ${dawnText(dawnResult(s.picks), nm, T)}`;
    case 'trial':
      return `${X.day} ${ev.n}: ${who ? who + ' was voted out' : 'no one was voted out'}`;
  }
  return '?';
}

function checkWin(s, roles) {
  let m = 0, o = 0;
  for (const id of s.alive) roles[id] === 'mafia' ? m++ : o++;
  if (m === 0) s.winner = 'town';
  else if (m >= o) s.winner = 'mafia';
  if (s.winner) s.phase = 'over';
}

function apply(s, ev, roles) {
  switch (ev.type) {
    case 'kill': case 'save': case 'check':
      s.picks[ev.type] = ev.target ?? null;
      if (ev.type === 'check' && ev.target) {
        s.policeLog.push({ n: ev.n, target: ev.target, mafia: roles[ev.target] === 'mafia' });
      }
      break;
    case 'dawn': {
      const d = dawnResult(s.picks);
      if (d.victim) { s.alive.delete(d.victim); s.out[d.victim] = { how: 'night', n: s.night }; }
      s.lastDawn = { n: s.night, ...d };
      s.prevSave = d.save;
      s.picks = {};
      s.phase = 'day';
      s.day++;
      checkWin(s, roles);
      break;
    }
    case 'trial':
      if (ev.target) { s.alive.delete(ev.target); s.out[ev.target] = { how: 'trial', n: s.day }; }
      s.lastTrial = { n: s.day, target: ev.target ?? null };
      s.phase = 'night';
      s.night++;
      checkWin(s, roles);
      break;
  }
}

/** Replays a game. `nm(id)` turns a seat id into a display name (only used for log lines). */
export function replay(game, nm = (id) => id) {
  const day = game.openWith === 'day';
  const s = {
    alive: new Set(Object.keys(game.roles)),
    phase: day ? 'day' : 'night',
    night: day ? 0 : 1,
    day: day ? 1 : 0,
    picks: {},
    prevSave: null,
    policeLog: [],
    lastDawn: null,
    lastTrial: null,
    winner: null,
    out: {},
    lines: [],
  };
  for (const ev of game.log) {
    if (s.phase === 'over') break; // defensive: nothing happens after the end
    s.lines.push({ text: describe(s, ev, game.roles, nm, TH(game)), type: ev.type });
    apply(s, ev, game.roles);
  }
  s.step = s.phase === 'night' ? STEPS.find((k) => k === 'dawn' || !(k in s.picks)) : null;
  return s;
}

// ---------- what the host can pick ----------

export function stepSkipped(game, s, step) {
  const role = STEP_ROLE[step];
  return !!role && role !== 'mafia' && !hasLiving(s, game.roles, role);
}

export function stepOptions(game, s, step, nm = (id) => id) {
  const ids = Object.keys(game.roles).filter((id) => s.alive.has(id));
  return ids.map((id) => {
    const role = game.roles[id];
    let why = null;
    if (step === 'kill' && role === 'mafia') why = TH(game).roles.mafia.name;
    if (step === 'save' && id === s.prevSave) why = 'Saved last night';
    if (step === 'check' && role === 'police') why = `The ${TH(game).roles.police.name}`;
    return { id, name: nm(id), role, ok: !why, why };
  });
}

export function checkStep(game, s, step, target) {
  if (s.phase !== 'night') return 'The night is already over.';
  if (step !== s.step) return 'That step was already confirmed.';
  if (target == null) return null;
  if (step === 'dawn') return 'Nothing to pick at this step.';
  if (stepSkipped(game, s, step)) return `The ${TH(game).roles[STEP_ROLE[step]].name} is out.`;
  const o = stepOptions(game, s, step).find((x) => x.id === target);
  if (!o) return 'Pick someone who is still in.';
  if (!o.ok) return `Can't pick that player: ${o.why}.`;
  return null;
}

export function checkTrial(game, s, target) {
  if (s.phase !== 'day') return "It isn't daytime.";
  if (target != null && !s.alive.has(target)) return 'Pick someone who is still in.';
  return null;
}

export function canBack(game, s) {
  const last = game.log[game.log.length - 1];
  return s.phase === 'night' && !!last && STEP_ROLE[last.type] !== undefined && last.n === s.night;
}

// ---------- narrator lines ----------

export function lineFor(step, opts = {}, T = themeOf()) {
  const L = T.text.lines;
  if (step === 'trial') return opts.opening ? L.trialOpening : L.trial;
  return L[step] || '';
}

/** Everything the host's phone needs for the current step. */
export function hostStep(game, s, nm) {
  const T = TH(game), R = T.roles;
  if (s.phase === 'night') {
    const step = s.step;
    const skipped = stepSkipped(game, s, step);
    const info = {
      phase: 'night', step, index: STEPS.indexOf(step) + 1, total: STEPS.length,
      line: lineFor(step, {}, T), skipped, options: [], noneLabel: null, note: '', summary: null,
    };
    if (step === 'dawn') {
      info.summary = dawnText(dawnResult(s.picks), nm, T);
      info.note = "Read the result out. Confirming updates everyone's phone.";
    } else if (skipped) {
      info.note = `The ${R[STEP_ROLE[step]].name} is out. Read the line anyway and pause a few seconds, so nobody can tell.`;
    } else {
      info.options = stepOptions(game, s, step, nm);
      info.noneLabel = { kill: 'No kill', save: 'No save', check: 'No check' }[step];
      info.note = {
        kill: `Tap who the ${R.mafia.group} point to, or No kill if they can't agree.`,
        save: `Tap who the ${R.doctor.name} points to.`,
        check: `Tap who the ${R.police.name} points to. The answer appears on their card when you confirm.`,
      }[step];
    }
    info.picks = ['kill', 'save', 'check'].map((k) => {
      const done = k in s.picks;
      const sk = stepSkipped(game, s, k);
      let label = '';
      if (done) label = sk ? 'Line read' : s.picks[k] ? nm(s.picks[k]) : { kill: 'No kill', save: 'No save', check: 'No check' }[k];
      return { step: k, role: STEP_ROLE[k], done, label, skipped: sk };
    });
    return info;
  }
  if (s.phase === 'day') {
    const opening = game.openWith === 'day' && s.day === 1;
    return {
      phase: 'day', step: 'trial', line: lineFor('trial', { opening }, T), skipped: false,
      note: 'When the vote is done, tap who was voted out, or No one for a tie or a skip.',
      options: Object.keys(game.roles).filter((id) => s.alive.has(id))
        .map((id) => ({ id, name: nm(id), role: game.roles[id], ok: true, why: null })),
      noneLabel: 'No one',
      lastNight: s.lastDawn ? dawnText(s.lastDawn, nm, T) : null,
    };
  }
  return null;
}

export function winLine(winner, T = themeOf()) {
  return winner ? T.teams[winner].win : null;
}
