"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useDataChannel, useConnectionState, useTranscriptions } from "@livekit/components-react";
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TELEMETRY_INTERVAL_MS = 250; // how often we send metrics to the agent
const VOLUME_SILENCE_THRESHOLD_DB = -60;
const PITCH_DEVIATION_HZ = 200; // deviation from target that triggers error

/** Sample lyrics for the karaoke display. */
const LYRICS = [
  { time: 0, text: "🎵  Take a deep breath…" },
  { time: 4, text: "Feel the rhythm in your chest" },
  { time: 8, text: "Let the melody rise" },
  { time: 12, text: "Through the night skies" },
  { time: 16, text: "Sing with all your heart" },
  { time: 20, text: "Every note a brand-new start" },
  { time: 24, text: "Hold the final tone…  🎶" },
];

const TARGET_PITCH_HZ = 440; // A4

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
  // ── LiveKit connection state ──────────────────────────────────────────
  const connectionState = useConnectionState();
  const isConnected = connectionState === ConnectionState.Connected;

  // ── Dashboard state ──────────────────────────────────────────────────
  const [isPaused, setIsPaused] = useState(false);
  const [coachNotes, setCoachNotes] = useState<string | null>(null);
  const [coachStatus, setCoachStatus] = useState<
    "idle" | "speaking" | "paused"
  >("idle");
  const [currentLyricIdx, setCurrentLyricIdx] = useState(0);
  const [sessionElapsed, setSessionElapsed] = useState(0);
  const [latestMetrics, setLatestMetrics] = useState<VocalMetrics>({
    volumeDb: -100,
    frequencyHz: 0,
  });
  const [alertMessage, setAlertMessage] = useState<string | null>(null);

  // Refs for interval / telemetry gating
  const metricsRef = useRef<VocalMetrics>({ volumeDb: -100, frequencyHz: 0 });
  const isPausedRef = useRef(false);
  isPausedRef.current = isPaused;

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

  // ── Vocal analyser hook ───────────────────────────────────────────────
  const onMetricsUpdate = useCallback((m: VocalMetrics) => {
    metricsRef.current = m;
    setLatestMetrics(m);
  }, []);

  const { isActive, metrics, analyserNode, start, stop } = useVocalAnalyzer({
    onMetricsUpdate,
  });

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
      // Gate: do NOT send while paused to prevent infinite loops
      if (isPausedRef.current) return;

      const m = metricsRef.current;
      const packet = JSON.stringify({
        type: "VOCAL_METRICS",
        volume_db: m.volumeDb,
        pitch_hz: m.frequencyHz,
      });

      sendData(new TextEncoder().encode(packet), { reliable: false });
    }, TELEMETRY_INTERVAL_MS);

    return () => clearInterval(id);
  }, [isConnected, isActive, sendData]);

  // ── Simulated lyric timer ─────────────────────────────────────────────
  useEffect(() => {
    if (isPaused || !isActive) return;

    const id = setInterval(() => {
      setSessionElapsed((prev) => {
        const next = prev + 1;
        // Advance lyric index
        const idx = LYRICS.findLastIndex((l) => l.time <= next);
        if (idx >= 0) setCurrentLyricIdx(idx);
        return next;
      });
    }, 1000);

    return () => clearInterval(id);
  }, [isPaused, isActive]);

  // ── Derived values ────────────────────────────────────────────────────
  const volumePct = dbToPercent(latestMetrics.volumeDb);
  const pitchPct = pitchToPercent(latestMetrics.frequencyHz);
  const pitchDeviation =
    latestMetrics.frequencyHz > 0
      ? Math.abs(latestMetrics.frequencyHz - TARGET_PITCH_HZ)
      : 0;
  const isVolumeWarn = latestMetrics.volumeDb < VOLUME_SILENCE_THRESHOLD_DB;
  const isPitchWarn = pitchDeviation > PITCH_DEVIATION_HZ && latestMetrics.frequencyHz > 0;

  // ── Simulate fault handler ────────────────────────────────────────────
  const simulateFault = useCallback(
    (reason: string) => {
      if (!isConnected) return;
      const packet = JSON.stringify({
        type: "CRITICAL_ERROR",
        reason,
      });
      sendData(new TextEncoder().encode(packet), { reliable: true });
    },
    [isConnected, sendData]
  );

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="relative mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-fuchsia-600 shadow-lg shadow-violet-600/20">
            <Headphones className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">
              AI Vocal Coach
            </h1>
            <p className="text-xs text-[var(--color-text-muted)]">
              Real-time pitch &amp; volume analysis
            </p>
          </div>
        </div>

        {/* Mic toggle */}
        <button
          onClick={isActive ? stop : start}
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
      </header>

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
          {/* Lyrics card */}
          <section className="glass-card glow-violet overflow-hidden">
            <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-5 py-3">
              <Music className="h-4 w-4 text-violet-400" />
              <h2 className="text-sm font-semibold text-[var(--color-text-secondary)]">
                Lyric Display
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

            <div className="flex flex-col items-center justify-center px-6 py-10">
              {LYRICS.map((line, idx) => (
                <p
                  key={idx}
                  className={`text-center text-xl font-bold leading-relaxed transition-all duration-300 sm:text-2xl ${
                    idx === currentLyricIdx
                      ? "lyric-active scale-105"
                      : idx < currentLyricIdx
                      ? "lyric-inactive text-sm opacity-40"
                      : "lyric-inactive text-base opacity-60"
                  }`}
                >
                  {line.text}
                </p>
              ))}
            </div>
          </section>

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
                    const isAgent = t.participantInfo?.identity?.includes("agent") || t.participantInfo?.identity === "";
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
                {latestMetrics.volumeDb.toFixed(1)} dB
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
                {latestMetrics.frequencyHz > 0
                  ? `${latestMetrics.frequencyHz.toFixed(1)} Hz`
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
                <span>Target: {TARGET_PITCH_HZ} Hz</span>
                {latestMetrics.frequencyHz > 0 && (
                  <span
                    className={
                      isPitchWarn ? "text-rose-400" : "text-emerald-400"
                    }
                  >
                    Δ {pitchDeviation.toFixed(0)} Hz
                  </span>
                )}
              </div>
            </div>
          </section>

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
                  :{(sessionElapsed % 60).toString().padStart(2, "0")}
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
                onClick={() => simulateFault("VOLUME_SILENCE")}
                className="flex items-center justify-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs font-semibold text-amber-400 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                Simulate Volume Fault
              </button>
              <button
                disabled={!isConnected}
                onClick={() =>
                  simulateFault("PITCH_DISTORTION_OUT_OF_BOUNDS")
                }
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
