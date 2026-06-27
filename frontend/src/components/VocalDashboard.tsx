"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useDataChannel,
  useConnectionState,
  useTranscriptions,
  useLocalParticipant,
  useRemoteParticipants,
} from "@livekit/components-react";
import { ConnectionState, RemoteAudioTrack } from "livekit-client";
import type { DataPublishOptions } from "livekit-client";
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
  Eye,
  EyeOff,
  Guitar,
  Piano,
  Minus,
  Plus,
} from "lucide-react";
import { useVocalAnalyzer, VocalMetrics } from "@/hooks/useVocalAnalyzer";
import { useSongPlayback } from "@/hooks/useSongPlayback";
import { useSyllableTracker } from "@/hooks/useSyllableTracker";
import { useTonePlayer } from "@/hooks/useTonePlayer";
import { SONG_EN001A } from "@/lib/songs/en001a";
import { VOLUME_SILENCE_THRESHOLD_DB, shiftHz } from "@/lib/songs/pitch";
import PitchLane from "@/components/PitchLane";
import PitchContourChart from "@/components/PitchContourChart";
import PerformanceIssues from "@/components/PerformanceIssues";
import LiveSoundEnergy from "@/components/LiveSoundEnergy";
import InstrumentNoteBoard from "@/components/InstrumentNoteBoard";
import { hzToNoteName, type DemoInstrument } from "@/lib/audio/notes";
import {
  parsePlayRequest,
  playRequestKey,
} from "@/lib/audio/playRequestParser";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TELEMETRY_INTERVAL_MS = 250; // how often we send metrics to the agent
const DISPLAY_UPDATE_MS = 100; // throttle UI meter updates to reduce flicker
const VOLUME_WARN_CLEAR_DB = -55;
const PITCH_HOLD_MS = 250;
const METRIC_SMOOTHING = 0.6; // higher = faster tracking (MPM already has internal median filtering)
const AUTO_FAULT_COOLDOWN_MS = 5000;
const AUTO_FAULT_DELAY_MS = 1500;
const VISUAL_CUE_FADE_MS = 3500;

type VisualCueTone = "positive" | "corrective" | "neutral";

interface VisualCue {
  text: string;
  tone: VisualCueTone;
}

interface TranscriptLine {
  isAgent: boolean;
  text: string;
  key: string;
}

const VISUAL_CUE_STYLES: Record<
  VisualCueTone,
  { bg: string; text: string; glow: string }
> = {
  positive: {
    bg: "from-emerald-500/25 to-teal-500/20",
    text: "text-emerald-200",
    glow: "shadow-emerald-500/30",
  },
  corrective: {
    bg: "from-amber-500/25 to-rose-500/20",
    text: "text-amber-100",
    glow: "shadow-amber-500/30",
  },
  neutral: {
    bg: "from-violet-500/25 to-cyan-500/20",
    text: "text-violet-100",
    glow: "shadow-violet-500/30",
  },
};

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

function isAgentIdentity(identity: string): boolean {
  return identity.includes("agent") || identity.startsWith("agent-");
}

function groupTranscriptLines(
  transcriptions: { text: string; participantInfo?: { identity?: string } }[]
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];

  for (let idx = 0; idx < transcriptions.length; idx++) {
    const entry = transcriptions[idx];
    const identity = entry.participantInfo?.identity ?? "";
    const isAgent = isAgentIdentity(identity);
    const text = entry.text.trim();
    if (!text) continue;

    const last = lines[lines.length - 1];
    if (last && last.isAgent === isAgent) {
      last.text = text;
      last.key = `${last.key}-${idx}`;
    } else {
      lines.push({ isAgent, text, key: `${identity}-${idx}` });
    }
  }

  return lines;
}

