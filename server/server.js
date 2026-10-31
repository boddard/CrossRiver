"use strict";
// F the Bus online: serves the phone client and runs game rooms over WebSockets.
//   PORT (default 3000) and HOST (default 0.0.0.0) set where it listens.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const game = require("./game");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const MAX_ROOMS = 500;
const IDLE_ROOM_MS = 6 * 60 * 60 * 1000;   // drop a room after 6h with no activity
const EMPTY_ROOM_MS = 30 * 60 * 1000;      // or 30 min after everyone has disconnected
const OFFLINE_GRACE_MS = 5000;             // show a player offline only after 5s without a connection
const HOST_GRACE_MS = 30000;               // hand the host role on after 30s offline

const PUBLIC = path.join(__dirname, "..", "public");
const INDEX = path.join(PUBLIC, "index.html");
// The few other files the app needs: install manifest, service worker and icons. Read once at start.
const STATIC = Object.fromEntries([
  ["/manifest.webmanifest", "application/manifest+json"],
  ["/sw.js", "text/javascript; charset=utf-8"],
  ["/icon-192.png", "image/png"],
  ["/icon-512.png", "image/png"],
  ["/apple-touch-icon.png", "image/png"],
].map(([p, type]) => [p, { type, body: fs.readFileSync(path.join(PUBLIC, p.slice(1))) }]));
let indexHtml = fs.readFileSync(INDEX);
fs.watchFile(INDEX, { interval: 2000 }, () => { try { indexHtml = fs.readFileSync(INDEX); } catch (e) {} });

const rooms = new Map();   // code -> room
const sockets = new Map(); // code -> Set<ws>

// 4-letter codes without look-alike letters (no I, O, L).
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ";
function newCode() {
  for (let tries = 0; tries < 1000; tries++) {
    let c = "";
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const headers = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, headers); return res.end(); }
  if (url.pathname === "/healthz") { res.writeHead(200, { ...headers, "Content-Type": "text/plain" }); return res.end(`ok ${rooms.size} rooms\n`); }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(req.method === "HEAD" ? undefined : indexHtml);
  }
  const file = STATIC[url.pathname];
  if (file) {
    res.writeHead(200, { ...headers, "Content-Type": file.type, "Cache-Control": url.pathname === "/sw.js" ? "no-cache" : "public, max-age=86400" });
    return res.end(req.method === "HEAD" ? undefined : file.body);
  }
  res.writeHead(404, { ...headers, "Content-Type": "text/plain" });
  res.end("Not found\n");
});

// Compress state messages over ~1 KB; mobile data and slow links benefit most.
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096, perMessageDeflate: { threshold: 1024 } });

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
// Several changes in the same tick (a join plus a reconnect, say) go out as one state message.
const pending = new Set();
function broadcast(code) {
  if (pending.has(code)) return;
  pending.add(code);
  setImmediate(() => {
    pending.delete(code);
    const room = rooms.get(code);
    const set = sockets.get(code);
    if (!room || !set) return;
    const data = JSON.stringify({ t: "state", state: game.publicState(room) });
    for (const ws of set) if (ws.readyState === 1) ws.send(data);
  });
}
function toRoom(code, msg) {
  const data = JSON.stringify(msg);
  for (const ws of sockets.get(code) || []) if (ws.readyState === 1) ws.send(data);
}
// Allow short bursts of reactions but not a flood: at most `max` in the last `ms`.
function allow(ws, key, max, ms) {
  const now = Date.now();
  const list = (ws[key] = (ws[key] || []).filter(t => now - t < ms));
  if (list.length >= max) return false;
  list.push(now); return true;
}
const REACTIONS = 6;
const online = (code, pid) => [...(sockets.get(code) || [])].some(s => s.pid === pid);
function attach(ws, code, pid) {
  ws.room = code; ws.pid = pid;
  if (!sockets.has(code)) sockets.set(code, new Set());
  sockets.get(code).add(ws);
}
function detach(ws) {
  const code = ws.room, pid = ws.pid;
  ws.room = null; ws.pid = null;
  const set = sockets.get(code);
  if (!set) return;
  set.delete(ws);
  if (!pid) return;
  // Wait out short drops (phone locked, page reload) before telling the room.
  setTimeout(() => {
    const room = rooms.get(code);
    if (!room || online(code, pid) || !game.player(room, pid)) return;
    game.setConnected(room, pid, false);
    broadcast(code);
    if (room.hostId === pid) setTimeout(() => {
      const r = rooms.get(code);
      if (!r || online(code, pid) || r.hostId !== pid) return;
      game.reassignHost(r);
      broadcast(code);
    }, HOST_GRACE_MS - OFFLINE_GRACE_MS);
  }, OFFLINE_GRACE_MS);
}

