"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useDataChannel, useConnectionState, useTranscriptions, useLocalParticipant } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import {
  Mic,
  MicOff,
  Activity,
  AlertTriangle,
  Music,
  Volume2,
  Radio,
  Zap,
  Play,
  Pause,
  TriangleAlert,
  Headphones,
  MessageSquare,
} from "lucide-react";
import { useVocalAnalyzer, VocalMetrics } from "@/hooks/useVocalAnalyzer";
import { useSongPlayback } from "@/hooks/useSongPlayback";
import { useSyllableTracker } from "@/hooks/useSyllableTracker";
import { SONG_EN001A } from "@/lib/songs/en001a";
import { VOLUME_SILENCE_THRESHOLD_DB } from "@/lib/songs/pitch";
import PitchLane from "@/components/PitchLane";
import PitchContourChart from "@/components/PitchContourChart";
import PerformanceIssues from "@/components/PerformanceIssues";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TELEMETRY_INTERVAL_MS = 250; // how often we send metrics to the agent
const DISPLAY_UPDATE_MS = 100; // throttle UI meter updates to reduce flicker
const VOLUME_WARN_CLEAR_DB = -55;
const PITCH_HOLD_MS = 250;
const METRIC_SMOOTHING = 0.35;
const AUTO_FAULT_COOLDOWN_MS = 5000;
const AUTO_FAULT_DELAY_MS = 1500;

const ACTIVE_SONG = SONG_EN001A;

// ---------------------------------------------------------------------------
// Helper: clamp a value to a 0 – 100 percentage
// ---------------------------------------------------------------------------

function dbToPercent(db: number): number {
  // Map -100 dB … 0 dB → 0% … 100%
  return Math.max(0, Math.min(100, ((db + 100) / 100) * 100));
}

