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

/** YIN pitch detector — more stable on vocals than raw autocorrelation. */
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
  if (rms < 0.002) return empty;

  const yin = new Float32Array(n);
  yin[0] = 1;

  let runningSum = 0;
  for (let tau = 1; tau < n; tau++) {
    let sum = 0;
    for (let i = 0; i < n - tau; i++) {
      const d = buffer[i] - buffer[i + tau];
      sum += d * d;
    }
    runningSum += sum;
    yin[tau] = runningSum === 0 ? 1 : (sum * tau) / runningSum;
  }

  const minTau = Math.floor(sampleRate / MAX_HZ);
  const maxTau = Math.min(Math.floor(sampleRate / MIN_HZ), n - 1);

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

  // Parabolic interpolation
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

  const confidence = Math.max(0, Math.min(1, 1 - yin[bestTau]));
  const clarity = computeHarmonicClarity(buffer, sampleRate, frequencyHz);
  const midiNote = Math.round(69 + 12 * Math.log2(frequencyHz / 440));

  // Shouted / loud vocals have more broadband energy — relax gates when level is high.
  const minConfidence = rms > 0.05 ? 0.3 : rms > 0.02 ? 0.4 : 0.5;
  const minClarity = rms > 0.05 ? 0.06 : rms > 0.02 ? 0.1 : 0.15;
  const isVoiced = confidence > minConfidence && clarity > minClarity;

  return {
    frequencyHz: Math.round(frequencyHz * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    clarity: Math.round(clarity * 100) / 100,
    isVoiced,
    noteName: hzToNoteName(frequencyHz),
    midiNote,
  };
}

/** Ratio of energy at fundamental vs surrounding bins (0–1). */
function computeHarmonicClarity(
  buffer: Float32Array,
  sampleRate: number,
  fundamentalHz: number
): number {
  const fftSize = 2048;
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const len = Math.min(buffer.length, fftSize);
  for (let i = 0; i < len; i++) re[i] = buffer[i];

  // Simple DFT at fundamental bin only (lightweight)
  const k = Math.round((fundamentalHz * fftSize) / sampleRate);
  if (k < 1 || k >= fftSize / 2) return 0;

  let fundMag = 0;
  let neighborMag = 0;
  const bins = [k - 2, k - 1, k, k + 1, k + 2].filter(
    (b) => b >= 1 && b < fftSize / 2
  );

  for (const bin of bins) {
    let sumRe = 0;
    let sumIm = 0;
    for (let n = 0; n < len; n++) {
      const angle = (2 * Math.PI * bin * n) / fftSize;
      sumRe += buffer[n] * Math.cos(angle);
      sumIm -= buffer[n] * Math.sin(angle);
    }
    const mag = Math.sqrt(sumRe * sumRe + sumIm * sumIm);
    if (bin === k) fundMag = mag;
    else neighborMag += mag;
  }

  const total = fundMag + neighborMag;
  return total > 0 ? fundMag / total : 0;
}

export function hzToNoteName(hz: number): string {
  if (hz <= 0) return "—";
  const midi = 69 + 12 * Math.log2(hz / 440);
  const rounded = Math.round(midi);
  const octave = Math.floor(rounded / 12) - 1;
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  return `${name}${octave}`;
}
