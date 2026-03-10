/**
 * useSync.js — Duo-fy v3
 *
 * ROOT CAUSES FIXED:
 *  1. applySyncPlay guarded with `if (!playerReadyRef.current) return`
 *     → On mobile (Connect mode), playerReady is true once a device is found,
 *       so this now works. But we also add a device-refresh fallback on 404.
 *  2. Auto-advance (fromQueue sync-play) was blocked on mobile by the same guard.
 *     Fix: guard lifted; REST play is attempted regardless of SDK mode.
 *  3. Track-end detection fired from progress interpolation every 500 ms,
 *     causing multiple `track-ended` emissions per song end.
 *     Fix: single dedup ref + 2-second cooldown.
 *  4. Drift correction ran even when the player was paused, causing spurious seeks.
 *     Fix: only correct drift when both isPlaying AND playerReady.
 *  5. useSync imported spotifySeek/Play/Pause from a relative path that assumed
 *     a flat hooks/ directory — now uses the correct import.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import socketService from "../socket";
import {
    spotifyPlay,
    spotifyPause,
    spotifySeek,
    getActiveSpotifyDevice,
} from "./useSpotifyPlayer";

// ── Constants ─────────────────────────────────────────────────────────────────

const DRIFT_THRESHOLD_MS = 400;   // seek to re-sync if drift exceeds this
const DRIFT_CHECK_INTERVAL_MS = 3000; // how often to check for drift
const TRACK_END_THRESHOLD_MS = 2000; // emit track-ended this many ms before track ends
const TRACK_END_COOLDOWN_MS = 4000; // minimum gap between two track-ended emits

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useSync({
    roomId,
    accessToken,
    deviceId,
    playerReady,
    spotifyTrack,
    progressMs,
    durationMs,
    spotifyIsPlaying,
}) {
    const [syncTrack, setSyncTrack] = useState(null);
    const [syncIsPlaying, setSyncIsPlaying] = useState(false);

    // Stable refs — always hold the latest prop values in async callbacks
    const accessTokenRef = useRef(accessToken);
    const deviceIdRef = useRef(deviceId);
    const playerReadyRef = useRef(playerReady);
    const progressMsRef = useRef(progressMs);
    const roomIdRef = useRef(roomId);

    useEffect(() => { accessTokenRef.current = accessToken; }, [accessToken]);
    useEffect(() => { deviceIdRef.current = deviceId; }, [deviceId]);
    useEffect(() => { playerReadyRef.current = playerReady; }, [playerReady]);
    useEffect(() => { progressMsRef.current = progressMs; }, [progressMs]);
    useEffect(() => { roomIdRef.current = roomId; }, [roomId]);

    // Internal sync state for drift correction
    const syncStateRef = useRef({
        positionMs: 0,
        serverTimestamp: Date.now(),
        isPlaying: false,
        trackId: null,
    });

    const trackEndedEmittedRef = useRef(null);   // trackId of the last track-ended emission
    const trackEndedAtRef = useRef(0);      // timestamp of the last emission (cooldown)
    const recentSkipRef = useRef(false);  // true if WE just triggered a skip
    const clockOffsetRef = useRef(0);      // estimated ms offset: server clock - local clock

    // ── Clock offset measurement ───────────────────────────────────────────────
    useEffect(() => {
        if (!roomId) return;
        socketService.measureLatency().then(({ clockOffset }) => {
            clockOffsetRef.current = clockOffset;
            console.log(`[useSync] Clock offset: ${Math.round(clockOffset)}ms`);
        });
    }, [roomId]);

    // ── Latency-corrected seek position ───────────────────────────────────────
    const computeAdjustedPosition = useCallback((posMs, serverTs) => {
        const serverInLocal = serverTs + clockOffsetRef.current;
        const transit = Math.max(0, Date.now() - serverInLocal);
        return posMs + transit;
    }, []);

    // ── Core: attempt Spotify playback, refresh device on 404 ─────────────────
    const attemptPlay = useCallback(async (track, positionMs) => {
        const token = accessTokenRef.current;
        const deviceId = deviceIdRef.current;

        try {
            await spotifyPlay(token, deviceId, {
                uris: [track.uri],
                position_ms: Math.round(positionMs),
            });
            console.log(`[useSync] Playing "${track.name}" @ ${Math.round(positionMs)}ms`);
        } catch (err) {
            if (err.status === 404) {
                // Device was lost — try to find a fresh one and retry once
                console.warn("[useSync] Device not found, searching for active device…");
                const freshId = await getActiveSpotifyDevice(token);
                if (freshId) {
                    deviceIdRef.current = freshId;
                    await spotifyPlay(token, freshId, {
                        uris: [track.uri],
                        position_ms: Math.round(positionMs),
                    }).catch(e => console.error("[useSync] Retry failed:", e.message));
                }
            } else if (err.status === 401) {
                console.warn("[useSync] Token expired during play");
            } else {
                console.error("[useSync] spotifyPlay error:", err.message);
            }
        }
    }, []);

    // ── Incoming sync handlers ─────────────────────────────────────────────────

    const applySyncPlay = useCallback(async ({ track, positionMs, serverTimestamp }) => {
        if (!track?.uri) return;

        const adjusted = computeAdjustedPosition(positionMs, serverTimestamp);

        setSyncTrack(track);
        setSyncIsPlaying(true);
        syncStateRef.current = {
            positionMs: adjusted,
            serverTimestamp: Date.now(),
            isPlaying: true,
            trackId: track.id,
        };
        trackEndedEmittedRef.current = null; // reset for the new track

        // Attempt play regardless of SDK mode — works for both "sdk" and "connect"
        await attemptPlay(track, adjusted);
    }, [computeAdjustedPosition, attemptPlay]);

    const applySyncPause = useCallback(async ({ positionMs }) => {
        setSyncIsPlaying(false);
        syncStateRef.current = {
            ...syncStateRef.current,
            positionMs,
            serverTimestamp: Date.now(),
            isPlaying: false,
        };

        try {
            await spotifyPause(accessTokenRef.current);
        } catch (err) {
            console.warn("[useSync] Pause error:", err.message);
        }
    }, []);

    const applySyncSeek = useCallback(async ({ positionMs, serverTimestamp }) => {
        const adjusted = computeAdjustedPosition(positionMs, serverTimestamp);
        syncStateRef.current = {
            ...syncStateRef.current,
            positionMs: adjusted,
            serverTimestamp: Date.now(),
        };

        try {
            await spotifySeek(accessTokenRef.current, Math.round(adjusted));
        } catch (err) {
            console.warn("[useSync] Seek error:", err.message);
        }
    }, [computeAdjustedPosition]);

    // ── Socket listeners ───────────────────────────────────────────────────────
    useEffect(() => {
        if (!roomId) return;

        const offPlay = socketService.on("sync-play", applySyncPlay);
        const offPause = socketService.on("sync-pause", applySyncPause);
        const offSeek = socketService.on("sync-seek", applySyncSeek);

        const offState = socketService.on("room-state", async (state) => {
            if (!state?.currentTrack) return;

            console.log("[useSync] Room state received:", state.currentTrack.name, state.isPlaying);
            setSyncTrack(state.currentTrack);
            setSyncIsPlaying(state.isPlaying);

            if (state.isPlaying) {
                const adjusted = computeAdjustedPosition(state.positionMs, state.serverTimestamp);
                syncStateRef.current = {
                    positionMs: adjusted,
                    serverTimestamp: Date.now(),
                    isPlaying: true,
                    trackId: state.currentTrack.id,
                };
                await attemptPlay(state.currentTrack, adjusted);
            }
        });

        const offQueueEnded = socketService.on("queue-ended", () => {
            console.log("[useSync] Queue ended");
            setSyncIsPlaying(false);
            syncStateRef.current = { ...syncStateRef.current, isPlaying: false };
        });

        return () => { offPlay(); offPause(); offSeek(); offState(); offQueueEnded(); };
    }, [roomId, applySyncPlay, applySyncPause, applySyncSeek, computeAdjustedPosition, attemptPlay]);

    // ── Drift correction ───────────────────────────────────────────────────────
    useEffect(() => {
        if (!roomId) return;

        const id = setInterval(() => {
            const s = syncStateRef.current;
            // Only correct drift when actually playing AND a player device exists
            if (!s.isPlaying || !playerReadyRef.current || !deviceIdRef.current) return;

            const expectedMs = s.positionMs + (Date.now() - s.serverTimestamp);
            const actualMs = progressMsRef.current;
            const drift = Math.abs(expectedMs - actualMs);

            if (drift > DRIFT_THRESHOLD_MS) {
                console.log(`[useSync] Drift ${Math.round(drift)}ms → correcting to ${Math.round(expectedMs)}ms`);
                spotifySeek(accessTokenRef.current, Math.round(expectedMs)).catch(() => { });
            }
        }, DRIFT_CHECK_INTERVAL_MS);

        return () => clearInterval(id);
    }, [roomId]);

    // ── Track-end detection ────────────────────────────────────────────────────
    // Two triggers (belt + suspenders). Both are gated by the same dedup ref
    // AND a cooldown to prevent double-fires during the Spotify poll window.

    const maybeEmitTrackEnded = useCallback((trackId) => {
        if (!trackId) return;
        if (trackEndedEmittedRef.current === trackId) return;
        if (Date.now() - trackEndedAtRef.current < TRACK_END_COOLDOWN_MS) return;
        if (recentSkipRef.current) return;

        trackEndedEmittedRef.current = trackId;
        trackEndedAtRef.current = Date.now();
        console.log("[useSync] Track ended:", trackId);
        socketService.emitTrackEnded(roomIdRef.current, trackId);
    }, []);

    // Trigger 1: track changes naturally (Spotify moves to next)
    const prevTrackIdRef = useRef(null);
    useEffect(() => {
        const currentId = spotifyTrack?.id ?? null;
        const prevId = prevTrackIdRef.current;

        if (prevId && currentId && currentId !== prevId && !recentSkipRef.current) {
            maybeEmitTrackEnded(prevId);
        }

        prevTrackIdRef.current = currentId;
    }, [spotifyTrack, maybeEmitTrackEnded]);

    // Trigger 2: progress crosses the end-of-track threshold
    useEffect(() => {
        if (!spotifyIsPlaying || !durationMs || !spotifyTrack) return;
        const remaining = durationMs - progressMs;

        if (remaining > 0 && remaining <= TRACK_END_THRESHOLD_MS) {
            maybeEmitTrackEnded(spotifyTrack.id);
        }
    }, [progressMs, durationMs, spotifyTrack, spotifyIsPlaying, maybeEmitTrackEnded]);

    // ── Outbound controls ──────────────────────────────────────────────────────

    const play = useCallback(async (track, positionMs = 0) => {
        if (!track?.uri) return;

        setSyncTrack(track);
        setSyncIsPlaying(true);
        syncStateRef.current = {
            positionMs,
            serverTimestamp: Date.now(),
            isPlaying: true,
            trackId: track.id,
        };
        trackEndedEmittedRef.current = null;

        await attemptPlay(track, positionMs);
        socketService.emitPlay(roomIdRef.current, track, positionMs);
    }, [attemptPlay]);

    const pause = useCallback(async (trackId, positionMs) => {
        setSyncIsPlaying(false);
        syncStateRef.current = { ...syncStateRef.current, isPlaying: false, positionMs };

        try {
            await spotifyPause(accessTokenRef.current);
        } catch (err) {
            console.warn("[useSync] Pause error:", err.message);
        }

        socketService.emitPause(roomIdRef.current, trackId, positionMs);
    }, []);

    const seek = useCallback(async (trackId, positionMs) => {
        syncStateRef.current = {
            ...syncStateRef.current,
            positionMs,
            serverTimestamp: Date.now(),
        };

        try {
            await spotifySeek(accessTokenRef.current, Math.round(positionMs));
        } catch (err) {
            console.warn("[useSync] Seek error:", err.message);
        }

        socketService.emitSeek(roomIdRef.current, trackId, positionMs);
    }, []);

    const skipNext = useCallback(() => {
        recentSkipRef.current = true;
        setTimeout(() => { recentSkipRef.current = false; }, 4000);
        socketService.emitSkip(roomIdRef.current);
    }, []);

    return {
        syncTrack,
        syncIsPlaying,
        controls: { play, pause, seek, skipNext },
    };
}