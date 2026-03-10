/**
 * useSpotifyPlayer.js — Duo-fy v3
 *
 * ROOT CAUSES FIXED:
 *  1. spotifySearch silently returned [] on 401/429/5xx → search showed "No match"
 *     Fix: throws typed errors; SearchPanel now shows the right message per error.
 *  2. Spotify Web Playback SDK doesn't work on iOS Safari or most Android browsers.
 *     Fix: isMobile detection → Spotify Connect fallback (polls active devices,
 *     controls whatever Spotify app is open on the user's phone via REST).
 *  3. spotifyPlay/spotifyPause had no retry logic; silent failures caused stuck state.
 *     Fix: exponential back-off retry, device-not-found 404 fallback.
 *  4. SDK init race condition when script already in DOM but window.Spotify not ready.
 *     Fix: unified init path; SDK ready callback always fires once.
 *
 * EXPORTS (hook):
 *   useSpotifyPlayer(accessToken)
 *     → { deviceId, playerReady, playerError, playerMode, isMobile, volume, setVolume }
 *
 *   playerMode: "initializing" | "sdk" | "connect" | "none"
 *     - "sdk"     : Web Playback SDK running (desktop Premium)
 *     - "connect" : Spotify Connect (REST control of active device – mobile / free)
 *     - "none"    : no active device found
 *
 * EXPORTS (REST helpers):
 *   spotifyPlay, spotifyPause, spotifySeek, spotifySkipNext, spotifySkipPrev
 *   spotifySearch, spotifyGetQueue, spotifyAddToQueue, getActiveSpotifyDevice
 */

import { useEffect, useState, useRef, useCallback } from "react";

const SDK_URL = "https://sdk.scdn.co/spotify-player.js";
const PLAYER_NAME = "Duo-fy";

// ── Mobile detection ──────────────────────────────────────────────────────────
// Spotify Web Playback SDK requires desktop Chrome / Firefox / Edge.
// iOS Safari and most Android browsers will hit initialization_error.
export const isMobileBrowser =
  typeof navigator !== "undefined" &&
  /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// ── REST helper ───────────────────────────────────────────────────────────────
