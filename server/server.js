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

const INDEX = path.join(__dirname, "..", "public", "index.html");
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
  res.writeHead(404, { ...headers, "Content-Type": "text/plain" });
  res.end("Not found\n");
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(code) {
  const room = rooms.get(code);
  const set = sockets.get(code);
  if (!room || !set) return;
  const data = JSON.stringify({ t: "state", state: game.publicState(room) });
  for (const ws of set) if (ws.readyState === 1) ws.send(data);
}
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
  const room = rooms.get(code);
  if (room && pid && ![...set].some(s => s.pid === pid)) { game.setConnected(room, pid, false); broadcast(code); }
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
    if (msg.t === "act") {
      const err = game.act(room, ws.pid, msg);
      if (err) return send(ws, { t: "error", msg: err });
      broadcast(room.code);
    }
  });
  ws.on("close", () => { if (ws.room) detach(ws); });
});

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
