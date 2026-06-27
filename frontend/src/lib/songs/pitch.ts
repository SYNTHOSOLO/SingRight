/** Convert MIDI note number to Hz, optionally transposed by key_diff semitones. */
export function midiToHz(midi: number, keyDiff = 0): number {
  return 440 * Math.pow(2, (midi - 69 + keyDiff) / 12);
}

/** Cents deviation between actual and expected pitch (positive = sharp). */
export function centsDeviation(actualHz: number, expectedHz: number): number {
  if (actualHz <= 0 || expectedHz <= 0) return 0;
  return 1200 * Math.log2(actualHz / expectedHz);
}

export const PITCH_WARN_CENTS = 50;
export const PITCH_CLEAR_CENTS = 35;
export const PITCH_MAJOR_CENTS = 80;
export const VOLUME_SILENCE_THRESHOLD_DB = -60;
export const SYLLABLE_VOICED_RATIO = 0.3;
