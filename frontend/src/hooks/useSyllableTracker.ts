"use client";

import { useEffect, useRef, useState } from "react";
import type { SongBundle, SyllableAnnotation, SyllableIssue, SyllableResult } from "@/lib/songs/types";
import {
  PITCH_CLEAR_CENTS,
  PITCH_WARN_CENTS,
  SYLLABLE_VOICED_RATIO,
  VOLUME_SILENCE_THRESHOLD_DB,
  shiftHz,
  nearestOctaveCentsDeviation,
} from "@/lib/songs/pitch";

export interface UseSyllableTrackerOptions {
  song: SongBundle;
  elapsedSec: number;
  livePitchHz: number;
  volumeDb: number;
  enabled: boolean;
  keyShiftSemitones?: number;
}

export interface SyllableTrackerState {
  activeSyllable: SyllableAnnotation | null;
  activeLyricLineIdx: number;
  pitchDeltaCents: number;
  isOnPitch: boolean;
  isPitchWarn: boolean;
  expectedPitchHz: number;
  completedResults: SyllableResult[];
  isRest: boolean;
}

interface Sample {
  t: number;
  pitchHz: number;
  volumeDb: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function classifyIssue(
  medianPitch: number,
  expectedHz: number,
  voicedRatio: number,
  minVolume: number
): { issue: SyllableIssue; pitchErrorCents: number } {
  if (voicedRatio < SYLLABLE_VOICED_RATIO || medianPitch <= 0) {
    return { issue: "missed", pitchErrorCents: 0 };
  }
  if (minVolume < VOLUME_SILENCE_THRESHOLD_DB) {
    return { issue: "quiet", pitchErrorCents: nearestOctaveCentsDeviation(medianPitch, expectedHz) };
  }

  const cents = nearestOctaveCentsDeviation(medianPitch, expectedHz);
  if (Math.abs(cents) <= PITCH_CLEAR_CENTS) {
    return { issue: "ok", pitchErrorCents: cents };
  }
  if (cents > 0) {
    return { issue: "sharp", pitchErrorCents: cents };
  }
  return { issue: "flat", pitchErrorCents: cents };
}

export function useSyllableTracker(
  options: UseSyllableTrackerOptions
): SyllableTrackerState {
  const { song, elapsedSec, livePitchHz, volumeDb, enabled, keyShiftSemitones = 0 } = options;

  const [completedResults, setCompletedResults] = useState<SyllableResult[]>([]);
  const samplesRef = useRef<Map<string, Sample[]>>(new Map());
  const scoredRef = useRef<Set<string>>(new Set());

  const activeSyllable =
    enabled
      ? song.syllables.find((s) => elapsedSec >= s.start && elapsedSec < s.end) ?? null
      : null;

  const isRest = enabled && !activeSyllable && elapsedSec > 0;

  const activeLyricLineIdx = activeSyllable?.lyricLineIdx ?? -1;

  const expectedPitchHz = activeSyllable
    ? shiftHz(activeSyllable.expectedHz, keyShiftSemitones)
    : 0;
  const pitchDeltaCents =
    activeSyllable && livePitchHz > 0 && expectedPitchHz > 0
      ? nearestOctaveCentsDeviation(livePitchHz, expectedPitchHz)
      : 0;

  const isOnPitch =
    activeSyllable !== null &&
    livePitchHz > 0 &&
    Math.abs(pitchDeltaCents) <= PITCH_CLEAR_CENTS;

  const isPitchWarn =
    activeSyllable !== null &&
    livePitchHz > 0 &&
    Math.abs(pitchDeltaCents) > PITCH_WARN_CENTS;

  // Collect samples for active syllable
  useEffect(() => {
    if (!enabled || !activeSyllable) return;

    const key = `${activeSyllable.start}-${activeSyllable.token}`;
    const bucket = samplesRef.current.get(key) ?? [];
    bucket.push({ t: elapsedSec, pitchHz: livePitchHz, volumeDb });
    samplesRef.current.set(key, bucket);
  }, [enabled, activeSyllable, elapsedSec, livePitchHz, volumeDb]);

  // Score syllables once their window ends
  useEffect(() => {
    if (!enabled) return;

    const toScore = song.syllables.filter(
      (s) => elapsedSec >= s.end && !scoredRef.current.has(`${s.start}-${s.token}`)
    );

    if (toScore.length === 0) return;

    const newResults: SyllableResult[] = [];

    for (const syllable of toScore) {
      const key = `${syllable.start}-${syllable.token}`;
      scoredRef.current.add(key);

      const samples = samplesRef.current.get(key) ?? [];
      const voiced = samples.filter((s) => s.pitchHz > 0);
      const voicedRatio =
        samples.length > 0 ? voiced.length / samples.length : 0;
      const pitches = voiced.map((s) => s.pitchHz);
      const medianPitch = median(pitches);
      const minVolume =
        samples.length > 0
          ? Math.min(...samples.map((s) => s.volumeDb))
          : -100;

      const firstVoiced = voiced[0];
      const timingOffsetMs = firstVoiced
        ? (firstVoiced.t - syllable.start) * 1000
        : 0;

      const targetHz = shiftHz(syllable.expectedHz, keyShiftSemitones);
      const { issue, pitchErrorCents } = classifyIssue(
        medianPitch,
        targetHz,
        voicedRatio,
        minVolume
      );

      newResults.push({
        token: syllable.token,
        start: syllable.start,
        end: syllable.end,
        pitchErrorCents,
        timingOffsetMs,
        volumeOk: minVolume >= VOLUME_SILENCE_THRESHOLD_DB,
        issue,
      });
    }

    if (newResults.length > 0) {
      setCompletedResults((prev) => [...prev, ...newResults]);
    }
  }, [enabled, elapsedSec, song.syllables]);

  // Reset on disable
  useEffect(() => {
    if (enabled) return;
    samplesRef.current.clear();
    scoredRef.current.clear();
    setCompletedResults([]);
  }, [enabled]);

  return {
    activeSyllable,
    activeLyricLineIdx,
    pitchDeltaCents,
    isOnPitch,
    isPitchWarn,
    expectedPitchHz,
    completedResults,
    isRest,
  };
}

export function isMajorIssue(issue: SyllableIssue): boolean {
  return issue === "sharp" || issue === "flat" || issue === "missed" || issue === "quiet";
}

export function issueSeverity(issue: SyllableIssue): "ok" | "minor" | "major" {
  if (issue === "ok") return "ok";
  if (issue === "quiet") return "minor";
  return "major";
}

export function getSessionSummary(results: SyllableResult[]) {
  if (results.length === 0) {
    return { onPitchPct: 0, avgCentsError: 0, worstSyllable: null as string | null };
  }

  const okCount = results.filter((r) => r.issue === "ok").length;
  const pitchResults = results.filter((r) => r.issue !== "missed");
  const avgCentsError =
    pitchResults.length > 0
      ? pitchResults.reduce((sum, r) => sum + Math.abs(r.pitchErrorCents), 0) /
        pitchResults.length
      : 0;

  const worst = [...results].sort(
    (a, b) => Math.abs(b.pitchErrorCents) - Math.abs(a.pitchErrorCents)
  )[0];

  return {
    onPitchPct: Math.round((okCount / results.length) * 100),
    avgCentsError: Math.round(avgCentsError),
    worstSyllable:
      worst && worst.issue !== "ok" ? worst.token : null,
  };
}
