import type { VocalMetrics } from "@/hooks/useVocalAnalyzer";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const NOTE_SEMITONES: Record<string, number> = {
  C: 0, "B#": 0, DB: 1, "C#": 1, D: 2, EB: 3, "D#": 3,
  E: 4, FB: 4, F: 5, "E#": 5, GB: 6, "F#": 6, G: 7,
  AB: 8, "G#": 8, A: 9, BB: 10, "A#": 10, B: 11, CB: 11,
};

/** Guitar open-string MIDI (high E → low E). */
export const GUITAR_OPEN_MIDI = [64, 59, 55, 50, 45, 40];

export type DemoInstrument = "piano" | "guitar" | "both";

export interface GuitarPosition {
  stringIndex: number;
  fret: number;
  noteName: string;
}

export function noteNameToMidi(name: string, defaultOctave = 4): number | null {
  const normalized = name.trim().toUpperCase().replace(/♯/g, "#").replace(/♭/g, "B").replace(/\s+/g, "");
  const match = normalized.match(/^([A-G](?:#|B)?)(\d)?$/);
  if (!match) return null;
  const semitone = NOTE_SEMITONES[match[1]];
  if (semitone === undefined) return null;
  const octave = match[2] ? parseInt(match[2], 10) : defaultOctave;
  return (octave + 1) * 12 + semitone;
}

export function normalizeNoteName(name: string, defaultOctave = 4): string | null {
  const midi = noteNameToMidi(name, defaultOctave);
  if (midi === null) return null;
  return midiToNoteName(midi);
}

export function midiToNoteName(midi: number): string {
  const rounded = Math.round(midi);
  const octave = Math.floor(rounded / 12) - 1;
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  return `${name}${octave}`;
}

export function hzToNoteName(hz: number): string {
  if (hz <= 0) return "—";
  const midi = 69 + 12 * Math.log2(hz / 440);
  return midiToNoteName(midi);
}

/** Composite 0–100 live vocal energy from volume, confidence, and clarity. */
export function computeLiveEnergy(metrics: VocalMetrics): number {
  const volNorm = Math.max(0, Math.min(1, (metrics.volumeDb + 65) / 50));
  if (!metrics.isVoiced && metrics.frequencyHz <= 0) {
    return Math.round(volNorm * 35);
  }
  const energy =
    volNorm * 0.45 + metrics.pitchConfidence * 0.3 + metrics.clarity * 0.25;
  return Math.round(Math.max(0, Math.min(100, energy * 100)));
}

export function midiToGuitarPosition(midi: number): GuitarPosition | null {
  let best: GuitarPosition | null = null;
  for (let s = 0; s < GUITAR_OPEN_MIDI.length; s++) {
    const fret = midi - GUITAR_OPEN_MIDI[s];
    if (fret >= 0 && fret <= 12) {
      if (!best || fret < best.fret) {
        best = {
          stringIndex: s,
          fret,
          noteName: midiToNoteName(midi),
        };
      }
    }
  }
  return best;
}

/** Piano keys shown on the board (inclusive MIDI range). */
export const PIANO_RANGE = { minMidi: 48, maxMidi: 72 }; // C3–C5

export function pianoKeysInRange(): { midi: number; name: string; isBlack: boolean }[] {
  const keys: { midi: number; name: string; isBlack: boolean }[] = [];
  for (let midi = PIANO_RANGE.minMidi; midi <= PIANO_RANGE.maxMidi; midi++) {
    const name = midiToNoteName(midi);
    const isBlack = name.includes("#");
    keys.push({ midi, name, isBlack });
  }
  return keys;
}
