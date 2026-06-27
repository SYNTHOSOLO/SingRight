const MIN_HZ = 60;
const MAX_HZ = 1200;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export interface PitchDetectionResult {
  frequencyHz: number;
  confidence: number;
  clarity: number;
  isVoiced: boolean;
  noteName: string;
  midiNote: number;
}

/** YIN pitch detector — optimized version with restricted search range and fast voicing gate. */
export function detectPitchYin(
  buffer: Float32Array,
  sampleRate: number,
  threshold = 0.15
): PitchDetectionResult {
  const empty: PitchDetectionResult = {
    frequencyHz: 0,
    confidence: 0,
    clarity: 0,
    isVoiced: false,
    noteName: "—",
    midiNote: 0,
  };

  const n = buffer.length;
  if (n < 2) return empty;

  let rms = 0;
  for (let i = 0; i < n; i++) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / n);
  
  // Gate out background room noise and breathing (increased from 0.002 to 0.015)
  if (rms < 0.015) return empty;

  const minTau = Math.floor(sampleRate / MAX_HZ);
  const maxTau = Math.min(Math.floor(sampleRate / MIN_HZ), n - 3);

  // We only need to calculate YIN values up to maxTau + 2 for parabolic interpolation
  const yin = new Float32Array(maxTau + 3);
  yin[0] = 1;

  let runningSum = 0;
  for (let tau = 1; tau <= maxTau + 2; tau++) {
    let sum = 0;
    for (let i = 0; i < n - tau; i++) {
      const d = buffer[i] - buffer[i + tau];
      sum += d * d;
    }
    runningSum += sum;
    yin[tau] = runningSum === 0 ? 1 : (sum * tau) / runningSum;
  }

  let bestTau = -1;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (yin[tau] < threshold) {
      while (tau + 1 <= maxTau && yin[tau + 1] < yin[tau]) {
        tau++;
      }
      bestTau = tau;
      break;
    }
  }

  if (bestTau === -1) {
    let minVal = Infinity;
    for (let tau = minTau; tau <= maxTau; tau++) {
      if (yin[tau] < minVal) {
        minVal = yin[tau];
        bestTau = tau;
      }
    }
    if (bestTau === -1 || minVal > (rms > 0.04 ? 0.55 : 0.45)) return empty;
  }

  // Parabolic interpolation around the best lag
  let refinedTau = bestTau;
  if (bestTau > minTau && bestTau < maxTau) {
    const s0 = yin[bestTau - 1];
    const s1 = yin[bestTau];
    const s2 = yin[bestTau + 1];
    const denom = 2 * s1 - s2 - s0;
    if (denom !== 0) {
      refinedTau = bestTau + (s2 - s0) / (2 * denom);
    }
  }

  const frequencyHz = sampleRate / refinedTau;
  if (frequencyHz < MIN_HZ || frequencyHz > MAX_HZ) return empty;

  // 1 - difference function value is the confidence of periodicity
  const confidence = Math.max(0, Math.min(1, 1 - yin[bestTau]));
  
  // Voice gate threshold (0.20 difference is standard for YIN voicing)
  const isVoiced = confidence > 0.80; 
  const midiNote = Math.round(69 + 12 * Math.log2(frequencyHz / 440));

  return {
    frequencyHz: Math.round(frequencyHz * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    clarity: Math.round(confidence * 100) / 100,
    isVoiced,
    noteName: hzToNoteName(frequencyHz),
    midiNote,
  };
}

export function hzToNoteName(hz: number): string {
  if (hz <= 0) return "—";
  const midi = 69 + 12 * Math.log2(hz / 440);
  const rounded = Math.round(midi);
  const octave = Math.floor(rounded / 12) - 1;
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  return `${name}${octave}`;
}