function useAgentAudioMute(muted: boolean) {
  const participants = useRemoteParticipants();

  useEffect(() => {
    for (const participant of participants) {
      participant.audioTrackPublications.forEach((pub) => {
        const track = pub.track;
        if (track instanceof RemoteAudioTrack) {
          track.setVolume(muted ? 0 : 1);
        }
      });
    }
  }, [participants, muted]);
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
  const [nonInterruptMode, setNonInterruptMode] = useState(true);
  const [allowAgentSpeech, setAllowAgentSpeech] = useState(false);
  const [visualCue, setVisualCue] = useState<VisualCue | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [coachNotes, setCoachNotes] = useState<string | null>(null);
  const [keyShift, setKeyShift] = useState(0);
  const [guideMelodyEnabled, setGuideMelodyEnabled] = useState(true);
  const [coachStatus, setCoachStatus] = useState<
    "idle" | "speaking" | "paused"
  >("idle");
  const [sessionElapsed, setSessionElapsed] = useState(0);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [displayMetrics, setDisplayMetrics] = useState<VocalMetrics>({
    volumeDb: -100,
    frequencyHz: 0,
    pitchConfidence: 0,
    clarity: 0,
    isVoiced: false,
    noteName: "—",
  });
  const [isVolumeWarn, setIsVolumeWarn] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [coachDemonstrating, setCoachDemonstrating] = useState(false);
  const [demoNotes, setDemoNotes] = useState<string[]>([]);
  const [demoActiveNote, setDemoActiveNote] = useState<string | null>(null);
  const [demoInstrument, setDemoInstrument] = useState<DemoInstrument>("both");
  const [instrumentFollowEnabled, setInstrumentFollowEnabled] = useState(false);
  const [followInstrument, setFollowInstrument] = useState<DemoInstrument>("both");

  // Refs for interval / telemetry gating
  const metricsRef = useRef<VocalMetrics>({
    volumeDb: -100,
    frequencyHz: 0,
    pitchConfidence: 0,
    clarity: 0,
    isVoiced: false,
    noteName: "—",
  });
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
  const nonInterruptModeRef = useRef(nonInterruptMode);
  nonInterruptModeRef.current = nonInterruptMode;
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const karaokeTranscriptScrollRef = useRef<HTMLDivElement>(null);
  const visualCueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  isPausedRef.current = isPaused;

  // Smoothed display refs (updated every frame, flushed to state on an interval)
  const smoothedRef = useRef({ volumeDb: -100, frequencyHz: 0 });
  const lastPitchAtRef = useRef(0);
  const lastDisplayFlushRef = useRef(0);

  const lastPlayRequestRef = useRef<string>("");
  const lastPlayRequestAtRef = useRef(0);

  const tonePlayer = useTonePlayer();
  const tonePlayerRef = useRef(tonePlayer);
  tonePlayerRef.current = tonePlayer;

  const sendAnalysisSnapshot = useCallback(() => {
    const sendFn = sendTelemetryRef.current;
    if (!sendFn) return;
    const m = metricsRef.current;
    const t = trackerRef.current;
    const packet = JSON.stringify({
      type: "ANALYSIS_SNAPSHOT",
      song_id: ACTIVE_SONG.id,
      syllable: t.activeSyllableToken,
      pitch_hz: m.frequencyHz,
      expected_pitch_hz: t.expectedPitchHz || null,
      pitch_delta_cents: t.pitchDeltaCents,
      pitch_confidence: m.pitchConfidence,
      clarity: m.clarity,
      is_voiced: m.isVoiced,
      note_name: m.noteName,
      volume_db: m.volumeDb,
      on_pitch: t.isOnPitch,
    });
    void sendFn(new TextEncoder().encode(packet), { reliable: true });
  }, []);

  const sendTelemetryRef = useRef<
    ((payload: Uint8Array, options: DataPublishOptions) => Promise<void>) | null
  >(null);

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
          setCoachDemonstrating(false);
        } else if (action === "SHOW_TIPS") {
          setCoachNotes(notes ?? null);
        } else if (action === "SHOW_CUE") {
          const cue = (parsed.cue as string) ?? "";
          const tone = (parsed.tone as VisualCueTone) ?? "neutral";
          if (cue) {
            setVisualCue({ text: cue, tone });
            if (visualCueTimerRef.current) clearTimeout(visualCueTimerRef.current);
            visualCueTimerRef.current = setTimeout(() => {
              setVisualCue(null);
            }, VISUAL_CUE_FADE_MS);
          }
        } else if (action === "SHOW_NOTES") {
          const rawNotes = parsed.notes as Array<{
            note_name: string;
            frequency_hz: number;
            duration_ms?: number;
          }>;
          if (rawNotes?.length) {
            const inst = (parsed.instrument as DemoInstrument) ?? "piano";
            setDemoInstrument(inst);
            setDemoNotes(rawNotes.map((n) => n.note_name));
            setDemoActiveNote(rawNotes[0]?.note_name ?? null);
            setCoachDemonstrating(true);
            setCoachStatus("speaking");
            setCoachNotes(
              notes ?? `On the board: ${rawNotes.map((n) => n.note_name).join(", ")}`
            );
          }
        } else if (action === "PLAY_REFERENCE_TONE") {
          const hz = parsed.frequency_hz as number;
          const durationMs = (parsed.duration_ms as number) ?? 1200;
          const syllable = parsed.syllable as string | undefined;
          const noteName =
            (parsed.note_name as string) ||
            (hz > 0 ? hzToNoteName(hz) : null) ||
            "—";
          if (!hz || hz <= 0) return;
          const inst = (parsed.instrument as DemoInstrument) ?? "both";
          setDemoInstrument(inst);
          setDemoNotes(noteName !== "—" ? [noteName] : []);
          setDemoActiveNote(noteName !== "—" ? noteName : null);
          setCoachDemonstrating(true);
          setCoachStatus("speaking");
          setCoachNotes(
            notes ?? `Reference tone: ${syllable ?? noteName} ${hz?.toFixed(0)} Hz`
          );
          void tonePlayerRef.current.playTone(hz, durationMs, inst).finally(() => {
            setCoachDemonstrating(false);
            setDemoActiveNote(null);
            setDemoNotes([]);
          });
        } else if (action === "PLAY_NOTE_SEQUENCE") {
          const rawNotes = parsed.notes as Array<{
            note_name: string;
            frequency_hz: number;
            duration_ms?: number;
          }>;
          if (rawNotes?.length) {
            const validNotes = rawNotes.filter((n) => n.frequency_hz > 0);
            if (!validNotes.length) return;
            const inst = (parsed.instrument as DemoInstrument) ?? "both";
            setDemoInstrument(inst);
            setDemoNotes(validNotes.map((n) => n.note_name));
            setCoachDemonstrating(true);
            setCoachStatus("speaking");
            const label = validNotes.map((n) => n.note_name).join(" → ");
            setCoachNotes(notes ?? `Playing: ${label}`);
            const events = validNotes.map((n) => ({
              frequencyHz: n.frequency_hz,
              durationMs: n.duration_ms ?? 1200,
              syllable: n.note_name,
            }));
            void tonePlayerRef.current
              .playSequence(
                events,
                (_i, event) => {
                  setDemoActiveNote(event.syllable ?? null);
                },
                inst
              )
              .finally(() => {
                setCoachDemonstrating(false);
                setDemoActiveNote(null);
                setDemoNotes([]);
              });
          }
        } else if (action === "PLAY_LYRIC_LINE") {
          const lineIndex = parsed.line_index as number;
          const group = ACTIVE_SONG.lineGroups[lineIndex];
          if (group) {
            setCoachDemonstrating(true);
            setCoachStatus("speaking");
            setCoachNotes(notes ?? `Playing: ${group.lyricText}`);
            const events = group.syllables.map((s) => ({
              frequencyHz: s.expectedHz,
              durationMs: Math.max(300, Math.round((s.end - s.start) * 1000)),
              syllable: s.token,
            }));
            void tonePlayerRef.current.playSequence(events).then(() => {
              setCoachDemonstrating(false);
            });
          }
        } else if (action === "REQUEST_ANALYSIS") {
          setCoachNotes(notes ?? "Running detailed voice analysis…");
          sendAnalysisSnapshot();
        }
      } catch {
        // Non-JSON payloads are silently ignored.
      }
    },
    [sendAnalysisSnapshot]
  );

  const { send: sendData } = useDataChannel("session_control", onDataReceived);
  const { send: sendTelemetry } = useDataChannel("telemetry");
  sendTelemetryRef.current = sendTelemetry;

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
      pitchConfidence: m.pitchConfidence,
      clarity: m.clarity,
      isVoiced: m.isVoiced,
      noteName: m.noteName,
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
    keyShiftSemitones: keyShift,
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
    setDisplayMetrics({
      volumeDb: -100,
      frequencyHz: 0,
      pitchConfidence: 0,
      clarity: 0,
      isVoiced: false,
      noteName: "—",
    });
    setIsVolumeWarn(false);
  }, [isActive]);

  // ── Guide Melody Synth (Web Audio sine wave guide tones) ───────────────
  const guideOscRef = useRef<OscillatorNode | null>(null);
  const guideGainRef = useRef<GainNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const shouldPlay = isActive && coachingMode === "karaoke" && !isPaused && syllableTracker.activeSyllable && guideMelodyEnabled;
    const targetHz = syllableTracker.activeSyllable
      ? shiftHz(syllableTracker.activeSyllable.expectedHz, keyShift)
      : 0;

    if (!shouldPlay || targetHz <= 0) {
      if (guideGainRef.current) {
        guideGainRef.current.gain.setTargetAtTime(0, audioCtxRef.current?.currentTime ?? 0, 0.05);
      }
      return;
    }

    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }

      if (!guideGainRef.current) {
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.connect(ctx.destination);
        guideGainRef.current = gain;
      }
      const gainNode = guideGainRef.current;

      if (!guideOscRef.current) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(targetHz, ctx.currentTime);
        osc.connect(gainNode);
        osc.start();
        guideOscRef.current = osc;
      } else {
        guideOscRef.current.frequency.setTargetAtTime(targetHz, ctx.currentTime, 0.03);
      }

      gainNode.gain.setTargetAtTime(0.12, ctx.currentTime, 0.05);
    } catch (err) {
      console.warn("Failed to play guide synth note:", err);
    }
  }, [isActive, coachingMode, isPaused, syllableTracker.activeSyllable, keyShift, guideMelodyEnabled]);

  useEffect(() => {
    if (!isActive) {
      if (guideOscRef.current) {
        try {
          guideOscRef.current.stop();
          guideOscRef.current.disconnect();
        } catch {}
        guideOscRef.current = null;
      }
      if (guideGainRef.current) {
        guideGainRef.current.disconnect();
        guideGainRef.current = null;
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    }
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
  const transcriptLines = useMemo(
    () => groupTranscriptLines(transcriptions),
    [transcriptions]
  );
  const studentLines = useMemo(
    () => transcriptLines.filter((line) => !line.isAgent),
    [transcriptLines]
  );
  const latestStudentText = studentLines.at(-1)?.text ?? "";

  const agentAudioMuted =
    coachingMode === "conversational" &&
    nonInterruptMode &&
    !allowAgentSpeech;
  useAgentAudioMute(agentAudioMuted);

  // Detect "play G3 on piano" in student speech → direct backend execution
  useEffect(() => {
    if (!isConnected || !isActive || !latestStudentText) return;

    const request = parsePlayRequest(latestStudentText);
    if (!request) return;

    const key = playRequestKey(request);
    const now = Date.now();
    if (
      key === lastPlayRequestRef.current &&
      now - lastPlayRequestAtRef.current < 4000
    ) {
      return;
    }
    lastPlayRequestRef.current = key;
    lastPlayRequestAtRef.current = now;

    const sendFn = sendTelemetryRef.current;
    if (!sendFn) return;

    const packet = JSON.stringify({
      type: "USER_PLAY_REQUEST",
      pitch: request.pitch,
      instrument: request.instrument,
    });
    void sendFn(new TextEncoder().encode(packet), { reliable: true });
  }, [latestStudentText, isConnected, isActive]);

  useEffect(() => {
    const scrollContainerToBottom = (container: HTMLDivElement | null) => {
      if (!container) return;
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      // Only scroll the transcript panel — never the page — and only if already near bottom.
      if (distanceFromBottom < 80) {
        container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
      }
    };

    scrollContainerToBottom(transcriptScrollRef.current);
    scrollContainerToBottom(karaokeTranscriptScrollRef.current);
  }, [transcriptLines]);

  useEffect(() => {
    return () => {
      if (visualCueTimerRef.current) clearTimeout(visualCueTimerRef.current);
    };
  }, []);

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
        pitch_confidence: m.pitchConfidence,
        clarity: m.clarity,
        is_voiced: m.isVoiced,
        note_name: m.noteName,
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

  useEffect(() => {
    if (!isConnected) return;
    const packet = JSON.stringify({
      type: "NON_INTERRUPT_MODE",
      enabled: nonInterruptMode,
    });
    sendTelemetry(new TextEncoder().encode(packet), { reliable: true });
  }, [nonInterruptMode, isConnected, sendTelemetry]);

  useEffect(() => {
    if (!isConnected) return;
    const packet = JSON.stringify({
      type: "INSTRUMENT_FOLLOW",
      enabled: instrumentFollowEnabled,
      instrument: followInstrument,
    });
    sendTelemetry(new TextEncoder().encode(packet), { reliable: true });
  }, [instrumentFollowEnabled, followInstrument, isConnected, sendTelemetry]);

  useEffect(() => {
    tonePlayer.setInstrumentFollow(
      instrumentFollowEnabled && isActive && !coachDemonstrating,
      followInstrument
    );
  }, [
    instrumentFollowEnabled,
    followInstrument,
    isActive,
    coachDemonstrating,
    tonePlayer,
  ]);

  useEffect(() => {
    if (!instrumentFollowEnabled || !isActive || coachDemonstrating) return;
    tonePlayer.updateInstrumentFollow(
      displayMetrics.frequencyHz,
      displayMetrics.isVoiced,
      displayMetrics.pitchConfidence
    );
  }, [
    displayMetrics,
    instrumentFollowEnabled,
    isActive,
    coachDemonstrating,
    tonePlayer,
  ]);

  useEffect(() => {
    if (coachingMode === "conversational") {
      setNonInterruptMode(true);
    } else {
      setAllowAgentSpeech(false);
      setVisualCue(null);
    }
  }, [coachingMode]);

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
  const liveNote =
    displayMetrics.isVoiced && displayMetrics.noteName !== "—"
      ? displayMetrics.noteName
      : null;
  const targetNote =
    targetPitchHz > 0 ? hzToNoteName(targetPitchHz) : null;

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

  // ── Auto-detect sustained vocal faults (Disabled to prevent session breaks) ──
  useEffect(() => {
    // We disable automatic pauses to let the user practice continuously without interruptions
    /*
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
    */
  }, [isVolumeWarn, isPitchWarn, isConnected, isActive, isPaused, sendCriticalError]);

  // ── Request Feedback ─────────────────────────────────────────────────
  const requestFeedback = useCallback(() => {
    if (!isConnected) return;
    setAllowAgentSpeech(true);
    const packet = JSON.stringify({ type: "REQUEST_FEEDBACK" });
    sendTelemetry(new TextEncoder().encode(packet), { reliable: true });
  }, [isConnected, sendTelemetry]);

  const handleSessionToggle = useCallback(async () => {
    if (isActive) {
      // Stop publishing mic to LiveKit so agent stops hearing us
      await localParticipant.setMicrophoneEnabled(false);
      songPlayback.stop();
      stop();
      tonePlayer.setInstrumentFollow(false);
      setInstrumentFollowEnabled(false);
      setSessionElapsed(0);
      sentSyllableResultsRef.current = 0;
      setMicError(null);
      setAllowAgentSpeech(false);
      setVisualCue(null);
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
  }, [isActive, songPlayback, stop, tonePlayer, localParticipant, start, coachingMode]);

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

        {/* Mode selector, Key Transposer, and Mic toggle */}
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

          {/* Key Transposer */}
          {coachingMode === "karaoke" && (
            <div className="flex items-center gap-2 rounded-full bg-white/5 p-1 border border-white/5 px-2">
              <span className="text-[10px] font-semibold tracking-wider text-[var(--color-text-muted)] uppercase pl-1 pr-1">Key</span>
              <button
                onClick={() => setKeyShift(prev => Math.max(-6, prev - 1))}
                disabled={keyShift <= -6}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-white/5 text-white hover:bg-white/15 transition disabled:opacity-40 disabled:hover:bg-white/5"
                title="Lower Key"
              >
                <Minus className="h-3 w-3" />
              </button>
              <span className="w-16 text-center text-xs font-mono font-bold text-violet-400">
                {keyShift === 0 ? "Original" : keyShift > 0 ? `+${keyShift} sem` : `${keyShift} sem`}
              </span>
              <button
                onClick={() => setKeyShift(prev => Math.min(6, prev + 1))}
                disabled={keyShift >= 6}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-white/5 text-white hover:bg-white/15 transition disabled:opacity-40 disabled:hover:bg-white/5"
                title="Raise Key"
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
          )}

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

                {/* Guide melody toggle */}
                {isActive && (
                  <button
                    onClick={() => setGuideMelodyEnabled(prev => !prev)}
                    className={`ml-3 rounded-full px-3 py-1 text-[10px] font-bold border transition ${
                      guideMelodyEnabled
                        ? "bg-violet-600/20 text-violet-300 border-violet-500/30 hover:bg-violet-600/30"
                        : "bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700"
                    }`}
                    title="Toggle Melody Guide Synth"
                  >
                    Guide Synth: {guideMelodyEnabled ? "ON" : "OFF"}
                  </button>
                )}

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

              {keyShift !== 0 && (
                <div className="bg-amber-500/10 border-b border-amber-500/20 px-5 py-2 flex items-center gap-2 text-amber-400/90">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
                  <span className="text-[11px] font-medium leading-normal">
                    Target notes transposed. The instrument track remains in the original key. Try humming or singing along in your comfortable octave!
                  </span>
                </div>
              )}

              <div className="p-3">
                <PitchLane
                  song={ACTIVE_SONG}
                  elapsedSec={sessionElapsed}
                  livePitchHz={displayMetrics.frequencyHz}
                  activeSyllable={syllableTracker.activeSyllable}
                  pitchDeltaCents={syllableTracker.pitchDeltaCents}
                  completedResults={syllableTracker.completedResults}
                  keyShiftSemitones={keyShift}
                />
              </div>
            </section>
          ) : (
            <section className="glass-card glow-violet overflow-hidden">
              <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-5 py-3">
                <Radio className="h-4 w-4 text-cyan-400 animate-pulse" />
                <h2 className="text-sm font-semibold text-[var(--color-text-secondary)]">
                  Conversational Mode
                </h2>
                {nonInterruptMode && (
                  <span className="ml-2 rounded-full bg-cyan-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cyan-300">
                    Silent cues
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setNonInterruptMode((prev) => !prev);
                    setAllowAgentSpeech(false);
                  }}
                  disabled={!isConnected}
                  className={`ml-auto flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold transition disabled:opacity-40 ${
                    nonInterruptMode
                      ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-300"
                      : "border-white/10 bg-white/5 text-[var(--color-text-muted)] hover:text-white"
                  }`}
                >
                  {nonInterruptMode ? (
                    <>
                      <EyeOff className="h-3 w-3" />
                      Non-Interrupt
                    </>
                  ) : (
                    <>
                      <Eye className="h-3 w-3" />
                      Verbal Coach
                    </>
                  )}
                </button>
              </div>

              {/* Big visual coaching cue */}
              <div className="relative flex min-h-[140px] items-center justify-center border-b border-[var(--color-border-subtle)] bg-[#0a0a0f]/60 px-6 py-8">
                {visualCue ? (
                  <p
                    key={visualCue.text}
                    className={`visual-cue-pop text-center text-4xl font-black tracking-tight sm:text-5xl ${
                      VISUAL_CUE_STYLES[visualCue.tone].text
                    }`}
                  >
                    {visualCue.text}
                  </p>
                ) : (
                  <p className="text-center text-sm text-[var(--color-text-muted)]">
                    {nonInterruptMode
                      ? "Coach cues appear here — no voice interruptions while you sing."
                      : "Coach will respond with voice and on-screen tips."}
                  </p>
                )}
                {visualCue && (
                  <div
                    className={`pointer-events-none absolute inset-4 rounded-2xl bg-gradient-to-br opacity-40 blur-2xl ${
                      VISUAL_CUE_STYLES[visualCue.tone].bg
                    }`}
                  />
                )}
              </div>

              {/* Live transcript */}
              <div className="flex flex-col gap-3 px-5 py-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                    Live Transcript
                  </h3>
                  {isActive && latestStudentText && (
                    <span className="text-[10px] text-emerald-400/80">Listening…</span>
                  )}
                </div>

                {latestStudentText && (
                  <p className="rounded-xl border border-violet-500/20 bg-violet-500/5 px-4 py-3 text-lg font-medium leading-snug text-white">
                    {latestStudentText}
                  </p>
                )}

                <div
                  ref={transcriptScrollRef}
                  className="flex max-h-[180px] flex-col gap-2 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800"
                >
                  {transcriptLines.length === 0 ? (
                    <p className="text-sm italic text-[var(--color-text-muted)]">
                      {isActive
                        ? "Start singing or speaking — your words appear here in real time."
                        : "Start a session to begin live transcription."}
                    </p>
                  ) : (
                    transcriptLines.map((line) => (
                      <div
                        key={line.key}
                        className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${
                          line.isAgent
                            ? "bg-cyan-500/5 text-[var(--color-text-muted)]"
                            : "bg-white/5 text-[var(--color-text-secondary)]"
                        }`}
                      >
                        <span
                          className={`mb-0.5 block text-[10px] font-bold uppercase tracking-wider ${
                            line.isAgent ? "text-cyan-400/70" : "text-violet-400/80"
                          }`}
                        >
                          {line.isAgent ? "Coach" : "You"}
                        </span>
                        {line.text}
                      </div>
                    ))
                  )}
                </div>

                <div className="flex flex-wrap gap-3 pt-1">
                  <button
                    disabled={!isConnected || !isActive}
                    onClick={requestFeedback}
                    className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-500/20 transition hover:shadow-xl hover:shadow-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Play className="h-4 w-4 fill-white" />
                    Stop &amp; Get Spoken Feedback
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
                keyShiftSemitones={keyShift}
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
                      ? coachingMode === "conversational" && nonInterruptMode
                        ? "Silent mode — glance at the big cue above while you sing."
                        : "Listening… The coach will chime in when it has feedback."
                      : "Start a session to receive live coaching."}
                  </p>
                )}
              </div>
            </section>

            {/* Real-time Transcription Stream — karaoke only (conversational has its own panel) */}
            {coachingMode === "karaoke" && (
            <section className="glass-card overflow-hidden">
              <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-5 py-3">
                <Radio className="h-4 w-4 text-fuchsia-400 animate-pulse" />
                <h2 className="text-sm font-semibold text-[var(--color-text-secondary)]">
                  Live Transcription Stream
                </h2>
              </div>
              <div
                ref={karaokeTranscriptScrollRef}
                className="flex max-h-[120px] flex-col gap-2 overflow-y-auto px-5 py-4 scrollbar-thin scrollbar-thumb-zinc-800"
              >
                {transcriptLines.length === 0 ? (
                  <p className="text-sm italic text-[var(--color-text-muted)]">
                    No speech detected yet.
                  </p>
                ) : (
                  transcriptLines.map((line) => (
                    <div key={line.key} className="flex flex-col gap-0.5 text-xs">
                      <span
                        className={`font-semibold ${
                          line.isAgent ? "text-cyan-400" : "text-violet-400"
                        }`}
                      >
                        {line.isAgent ? "Coach" : "Student"}:
                      </span>
                      <p className="text-[var(--color-text-secondary)] leading-relaxed">
                        {line.text}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </section>
            )}
          </div>
        </div>

        {/* ── Right column: Telemetry + Controls ──────────────────────── */}
        <div className="flex flex-col gap-6">
          <LiveSoundEnergy
            metrics={displayMetrics}
            targetNote={targetNote}
            isActive={isActive}
          />

          <InstrumentNoteBoard
            liveNote={liveNote}
            targetNote={targetNote}
            demoNotes={demoNotes}
            demoActiveNote={demoActiveNote}
            instrument={
              instrumentFollowEnabled ? followInstrument : demoInstrument
            }
            coachDemonstrating={coachDemonstrating}
          />

          {/* Instrument follow toggle */}
          <section className="glass-card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-5 py-3">
              <Guitar className="h-4 w-4 text-amber-400" />
              <h2 className="text-sm font-semibold text-[var(--color-text-secondary)]">
                Instrument Mirror
              </h2>
              <button
                type="button"
                disabled={!isActive}
                onClick={() => setInstrumentFollowEnabled((v) => !v)}
                className={`ml-auto rounded-full px-3 py-1 text-[11px] font-semibold transition disabled:opacity-40 ${
                  instrumentFollowEnabled
                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                    : "bg-white/5 text-[var(--color-text-muted)] border border-white/10"
                }`}
              >
                {instrumentFollowEnabled ? "On" : "Off"}
              </button>
            </div>
            <div className="space-y-3 px-5 py-4">
              <p className="text-xs text-[var(--color-text-muted)]">
                Mirror your sung pitch as live piano/guitar simulation. Turn on
                before singing — coach samples also use this sound.
              </p>
              <div className="flex rounded-full bg-white/5 p-0.5 border border-white/5">
                {(
                  [
                    ["piano", "Piano", Piano],
                    ["guitar", "Guitar", Guitar],
                    ["both", "Both", Music],
                  ] as const
                ).map(([id, label, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    disabled={!isActive}
                    onClick={() => setFollowInstrument(id)}
                    className={`flex flex-1 items-center justify-center gap-1 rounded-full px-2 py-1.5 text-[10px] font-semibold transition disabled:opacity-40 ${
                      followInstrument === id
                        ? "bg-violet-600 text-white"
                        : "text-[var(--color-text-muted)]"
                    }`}
                  >
                    <Icon className="h-3 w-3" />
                    {label}
                  </button>
                ))}
              </div>
              {instrumentFollowEnabled && isActive && displayMetrics.isVoiced && (
                <p className="text-center text-xs text-cyan-400">
                  Mirroring {displayMetrics.noteName.replace("#", "♯")} on{" "}
                  {followInstrument}
                </p>
              )}
            </div>
          </section>

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
                  ? `${displayMetrics.noteName} · ${displayMetrics.frequencyHz.toFixed(1)} Hz`
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
              <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-lg bg-white/5 px-2 py-1.5">
                  <p className="text-[var(--color-text-muted)]">Confidence</p>
                  <p className={`font-mono font-semibold ${displayMetrics.pitchConfidence > 0.5 ? "text-emerald-400" : "text-zinc-400"}`}>
                    {(displayMetrics.pitchConfidence * 100).toFixed(0)}%
                  </p>
                </div>
                <div className="rounded-lg bg-white/5 px-2 py-1.5">
                  <p className="text-[var(--color-text-muted)]">Clarity</p>
                  <p className={`font-mono font-semibold ${displayMetrics.clarity > 0.3 ? "text-cyan-400" : "text-zinc-400"}`}>
                    {(displayMetrics.clarity * 100).toFixed(0)}%
                  </p>
                </div>
                <div className="rounded-lg bg-white/5 px-2 py-1.5">
                  <p className="text-[var(--color-text-muted)]">Voiced</p>
                  <p className={`font-semibold ${displayMetrics.isVoiced ? "text-emerald-400" : "text-zinc-500"}`}>
                    {displayMetrics.isVoiced ? "Yes" : "No"}
                  </p>
                </div>
              </div>
              {coachDemonstrating && (
                <p className="mt-2 flex items-center gap-1 text-xs text-violet-400">
                  <Music className="h-3 w-3" /> Coach playing reference tones…
                </p>
              )}
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
