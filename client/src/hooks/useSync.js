/**
 * useSync.js — Duo-fy Playback Synchronisation Hook
 *
 * Responsibilities:
 *  1. Listens for sync events from the partner  (sync-play, sync-pause, sync-seek, room-state)
 *  2. Corrects for network latency using server timestamps
 *  3. Runs a periodic drift-check every 3 s — auto-seeks if drift > DRIFT_THRESHOLD
 *  4. Detects natural track end and emits track-ended for auto-queue-advance
 *  5. Exposes play / pause / seek / skip controls that act locally AND emit to partner
 *
 * Usage in Room.jsx:
 *
 *   const { spotifyTrack, progressMs, durationMs, isPlaying } = useSpotify(token, onExpired);
 *   const { playerReady, deviceId } = useSpotifyPlayer(token);
 *
 *   const { syncTrack, syncIsPlaying, controls } = useSync({
 *     roomId,
 *     accessToken: token,
 *     deviceId,
 *     playerReady,
 *     spotifyTrack,      // from useSpotify — used for track-end detection
 *     progressMs,        // from useSpotify — used for drift correction
 *     durationMs,        // from useSpotify — used for track-end detection
 *     spotifyIsPlaying,  // from useSpotify — used for track-end detection
 *   });
 *
 *   // Use controls.play / pause / seek / skip in your UI
 */

import { useEffect, useRef, useState, useCallback } from "react";
import socketService from "../socket";
import {
    spotifyPlay,
    spotifyPause,
    spotifySeek,
} from "./useSpotifyPlayer";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Auto-seek to correct position when drift exceeds this many milliseconds. */
const DRIFT_THRESHOLD_MS = 400;

/** How often (ms) to run the drift correction check while playing. */
const DRIFT_CHECK_INTERVAL_MS = 3000;

/**
 * Minimum ms before end-of-track to emit track-ended.
 * Prevents double-fire during the Spotify polling window.
 */