function pitchToPercent(hz: number): number {
  if (hz === 0) return 0;
  // Map 60 Hz … 1200 Hz onto 0% … 100% logarithmically
  const minLog = Math.log2(60);
  const maxLog = Math.log2(1200);
  const pct = ((Math.log2(hz) - minLog) / (maxLog - minLog)) * 100;
  return Math.max(0, Math.min(100, pct));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function VocalDashboard() {
  // ── LiveKit connection state ──────────────────────────────────────────────────
  const connectionState = useConnectionState();
  const isConnected = connectionState === ConnectionState.Connected;
  const { microphoneTrack, localParticipant } = useLocalParticipant();

  // ── Dashboard state ──────────────────────────────────────────────────
  const [coachingMode, setCoachingMode] = useState<"karaoke" | "conversational">("karaoke");
  const [isPaused, setIsPaused] = useState(false);
  const [coachNotes, setCoachNotes] = useState<string | null>(null);
  const [coachStatus, setCoachStatus] = useState<
    "idle" | "speaking" | "paused"
  >("idle");
  const [sessionElapsed, setSessionElapsed] = useState(0);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [displayMetrics, setDisplayMetrics] = useState<VocalMetrics>({
    volumeDb: -100,
    frequencyHz: 0,
  });
  const [isVolumeWarn, setIsVolumeWarn] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);

  // Refs for interval / telemetry gating
  const metricsRef = useRef<VocalMetrics>({ volumeDb: -100, frequencyHz: 0 });
  const trackerRef = useRef({
    activeSyllableToken: null as string | null,
    expectedPitchHz: 0,
    pitchDeltaCents: 0,
    isOnPitch: false,
    isPitchWarn: false,
    elapsedSec: 0,
  });
  const sentSyllableResultsRef = useRef(0);
  const isPausedRef = useRef(false);
  const lastAutoFaultRef = useRef(0);
  const coachingModeRef = useRef(coachingMode);
  coachingModeRef.current = coachingMode;
  isPausedRef.current = isPaused;

  // Smoothed display refs (updated every frame, flushed to state on an interval)
  const smoothedRef = useRef({ volumeDb: -100, frequencyHz: 0 });
  const lastPitchAtRef = useRef(0);
  const lastDisplayFlushRef = useRef(0);

  // ── Data channel: send & receive ──────────────────────────────────────
  const onDataReceived = useCallback(
    (msg: { payload: Uint8Array; topic?: string }) => {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(msg.payload));
        const action: string | undefined = parsed.action;
        const notes: string | undefined = parsed.coach_notes;

        if (action === "PAUSE_TRACK") {
          setIsPaused(true);
          setCoachStatus("paused");
          setAlertMessage(notes ?? "Coach is intervening…");
          setCoachNotes(notes ?? null);
        } else if (action === "RESUME_TRACK") {
          setIsPaused(false);
          setCoachStatus("idle");
          setAlertMessage(null);
          setCoachNotes(notes ?? null);
        } else if (action === "SHOW_TIPS") {
          setCoachNotes(notes ?? null);
        }
      } catch {
        // Non-JSON payloads are silently ignored.
      }
    },
    []
  );

  const { send: sendData } = useDataChannel("session_control", onDataReceived);
  const { send: sendTelemetry } = useDataChannel("telemetry");

  const songPlayback = useSongPlayback({
    src: ACTIVE_SONG.audioSrc,
    enabled: coachingMode === "karaoke",
    isPaused,
  });

  // ── Vocal analyser hook ───────────────────────────────────────────────
  const onMetricsUpdate = useCallback((m: VocalMetrics) => {
    metricsRef.current = m;

    const now = performance.now();
    const smoothed = smoothedRef.current;

    smoothed.volumeDb +=
      (m.volumeDb - smoothed.volumeDb) * METRIC_SMOOTHING;

    if (m.frequencyHz > 0) {
      lastPitchAtRef.current = now;
      if (smoothed.frequencyHz === 0) {
        smoothed.frequencyHz = m.frequencyHz;
      } else {
        smoothed.frequencyHz +=
          (m.frequencyHz - smoothed.frequencyHz) * METRIC_SMOOTHING;
      }
    } else if (now - lastPitchAtRef.current > PITCH_HOLD_MS) {
      smoothed.frequencyHz +=
        (0 - smoothed.frequencyHz) * METRIC_SMOOTHING;
      if (smoothed.frequencyHz < 1) smoothed.frequencyHz = 0;
    }

    if (now - lastDisplayFlushRef.current < DISPLAY_UPDATE_MS) return;
    lastDisplayFlushRef.current = now;

    const displayVolume = Math.round(smoothed.volumeDb * 10) / 10;
    const displayPitch =
      smoothed.frequencyHz >= 1
        ? Math.round(smoothed.frequencyHz * 10) / 10
        : 0;

    setDisplayMetrics({
      volumeDb: displayVolume,
      frequencyHz: displayPitch,
    });

    setIsVolumeWarn((prev) => {
      if (!prev && displayVolume < VOLUME_SILENCE_THRESHOLD_DB) return true;
      if (prev && displayVolume >= VOLUME_WARN_CLEAR_DB) return false;
      return prev;
    });
  }, []);

  const { isActive, analyserNode, error: analyzerError, start, stop } = useVocalAnalyzer({
    onMetricsUpdate,
  });

  const syllableTracker = useSyllableTracker({
    song: ACTIVE_SONG,
    elapsedSec: sessionElapsed,
    livePitchHz: displayMetrics.frequencyHz,
    volumeDb: displayMetrics.volumeDb,
    enabled: isActive && coachingMode === "karaoke",
  });

  const isPitchWarn =
    coachingMode === "karaoke" ? syllableTracker.isPitchWarn : false;

  trackerRef.current = {
    activeSyllableToken: syllableTracker.activeSyllable?.token ?? null,
    expectedPitchHz: syllableTracker.expectedPitchHz,
    pitchDeltaCents: syllableTracker.pitchDeltaCents,
    isOnPitch: syllableTracker.isOnPitch,
    isPitchWarn,
    elapsedSec: sessionElapsed,
  };

  useEffect(() => {
    if (isActive) return;
    smoothedRef.current = { volumeDb: -100, frequencyHz: 0 };
    lastPitchAtRef.current = 0;
    lastDisplayFlushRef.current = 0;
    setDisplayMetrics({ volumeDb: -100, frequencyHz: 0 });
    setIsVolumeWarn(false);
  }, [isActive]);

  // ── Canvas Waveform Visualizer ─────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!isActive || !analyserNode || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animationFrameId = requestAnimationFrame(draw);
      analyserNode.getByteTimeDomainData(dataArray);

      // Clean drawing area with subtle decay
      ctx.fillStyle = "rgba(10, 10, 15, 0.25)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.lineWidth = 2.5;
      
      const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
      gradient.addColorStop(0, "#8b5cf6"); // violet-500
      gradient.addColorStop(0.5, "#06b6d4"); // cyan-500
      gradient.addColorStop(1, "#d946ef"); // fuchsia-500
      ctx.strokeStyle = gradient;
      
      ctx.beginPath();

      const sliceWidth = canvas.width / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }

        x += sliceWidth;
      }

      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();
    };

    draw();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [isActive, analyserNode]);

  // ── Real-time Transcription Stream ────────────────────────────────────
  const transcriptions = useTranscriptions();

  // ── Telemetry dispatch interval ───────────────────────────────────────
  useEffect(() => {
    if (!isConnected || !isActive) return;

    const id = setInterval(() => {
      if (isPausedRef.current) return;

      const m = metricsRef.current;
      const t = trackerRef.current;
      const packet = JSON.stringify({
        type: "VOCAL_METRICS",
        volume_db: m.volumeDb,
        pitch_hz: m.frequencyHz,
        coaching_mode: coachingModeRef.current,
        song_id: ACTIVE_SONG.id,
        elapsed_sec: t.elapsedSec,
        syllable: t.activeSyllableToken,
        expected_pitch_hz: t.expectedPitchHz || null,
        pitch_delta_cents: t.pitchDeltaCents,
        on_pitch: t.isOnPitch,
      });

      sendTelemetry(new TextEncoder().encode(packet), { reliable: false });
    }, TELEMETRY_INTERVAL_MS);

    return () => clearInterval(id);
  }, [isConnected, isActive, sendTelemetry]);

  // ── Send song context when session starts ─────────────────────────────
  useEffect(() => {
    if (!isConnected || !isActive || coachingMode !== "karaoke") return;

    const packet = JSON.stringify({
      type: "SONG_SELECTED",
      song_id: ACTIVE_SONG.id,
      songname: ACTIVE_SONG.metadata.songname,
      tempo: ACTIVE_SONG.metadata.tempo,
      time_signature: ACTIVE_SONG.metadata.time_signature,
      lyric_excerpt: ACTIVE_SONG.lyricLines[0],
    });
    sendTelemetry(new TextEncoder().encode(packet), { reliable: true });
    sentSyllableResultsRef.current = 0;
  }, [isConnected, isActive, coachingMode, sendTelemetry]);

  // ── Send syllable results as they complete ────────────────────────────
  useEffect(() => {
    if (!isConnected || !isActive) return;

    const results = syllableTracker.completedResults;
    if (results.length <= sentSyllableResultsRef.current) return;

    const newResults = results.slice(sentSyllableResultsRef.current);
    sentSyllableResultsRef.current = results.length;

    for (const result of newResults) {
      const packet = JSON.stringify({
        type: "SYLLABLE_RESULT",
        song_id: ACTIVE_SONG.id,
        syllable: result.token,
        issue: result.issue,
        pitch_error_cents: result.pitchErrorCents,
        timing_offset_ms: result.timingOffsetMs,
      });
      sendTelemetry(new TextEncoder().encode(packet), { reliable: true });
    }
  }, [
    isConnected,
    isActive,
    syllableTracker.completedResults,
    sendTelemetry,
  ]);

  // ── Notify agent of coaching mode changes ─────────────────────────────
  useEffect(() => {
    if (!isConnected) return;
    const packet = JSON.stringify({ type: "COACHING_MODE", mode: coachingMode });
    sendTelemetry(new TextEncoder().encode(packet), { reliable: true });
  }, [coachingMode, isConnected, sendTelemetry]);

  // ── Lyric timer synced to reference audio (karaoke) or wall clock ─────
  const sessionStartRef = useRef<number>(0);

  useEffect(() => {
    if (!isActive) return;
    sessionStartRef.current = performance.now();
  }, [isActive]);

  useEffect(() => {
    if (isPaused || !isActive) return;

    let rafId: number;
    const tick = () => {
      if (coachingMode === "karaoke") {
        const audioTime = songPlayback.getCurrentTime();
        if (audioTime > 0) {
          // Audio is running — use its timestamp (authoritative for syllable sync)
          setSessionElapsed(audioTime);
        } else {
          // Audio not yet loaded — advance via wall clock so lane scrolls immediately
          const wallSec = (performance.now() - sessionStartRef.current) / 1000;
          setSessionElapsed(wallSec);
        }
      } else {
        const wallSec = (performance.now() - sessionStartRef.current) / 1000;
        setSessionElapsed(wallSec);
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPaused, isActive, coachingMode, songPlayback]);


  // ── Derived values (smoothed for stable meter rendering) ──────────────
  const volumePct = dbToPercent(displayMetrics.volumeDb);
  const pitchPct = pitchToPercent(displayMetrics.frequencyHz);
  const targetPitchHz =
    coachingMode === "karaoke" && syllableTracker.expectedPitchHz > 0
      ? syllableTracker.expectedPitchHz
      : 0;
  const pitchDeltaCents =
    coachingMode === "karaoke" ? syllableTracker.pitchDeltaCents : 0;

  const sendCriticalError = useCallback(
    (
      reason: string,
      bypassCooldown = false,
      extra?: Record<string, unknown>
    ) => {
      if (!isConnected) return;
      const now = Date.now();
      if (!bypassCooldown && now - lastAutoFaultRef.current < AUTO_FAULT_COOLDOWN_MS) {
        return;
      }
      lastAutoFaultRef.current = now;

      const t = trackerRef.current;
      const packet = JSON.stringify({
        type: "CRITICAL_ERROR",
        reason,
        song_id: ACTIVE_SONG.id,
        syllable: t.activeSyllableToken,
        expected_hz: t.expectedPitchHz || null,
        actual_hz: metricsRef.current.frequencyHz || null,
        ...extra,
      });
      sendTelemetry(new TextEncoder().encode(packet), { reliable: true });
    },
    [isConnected, sendTelemetry]
  );

  // ── Auto-detect sustained vocal faults ────────────────────────────────
  useEffect(() => {
    if (!isConnected || !isActive || isPaused) return;

    const timers: ReturnType<typeof setTimeout>[] = [];

    if (isVolumeWarn) {
      timers.push(
        setTimeout(() => sendCriticalError("VOLUME_SILENCE"), AUTO_FAULT_DELAY_MS)
      );
    }
    if (isPitchWarn && syllableTracker.activeSyllable) {
      timers.push(
        setTimeout(
          () => sendCriticalError("PITCH_OFF_TARGET"),
          AUTO_FAULT_DELAY_MS
        )
      );
    }

    return () => timers.forEach(clearTimeout);
  }, [isVolumeWarn, isPitchWarn, isConnected, isActive, isPaused, sendCriticalError]);

  // ── Request Feedback ─────────────────────────────────────────────────
  const requestFeedback = useCallback(() => {
    if (!isConnected) return;
    const packet = JSON.stringify({ type: "REQUEST_FEEDBACK" });
    sendTelemetry(new TextEncoder().encode(packet), { reliable: true });
  }, [isConnected, sendTelemetry]);

  const handleSessionToggle = useCallback(async () => {
    if (isActive) {
      // Stop publishing mic to LiveKit so agent stops hearing us
      await localParticipant.setMicrophoneEnabled(false);
      songPlayback.stop();
      stop();
      setSessionElapsed(0);
      sentSyllableResultsRef.current = 0;
      setMicError(null);
      return;
    }

    setMicError(null);
    try {
      // 1. Publish mic to LiveKit room so the backend agent can hear us.
      //    setMicrophoneEnabled returns the LocalTrackPublication directly.
      const pub = await localParticipant.setMicrophoneEnabled(true);

      // 2. Wire the same mic track into our Web Audio analyser.
      //    Use the returned publication's track to avoid stale React state.
      const mediaTrack = pub?.track?.mediaStreamTrack;
      const stream = mediaTrack ? new MediaStream([mediaTrack]) : undefined;
      await start(stream);

      if (coachingMode === "karaoke") {
        await songPlayback.start();
      }
    } catch (err) {
      setMicError(
        err instanceof Error ? err.message : "Failed to start microphone."
      );
    }
  }, [isActive, songPlayback, stop, localParticipant, start, coachingMode]);

  // Start/stop reference audio when coaching mode changes mid-session
  useEffect(() => {
    if (!isActive) return;
    if (coachingMode === "karaoke") {
      void songPlayback.start();
    } else {
      songPlayback.stop();
    }
  }, [coachingMode, isActive, songPlayback]);

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="relative mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-fuchsia-600 shadow-lg shadow-violet-600/20">
            <Headphones className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">
              AI Vocal Coach
            </h1>
            <p className="text-xs text-[var(--color-text-muted)]">
              {ACTIVE_SONG.metadata.songname} · {ACTIVE_SONG.metadata.tempo} BPM ·{" "}
              {ACTIVE_SONG.metadata.time_signature}
            </p>
          </div>
        </div>

        {/* Mode selector and Mic toggle */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Mode Selector Tab Bar */}
          <div className="flex rounded-full bg-white/5 p-1 border border-white/5">
            <button
              onClick={() => setCoachingMode("karaoke")}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${
                coachingMode === "karaoke"
                  ? "bg-violet-600 text-white shadow"
                  : "text-[var(--color-text-muted)] hover:text-white"
              }`}
            >
              Karaoke Mode
            </button>
            <button
              onClick={() => setCoachingMode("conversational")}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${
                coachingMode === "conversational"
                  ? "bg-violet-600 text-white shadow"
                  : "text-[var(--color-text-muted)] hover:text-white"
              }`}
            >
              Conversational Mode
            </button>
          </div>

          <button
            onClick={handleSessionToggle}
            className={`group relative flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-all duration-300 ${
              isActive
                ? "bg-rose-500/15 text-rose-400 hover:bg-rose-500/25 border border-rose-500/30"
                : "bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white hover:shadow-lg hover:shadow-violet-600/25"
            }`}
          >
            {isActive ? (
              <>
                <MicOff className="h-4 w-4" />
                Stop Session
              </>
            ) : (
              <>
                <Mic className="h-4 w-4" />
                Start Session
              </>
            )}
          </button>
        </div>
      </header>

      {/* ── Mic error ─────────────────────────────────────────────────── */}
      {(micError || analyzerError) && (
        <div className="alert-overlay glass-card glow-rose flex items-start gap-3 border-rose-500/30 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />
          <div>
            <p className="text-sm font-semibold text-rose-300">Microphone Error</p>
            <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
              {micError ?? analyzerError}
            </p>
          </div>
        </div>
      )}

      {/* ── Alert Overlay ─────────────────────────────────────────────── */}
      {alertMessage && (
        <div className="alert-overlay glass-card glow-rose flex items-start gap-3 border-rose-500/30 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />
          <div>
            <p className="text-sm font-semibold text-rose-300">
              Coach Intervention
            </p>
            <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
              {alertMessage}
            </p>
          </div>
        </div>
      )}

      {/* ── Main grid ─────────────────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* ── Left column: Lyrics + Coach Feed ────────────────────────── */}
        <div className="flex flex-col gap-6 lg:col-span-2">
          {/* Lyrics / Conversational Card */}
          {coachingMode === "karaoke" ? (
            <section className="glass-card glow-violet overflow-hidden">
              <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-5 py-3">
                <Music className="h-4 w-4 text-violet-400" />
                <h2 className="text-sm font-semibold text-[var(--color-text-secondary)]">
                  Pitch Lane — {ACTIVE_SONG.metadata.songname}
                </h2>
                {isPaused && (
                  <span className="ml-auto flex items-center gap-1 text-xs text-amber-400">
                    <Pause className="h-3 w-3" /> Paused
                  </span>
                )}
                {!isPaused && isActive && (
                  <span className="ml-auto flex items-center gap-1 text-xs text-emerald-400">
                    <Play className="h-3 w-3" /> Playing
                  </span>
                )}
              </div>

              <div className="p-3">
                <PitchLane
                  song={ACTIVE_SONG}
                  elapsedSec={sessionElapsed}
                  livePitchHz={displayMetrics.frequencyHz}
                  activeSyllable={syllableTracker.activeSyllable}
                  pitchDeltaCents={syllableTracker.pitchDeltaCents}
                  completedResults={syllableTracker.completedResults}
                />
              </div>
            </section>
          ) : (
            <section className="glass-card glow-violet overflow-hidden">
              <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-5 py-3">
                <Radio className="h-4 w-4 text-cyan-400 animate-pulse" />
                <h2 className="text-sm font-semibold text-[var(--color-text-secondary)]">
                  Conversational Free Talk Mode
                </h2>
              </div>
              <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
                <p className="max-w-md text-sm text-[var(--color-text-secondary)] leading-relaxed">
                  You are in free-talk mode. Speak, sing, or chat with the AI vocal coach.
                  Your speech will be transcribed and evaluated in real time.
                </p>
                <div className="mt-6 flex flex-wrap gap-3 justify-center">
                  <button
                    disabled={!isConnected || !isActive}
                    onClick={requestFeedback}
                    className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-500/20 transition hover:shadow-xl hover:shadow-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Play className="h-4 w-4 fill-white" />
                    Stop Performance &amp; Get Feedback
                  </button>
                </div>
              </div>
            </section>
          )}

          {coachingMode === "karaoke" && isActive && (
            <section className="glass-card overflow-hidden p-4">
              <div className="mb-2 flex items-center gap-2">
                <Activity className="h-4 w-4 text-violet-400" />
                <h2 className="text-sm font-semibold text-[var(--color-text-secondary)]">
                  Pitch Contour
                </h2>
              </div>
              <PitchContourChart
                song={ACTIVE_SONG}
                elapsedSec={sessionElapsed}
                livePitchHz={displayMetrics.frequencyHz}
                activeSyllable={syllableTracker.activeSyllable}
                pitchDeltaCents={syllableTracker.pitchDeltaCents}
              />
            </section>
          )}

          {/* Audio Waveform visualizer */}
          <section className="glass-card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-5 py-3">
              <Activity className="h-4 w-4 text-cyan-400" />
              <h2 className="text-sm font-semibold text-[var(--color-text-secondary)]">
                Live Input Signal Waveform
              </h2>
              {isActive && (
                <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-cyan-500/20 px-2 py-0.5 text-[10px] font-medium text-cyan-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-ping" />
                  Active Analyser
                </span>
              )}
            </div>
            <div className="relative h-24 w-full bg-[#0a0a0f] p-1">
              {isActive ? (
                <canvas
                  ref={canvasRef}
                  width={600}
                  height={96}
                  className="h-full w-full rounded-lg"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-xs italic text-[var(--color-text-muted)]">
                  Mic inactive — start session to stream and visualize signal waveform
                </div>
              )}
            </div>
          </section>

          <div className="grid gap-6 md:grid-cols-2">
            {/* Coach live feed */}
            <section className="glass-card overflow-hidden">
              <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-5 py-3">
                <MessageSquare className="h-4 w-4 text-cyan-400" />
                <h2 className="text-sm font-semibold text-[var(--color-text-secondary)]">
                  AI Coach Live Feed
                </h2>
                {/* Status indicator */}
                <span className="ml-auto flex items-center gap-2">
                  <span className="relative flex h-2.5 w-2.5">
                    <span
                      className={`pulse-dot absolute inline-flex h-full w-full rounded-full ${
                        coachStatus === "speaking"
                          ? "bg-emerald-400"
                          : coachStatus === "paused"
                          ? "bg-rose-400"
                          : "bg-zinc-500"
                      }`}
                    />
                  </span>
                  <span className="text-xs capitalize text-[var(--color-text-muted)]">
                    {coachStatus}
                  </span>
                </span>
              </div>

              <div className="px-5 py-4">
                {coachNotes ? (
                  <p className="text-sm leading-relaxed text-[var(--color-text-secondary)]">
                    {coachNotes}
                  </p>
                ) : (
                  <p className="text-sm italic text-[var(--color-text-muted)]">
                    {isActive
                      ? "Listening… The coach will chime in when it has feedback."
                      : "Start a session to receive live coaching."}
                  </p>
                )}
              </div>
            </section>

            {/* Real-time Transcription Stream */}
            <section className="glass-card overflow-hidden">
              <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-5 py-3">
                <Radio className="h-4 w-4 text-fuchsia-400 animate-pulse" />
                <h2 className="text-sm font-semibold text-[var(--color-text-secondary)]">
                  Live Transcription Stream
                </h2>
              </div>
              <div className="flex flex-col gap-2 max-h-[120px] overflow-y-auto px-5 py-4 scrollbar-thin scrollbar-thumb-zinc-800">
                {transcriptions.length === 0 ? (
                  <p className="text-sm italic text-[var(--color-text-muted)]">
                    No speech detected yet.
                  </p>
                ) : (
                  transcriptions.map((t, idx) => {
                    const identity = t.participantInfo?.identity ?? "";
                    const isAgent =
                      identity.includes("agent") || identity.startsWith("agent-");
                    return (
                      <div key={idx} className="flex flex-col gap-0.5 text-xs">
                        <span className={`font-semibold ${isAgent ? "text-cyan-400" : "text-violet-400"}`}>
                          {isAgent ? "Coach" : "Student"}:
                        </span>
                        <p className="text-[var(--color-text-secondary)] leading-relaxed">{t.text}</p>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        </div>

        {/* ── Right column: Telemetry + Controls ──────────────────────── */}
        <div className="flex flex-col gap-6">
          {/* Volume gauge */}
          <section className="glass-card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-5 py-3">
              <Volume2 className="h-4 w-4 text-emerald-400" />
              <h2 className="text-sm font-semibold text-[var(--color-text-secondary)]">
                Volume
              </h2>
              <span className="ml-auto font-mono text-xs text-[var(--color-text-muted)]">
                {displayMetrics.volumeDb.toFixed(1)} dB
              </span>
            </div>
            <div className="px-5 py-4">
              <div className="h-3 w-full overflow-hidden rounded-full bg-white/5">
                <div
                  className={`meter-fill ${isVolumeWarn ? "meter-fill-warn" : ""}`}
                  style={{ width: `${volumePct}%` }}
                />
              </div>
              {isVolumeWarn && isActive && (
                <p className="mt-2 flex items-center gap-1 text-xs text-amber-400">
                  <TriangleAlert className="h-3 w-3" /> Very low volume
                </p>
              )}
            </div>
          </section>

          {/* Pitch gauge */}
          <section className="glass-card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-5 py-3">
              <Activity className="h-4 w-4 text-cyan-400" />
              <h2 className="text-sm font-semibold text-[var(--color-text-secondary)]">
                Pitch
              </h2>
              <span className="ml-auto font-mono text-xs text-[var(--color-text-muted)]">
                {displayMetrics.frequencyHz > 0
                  ? `${displayMetrics.frequencyHz.toFixed(1)} Hz`
                  : "—"}
              </span>
            </div>
            <div className="px-5 py-4">
              <div className="h-3 w-full overflow-hidden rounded-full bg-white/5">
                <div
                  className={`meter-fill ${isPitchWarn ? "meter-fill-warn" : ""}`}
                  style={{ width: `${pitchPct}%` }}
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-[var(--color-text-muted)]">
                <span>
                  {targetPitchHz > 0
                    ? `Target: ${targetPitchHz.toFixed(0)} Hz`
                    : syllableTracker.isRest
                    ? "Rest"
                    : "Target: —"}
                </span>
                {displayMetrics.frequencyHz > 0 && targetPitchHz > 0 && (
                  <span
                    className={
                      isPitchWarn ? "text-rose-400" : "text-emerald-400"
                    }
                  >
                    Δ {Math.abs(pitchDeltaCents).toFixed(0)}¢
                    {pitchDeltaCents > 0 ? " sharp" : pitchDeltaCents < 0 ? " flat" : ""}
                  </span>
                )}
              </div>
            </div>
          </section>

          <PerformanceIssues
            completedResults={syllableTracker.completedResults}
          />

          {/* Session info */}
          <section className="glass-card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-5 py-3">
              <Radio className="h-4 w-4 text-fuchsia-400" />
              <h2 className="text-sm font-semibold text-[var(--color-text-secondary)]">
                Session
              </h2>
            </div>
            <div className="grid grid-cols-2 gap-4 px-5 py-4">
              <div>
                <p className="text-xs text-[var(--color-text-muted)]">
                  Elapsed
                </p>
                <p className="mt-0.5 font-mono text-lg font-bold text-white">
                  {Math.floor(sessionElapsed / 60)
                    .toString()
                    .padStart(2, "0")}
                  :{Math.floor(sessionElapsed % 60)
                    .toString()
                    .padStart(2, "0")}
                </p>
              </div>
              <div>
                <p className="text-xs text-[var(--color-text-muted)]">Status</p>
                <p
                  className={`mt-0.5 text-sm font-semibold ${
                    isPaused
                      ? "text-amber-400"
                      : isActive
                      ? "text-emerald-400"
                      : "text-zinc-500"
                  }`}
                >
                  {isPaused ? "Paused" : isActive ? "Recording" : "Idle"}
                </p>
              </div>
            </div>
          </section>

          {/* Simulate fault controls */}
          <section className="glass-card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-5 py-3">
              <Zap className="h-4 w-4 text-amber-400" />
              <h2 className="text-sm font-semibold text-[var(--color-text-secondary)]">
                Debug Controls
              </h2>
            </div>
            <div className="flex flex-col gap-2 px-5 py-4">
              <button
                disabled={!isConnected}
                onClick={() => sendCriticalError("VOLUME_SILENCE", true)}
                className="flex items-center justify-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs font-semibold text-amber-400 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                Simulate Volume Fault
              </button>
              <button
                disabled={!isConnected}
                onClick={() => sendCriticalError("PITCH_OFF_TARGET", true)}
                className="flex items-center justify-center gap-2 rounded-lg border border-rose-500/20 bg-rose-500/10 px-4 py-2 text-xs font-semibold text-rose-400 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                Simulate Pitch Fault
              </button>
              <button
                disabled={!isConnected || !isPaused}
                onClick={() => {
                  // Manually send a resume to clear paused state for testing
                  const pkt = JSON.stringify({
                    action: "RESUME_TRACK",
                    coach_notes: "Resuming session manually.",
                  });
                  sendData(new TextEncoder().encode(pkt), { reliable: true });
                }}
                className="flex items-center justify-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-xs font-semibold text-emerald-400 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Play className="h-3.5 w-3.5" />
                Force Resume
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
