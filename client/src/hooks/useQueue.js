import { useEffect, useRef, useState, useCallback } from "react";
import socketService from "../socket";

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Convert a raw Spotify API track item into the lean shape stored in the queue.
 *
 * @param {object} item  — item from /v1/search or /v1/me/player/queue
 * @returns {{ id, uri, name, artists, albumArt, durationMs }}
 */
export function normalizeSpotifyTrack(item) {
    return {
        id: item.id,
        uri: item.uri,
        name: item.name,
        artists: (item.artists ?? []).map((a) => a.name).join(", "),
        albumArt: item.album?.images?.[0]?.url ?? null,
        durationMs: item.duration_ms ?? 0,
    };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {string} params.roomId  — current room ID
 */
export function useQueue({ roomId }) {
    const [queue, setQueue] = useState([]);
    const roomIdRef = useRef(roomId);

    useEffect(() => { roomIdRef.current = roomId; }, [roomId]);

    // ── Listen for queue updates broadcast by the server ──────────────────────
    useEffect(() => {
        if (!roomId) {
            setQueue([]);
            return;
        }

        const offUpdated = socketService.on("queue-updated", ({ queue: serverQueue }) => {
            setQueue(serverQueue ?? []);
        });

        // Also sync from the initial room-state snapshot (received on join)
        const offState = socketService.on("room-state", ({ queue: serverQueue }) => {
            if (Array.isArray(serverQueue)) setQueue(serverQueue);
        });

        return () => { offUpdated(); offState(); };
    }, [roomId]);

    // ── Outbound mutations ────────────────────────────────────────────────────

    /**
     * Add a track to the shared queue.
     * Accepts either a normalized track object or a raw Spotify API item.
     *
     * @param {object} trackOrItem
     */
    const addToQueue = useCallback((trackOrItem) => {
        if (!trackOrItem || !roomIdRef.current) return;

        // Detect raw Spotify item (has `album` property) vs normalized
        const track = trackOrItem.album
            ? normalizeSpotifyTrack(trackOrItem)
            : trackOrItem;

        socketService.emitQueueAdd(roomIdRef.current, track);
    }, []);

    /**
     * Remove the track at `index` from the shared queue.
     * @param {number} index
     */
    const removeFromQueue = useCallback((index) => {
        if (index == null || !roomIdRef.current) return;
        socketService.emitQueueRemove(roomIdRef.current, index);
    }, []);

    return { queue, addToQueue, removeFromQueue };
}
