/** Convert MIDI note number to Hz, optionally transposed by key_diff semitones. */
export function midiToHz(midi: number, keyDiff = 0): number {
  return 440 * Math.pow(2, (midi - 69 + keyDiff) / 12);
}

/** Shift an Hz value by `semitones` */
export function shiftHz(hz: number, semitones: number): number {
  if (hz <= 0) return 0;
  return hz * Math.pow(2, semitones / 12);
}

/** Cents deviation between actual and expected pitch (positive = sharp). */
export function centsDeviation(actualHz: number, expectedHz: number): number {
  if (actualHz <= 0 || expectedHz <= 0) return 0;
  return 1200 * Math.log2(actualHz / expectedHz);
}

/**
 * Find the smallest absolute cents deviation between actualHz and targetHz,
 * allowing ±3 octaves. Returns the signed cents error to the closest octave.
 */
export function nearestOctaveCentsDeviation(actualHz: number, expectedHz: number): number {
  if (actualHz <= 0 || expectedHz <= 0) return 0;
  let bestCents = Infinity;
  let bestSignedCents = 0;
  for (let o = -3; o <= 3; o++) {
    const shifted = expectedHz * Math.pow(2, o);
    const cents = 1200 * Math.log2(actualHz / shifted);
    if (Math.abs(cents) < Math.abs(bestCents)) {
      bestCents = cents;
      bestSignedCents = cents;
    }
  }
  return bestSignedCents;
}

/** Within this many cents of target counts as on-pitch (green / correct). */
export const PITCH_CLEAR_CENTS = 60;
/** Beyond this many cents triggers a warning state. */
export const PITCH_WARN_CENTS = 90;
/** Clearly wrong — used for major-issue classification. */
export const PITCH_MAJOR_CENTS = 100;
export const VOLUME_SILENCE_THRESHOLD_DB = -70;
export const SYLLABLE_VOICED_RATIO = 0.2;
