import type { DemoInstrument } from "@/lib/audio/notes";

export type InstrumentTimbre = "piano" | "guitar";

interface PartialSpec {
  ratio: number;
  gain: number;
  type: OscillatorType;
  detune?: number;
}

const PIANO_PARTIALS: PartialSpec[] = [
  { ratio: 1, gain: 1, type: "triangle" },
  { ratio: 2, gain: 0.48, type: "sine" },
  { ratio: 3, gain: 0.26, type: "sine" },
  { ratio: 4, gain: 0.14, type: "sine" },
  { ratio: 5.04, gain: 0.08, type: "sine", detune: 3 },
];

export interface InstrumentVoice {
  output: GainNode;
  setFrequency: (hz: number, glideSec?: number) => void;
  trigger: (hz: number) => void;
  release: (releaseSec?: number) => void;
  dispose: () => void;
}

export function createPianoVoice(ctx: AudioContext): InstrumentVoice {
  const output = ctx.createGain();
  output.gain.value = 0;

  const partialNodes = PIANO_PARTIALS.map(({ ratio, gain, type, detune = 0 }) => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = 440;
    osc.detune.value = detune;
    g.gain.value = gain;
    osc.connect(g);
    g.connect(output);
    osc.start();
    return { osc, ratio };
  });

  const applyPianoEnvelope = (peak: number) => {
    const now = ctx.currentTime;
    output.gain.cancelScheduledValues(now);
    output.gain.setValueAtTime(0, now);
    output.gain.linearRampToValueAtTime(peak, now + 0.012);
    output.gain.exponentialRampToValueAtTime(peak * 0.55, now + 0.18);
    output.gain.exponentialRampToValueAtTime(peak * 0.28, now + 0.9);
  };

  return {
    output,
    setFrequency(hz, glideSec = 0.04) {
      const now = ctx.currentTime;
      for (const { osc, ratio } of partialNodes) {
        osc.frequency.setTargetAtTime(hz * ratio, now, glideSec);
      }
    },
    trigger(hz) {
      this.setFrequency(hz, 0.008);
      applyPianoEnvelope(0.22);
    },
    release(releaseSec = 0.12) {
      const now = ctx.currentTime;
      output.gain.cancelScheduledValues(now);
      output.gain.setTargetAtTime(0, now, releaseSec);
    },
    dispose() {
      partialNodes.forEach(({ osc }) => {
        try {
          osc.stop();
          osc.disconnect();
        } catch {
          // already stopped
        }
      });
      output.disconnect();
    },
  };
}

export function createGuitarVoice(ctx: AudioContext): InstrumentVoice {
  const output = ctx.createGain();
  output.gain.value = 0;

  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = 440;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 2200;
  filter.Q.value = 0.8;

  osc.connect(filter);
  filter.connect(output);
  osc.start();

  return {
    output,
    setFrequency(hz, glideSec = 0.03) {
      osc.frequency.setTargetAtTime(hz, ctx.currentTime, glideSec);
      filter.frequency.setTargetAtTime(
        Math.min(4000, hz * 4.5),
        ctx.currentTime,
        glideSec
      );
    },
    trigger(hz) {
      const now = ctx.currentTime;
      this.setFrequency(hz, 0.005);
      output.gain.cancelScheduledValues(now);
      output.gain.setValueAtTime(0, now);
      output.gain.linearRampToValueAtTime(0.16, now + 0.008);
      output.gain.exponentialRampToValueAtTime(0.05, now + 0.55);
    },
    release(releaseSec = 0.06) {
      const now = ctx.currentTime;
      output.gain.cancelScheduledValues(now);
      output.gain.setTargetAtTime(0, now, releaseSec);
    },
    dispose() {
      try {
        osc.stop();
        osc.disconnect();
      } catch {
        // already stopped
      }
      filter.disconnect();
      output.disconnect();
    },
  };
}

export function timbresForInstrument(instrument: DemoInstrument): InstrumentTimbre[] {
  if (instrument === "piano") return ["piano"];
  if (instrument === "guitar") return ["guitar"];
  return ["piano", "guitar"];
}
