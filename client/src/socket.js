/**
 * socket.js — Duo-fy Socket Service v2
 *
 * New in v2:
 * - emitControl()      — unified play / pause / seek / skip emitter
 * - emitTrackEnded()   — signal natural track completion for auto-advance
 * - emitQueueAdd()     — add a track to the shared room queue
 * - emitQueueRemove()  — remove a track from the shared room queue
 * - measureLatency()   — ping/pong clock-offset measurement
 * - requestRoomState() — ask server for a full state snapshot (reconnect / tab restore)
 *
 * Backward-compatible: emitPlay / emitPause / emitReaction are kept.
 */

import { io } from "socket.io-client";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";
const IS_DEV = import.meta.env.DEV;

const socket = io(BACKEND_URL, {
  autoConnect: false,
  transports: ["websocket"],
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1500,
  reconnectionDelayMax: 5000,
  timeout: 10000,
});

if (IS_DEV) {
  socket.onAny((event, ...args) =>
    console.log(`[Duo-fy ↓] "${event}"`, ...args)
  );
  socket.onAnyOutgoing((event, ...args) =>
    console.log(`[Duo-fy ↑] "${event}"`, ...args)
  );
  socket.on("connect", () => console.log(`[Duo-fy] Connected — id: ${socket.id}`));
  socket.on("disconnect", (r) => console.warn(`[Duo-fy] Disconnected — ${r}`));
  socket.on("connect_error", (e) => console.error(`[Duo-fy] Error — ${e.message}`));
}

const socketService = {
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  connect() { if (!socket.connected) socket.connect(); },
  disconnect() { socket.disconnect(); },
  get id() { return socket.id; },
  get connected() { return socket.connected; },

  // ── Room ───────────────────────────────────────────────────────────────────

  createRoom(roomId, userInfo = {}) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Server did not respond in time.")), 8000);
      socket.emit("create-room", { roomId, ...userInfo }, (res) => {
        clearTimeout(t);
        res?.success ? resolve(res) : reject(new Error(res?.error || "Failed to create room."));
      });
    });
  },

  /**
   * joinRoom now resolves with { roomId, roomState } where roomState carries
   * the full current playback snapshot so the joiner can sync immediately.
   */
  joinRoom(roomId, userInfo = {}) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Server did not respond in time.")), 8000);
      socket.emit("join-room", { roomId, ...userInfo }, (res) => {
        clearTimeout(t);
        res?.success ? resolve(res) : reject(new Error(res?.error || "Room not found."));
      });
    });
  },

  leaveRoom(roomId) { socket.emit("leave-room", { roomId }); },

  /**
   * Ask the server to re-send the current room state snapshot.
   * Useful after tab/window visibility is restored, or after a brief disconnect.
   */
  requestRoomState(roomId) {
    socket.emit("request-state", { roomId });
  },

  // ── Playback Control ───────────────────────────────────────────────────────

  /**
   * Unified control emitter.
   *
   * @param {string}  roomId
   * @param {"play"|"pause"|"seek"|"skip"} event
   * @param {object}  [meta]
   *   - track      : Track object (required for "play" with a new track)
   *   - trackId    : string       (for "pause" / "seek")
   *   - positionMs : number       (current playback position in ms)
   */
  emitControl(roomId, event, meta = {}) {
    socket.emit("control", {
      event,
      roomId,
      ...meta,
    });
  },

  // Convenience wrappers ──────────────────────────────────────────────────────

  emitPlay(roomId, track, positionMs = 0) {
    this.emitControl(roomId, "play", { track, positionMs });
  },

  emitPause(roomId, trackId, positionMs = 0) {
    this.emitControl(roomId, "pause", { trackId, positionMs });
  },

  emitSeek(roomId, trackId, positionMs) {
    this.emitControl(roomId, "seek", { trackId, positionMs });
  },

  emitSkip(roomId) {
    this.emitControl(roomId, "skip");
  },

  /**
   * Signal that the current track has ended naturally.
   * The server uses this to auto-advance the queue.
   * Both clients may emit; the server deduplicates via trackId.
   */
  emitTrackEnded(roomId, trackId) {
    socket.emit("track-ended", { roomId, trackId });
  },

  // ── Queue ──────────────────────────────────────────────────────────────────

  /**
   * Add a track to the shared room queue.
   * @param {string} roomId
   * @param {{ id, uri, name, artists, albumArt, durationMs }} track
   */
  emitQueueAdd(roomId, track) {
    socket.emit("queue-add", { roomId, track });
  },

  /**
   * Remove the track at `index` from the shared queue.
   */
  emitQueueRemove(roomId, index) {
    socket.emit("queue-remove", { roomId, index });
  },

  // ── Reactions  (unchanged) ─────────────────────────────────────────────────
  emitReaction(roomId, emoji) {
    socket.emit("reaction", { roomId, emoji, timestamp: Date.now() });
  },

  // ── Latency Measurement ───────────────────────────────────────────────────
  /**
   * Sends a ping-sync and resolves with:
   *   { rtt, clockOffset }
   *
   * clockOffset: estimated ms difference between server clock and local clock.
   *   Add this to any serverTimestamp to convert it to local time.
   *
   * Usage:
   *   const { rtt, clockOffset } = await socketService.measureLatency();
   *   const localEquivalent = serverTimestamp + clockOffset;
   */
  measureLatency() {
    return new Promise((resolve) => {
      const clientSent = Date.now();

      const handler = ({ clientTimestamp, serverTimestamp }) => {
        const clientReceived = Date.now();
        const rtt = clientReceived - clientTimestamp;
        const clockOffset = serverTimestamp - (clientTimestamp + rtt / 2);
        resolve({ rtt, clockOffset });
      };

      socket.once("pong-sync", handler);
      socket.emit("ping-sync", { clientTimestamp: clientSent });

      // Safety timeout
      setTimeout(() => {
        socket.off("pong-sync", handler);
        resolve({ rtt: 0, clockOffset: 0 });
      }, 3000);
    });
  },

  // ── Listeners ─────────────────────────────────────────────────────────────
  on(event, handler) {
    socket.on(event, handler);
    return () => socket.off(event, handler);
  },
  off(event, handler) { socket.off(event, handler); },
  once(event, handler) { socket.once(event, handler); },
};

export default socketService;