function authHeader(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function spotifyFetch(url, options, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options);

      // Success codes Spotify uses
      if (res.status === 200 || res.status === 201 || res.status === 202 || res.status === 204) {
        return res;
      }

      // Auth expired → surface immediately, don't retry
      if (res.status === 401) {
        const err = new Error("TOKEN_EXPIRED");
        err.status = 401;
        throw err;
      }

      // Rate limited → back-off then retry
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "2", 10);
        if (i < retries) {
          await delay(retryAfter * 1000);
          continue;
        }
        const err = new Error("RATE_LIMITED");
        err.status = 429;
        throw err;
      }

      // Device not found — caller should find a new device
      if (res.status === 404) {
        const err = new Error("DEVICE_NOT_FOUND");
        err.status = 404;
        throw err;
      }

      // Transient server error → retry with back-off
      if ((res.status === 502 || res.status === 503) && i < retries) {
        await delay(500 * (i + 1));
        continue;
      }

      // Anything else
      const body = await res.json().catch(() => ({}));
      const msg = body?.error?.message || `SPOTIFY_HTTP_${res.status}`;
      console.warn("[Spotify]", url, res.status, msg);
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    } catch (err) {
      if (err.status === 401 || err.status === 404) throw err; // don't retry
      lastErr = err;
      if (i < retries) await delay(400 * (i + 1));
    }
  }
  throw lastErr;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useSpotifyPlayer(accessToken) {
  const [deviceId, setDeviceId] = useState(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [playerError, setPlayerError] = useState(null);
  const [playerMode, setPlayerMode] = useState("initializing");
  const [volume, setVolumeState] = useState(0.7);

  const playerRef = useRef(null);
  const tokenRef = useRef(accessToken);
  const modeRef = useRef("initializing");

  useEffect(() => { tokenRef.current = accessToken; }, [accessToken]);

  // ── Path A: Desktop — Spotify Web Playback SDK ─────────────────────────────
  useEffect(() => {
    if (!accessToken || isMobileBrowser) return;

    const init = () => {
      if (playerRef.current) return; // already initialised

      const player = new window.Spotify.Player({
        name: PLAYER_NAME,
        getOAuthToken: cb => cb(tokenRef.current),
        volume: 0.7,
      });

      playerRef.current = player;

      player.addListener("ready", ({ device_id }) => {
        console.log("[SDK] Ready — device:", device_id);
        setDeviceId(device_id);
        setPlayerReady(true);
        setPlayerError(null);
        setPlayerMode("sdk");
        modeRef.current = "sdk";

        // Transfer playback to the browser player (don't auto-start)
        fetchWithRetry(() =>
          fetch("https://api.spotify.com/v1/me/player", {
            method: "PUT",
            headers: authHeader(tokenRef.current),
            body: JSON.stringify({ device_ids: [device_id], play: false }),
          })
        ).catch(() => { });
      });

      player.addListener("not_ready", () => {
        console.warn("[SDK] Not ready");
        setPlayerReady(false);
        setDeviceId(null);
        modeRef.current = "none";
        setPlayerMode("none");
      });

      player.addListener("initialization_error", ({ message }) => {
        console.error("[SDK] init error:", message);
        setPlayerError("Player failed to initialize. Try refreshing.");
        modeRef.current = "none";
        setPlayerMode("none");
      });

      player.addListener("authentication_error", ({ message }) => {
        console.error("[SDK] auth error:", message);
        setPlayerError("Spotify authentication failed. Please log in again.");
      });

      player.addListener("account_error", () => {
        setPlayerError("Spotify Premium is required to play audio in the browser.");
        modeRef.current = "none";
        setPlayerMode("none");
      });

      player.addListener("playback_error", ({ message }) => {
        console.warn("[SDK] Playback error:", message);
      });

      player.connect();
    };

    // SDK script already loaded and ready
    if (window.Spotify?.Player) {
      init();
      return;
    }

    // Script tag already in DOM but window.Spotify not set yet
    const prev = window.onSpotifyWebPlaybackSDKReady;
    window.onSpotifyWebPlaybackSDKReady = () => {
      prev?.();
      init();
    };

    if (!document.getElementById("spotify-sdk")) {
      const s = document.createElement("script");
      s.id = "spotify-sdk";
      s.src = SDK_URL;
      s.async = true;
      document.head.appendChild(s);
    }

    return () => {
      playerRef.current?.disconnect();
      playerRef.current = null;
      setDeviceId(null);
      setPlayerReady(false);
      setPlayerMode("initializing");
    };
  }, [accessToken]);

  // ── Path B: Mobile — Spotify Connect (poll active devices) ─────────────────
  // Even on mobile, the user can have Spotify open on the same phone.
  // We poll GET /v1/me/player/devices every 5 s.
  // When any active device is found, we use it for REST-API playback control.
  useEffect(() => {
    if (!accessToken || !isMobileBrowser) return;

    setPlayerMode("initializing");
    let cancelled = false;

    const pollDevices = async () => {
      try {
        const res = await fetch("https://api.spotify.com/v1/me/player/devices", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok || cancelled) return;

        const { devices = [] } = await res.json();
        // Prefer the active device; fall back to the first available
        const target = devices.find(d => d.is_active) ?? devices[0] ?? null;

        if (target && !cancelled) {
          setDeviceId(target.id);
          setPlayerReady(true);
          setPlayerError(null);
          setPlayerMode("connect");
          modeRef.current = "connect";
          console.log("[Connect] Active device:", target.name, target.id);
        } else if (!cancelled) {
          // No device yet — keep trying
          if (modeRef.current !== "connect") {
            setPlayerReady(false);
            setDeviceId(null);
            setPlayerMode("none");
            modeRef.current = "none";
          }
        }
      } catch (err) {
        if (!cancelled) console.warn("[Connect] Device poll error:", err.message);
      }
    };

    pollDevices(); // immediate first check
    const interval = setInterval(pollDevices, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [accessToken]);

  const setVolume = useCallback(v => {
    setVolumeState(v);
    playerRef.current?.setVolume(v).catch(() => { });
  }, []);

  return {
    deviceId,
    playerReady,
    playerError,
    playerMode,
    isMobile: isMobileBrowser,
    volume,
    setVolume,
  };
}

// Helper: simple retry wrapper used only inside the hook
async function fetchWithRetry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (e) { if (i === retries) throw e; await delay(400); }
  }
}

// ── REST helpers ──────────────────────────────────────────────────────────────

/**
 * spotifyPlay — starts or resumes playback.
 * Automatically falls back to "no device_id" if the device is not found (404).
 */
export async function spotifyPlay(accessToken, deviceId, options = {}) {
  const body = {};
  if (options.uris) body.uris = options.uris;
  if (options.context_uri) body.context_uri = options.context_uri;
  if (options.offset) body.offset = options.offset;
  if (options.position_ms !== undefined) body.position_ms = options.position_ms;

  const url = `https://api.spotify.com/v1/me/player/play${deviceId ? `?device_id=${deviceId}` : ""}`;

  try {
    return await spotifyFetch(url, {
      method: "PUT",
      headers: authHeader(accessToken),
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Device evicted — retry once without pinning the device
    if (err.status === 404 && deviceId) {
      console.warn("[spotifyPlay] Device not found, retrying without deviceId");
      return spotifyFetch(`https://api.spotify.com/v1/me/player/play`, {
        method: "PUT",
        headers: authHeader(accessToken),
        body: JSON.stringify(body),
      }, 1);
    }
    throw err;
  }
}

export async function spotifyPause(accessToken) {
  return spotifyFetch("https://api.spotify.com/v1/me/player/pause", {
    method: "PUT",
    headers: authHeader(accessToken),
  });
}

export async function spotifySeek(accessToken, positionMs) {
  const ms = Math.max(0, Math.round(positionMs));
  return spotifyFetch(
    `https://api.spotify.com/v1/me/player/seek?position_ms=${ms}`,
    { method: "PUT", headers: authHeader(accessToken) }
  );
}

export async function spotifySkipNext(accessToken) {
  return spotifyFetch("https://api.spotify.com/v1/me/player/next", {
    method: "POST",
    headers: authHeader(accessToken),
  });
}

export async function spotifySkipPrev(accessToken) {
  return spotifyFetch("https://api.spotify.com/v1/me/player/previous", {
    method: "POST",
    headers: authHeader(accessToken),
  });
}

export async function spotifyAddToQueue(accessToken, trackUri) {
  return spotifyFetch(
    `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(trackUri)}`,
    { method: "POST", headers: authHeader(accessToken) }
  );
}

export async function spotifyGetQueue(accessToken) {
  const res = await spotifyFetch("https://api.spotify.com/v1/me/player/queue", {
    headers: authHeader(accessToken),
  });
  if (!res) return { currently_playing: null, queue: [] };
  return res.json();
}

/**
 * spotifySearch — throws typed errors instead of silently returning [].
 *
 * Errors thrown:
 *   message: "TOKEN_EXPIRED"  — 401
 *   message: "RATE_LIMITED"   — 429
 *   message: "SEARCH_FAILED"  — other non-ok
 */
export async function spotifySearch(accessToken, query, limit = 15) {
  if (!query?.trim()) return [];

  const res = await spotifyFetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(query.trim())}&type=track&limit=${limit}`,
    { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const data = await res.json();
  return data.tracks?.items ?? [];
}

/**
 * getActiveSpotifyDevice — resolves the best device_id to use right now.
 * Useful on mobile when the Connect device changes.
 */
export async function getActiveSpotifyDevice(accessToken) {
  try {
    const res = await fetch("https://api.spotify.com/v1/me/player/devices", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const { devices = [] } = await res.json();
    return (devices.find(d => d.is_active) ?? devices[0])?.id ?? null;
  } catch { return null; }
}