"use strict";
// Room state and rules for F the Bus online. The server is the only dealer: phones send actions,
// the server applies them here and broadcasts publicState() to everyone in the room.
const crypto = require("crypto");

const SUITS = {
  S: { name: "Spades", sym: "♠", red: false },
  H: { name: "Hearts", sym: "♥", red: true },
  D: { name: "Diamonds", sym: "♦", red: true },
  C: { name: "Clubs", sym: "♣", red: false },
};
const SUIT_KEYS = ["S", "H", "D", "C"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const MODES = ["classic", "hilo", "horse"];
const MAX_PLAYERS = 16;

const rand = n => crypto.randomInt(n);
const token = bytes => crypto.randomBytes(bytes).toString("hex");
function shuffle(d) { for (let i = d.length - 1; i > 0; i--) { const j = rand(i + 1); [d[i], d[j]] = [d[j], d[i]]; } return d; }
function deck({ exclude = [], aces = true } = {}) {
  const skip = new Set(exclude.map(c => c.r + c.s));
  const d = [];
  for (const s of SUIT_KEYS) for (const r of RANKS) if ((aces || r !== "A") && !skip.has(r + s)) d.push({ r, s });
  return shuffle(d);
}
const label = c => c.r + SUITS[c.s].sym;

function createRoom(code) {
  return {
    code, hostId: null, players: [],
    settings: { mode: "classic", acesHigh: true, tiesMiss: true, trackLen: 7 },
    screen: "lobby",
    current: null, starter: 0, deck: [], row: [], stage: 0, phase: "guess", lastGood: "",
    race: null,
    ev: { seq: 0, type: "", dealt: -1 },
    lastActive: Date.now(),
  };
}

function cleanName(name) {
  return String(name || "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 20);
}

function addPlayer(room, name) {
  if (room.players.length >= MAX_PLAYERS) return null;
  const p = {
    id: token(6), token: token(16), name, connected: true,
    drinks: 0, rides: 0, best: null, tries: 0, roundDrinks: 0, off: false,
    bet: { suit: SUIT_KEYS[room.players.length % 4], amt: 2 },
  };
  room.players.push(p);
  if (!room.hostId) room.hostId = p.id;
  return p;
}

const player = (room, id) => room.players.find(p => p.id === id);
const idx = (room, id) => room.players.findIndex(p => p.id === id);
const isHost = (room, id) => room.hostId === id;
function bump(room, type, dealt = -1) { room.ev = { seq: room.ev.seq + 1, type, dealt }; }

// Hand host to the next connected player when the host leaves or drops.
function reassignHost(room) {
  const h = player(room, room.hostId);
  if (h && h.connected) return;
  const next = room.players.find(p => p.connected) || room.players[0];
  room.hostId = next ? next.id : null;
}

// ---- Classic / Higher or Lower ----
function value(room, c) { return c.r === "A" ? (room.settings.acesHigh ? 14 : 1) : ({ J: 11, Q: 12, K: 13 }[c.r] || +c.r); }
function draw(room) {
  if (!room.deck.length) room.deck = deck({ exclude: room.row });
  return room.deck.pop();
}
// Turns rotate after every miss or get-off; players who are off sit out until the next round.
function nextUp(room, fromId) {
  const n = room.players.length;
  const from = idx(room, fromId);
  for (let k = 1; k <= n; k++) { const p = room.players[((from < 0 ? -1 : from) + k + n) % n]; if (!p.off) return p.id; }
  return null;
}
function beginTurn(room, id) {
  const p = player(room, id);
  room.current = id; p.tries += 1;
  room.row = []; room.stage = 0; room.phase = "guess"; room.lastGood = "";
  let dealt = -1;
  if (room.settings.mode === "hilo") { room.row[0] = draw(room); room.stage = 1; dealt = 0; }
  bump(room, "turn", dealt);
}
function newRound(room) {
  room.players.forEach(p => { p.off = false; p.tries = 0; p.roundDrinks = 0; });
  const first = room.starter % room.players.length;
  room.starter = first + 1;
  room.screen = "play";
  beginTurn(room, room.players[first].id);
}
function passTurn(room) {
  const next = nextUp(room, room.current);
  if (next === null) return newRound(room);
  beginTurn(room, next);
}
const GUESSES = {
  classic: [["red", "black"], ["higher", "lower"], ["inside", "outside"], SUIT_KEYS],
  hilo: [null, ["higher", "lower"], ["higher", "lower"], ["higher", "lower"]],
};
function judge(room, stage, g, card) {
  const v = value(room, card), ties = room.settings.tiesMiss;
  if (room.settings.mode === "hilo") {
    const a = value(room, room.row[stage - 1]);
    if (v === a) return !ties;
    return g === "higher" ? v > a : v < a;
  }
  if (stage === 0) return (g === "red") === SUITS[card.s].red;
  if (stage === 1) {
    const a = value(room, room.row[0]);
    if (v === a) return !ties;
    return g === "higher" ? v > a : v < a;
  }
  if (stage === 2) {
    const lo = Math.min(value(room, room.row[0]), value(room, room.row[1]));
    const hi = Math.max(value(room, room.row[0]), value(room, room.row[1]));
    if (v === lo || v === hi) return !ties;
    const inside = v > lo && v < hi;
    return g === "inside" ? inside : !inside;
  }
  return card.s === g;
}
function guess(room, g) {
  const stage = room.stage;
  const card = draw(room);
  room.row[stage] = card;
  const p = player(room, room.current);
  if (!judge(room, stage, g, card)) {
    p.drinks += 1; p.roundDrinks += 1;
    room.phase = "miss";
    bump(room, "miss", stage);
  } else if (stage === 3) {
    p.rides += 1; p.off = true;
    if (p.best === null || p.tries < p.best) p.best = p.tries;
    room.phase = "won";
    bump(room, "won", stage);
  } else {
    room.stage += 1;
    room.lastGood = room.settings.mode === "hilo"
      ? `${label(card)}. ${stage} right, ${3 - stage} to go.`
      : `${label(card)}. Card ${stage + 1} is good.`;
    bump(room, "good", stage);
  }
}

// ---- Horse race ----
// Each flip moves that suit's ace one spot. Once every ace has reached sideline card k, card k turns
// over and the ace of its suit drops back one (never below the start). First ace past the last card wins.
function newRace(room) {
  const len = room.settings.trackLen;
  const d = deck({ aces: false });
  room.race = {
    id: token(4), len, side: d.splice(0, len), sideUp: Array(len).fill(false), next: 1, deck: d, discard: [],
    pos: { S: 0, H: 0, D: 0, C: 0 }, last: null, msg: "Tap Flip to start the race.", back: null, flips: 0,
    winner: null, results: null, entrants: room.players.map(p => p.id),
  };
  room.screen = "race";
  bump(room, "race");
}
function flip(room) {
  const r = room.race;
  if (!r.deck.length) { r.deck = shuffle(r.discard); r.discard = []; }
  const c = r.deck.pop();
  r.discard.push(c); r.last = c; r.flips += 1; r.back = null;
  r.pos[c.s] += 1;
  const msgs = [`${label(c)}: ${SUITS[c.s].name} move${r.pos[c.s] > r.len ? " past the last card" : ` up to ${r.pos[c.s]}`}.`];
  if (r.pos[c.s] > r.len) {
    r.winner = c.s;
  } else {
    while (r.next <= r.len && SUIT_KEYS.every(k => r.pos[k] >= r.next)) {
      const sc = r.side[r.next - 1];
      r.sideUp[r.next - 1] = true;
      if (r.pos[sc.s] > 0) r.pos[sc.s] -= 1;
      r.back = sc.s;
      msgs.push(`Sideline card ${r.next} is ${label(sc)}. ${SUITS[sc.s].name} drop back to ${r.pos[sc.s]}.`);
      r.next += 1;
    }
  }
  r.msg = msgs.join(" ");
  if (r.winner) {
    // Settle bets for players who were in the room when the race started.
    r.results = room.players.filter(p => r.entrants.includes(p.id)).map(p => {
      const won = p.bet.suit === r.winner;
      if (won) p.rides += 1; else p.drinks += p.bet.amt;
      return { id: p.id, name: p.name, suit: p.bet.suit, amt: p.bet.amt, won };
    });
    bump(room, "won");
  } else {
    bump(room, "flip");
  }
}

// ---- membership ----
function removePlayer(room, id) {
  const i = idx(room, id);
  if (i < 0) return;
  const wasCurrent = room.current === id && room.screen === "play";
  const next = wasCurrent ? nextUp(room, id) : null;
  room.players.splice(i, 1);
  if (room.hostId === id) { room.hostId = null; reassignHost(room); }
  if (!room.players.length) return;
  if (room.starter > i) room.starter -= 1;
  if (wasCurrent) {
    if (next && next !== id) beginTurn(room, next); else newRound(room);
  }
}

function setConnected(room, id, connected) {
  const p = player(room, id);
  if (!p) return;
  p.connected = connected;
  if (!connected && room.hostId === id) reassignHost(room);
  if (connected && !player(room, room.hostId)?.connected) room.hostId = id;
}

// ---- actions from phones ----
// Returns an error message for the player, or null when the action was applied.
function act(room, pid, msg) {
  const me = player(room, pid);
  if (!me) return "You're not in this room any more. Join again with the room code.";
  const host = isHost(room, pid);
  const a = msg && msg.a;
  const hostOnly = () => host ? null : "Only the host can do that.";
  room.lastActive = Date.now();

  switch (a) {
    case "setMode":
      if (hostOnly()) return hostOnly();
      if (room.screen !== "lobby" || !MODES.includes(msg.mode)) return "That mode isn't available.";
      room.settings.mode = msg.mode; return null;
    case "setSetting":
      if (hostOnly()) return hostOnly();
      if (!["acesHigh", "tiesMiss"].includes(msg.key)) return "Unknown setting.";
      room.settings[msg.key] = !!msg.value; return null;
    case "setTrackLen":
      if (hostOnly()) return hostOnly();
      room.settings.trackLen = Math.min(10, Math.max(5, room.settings.trackLen + (msg.delta > 0 ? 1 : -1))); return null;
    case "kick":
      if (hostOnly()) return hostOnly();
      if (msg.id === pid) return "Use Leave room to leave.";
      removePlayer(room, msg.id); return null;
    case "start":
      if (hostOnly()) return hostOnly();
      if (!room.players.length) return "Add a player first.";
      if (room.settings.mode === "horse") { room.screen = "bets"; bump(room, "screen"); return null; }
      room.starter = 0; newRound(room); return null;
    case "menu":
      if (hostOnly()) return hostOnly();
      room.screen = "lobby"; bump(room, "screen"); return null;
    case "restart":
      if (hostOnly()) return hostOnly();
      room.players.forEach(p => { p.drinks = 0; p.rides = 0; p.best = null; });
      room.starter = 0; room.deck = [];
      if (room.settings.mode === "horse") { room.race = null; room.screen = "bets"; bump(room, "screen"); return null; }
      if (room.screen === "play") newRound(room); else bump(room, "screen");
      return null;
    case "guess": {
      if (room.screen !== "play" || room.phase !== "guess") return "Wait for the next turn.";
      const rider = player(room, room.current);
      if (pid !== room.current && !(host && rider && !rider.connected)) return `It's ${rider ? rider.name : "someone else"}'s turn.`;
      const allowed = GUESSES[room.settings.mode][room.stage];
      if (!allowed || !allowed.includes(msg.g)) return "That guess doesn't fit this card.";
      guess(room, msg.g); return null;
    }
    case "pass":
      if (room.screen !== "play" || room.phase === "guess") return "Finish the guess first.";
      if (pid !== room.current && !host) return "The rider or the host passes the bus.";
      passTurn(room); return null;
    case "skip": {
      if (hostOnly()) return hostOnly();
      if (room.screen !== "play") return "Nothing to skip.";
      passTurn(room); return null;
    }
    case "setBet": {
      if (!["bets", "lobby"].includes(room.screen)) return "Bets are closed.";
      if (msg.suit !== undefined) { if (!SUIT_KEYS.includes(msg.suit)) return "Pick a suit."; me.bet.suit = msg.suit; }
      if (msg.delta !== undefined) me.bet.amt = Math.min(5, Math.max(1, me.bet.amt + (msg.delta > 0 ? 1 : -1)));
      return null;
    }
    case "startRace":
      if (hostOnly()) return hostOnly();
      if (room.screen !== "bets") return "Place bets first.";
      newRace(room); return null;
    case "flip":
      if (room.screen !== "race" || !room.race || room.race.winner) return "The race is over.";
      flip(room); return null;
    case "raceAgain":
      if (hostOnly()) return hostOnly();
      room.screen = "bets"; bump(room, "screen"); return null;
    default:
      return "Unknown action.";
  }
}

// What every phone sees: no tokens, no deck order, no face-down sideline cards.
function publicState(room) {
  const r = room.race;
  return {
    code: room.code, hostId: room.hostId, settings: room.settings, screen: room.screen,
    players: room.players.map(({ token: _t, ...p }) => p),
    current: room.current, row: room.row, stage: room.stage, phase: room.phase, lastGood: room.lastGood,
    next: room.screen === "play" ? nextUp(room, room.current) : null,
    race: r && {
      id: r.id, len: r.len, side: r.side.map((c, i) => r.sideUp[i] ? c : null), sideUp: r.sideUp,
      pos: r.pos, last: r.last, msg: r.msg, back: r.back, flips: r.flips, winner: r.winner, results: r.results,
    },
    ev: room.ev,
  };
}

module.exports = { createRoom, addPlayer, removePlayer, setConnected, cleanName, act, publicState, player, SUIT_KEYS, MAX_PLAYERS };