function hello(ws, msg) {
  const name = game.cleanName(msg.name);
  const code = String(msg.room || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  if (ws.room) detach(ws);
  let room;
  if (msg.create) {
    if (!name) return send(ws, { t: "error", msg: "Enter your name first." });
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: "error", msg: "The server is full right now. Try again in a bit." });
    const c = newCode();
    if (!c) return send(ws, { t: "error", msg: "Couldn't make a room code. Try again." });
    room = game.createRoom(c);
    rooms.set(c, room);
  } else {
    room = rooms.get(code);
    if (!room) return send(ws, { t: "error", msg: code ? `There's no room ${code}. Check the code, or create a new room.` : "Enter a room code.", code: "no_room" });
  }
  // A returning phone keeps its seat (and its drinks) by presenting its token.
  let p = msg.token && room.players.find(x => x.token === msg.token);
  if (p) {
    if (name && name !== p.name) p.name = name;
  } else {
    if (!name) return send(ws, { t: "error", msg: "Enter your name first.", code: "need_name" });
    p = game.addPlayer(room, name);
    if (!p) return send(ws, { t: "error", msg: `Room ${room.code} is full (${game.MAX_PLAYERS} players).` });
  }
  attach(ws, room.code, p.id);
  game.setConnected(room, p.id, true);
  room.lastActive = Date.now();
  send(ws, { t: "welcome", you: p.id, token: p.token, room: room.code });
  broadcast(room.code);
}

wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "ping") return send(ws, { t: "pong" });
    if (msg.t === "hello") return hello(ws, msg);
    const room = ws.room && rooms.get(ws.room);
    if (!room) return send(ws, { t: "error", msg: "You're not in a room.", code: "no_room" });
    if (msg.t === "leave") {
      const code = ws.room, pid = ws.pid;
      detach(ws);
      game.removePlayer(room, pid);
      send(ws, { t: "left" });
      if (!room.players.length) { rooms.delete(code); sockets.delete(code); } else broadcast(code);
      return;
    }
    if (msg.t === "react") {
      const e = Number(msg.e);
      if (!Number.isInteger(e) || e < 0 || e >= REACTIONS || !allow(ws, "reacts", 6, 3000)) return;
      const p = game.player(room, ws.pid);
      if (p) p.reacts += 1;
      return toRoom(room.code, { t: "react", from: ws.pid, e });
    }
    // Live swipe progress from the rider (or the horse race flipper), so everyone watches the card lift.
    if (msg.t === "drag") {
      if (!allow(ws, "drag", 30, 1000)) return;
      // p runs 0-2: 0-1 turns the card to edge-on, 1-2 turns it face up (after the server has dealt it).
      const p = Math.max(0, Math.min(2, Number(msg.p) || 0));
      const riding = room.screen === "play" && room.phase === "guess" && room.current === ws.pid;
      const flipping = (room.screen === "race" && room.race && !room.race.winner && room.race.flipper === ws.pid)
        || (room.screen === "kings" && room.kings && !room.kings.over && !room.kings.pending && room.kings.drawer === ws.pid);
      const finishing = room.ev.by === ws.pid && Date.now() - (room.phaseAt || 0) < 8000; // turning the card they just drew
      if (!riding && !flipping && !finishing) return;
      const g = riding && typeof msg.g === "string" && /^[a-zSHDC]{1,8}$/.test(msg.g) ? msg.g : undefined;
      const dir = Number(msg.dir) < 0 ? -1 : 1;
      const spd = Number.isFinite(+msg.spd) && msg.spd ? Math.round(Math.min(600, Math.max(100, +msg.spd))) : undefined;
      // "ms" is the turn's animation time; it can't be called "t", which is the message type.
      const ms = Number.isFinite(+msg.ms) && msg.ms ? Math.round(Math.min(500, Math.max(40, +msg.ms))) : undefined;
      return toRoom(room.code, { t: "drag", by: ws.pid, p, g, dir, spd, ms, seq: room.ev.seq });
    }
    if (msg.t === "nudge") {
      const to = game.player(room, msg.to);
      const k = room.kings;
      const slow = (room.screen === "play" && room.current === to.id && room.phase === "guess")
        || (room.screen === "kings" && k && !k.over && ((!k.pending && k.drawer === to.id) || (k.pending && k.pending.by === to.id && k.pending.type !== "race")));
      if (!to || to.id === ws.pid || !slow) return;
      if (!allow(ws, "nudge:" + to.id, 1, 10000)) return send(ws, { t: "error", msg: `You can nudge ${to.name} again in a few seconds.` });
      return toRoom(room.code, { t: "nudge", from: ws.pid, to: to.id });
    }
    if (msg.t === "act") {
      if (game.isStale(room, msg)) return send(ws, { t: "stale", state: game.publicState(room) });
      const err = game.act(room, ws.pid, msg);
      if (err) return send(ws, { t: "error", msg: err });
      if (msg.a === "give") toRoom(room.code, { t: "gift", from: ws.pid, to: msg.to });
      if (msg.a === "drank" && room.lastDrank) { toRoom(room.code, { t: "drank", by: ws.pid, n: room.lastDrank }); room.lastDrank = 0; }
      broadcast(room.code);
    }
  });
  ws.on("close", () => { if (ws.room) detach(ws); });
});

// Move turns on by themselves (auto-pass after a result, skip riders who've dropped).
setInterval(() => { for (const [code, room] of rooms) if (game.tick(room)) broadcast(code); }, 250).unref();

// Drop dead connections and stale rooms.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const live = [...(sockets.get(code) || [])].length;
    const idle = now - room.lastActive;
    if (idle > IDLE_ROOM_MS || (!live && idle > EMPTY_ROOM_MS)) {
      for (const ws of sockets.get(code) || []) ws.close();
      rooms.delete(code); sockets.delete(code);
    }
  }
}, 60000).unref();

server.listen(PORT, HOST, () => console.log(`F the Bus online listening on http://${HOST}:${PORT}`));
