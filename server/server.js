/**
 * server.js — Duo-fy Backend v2
 *
 * New in v2:
 * - Per-room state machine  (track, position, isPlaying, queue, updatedAt)
 * - Rich control events: play / pause / seek / skip — all carry track + position
 * - Server timestamps on every sync broadcast so clients correct for network lag
 * - Shared queue: queue-add, queue-remove, auto-advance on track-ended
 * - room-state snapshot delivered to joining / reconnecting users
 * - Clock-offset ping/pong so clients can measure their own latency
 * - All existing OAuth routes & reactions kept intact
 */

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

// ─── Environment Validation ───────────────────────────────────────────────────

const REQUIRED_ENV = [
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_REDIRECT_URI",
];

const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`[Duo-fy] Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI,
  FRONTEND_URL = "http://127.0.0.1:5173",
  PORT = 5000,
  NODE_ENV = "development",
} = process.env;

const IS_DEV = NODE_ENV !== "production";

// ─── App + Server ─────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);

// ─── Socket.io ────────────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: { origin: FRONTEND_URL, methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  pingTimeout: 20000,
  pingInterval: 10000,
});

// ─── Express Middleware ───────────────────────────────────────────────────────

app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(level, ...args) {
  const prefix = `[Duo-fy ${new Date().toISOString()}]`;
  if (level === "error") console.error(prefix, ...args);
  else if (IS_DEV) console.log(prefix, ...args);
}

function spotifyAuthHeader() {
  return (
    "Basic " +
    Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")
  );
}

function getRoomSize(roomId) {
  return io.sockets.adapter.rooms.get(roomId)?.size ?? 0;
}

// ─── Room State ───────────────────────────────────────────────────────────────
//
// roomStates: Map<roomId, RoomState>
//
// RoomState = {
//   hostSocketId : string
//   currentTrack : { id, uri, name, artists, albumArt, durationMs } | null
//   positionMs   : number   — position at `updatedAt`
//   isPlaying    : boolean
//   updatedAt    : number   — server timestamp of last state change
//   queue        : Track[]
// }

const roomStates = new Map();

function initRoomState(roomId, hostSocketId) {
  roomStates.set(roomId, {
    hostSocketId,
    currentTrack: null,
    positionMs: 0,
    isPlaying: false,
    updatedAt: Date.now(),
    queue: [],
  });
}

function getRoomState(roomId) {
  return roomStates.get(roomId) ?? null;
}

// Returns positionMs adjusted for elapsed time since last update
function getEffectivePosition(state) {
  if (!state.isPlaying) return state.positionMs;
  return state.positionMs + (Date.now() - state.updatedAt);
}

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), rooms: roomStates.size });
});

/* ══════════════════════════════════════════════════════════════════════════════
   Spotify OAuth  (unchanged from v1)
══════════════════════════════════════════════════════════════════════════════ */

app.get("/login", (_req, res) => {
  const scope = [
    "streaming",
    "user-read-email",
    "user-read-private",
    "user-modify-playback-state",
    "user-read-playback-state",
  ].join(" ");

  const authURL =
    "https://accounts.spotify.com/authorize?" +
    new URLSearchParams({
      response_type: "code",
      client_id: SPOTIFY_CLIENT_ID,
      scope,
      redirect_uri: SPOTIFY_REDIRECT_URI,
    });

  res.redirect(authURL);
});

app.get("/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    log("error", "Spotify denied access:", error);
    return res.redirect(`${FRONTEND_URL}?auth_error=access_denied`);
  }

  try {
    const response = await axios.post(
      "https://accounts.spotify.com/api/token",
      new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: SPOTIFY_REDIRECT_URI }),
      { headers: { Authorization: spotifyAuthHeader(), "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { access_token, refresh_token, expires_in } = response.data;
    res.redirect(
      `${FRONTEND_URL}/?access_token=${access_token}` +
      `&refresh_token=${refresh_token}&expires_in=${expires_in}`
    );
  } catch (err) {
    log("error", "Token exchange failed:", err.response?.data?.error ?? err.message);
    res.redirect(`${FRONTEND_URL}?auth_error=token_exchange_failed`);
  }
});

app.get("/refresh", async (req, res) => {
  const { refresh_token } = req.query;
  if (!refresh_token) return res.status(400).json({ error: "refresh_token is required" });

  try {
    const response = await axios.post(
      "https://accounts.spotify.com/api/token",
      new URLSearchParams({ grant_type: "refresh_token", refresh_token }),
      { headers: { Authorization: spotifyAuthHeader(), "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const { access_token, expires_in } = response.data;
    res.json({ access_token, expires_in });
  } catch (err) {
    log("error", "Token refresh failed:", err.response?.data?.error ?? err.message);
    res.status(500).json({ error: "Failed to refresh token" });
  }
});

/* ══════════════════════════════════════════════════════════════════════════════
   Socket.io — Room, Playback & Queue Logic
══════════════════════════════════════════════════════════════════════════════ */

const MAX_ROOM_SIZE = 2;

io.on("connection", (socket) => {
  log("info", `Socket connected: ${socket.id}`);
  let currentRoom = null;

  // ── Clock Sync Ping ────────────────────────────────────────────────────────
  // Clients send a ping with their local timestamp; the server echoes it back
  // with a server timestamp. Clients use the round-trip time to estimate their
  // own clock offset: offset = serverTimestamp - (clientSent + RTT/2)
  socket.on("ping-sync", ({ clientTimestamp } = {}) => {
    socket.emit("pong-sync", {
      clientTimestamp,
      serverTimestamp: Date.now(),
    });
  });

  // ── Create Room ────────────────────────────────────────────────────────────
  socket.on("create-room", ({ roomId } = {}, callback) => {
    if (typeof callback !== "function") return;
    if (!roomId || typeof roomId !== "string")
      return callback({ success: false, error: "Invalid room ID." });
    if (getRoomSize(roomId) > 0)
      return callback({ success: false, error: "Room ID already in use." });

    socket.join(roomId);
    currentRoom = roomId;
    initRoomState(roomId, socket.id);

    log("info", `Room created: ${roomId} by ${socket.id}`);
    callback({ success: true, roomId });
  });

  // ── Join Room ──────────────────────────────────────────────────────────────
  socket.on("join-room", ({ roomId } = {}, callback) => {
    if (typeof callback !== "function") return;
    if (!roomId || typeof roomId !== "string")
      return callback({ success: false, error: "Invalid room ID." });

    const size = getRoomSize(roomId);
    if (size === 0) return callback({ success: false, error: "Room not found." });
    if (size >= MAX_ROOM_SIZE) return callback({ success: false, error: "Room is full." });

    socket.join(roomId);
    currentRoom = roomId;
    log("info", `Socket ${socket.id} joined room: ${roomId}`);

    socket.to(roomId).emit("partner-joined");

    // Deliver current room state so the joiner can sync immediately.
    // positionMs is projected forward from the last known state update.
    const state = getRoomState(roomId);
    callback({
      success: true,
      roomId,
      roomState: state ? {
        currentTrack: state.currentTrack,
        positionMs: getEffectivePosition(state),
        isPlaying: state.isPlaying,
        queue: state.queue,
        serverTimestamp: Date.now(),
      } : null,
    });
  });

  // ── Request State  (reconnect / tab visibility restore) ───────────────────
  socket.on("request-state", ({ roomId } = {}) => {
    if (!roomId || !socket.rooms.has(roomId)) return;
    const state = getRoomState(roomId);
    if (!state) return;

    socket.emit("room-state", {
      currentTrack: state.currentTrack,
      positionMs: getEffectivePosition(state),
      isPlaying: state.isPlaying,
      queue: state.queue,
      serverTimestamp: Date.now(),
    });
  });

  // ── Leave Room ─────────────────────────────────────────────────────────────
  socket.on("leave-room", ({ roomId } = {}) => {
    if (!roomId) return;
    socket.leave(roomId);
    socket.to(roomId).emit("partner-left");
    currentRoom = null;

    if (getRoomSize(roomId) === 0) {
      roomStates.delete(roomId);
      log("info", `Room ${roomId} cleaned up (empty)`);
    }
  });

  // ── Playback Control ───────────────────────────────────────────────────────
  //
  // Unified "control" event payload:
  // {
  //   event      : "play" | "pause" | "seek" | "skip"
  //   roomId     : string
  //   track?     : Track     — required for "play" (new track)
  //   trackId?   : string    — for "pause"/"seek" (stale-event guard)
  //   positionMs?: number    — position at the moment the action fired
  // }
  //
  // Server rebroadcasts to the PARTNER only (sender already acted locally)
  // for play/pause/seek, and to BOTH for skip (authoritative queue advance).

  socket.on("control", (payload = {}) => {
    const { event, roomId, track, trackId, positionMs = 0 } = payload;

    if (!roomId || !event) return;
    if (!["play", "pause", "seek", "skip"].includes(event)) return;
    if (!socket.rooms.has(roomId)) {
      log("info", `Unauthorized control by ${socket.id} for room ${roomId}`);
      return;
    }

    const state = getRoomState(roomId);
    if (!state) return;

    const serverTimestamp = Date.now();

    if (event === "play") {
      const resolvedTrack = track ?? state.currentTrack;
      if (!resolvedTrack) return;

      Object.assign(state, {
        currentTrack: resolvedTrack,
        positionMs,
        isPlaying: true,
        updatedAt: serverTimestamp,
      });

      socket.to(roomId).emit("sync-play", {
        track: resolvedTrack,
        positionMs,
        serverTimestamp,
      });

      log("info", `sync-play → room ${roomId} | "${resolvedTrack.name}" @ ${positionMs}ms`);
    }

    else if (event === "pause") {
      if (trackId && state.currentTrack?.id !== trackId) return; // stale

      Object.assign(state, {
        positionMs,
        isPlaying: false,
        updatedAt: serverTimestamp,
      });

      socket.to(roomId).emit("sync-pause", {
        trackId: state.currentTrack?.id,
        positionMs,
        serverTimestamp,
      });

      log("info", `sync-pause → room ${roomId} @ ${positionMs}ms`);
    }

    else if (event === "seek") {
      if (trackId && state.currentTrack?.id !== trackId) return;

      Object.assign(state, {
        positionMs,
        updatedAt: serverTimestamp,
        // isPlaying unchanged — seek doesn't toggle play/pause
      });

      socket.to(roomId).emit("sync-seek", {
        trackId: state.currentTrack?.id,
        positionMs,
        serverTimestamp,
      });

      log("info", `sync-seek → room ${roomId} @ ${positionMs}ms`);
    }

    else if (event === "skip") {
      if (state.queue.length === 0) {
        Object.assign(state, { isPlaying: false, positionMs: 0, updatedAt: serverTimestamp });
        io.to(roomId).emit("queue-ended", { serverTimestamp });
        return;
      }

      const nextTrack = state.queue.shift();
      Object.assign(state, {
        currentTrack: nextTrack,
        positionMs: 0,
        isPlaying: true,
        updatedAt: serverTimestamp,
      });

      // Broadcast to BOTH so they start the same next track in unison
      io.to(roomId).emit("sync-play", { track: nextTrack, positionMs: 0, serverTimestamp, fromQueue: true });
      io.to(roomId).emit("queue-updated", { queue: state.queue, serverTimestamp });

      log("info", `skip → room ${roomId}, now: "${nextTrack.name}"`);
    }
  });

  // ── Track Ended (auto-advance) ─────────────────────────────────────────────
  // Either client may emit this. Server deduplicates via trackId comparison.
  // { roomId, trackId }
  socket.on("track-ended", ({ roomId, trackId } = {}) => {
    if (!roomId || !socket.rooms.has(roomId)) return;

    const state = getRoomState(roomId);
    if (!state) return;
    if (state.currentTrack?.id !== trackId) return; // already advanced or stale

    const serverTimestamp = Date.now();

    if (state.queue.length === 0) {
      Object.assign(state, { isPlaying: false, positionMs: 0, updatedAt: serverTimestamp });
      io.to(roomId).emit("queue-ended", { serverTimestamp });
      log("info", `Queue exhausted in room ${roomId}`);
      return;
    }

    const nextTrack = state.queue.shift();
    Object.assign(state, {
      currentTrack: nextTrack,
      positionMs: 0,
      isPlaying: true,
      updatedAt: serverTimestamp,
    });

    io.to(roomId).emit("sync-play", { track: nextTrack, positionMs: 0, serverTimestamp, fromQueue: true });
    io.to(roomId).emit("queue-updated", { queue: state.queue, serverTimestamp });

    log("info", `Auto-advance → "${nextTrack.name}" in room ${roomId}`);
  });

  // ── Queue Management ───────────────────────────────────────────────────────

  // queue-add: { roomId, track }
  socket.on("queue-add", ({ roomId, track } = {}) => {
    if (!roomId || !track?.id || !track?.uri) return;
    if (!socket.rooms.has(roomId)) return;

    const state = getRoomState(roomId);
    if (!state) return;

    state.queue.push(track);

    // If nothing is playing, start this track immediately for both users
    if (!state.currentTrack) {
      const serverTimestamp = Date.now();
      const first = state.queue.shift();
      Object.assign(state, { currentTrack: first, positionMs: 0, isPlaying: true, updatedAt: serverTimestamp });
      io.to(roomId).emit("sync-play", { track: first, positionMs: 0, serverTimestamp, fromQueue: true });
    }

    io.to(roomId).emit("queue-updated", { queue: state.queue, serverTimestamp: Date.now() });
    log("info", `queue-add: "${track.name}" → room ${roomId}`);
  });

  // queue-remove: { roomId, index }
  socket.on("queue-remove", ({ roomId, index } = {}) => {
    if (!roomId || index == null) return;
    if (!socket.rooms.has(roomId)) return;

    const state = getRoomState(roomId);
    if (!state || index < 0 || index >= state.queue.length) return;

    const [removed] = state.queue.splice(index, 1);
    io.to(roomId).emit("queue-updated", { queue: state.queue, serverTimestamp: Date.now() });
    log("info", `queue-remove: "${removed?.name}" at [${index}] in room ${roomId}`);
  });

  // ── Reactions  (unchanged — kept for compatibility) ────────────────────────
  socket.on("reaction", ({ roomId, emoji, timestamp } = {}) => {
    if (!roomId || !emoji) return;
    if (!socket.rooms.has(roomId)) return;
    socket.to(roomId).emit("reaction", { emoji, timestamp: timestamp ?? Date.now() });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on("disconnect", (reason) => {
    log("info", `Socket disconnected: ${socket.id} — reason: ${reason}`);
    if (currentRoom) {
      socket.to(currentRoom).emit("partner-left");
      if (getRoomSize(currentRoom) === 0) {
        roomStates.delete(currentRoom);
        log("info", `Room ${currentRoom} cleaned up after disconnect`);
      }
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   Start Server + Graceful Shutdown
══════════════════════════════════════════════════════════════════════════════ */

server.listen(PORT, () => {
  log("info", `Server running on http://localhost:${PORT} [${NODE_ENV}]`);
});

function shutdown(signal) {
  log("info", `${signal} received — shutting down gracefully`);
  io.close();
  server.close(() => { log("info", "HTTP server closed."); process.exit(0); });
  setTimeout(() => process.exit(1), 8000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));