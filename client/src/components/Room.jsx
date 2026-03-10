/**
 * Room.jsx – "Lovers Mode"
 * Desktop: 3-col (Queue | Player | Search)
 * Mobile:  tab-switched full-screen panels
 *
 * v2 changes (logic only — all UI / JSX / reactions untouched):
 *  - useSync  → accurate play/pause/seek/skip sync + drift correction
 *  - useQueue → shared server-side queue instead of per-user Spotify poll
 *  - SearchPanel uses onAddToQueue prop  (adds to shared queue via socket)
 *  - QueuePanel  accepts queue + onRemove props (no more internal Spotify fetch)
 *  - Socket sync-play/pause kept for UI state only; Spotify calls moved to useSync
 *  - sync-seek and sync-track listeners removed (handled inside useSync)
 */
import { useState, useEffect, useCallback, useRef } from "react";
import socketService from "../socket";
import { useSpotify, fmtMs } from "../hooks/useSpotify";
import {
  useSpotifyPlayer,
  spotifySkipPrev,
} from "../hooks/useSpotifyPlayer";
import { useSync } from "../hooks/useSync";
import { useQueue, normalizeSpotifyTrack } from "../hooks/useQueue";
import "./Room.css";

const REACTIONS = ["❤️", "🔥", "🌙", "✨", "🎵"];
const BARS = Array.from({ length: 28 }, (_, i) =>
  10 + Math.round(Math.abs(Math.sin(i * 0.7)) * 16 + Math.cos(i * 0.45) * 6)
);

function syncLabel(ms) {
  if (ms === null) return null;
  if (ms < 60) return { text: "Perfect Sync ✦", cls: "s--perfect" };
  if (ms < 150) return { text: "In Sync ✓", cls: "s--good" };
  if (ms < 350) return { text: "Adjusting…", cls: "s--ok" };
  return { text: "Syncing…", cls: "s--slow" };
}

async function shareRoom(roomId) {
  const url = `${window.location.origin}/room/${roomId}`;
  if (navigator.share) {
    try { await navigator.share({ title: "Listen with me on Duo-fy 💕", url }); return; } catch { }
  }
  await navigator.clipboard?.writeText(url).catch(() => { });
}