const TRACK_END_THRESHOLD_MS = 1500;

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {string}      params.roomId
 * @param {string}      params.accessToken
 * @param {string|null} params.deviceId
 * @param {boolean}     params.playerReady
 * @param {object|null} params.spotifyTrack      — current track from useSpotify
 * @param {number}      params.progressMs        — interpolated position from useSpotify
 * @param {number}      params.durationMs        — track duration from useSpotify
 * @param {boolean}     params.spotifyIsPlaying  — isPlaying from useSpotify
 */
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
    // The sync state as known from the last Socket event (or room-state snapshot)
    const [syncTrack, setSyncTrack] = useState(null);
    const [syncIsPlaying, setSyncIsPlaying] = useState(false);

    // Ref mirrors so async callbacks always read the latest values
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

    /**
     * Internal sync state ref used for drift correction.
     * {
     *   positionMs      : number  — position at the time of the last sync event
     *   serverTimestamp : number  — local time when the event was processed
     *   isPlaying       : boolean
     *   trackId         : string | null
     * }
     */
    const syncStateRef = useRef({
        positionMs: 0,
        serverTimestamp: Date.now(),
        isPlaying: false,
        trackId: null,
    });

    // Tracks the last trackId for which we emitted track-ended (dedup guard)
    const trackEndedEmittedRef = useRef(null);

    // Tracks whether WE triggered the most recent skip (avoids false track-end detect)
    const recentSkipRef = useRef(false);

    // Estimated clock offset between server and local clock (ms)
    // Positive = server is ahead; add to server timestamps to get local equivalents
    const clockOffsetRef = useRef(0);

    // ── Measure clock offset on mount ─────────────────────────────────────────
    useEffect(() => {
        if (!roomId) return;
        socketService.measureLatency().then(({ clockOffset }) => {
            clockOffsetRef.current = clockOffset;
        });
    }, [roomId]);

    // ── Adjust position for network latency ───────────────────────────────────
    /**
     * Given a server-stamped positionMs and serverTimestamp, returns the
     * best estimate of what position to seek to RIGHT NOW so both clients land
     * in sync.
     *
     * adjusted = positionMs + (now_local - serverTimestamp_in_local_time)
     *          = positionMs + (now_local - (serverTimestamp + clockOffset))
     */
    const computeAdjustedPosition = useCallback((positionMs, serverTimestamp) => {
        const serverInLocal = serverTimestamp + clockOffsetRef.current;
        const transit = Math.max(0, Date.now() - serverInLocal);
        return positionMs + transit;
    }, []);

    // ── Apply a sync event from the partner ───────────────────────────────────
    const applySyncPlay = useCallback(async ({ track, positionMs, serverTimestamp }) => {
        if (!playerReadyRef.current) return;

        const adjusted = computeAdjustedPosition(positionMs, serverTimestamp);

        setSyncTrack(track);
        setSyncIsPlaying(true);
        syncStateRef.current = {
            positionMs: adjusted,
            serverTimestamp: Date.now(),
            isPlaying: true,
            trackId: track?.id ?? null,
        };

        await spotifyPlay(accessTokenRef.current, deviceIdRef.current, {
            uris: [track.uri],
            position_ms: Math.round(adjusted),
        });
    }, [computeAdjustedPosition]);

    const applySyncPause = useCallback(async ({ positionMs, serverTimestamp }) => {
        if (!playerReadyRef.current) return;

        setSyncIsPlaying(false);
        syncStateRef.current = {
            ...syncStateRef.current,
            positionMs,
            serverTimestamp: Date.now(),
            isPlaying: false,
        };

        await spotifyPause(accessTokenRef.current);
    }, []);

    const applySyncSeek = useCallback(async ({ positionMs, serverTimestamp }) => {
        if (!playerReadyRef.current) return;

        const adjusted = computeAdjustedPosition(positionMs, serverTimestamp);

        syncStateRef.current = {
            ...syncStateRef.current,
            positionMs: adjusted,
            serverTimestamp: Date.now(),
        };

        await spotifySeek(accessTokenRef.current, Math.round(adjusted));
    }, [computeAdjustedPosition]);

    // ── Socket Listeners ──────────────────────────────────────────────────────
    useEffect(() => {
        if (!roomId) return;

        const offPlay = socketService.on("sync-play", applySyncPlay);
        const offPause = socketService.on("sync-pause", applySyncPause);
        const offSeek = socketService.on("sync-seek", applySyncSeek);

        // Full room state snapshot — received on join or after request-state
        const offState = socketService.on("room-state", async (state) => {
            if (!state?.currentTrack) return;
            setSyncTrack(state.currentTrack);
            setSyncIsPlaying(state.isPlaying);

            if (state.isPlaying && playerReadyRef.current) {
                const adjusted = computeAdjustedPosition(state.positionMs, state.serverTimestamp);
                syncStateRef.current = {
                    positionMs: adjusted,
                    serverTimestamp: Date.now(),
                    isPlaying: true,
                    trackId: state.currentTrack.id,
                };
                await spotifyPlay(accessTokenRef.current, deviceIdRef.current, {
                    uris: [state.currentTrack.uri],
                    position_ms: Math.round(adjusted),
                });
            }
        });

        const offQueueEnded = socketService.on("queue-ended", () => {
            setSyncIsPlaying(false);
            syncStateRef.current = { ...syncStateRef.current, isPlaying: false };
        });

        return () => { offPlay(); offPause(); offSeek(); offState(); offQueueEnded(); };
    }, [roomId, applySyncPlay, applySyncPause, applySyncSeek, computeAdjustedPosition]);

    // ── Drift Correction ──────────────────────────────────────────────────────
    useEffect(() => {
        if (!roomId) return;

        const id = setInterval(() => {
            const syncState = syncStateRef.current;
            if (!syncState.isPlaying || !playerReadyRef.current) return;

            // Expected position = last known position + elapsed time
            const expectedMs = syncState.positionMs + (Date.now() - syncState.serverTimestamp);
            const actualMs = progressMsRef.current;
            const drift = Math.abs(expectedMs - actualMs);

            if (drift > DRIFT_THRESHOLD_MS) {
                console.log(`[useSync] Drift ${Math.round(drift)}ms — correcting to ${Math.round(expectedMs)}ms`);
                spotifySeek(accessTokenRef.current, Math.round(expectedMs)).catch(() => { });
            }
        }, DRIFT_CHECK_INTERVAL_MS);

        return () => clearInterval(id);
    }, [roomId]);

    // ── Track-End Detection ───────────────────────────────────────────────────
    const prevTrackRef = useRef(null);

    useEffect(() => {
        const currentId = spotifyTrack?.id ?? null;
        const prevId = prevTrackRef.current?.id ?? null;

        // Detect natural track end: was playing, progress near duration, track disappeared / changed
        if (
            prevId &&
            currentId !== prevId &&
            !recentSkipRef.current &&
            trackEndedEmittedRef.current !== prevId
        ) {
            trackEndedEmittedRef.current = prevId;
            socketService.emitTrackEnded(roomIdRef.current, prevId);
        }

        prevTrackRef.current = spotifyTrack;
    }, [spotifyTrack]);

    // Also detect end-of-track via progress reaching near durationMs
    useEffect(() => {
        if (!spotifyIsPlaying || !durationMs || !spotifyTrack) return;
        const remaining = durationMs - progressMs;

        if (
            remaining > 0 &&
            remaining <= TRACK_END_THRESHOLD_MS &&
            trackEndedEmittedRef.current !== spotifyTrack.id
        ) {
            trackEndedEmittedRef.current = spotifyTrack.id;
            socketService.emitTrackEnded(roomIdRef.current, spotifyTrack.id);
        }
    }, [progressMs, durationMs, spotifyTrack, spotifyIsPlaying]);

    // ── Outbound Controls ─────────────────────────────────────────────────────
    /**
     * Call these from your UI instead of calling Spotify directly.
     * They execute the action locally AND emit the sync event to the partner.
     */

    /**
     * Start playing a track (or resume current).
     * @param {object} track  — { id, uri, name, artists, albumArt, durationMs }
     * @param {number} [positionMs=0]
     */
    const play = useCallback(async (track, positionMs = 0) => {
        if (!playerReadyRef.current || !track) return;

        setSyncTrack(track);
        setSyncIsPlaying(true);

        const now = Date.now();
        syncStateRef.current = {
            positionMs,
            serverTimestamp: now,
            isPlaying: true,
            trackId: track.id,
        };
        trackEndedEmittedRef.current = null;

        await spotifyPlay(accessTokenRef.current, deviceIdRef.current, {
            uris: [track.uri],
            position_ms: Math.round(positionMs),
        });

        socketService.emitPlay(roomIdRef.current, track, positionMs);
    }, []);

    /**
     * Pause playback.
     * @param {string} trackId   — current track ID (stale-event guard on server)
     * @param {number} positionMs — current position
     */
    const pause = useCallback(async (trackId, positionMs) => {
        if (!playerReadyRef.current) return;

        setSyncIsPlaying(false);
        syncStateRef.current = { ...syncStateRef.current, isPlaying: false, positionMs };

        await spotifyPause(accessTokenRef.current);

        socketService.emitPause(roomIdRef.current, trackId, positionMs);
    }, []);

    /**
     * Seek to a new position.
     * @param {string} trackId
     * @param {number} positionMs
     */
    const seek = useCallback(async (trackId, positionMs) => {
        if (!playerReadyRef.current) return;

        syncStateRef.current = {
            ...syncStateRef.current,
            positionMs,
            serverTimestamp: Date.now(),
        };

        await spotifySeek(accessTokenRef.current, Math.round(positionMs));

        socketService.emitSeek(roomIdRef.current, trackId, positionMs);
    }, []);

    /**
     * Skip to the next track in the shared queue.
     * The server is authoritative; it responds with sync-play for both users.
     */
    const skipNext = useCallback(() => {
        recentSkipRef.current = true;
        setTimeout(() => { recentSkipRef.current = false; }, 3000);
        socketService.emitSkip(roomIdRef.current);
    }, []);

    return {
        syncTrack,
        syncIsPlaying,
        controls: { play, pause, seek, skipNext },
    };
}