/* ── Search panel ─────────────────────────────────────────── */
// Added: onAddToQueue prop — routes "+ queue" clicks through the shared queue
function SearchPanel({ accessToken, deviceId, onTrackPlay, onAddToQueue }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState("idle");
  const [queued, setQueued] = useState({});
  const debRef = useRef(null);
  const inputRef = useRef(null);

  // Lazy-import spotifySearch so this file stays self-contained
  const [spotifySearch, setSpotifySearch] = useState(null);
  useEffect(() => {
    import("../hooks/useSpotifyPlayer").then(m => setSpotifySearch(() => m.spotifySearch));
  }, []);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 80); }, []);

  useEffect(() => {
    clearTimeout(debRef.current);
    if (!q.trim()) { setResults([]); setStatus("idle"); return; }
    setStatus("loading");
    debRef.current = setTimeout(async () => {
      try {
        const t = await spotifySearch?.(accessToken, q.trim(), 12) ?? [];
        setResults(t); setStatus("done");
      } catch { setStatus("error"); }
    }, 300);
    return () => clearTimeout(debRef.current);
  }, [q, accessToken, spotifySearch]);

  const fmt = ms => {
    const s = Math.floor((ms || 0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  return (
    <div className="search-panel">
      <div className="sp-head">
        <div className={`sp-field ${q ? "sp-field--on" : ""}`}>
          <SearchIcon />
          <input
            ref={inputRef} className="sp-input" type="search"
            placeholder="Search songs, artists…" value={q}
            onChange={e => setQ(e.target.value)} autoComplete="off"
          />
          {status === "loading" && <div className="sp-spin" />}
          {q && status !== "loading" && (
            <button className="sp-clear" onClick={() => { setQ(""); inputRef.current?.focus(); }}>✕</button>
          )}
        </div>
      </div>

      <div className="sp-body">
        {status === "idle" && (
          <div className="sp-empty"><span>🎵</span><p>Find something beautiful to play together</p></div>
        )}

        {status === "loading" && Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="sp-skeleton" style={{ animationDelay: `${i * .07}s` }}>
            <div className="sps-art" /><div className="sps-lines"><div className="sps-l sps-l--a" /><div className="sps-l sps-l--b" /></div>
          </div>
        ))}

        {status === "error" && (
          <div className="sp-empty"><span>⚠️</span><p>Oops — Spotify didn't respond. Try again.</p></div>
        )}
        {status === "done" && results.length === 0 && (
          <div className="sp-empty"><span>🔍</span><p>No match for "{q}".<br />Try different words.</p></div>
        )}

        {status === "done" && results.map((t, i) => (
          <div key={t.id} className="sp-track" style={{ animationDelay: `${i * .04}s` }}>
            <img
              src={t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || ""}
              alt="" className="sp-track__art" loading="lazy"
            />
            <div className="sp-track__info">
              <p className="sp-track__name">{t.name}</p>
              <p className="sp-track__meta">{t.artists.map(a => a.name).join(", ")}</p>
            </div>
            <span className="sp-track__dur">{fmt(t.duration_ms)}</span>
            <div className="sp-track__acts">
              {/* + button → shared queue via onAddToQueue */}
              <button
                className={`sp-act sp-act--q ${queued[t.id] ? "sp-act--queued" : ""}`}
                onClick={() => {
                  onAddToQueue?.(t);
                  setQueued(p => ({ ...p, [t.id]: true }));
                  setTimeout(
                    () => setQueued(p => { const n = { ...p }; delete n[t.id]; return n; }),
                    2000
                  );
                }}
              >
                {queued[t.id] ? "✓" : "+"}
              </button>
              {/* Play → immediate playback synced to partner */}
              <button
                className="sp-act sp-act--play"
                onClick={() => onTrackPlay?.(t)}
              >
                ▶ Play
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Queue panel ───────────────────────────────────────────── */
// v2: accepts `queue` (normalized Track[]) + `onRemove` from useQueue.
// No longer fetches from Spotify — the shared queue is the source of truth.
function QueuePanel({ currentTrack, deviceId, partnerName, partnerAvatar, partnerOnline, queue, onRemove, onTrackPlay }) {
  const partInit = (partnerName?.[0] ?? "P").toUpperCase();

  return (
    <div className="queue-panel">
      {/* Partner */}
      <div className="qp-partner">
        <div className={`qp-avatar ${partnerOnline ? "qp-avatar--on" : ""}`}>
          {partnerAvatar
            ? <img src={partnerAvatar} alt={partnerName} />
            : <span>{partInit}</span>
          }
          {partnerOnline && <span className="qp-avatar__dot" />}
        </div>
        <div className="qp-partner__text">
          <p className="qp-partner__name">{partnerName ?? "Waiting for partner…"}</p>
          <p className="qp-partner__status">{partnerOnline ? "Connected" : "Share your code to invite"}</p>
        </div>
      </div>

      <div className="qp-head">
        <span>Up Next</span>
        {queue.length > 0 && <span className="qp-count">{queue.length} tracks</span>}
      </div>

      <div className="qp-list">
        {queue.length === 0 && (
          <div className="qp-empty"><p>Queue is empty</p><p>Search for songs to add</p></div>
        )}

        {queue.map((t, i) => (
          <div key={`${t.id}-${i}`} className="qp-track">
            <span className="qp-num">{i + 1}</span>
            {/* normalized track: albumArt instead of album.images */}
            <img src={t.albumArt || ""} alt="" className="qp-art" loading="lazy" />
            <div className="qp-info">
              <p className="qp-name">{t.name}</p>
              {/* normalized track: artists is already a string */}
              <p className="qp-artist">{t.artists}</p>
            </div>
            <button
              className="qp-play"
              onClick={() => onTrackPlay?.(t, true)}  // true = already normalized
            >▶</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════
   MAIN ROOM
════════════════════════════════════════════ */
export default function Room({ roomId, onLeaveRoom, spotifyToken }) {
  // ── Data hooks ────────────────────────────────────────────────────────────
  const { track, progressMs, durationMs, profile, isPlaying } =
    useSpotify(spotifyToken);

  const { deviceId, playerReady, playerError, volume, setVolume } =
    useSpotifyPlayer(spotifyToken);

  // ── Sync engine ───────────────────────────────────────────────────────────
  // useSync owns all Spotify play/pause/seek/skip calls going to the partner.
  // Room.jsx only calls controls.* — never calls spotifyPlay/Pause/Seek directly.
  const { syncTrack, syncIsPlaying, controls } = useSync({
    roomId,
    accessToken: spotifyToken,
    deviceId,
    playerReady,
    spotifyTrack: track,
    progressMs,
    durationMs,
    spotifyIsPlaying: isPlaying,
  });

  // ── Shared queue ──────────────────────────────────────────────────────────
  const { queue, addToQueue, removeFromQueue } = useQueue({ roomId });

  // ── UI state ──────────────────────────────────────────────────────────────
  // syncPlaying mirrors syncIsPlaying from useSync; partner-left can override it.
  const [syncPlaying, setSyncPlaying] = useState(false);
  const [connStatus, setConnStatus] = useState("connecting");
  const [latency, setLatency] = useState(null);
  const [partnerOnline, setPartnerOnline] = useState(false);
  const [partnerName, setPartnerName] = useState(null);
  const [partnerAvatar, setPartnerAvatar] = useState(null);
  const [partnerPlaying, setPartnerPlaying] = useState(false);
  const [mobileTab, setMobileTab] = useState("player");
  const [showCodeCard, setShowCodeCard] = useState(true);
  const [codeCopied, setCodeCopied] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [toast, setToast] = useState(null);
  const [reactions, setReactions] = useState([]);
  const [celebrating, setCelebrating] = useState(false);
  const [heartbeat, setHeartbeat] = useState(false);
  const [listeningSecs, setListeningSecs] = useState(0);
  const [sessionSongs, setSessionSongs] = useState(new Set());
  const [syncCount, setSyncCount] = useState(0);

  const toastRef = useRef(null);
  const celebRef = useRef(null);
  const listenRef = useRef(null);
  const lastPlayRef = useRef(null);
  const prevTrkRef = useRef(null);

  // Keep syncPlaying in sync with useSync's authoritative state
  useEffect(() => { setSyncPlaying(syncIsPlaying); }, [syncIsPlaying]);

  // Track session songs
  useEffect(() => {
    if (track?.id && track.id !== prevTrkRef.current) {
      prevTrkRef.current = track.id;
      setSessionSongs(p => new Set([...p, track.id]));
    }
  }, [track?.id]);

  // Heartbeat / listening timer
  useEffect(() => {
    if (syncPlaying && partnerOnline) {
      listenRef.current = setInterval(() => setListeningSecs(s => s + 1), 1000);
      setHeartbeat(true);
    } else {
      clearInterval(listenRef.current);
      setHeartbeat(false);
    }
    return () => clearInterval(listenRef.current);
  }, [syncPlaying, partnerOnline]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const showToast = useCallback((text, type = "info") => {
    clearTimeout(toastRef.current);
    setToast({ text, type });
    toastRef.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const celebrate = useCallback(() => {
    setCelebrating(true);
    clearTimeout(celebRef.current);
    celebRef.current = setTimeout(() => setCelebrating(false), 3500);
  }, []);

  const addReaction = useCallback((emoji, fromPartner) => {
    const id = Date.now() + Math.random();
    setReactions(p => [...p, { id, emoji, fromPartner }]);
    setTimeout(() => setReactions(p => p.filter(r => r.id !== id)), 3000);
  }, []);

  const copyCode = async () => {
    await navigator.clipboard?.writeText(roomId).catch(() => { });
    setCodeCopied(true); showToast("Room code copied!", "info");
    setTimeout(() => setCodeCopied(false), 2000);
  };

  // ── Socket listeners ──────────────────────────────────────────────────────
  // sync-play / sync-pause → UI state + toasts only.
  // ALL Spotify API calls are handled inside useSync — not here.
  useEffect(() => {
    if (socketService.connected) setConnStatus("connected");

    const offs = [
      socketService.on("connect", () => setConnStatus("connected")),
      socketService.on("disconnect", r => {
        if (r !== "io client disconnect") {
          setConnStatus("disconnected");
          setSyncPlaying(false);
        }
      }),
      socketService.on("reconnect_attempt", () => setConnStatus("reconnecting")),

      // Partner presence
      socketService.on("partner-joined", data => {
        setPartnerOnline(true);
        setPartnerName(data?.displayName ?? "Partner");
        setPartnerAvatar(data?.avatarUrl ?? null);
        setShowCodeCard(false);
        showToast(`${data?.displayName ?? "Partner"} joined 💕`, "join");
        celebrate();
        // Re-request state so the new partner syncs to our current position
        socketService.requestRoomState(roomId);
      }),
      socketService.on("partner-left", () => {
        setPartnerOnline(false);
        setPartnerPlaying(false);
        setShowCodeCard(true);
        showToast(`${partnerName ?? "Partner"} left`, "leave");
      }),

      // Sync events — UI side effects only, no Spotify calls (useSync owns those)
      socketService.on("sync-play", data => {
        // Measure and display latency for the sync chip
        const lag = data?.serverTimestamp ? Date.now() - data.serverTimestamp : null;
        if (lag !== null && lag >= 0) setLatency(lag);

        setSyncPlaying(true);
        setPartnerPlaying(true);
        setSyncCount(n => n + 1);

        if (lastPlayRef.current && Date.now() - lastPlayRef.current < 2500) {
          celebrate();
          showToast("You're in sync 💕", "sync");
        } else {
          showToast(`${partnerName ?? "Partner"} played`, "play");
        }
      }),

      socketService.on("sync-pause", () => {
        setPartnerPlaying(false);
        // syncIsPlaying from useSync will flip syncPlaying via the useEffect above
        showToast(`${partnerName ?? "Partner"} paused`, "pause");
      }),

      // Reactions — unchanged
      socketService.on("reaction", ({ emoji } = {}) => {
        if (emoji) addReaction(emoji, true);
      }),
    ];

    return () => {
      offs.forEach(fn => fn());
      clearTimeout(toastRef.current);
      clearTimeout(celebRef.current);
      clearInterval(listenRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, partnerName, deviceId, spotifyToken]);

  // ── Playback controls — all go through useSync ────────────────────────────

  const handlePlay = useCallback(async () => {
    if (connStatus !== "connected" || syncPlaying || !track) return;
    lastPlayRef.current = Date.now();
    await controls.play(normalizeSpotifyTrack(track), progressMs);
  }, [connStatus, syncPlaying, track, progressMs, controls]);

  const handlePause = useCallback(async () => {
    if (connStatus !== "connected" || !syncPlaying) return;
    await controls.pause(track?.id, progressMs);
  }, [connStatus, syncPlaying, track, progressMs, controls]);

  // Progress bar drag → seek both players
  const handleSeek = useCallback(async e => {
    if (!durationMs || !track) return;
    const pct = parseFloat(e.target.value); // 0–100
    const positionMs = Math.round((pct / 100) * durationMs);
    await controls.seek(track.id, positionMs);
  }, [durationMs, track, controls]);

  // Called when user clicks "▶ Play" on a search result or a queue item
  // alreadyNormalized = true when called from QueuePanel (track is already lean shape)
  const handleTrackPlay = useCallback(async (t, alreadyNormalized = false) => {
    const normalized = alreadyNormalized ? t : normalizeSpotifyTrack(t);
    await controls.play(normalized, 0);
    showToast(`Playing "${normalized.name}"`, "play");
  }, [controls, showToast]);

  const handleReaction = useCallback(emoji => {
    socketService.emitReaction(roomId, emoji);
    addReaction(emoji, false);
  }, [roomId, addReaction]);

  // ── Derived display values ────────────────────────────────────────────────
  const isConnected = connStatus === "connected";
  const albumArt = track?.album?.images?.[0]?.url ?? null;
  const trackName = track?.name ?? "Ready to Sync";
  const artistName = track?.artists?.map(a => a.name).join(", ") ?? "Open Spotify to start";
  const progressPct = durationMs > 0 ? Math.min((progressMs / durationMs) * 100, 100) : 0;
  const myInit = profile?.name?.[0]?.toUpperCase() ?? "Y";
  const partInit = (partnerName?.[0] ?? "P").toUpperCase();
  const listenMin = Math.floor(listeningSecs / 60);
  const listenSec = listeningSecs % 60;
  const sync = syncLabel(latency);
  const isPremium = playerReady;
  const isFree = !playerReady && !!playerError;
  const trackUri = track?.uri ?? null;
  const spotifyLink = trackUri
    ? `https://open.spotify.com/track/${trackUri.split(":")[2]}`
    : "https://open.spotify.com";

  /* ── Shared player content ────────────────────────────────── */
  const playerContent = (
    <div className="player-content">
      {/* Art */}
      <div className={`art-frame ${syncPlaying ? "art-frame--playing" : ""} ${celebrating ? "art-frame--synced" : ""}`}>
        {albumArt
          ? <img src={albumArt} alt={trackName} className="art-img" />
          : <div className="art-placeholder"><RingIcon /><p>Open Spotify to start</p></div>
        }
        {syncPlaying && <div className="art-glow" />}
        {celebrating && <>
          <div className="art-ring art-ring--1" />
          <div className="art-ring art-ring--2" />
          <div className="art-ring art-ring--3" />
        </>}
      </div>

      {/* Together badge */}
      {syncPlaying && partnerOnline && (
        <div className={`together-badge ${heartbeat ? "together-badge--pulse" : ""}`}>
          <span className="tb-heart">♥</span>
          Listening Together
          {listeningSecs > 0 && (
            <span className="tb-time">{listenMin > 0 ? `${listenMin}m ` : ""}{listenSec}s</span>
          )}
        </div>
      )}

      {/* Track block */}
      <div className="track-block">
        <div className="track-chips">
          {sync && <span className={`chip ${sync.cls}`}>{sync.text}</span>}
          {isPremium && <span className="chip chip--device">▶ Duo-fy Web</span>}
          {isFree && <span className="chip chip--free">♫ Spotify App</span>}
        </div>
        <h2 className="track-name">{trackName}</h2>
        <p className="track-artist">{artistName}</p>

        {partnerOnline && (
          <div className="partner-micro">
            <div className={`pm-av ${partnerPlaying ? "pm-av--playing" : ""}`}>
              {partnerAvatar ? <img src={partnerAvatar} alt={partnerName} /> : <span>{partInit}</span>}
            </div>
            <span className="pm-label">
              {partnerPlaying ? `${partnerName} is listening` : `${partnerName} is here`}
            </span>
          </div>
        )}

        {/* Waveform */}
        <div className="waveform" aria-hidden>
          {BARS.map((h, i) => (
            <div key={i}
              className={`w-bar ${syncPlaying ? "w-bar--live" : ""}`}
              style={{
                height: syncPlaying ? `${h}px` : "3px",
                animationDelay: `${(i * 0.055).toFixed(2)}s`,
                animationDuration: `${0.55 + (i % 5) * 0.13}s`,
              }}
            />
          ))}
        </div>
      </div>

      {/* Progress bar + partner pin */}
      <div className="prog-section">
        <div className="prog-bar-wrap">
          {partnerOnline && (
            <div className="prog-partner-pin" style={{ left: `calc(${progressPct}% - 9px)` }}>
              {partnerAvatar ? <img src={partnerAvatar} alt="" /> : <span>{partInit}</span>}
            </div>
          )}
          <div className="prog-bar">
            <div className="prog-fill" style={{ width: `${progressPct}%` }}>
              <div className="prog-thumb" />
            </div>
            <input
              type="range" className="prog-scrub"
              min="0" max="100" step="0.1"
              value={progressPct}
              onChange={() => { }}
              onMouseUp={handleSeek}
              onTouchEnd={handleSeek}
              aria-label="Seek"
            />
          </div>
        </div>
        <div className="prog-times">
          <span>{fmtMs(progressMs)}</span>
          <span>{fmtMs(durationMs)}</span>
        </div>
      </div>

      {/* Controls — skip-next goes through useSync (server advances queue) */}
      <div className="controls">
        <button
          className="ctrl ctrl--sm"
          onClick={() => spotifySkipPrev(spotifyToken).catch(() => { })}
          disabled={!deviceId}
        >
          <PrevIcon />
        </button>
        <button
          className={`ctrl ctrl--play ${syncPlaying ? "ctrl--pause" : ""} ${heartbeat ? "ctrl--pulse" : ""} ${celebrating ? "ctrl--pop" : ""}`}
          onClick={syncPlaying ? handlePause : handlePlay}
          disabled={!isConnected}
        >
          {syncPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          className="ctrl ctrl--sm"
          onClick={() => controls.skipNext()}
          disabled={!isConnected}
        >
          <NextIcon />
        </button>
      </div>

      {/* Volume */}
      <div className="vol-row">
        <VolMin />
        <input
          type="range" min="0" max="1" step="0.02" value={volume}
          onChange={e => setVolume(parseFloat(e.target.value))}
          className="vol-slider" aria-label="Volume"
        />
        <VolMax />
      </div>

      {/* Free user nudge */}
      {isFree && (
        <a href={spotifyLink} target="_blank" rel="noopener noreferrer" className="open-spotify">
          Open in Spotify App ↗
        </a>
      )}

      {/* Reactions — unchanged */}
      <div className="react-row">
        {REACTIONS.map(e => (
          <button key={e} className="react-btn" onClick={() => handleReaction(e)} aria-label={`React ${e}`}>
            {e}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className={`room ${celebrating ? "room--cel" : ""}`}>
      {/* Ambient */}
      <div className="room-bg" aria-hidden>
        <div className="bg-orb bg-orb--a" />
        <div className="bg-orb bg-orb--b" />
        {celebrating && <div className="bg-orb bg-orb--c" />}
      </div>
      {albumArt && <div className="room-art-bg" style={{ backgroundImage: `url(${albumArt})` }} aria-hidden />}

      {/* Floating reactions */}
      <div className="react-stage" aria-hidden>
        {reactions.map(r => <span key={r.id} className={`rf ${r.fromPartner ? "rf--p" : ""}`}>{r.emoji}</span>)}
      </div>

      {/* Toast */}
      {toast && (
        <div className={`toast toast--${toast.type}`} role="status" aria-live="polite">
          <span className="toast-dot" />{toast.text}
        </div>
      )}

      {/* Celebrate overlay */}
      {celebrating && (
        <div className="celebrate-overlay" aria-hidden>
          <p className="cel-text">You're in sync 💕</p>
        </div>
      )}

      {/* ── TOPBAR ──────────────────────────────────────── */}
      <header className="topbar">
        <a href="/" className="topbar-brand">
          <HpIcon />
          <span className="brand-name">Duo-<em>fy</em></span>
        </a>

        <nav className="mob-tabs">
          {[["queue", "Queue"], ["player", "Player"], ["search", "Search"]].map(([tab, label]) => (
            <button
              key={tab}
              className={`mob-tab ${mobileTab === tab ? "mob-tab--on" : ""}`}
              onClick={() => setMobileTab(tab)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="topbar-right">
          <div className={`conn-badge ${isConnected ? "conn-badge--live" : ""}`}>
            <span className="conn-dot" />
            <span className="conn-text">
              {isConnected ? (partnerOnline ? "Connected" : "Waiting") : connStatus}
            </span>
          </div>
        </div>
      </header>

      {/* ── ROOM CODE BANNER ────────────────────────────── */}
      {showCodeCard && (
        <div className="code-banner">
          <p className="code-banner__label">Invite your partner</p>
          <div className="code-banner__code">{roomId}</div>
          <div className="code-banner__btns">
            <button className="code-btn" onClick={copyCode}>
              {codeCopied ? "✓ Copied!" : "📋 Copy Code"}
            </button>
            <button className="code-btn code-btn--alt" onClick={() => shareRoom(roomId)}>
              🔗 Share Link
            </button>
          </div>
        </div>
      )}

      {/* ── DESKTOP 3-COLUMN ────────────────────────────── */}
      <div className="desk-layout">
        <aside className="desk-left">
          <QueuePanel
            currentTrack={track}
            deviceId={deviceId}
            partnerName={partnerName}
            partnerAvatar={partnerAvatar}
            partnerOnline={partnerOnline}
            queue={queue}
            onRemove={removeFromQueue}
            onTrackPlay={handleTrackPlay}
          />
        </aside>
        <main className="desk-center">
          {playerContent}
          <button className="leave-btn" onClick={() => setShowSummary(true)}>Leave Room</button>
        </main>
        <aside className="desk-right">
          <SearchPanel
            accessToken={spotifyToken}
            deviceId={deviceId}
            onTrackPlay={handleTrackPlay}
            onAddToQueue={addToQueue}
          />
        </aside>
      </div>

      {/* ── MOBILE PANELS ───────────────────────────────── */}
      <div className={`mob-panel ${mobileTab === "queue" ? "mob-panel--show" : ""}`}>
        <QueuePanel
          currentTrack={track} deviceId={deviceId}
          partnerName={partnerName} partnerAvatar={partnerAvatar} partnerOnline={partnerOnline}
          queue={queue} onRemove={removeFromQueue} onTrackPlay={handleTrackPlay}
        />
      </div>
      <div className={`mob-panel ${mobileTab === "player" ? "mob-panel--show" : ""}`}>
        {playerContent}
        <div style={{ height: "8px" }} />
        <button className="leave-btn" onClick={() => setShowSummary(true)}>Leave Room</button>
        <div style={{ height: "16px" }} />
      </div>
      <div className={`mob-panel ${mobileTab === "search" ? "mob-panel--show" : ""}`}>
        <SearchPanel
          accessToken={spotifyToken}
          deviceId={deviceId}
          onTrackPlay={handleTrackPlay}
          onAddToQueue={addToQueue}
        />
      </div>

      {/* Mini bar (non-player tabs) */}
      {mobileTab !== "player" && (
        <div className="mini-bar">
          <div className="mini-track">
            {albumArt
              ? <img src={albumArt} alt="" className="mini-art" />
              : <div className="mini-art mini-art--ph">🎵</div>
            }
            <div>
              <p className="mini-name">{trackName}</p>
              <p className="mini-artist">{artistName}</p>
            </div>
          </div>
          <button
            className={`mini-play-btn ${syncPlaying ? "mini-play-btn--pause" : ""}`}
            onClick={syncPlaying ? handlePause : handlePlay}
            disabled={!isConnected}
          >
            {syncPlaying ? "⏸" : "▶"}
          </button>
        </div>
      )}

      {/* ── SESSION SUMMARY ─────────────────────────────── */}
      {showSummary && (
        <div className="sum-overlay" onClick={e => e.target === e.currentTarget && setShowSummary(false)}>
          <div className="sum-sheet">
            <div className="sum-heart">💕</div>
            <h2 className="sum-title">Session Complete</h2>
            <div className="sum-stats">
              <div className="sum-stat">
                <span className="ss-val">{listenMin > 0 ? `${listenMin}m` : `${listeningSecs}s`}</span>
                <span className="ss-key">Together</span>
              </div>
              <div className="sum-stat">
                <span className="ss-val">{sessionSongs.size}</span>
                <span className="ss-key">Songs</span>
              </div>
              <div className="sum-stat">
                <span className="ss-val">{syncCount}</span>
                <span className="ss-key">Syncs</span>
              </div>
            </div>
            <p className="sum-msg">
              {listenMin >= 30 ? "A whole album's worth of togetherness 💕"
                : listenMin >= 10 ? "Same songs, same moment 🎵"
                  : listeningSecs > 0 ? "Every shared moment counts 💕"
                    : "Come back and listen together 🌙"}
            </p>
            <button className="sum-leave" onClick={() => { setShowSummary(false); onLeaveRoom(); }}>
              Leave Room
            </button>
            <button className="sum-stay" onClick={() => setShowSummary(false)}>
              Keep Listening
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Icons (unchanged) ─────────────────────────────────────── */
const HpIcon = () => (<svg width="22" height="22" viewBox="0 0 22 22" fill="none"><path d="M4 13a2 2 0 012-2h1a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm9 0a2 2 0 012-2h1a2 2 0 012 2v2a2 2 0 01-2 2h-1a2 2 0 01-2-2v-2z" fill="url(#hp)" /><path d="M4 13A7 7 0 0118 13" stroke="url(#hp)" strokeWidth="2" strokeLinecap="round" fill="none" /><defs><linearGradient id="hp" x1="4" y1="8" x2="18" y2="17" gradientUnits="userSpaceOnUse"><stop stopColor="#FF4FA3" /><stop offset="1" stopColor="#B38CFF" /></linearGradient></defs></svg>);
const PlayIcon = () => <svg width="28" height="28" viewBox="0 0 28 28" fill="currentColor"><path d="M5 3.5l19 10.5L5 24.5V3.5z" /></svg>;
const PauseIcon = () => <svg width="28" height="28" viewBox="0 0 28 28" fill="currentColor"><rect x="4" y="4" width="7" height="20" rx="2" /><rect x="17" y="4" width="7" height="20" rx="2" /></svg>;
const PrevIcon = () => <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor"><path d="M3 3h2v12H3V3zm2 6L15 3v12L5 9z" /></svg>;
const NextIcon = () => <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor"><path d="M15 3h-2v12h2V3zM13 9L3 3v12l10-6z" /></svg>;
const VolMin = () => <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor"><path d="M2 5H0v3h2l3 3V2L2 5z" /></svg>;
const VolMax = () => <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor"><path d="M2 5H0v3h2l3 3V2L2 5zm7.5-.5A2.5 2.5 0 019.5 9M8 5.5a.5.5 0 010 2" /></svg>;
const SearchIcon = () => <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M9.5 8.5a4 4 0 10-.93.93l2.75 2.75.94-.94L9.5 8.5zm-4 .5a3 3 0 110-6 3 3 0 010 6z" /></svg>;
const RingIcon = () => (<svg width="60" height="60" viewBox="0 0 60 60" fill="none"><circle cx="30" cy="30" r="28" stroke="url(#ri)" strokeWidth="1.5" strokeDasharray="6 4" /><circle cx="30" cy="30" r="12" fill="url(#rj)" opacity=".4" /><circle cx="30" cy="30" r="5" fill="white" opacity=".7" /><defs><linearGradient id="ri" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#FF4FA3" /><stop offset="1" stopColor="#B38CFF" /></linearGradient><linearGradient id="rj" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#B38CFF" /><stop offset="1" stopColor="#5EF2C5" /></linearGradient></defs></svg>);