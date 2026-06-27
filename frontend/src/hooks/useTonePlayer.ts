"use client";

import { useCallback, useRef } from "react";
import type { DemoInstrument } from "@/lib/audio/notes";
import {
  createGuitarVoice,
  createPianoVoice,
  timbresForInstrument,
  type InstrumentTimbre,
  type InstrumentVoice,
} from "@/lib/audio/instrumentSynth";

export interface ToneEvent {
  frequencyHz: number;
  durationMs: number;
  syllable?: string;
}

export interface UseTonePlayerReturn {
  playTone: (
    frequencyHz: number,
    durationMs?: number,
    instrument?: DemoInstrument
  ) => Promise<void>;
  playSequence: (
    events: ToneEvent[],
    onNoteStart?: (index: number, event: ToneEvent) => void,
    instrument?: DemoInstrument
  ) => Promise<void>;
  setInstrumentFollow: (enabled: boolean, instrument?: DemoInstrument) => void;
  updateInstrumentFollow: (
    frequencyHz: number,
    isVoiced: boolean,
    confidence: number
  ) => void;
  stop: () => void;
  isPlaying: boolean;
}

export function useTonePlayer(): UseTonePlayerReturn {
  const ctxRef = useRef<AudioContext | null>(null);
  const demoNodesRef = useRef<AudioNode[]>([]);
  const isPlayingRef = useRef(false);

  const followEnabledRef = useRef(false);
  const followInstrumentRef = useRef<DemoInstrument>("both");
  const followVoicesRef = useRef<{ piano?: InstrumentVoice; guitar?: InstrumentVoice }>({});
  const lastFollowMidiRef = useRef<number | null>(null);
  const followActiveRef = useRef(false);

  const getCtx = useCallback(async () => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext();
    }
    await ctxRef.current.resume();
    return ctxRef.current;
  }, []);

  const stopDemo = useCallback(() => {
    demoNodesRef.current.forEach((node) => {
      try {
        if (node instanceof OscillatorNode) node.stop();
        node.disconnect();
      } catch {
        // already stopped
      }
    });
    demoNodesRef.current = [];
    isPlayingRef.current = false;
  }, []);

  const ensureFollowVoices = useCallback(async (instrument: DemoInstrument) => {
    const ctx = await getCtx();
    const timbres = timbresForInstrument(instrument);
    const voices = followVoicesRef.current;

    if (timbres.includes("piano") && !voices.piano) {
      const v = createPianoVoice(ctx);
      v.output.connect(ctx.destination);
      voices.piano = v;
    }
    if (!timbres.includes("piano") && voices.piano) {
      voices.piano.dispose();
      delete voices.piano;
    }

    if (timbres.includes("guitar") && !voices.guitar) {
      const v = createGuitarVoice(ctx);
      v.output.connect(ctx.destination);
      voices.guitar = v;
    }
    if (!timbres.includes("guitar") && voices.guitar) {
      voices.guitar.dispose();
      delete voices.guitar;
    }
  }, [getCtx]);

  const releaseFollowVoices = useCallback(() => {
    const voices = followVoicesRef.current;
    voices.piano?.release();
    voices.guitar?.release();
    followActiveRef.current = false;
    lastFollowMidiRef.current = null;
  }, []);

  const playOneShot = useCallback(
    async (
      frequencyHz: number,
      durationMs: number,
      timbre: InstrumentTimbre
    ) => {
      const ctx = await getCtx();
      const voice =
        timbre === "piano" ? createPianoVoice(ctx) : createGuitarVoice(ctx);
      voice.output.connect(ctx.destination);
      demoNodesRef.current.push(voice.output);
      voice.trigger(frequencyHz);
      await new Promise((r) => setTimeout(r, durationMs));
      voice.release(0.05);
      await new Promise((r) => setTimeout(r, 80));
      voice.dispose();
    },
    [getCtx]
  );

  const playTone = useCallback(
    async (
      frequencyHz: number,
      durationMs = 1200,
      instrument: DemoInstrument = "both"
    ) => {
      if (!frequencyHz || frequencyHz <= 0) return;
      stopDemo();
      isPlayingRef.current = true;

      const timbres = timbresForInstrument(instrument);
      await Promise.all(
        timbres.map((t) => playOneShot(frequencyHz, durationMs, t))
      );

      isPlayingRef.current = false;
    },
    [playOneShot, stopDemo]
  );

  const playSequence = useCallback(
    async (
      events: ToneEvent[],
      onNoteStart?: (index: number, event: ToneEvent) => void,
      instrument: DemoInstrument = "both"
    ) => {
      stopDemo();
      isPlayingRef.current = true;

      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        onNoteStart?.(i, event);
        await playTone(event.frequencyHz, event.durationMs, instrument);
        await new Promise((r) => setTimeout(r, 60));
      }

      isPlayingRef.current = false;
    },
    [playTone, stopDemo]
  );

  const setInstrumentFollow = useCallback(
    (enabled: boolean, instrument: DemoInstrument = "both") => {
      followEnabledRef.current = enabled;
      followInstrumentRef.current = instrument;
      if (!enabled) {
        releaseFollowVoices();
        return;
      }
      void ensureFollowVoices(instrument);
    },
    [ensureFollowVoices, releaseFollowVoices]
  );

  const updateInstrumentFollow = useCallback(
    (frequencyHz: number, isVoiced: boolean, confidence: number) => {
      if (!followEnabledRef.current || isPlayingRef.current) return;

      void ensureFollowVoices(followInstrumentRef.current).then(() => {
        const voices = followVoicesRef.current;
        if (!isVoiced || frequencyHz <= 0 || confidence < 0.35) {
          if (followActiveRef.current) releaseFollowVoices();
          return;
        }

        const midi = Math.round(69 + 12 * Math.log2(frequencyHz / 440));
        const noteChanged = lastFollowMidiRef.current !== midi;

        if (noteChanged) {
          voices.piano?.trigger(frequencyHz);
          voices.guitar?.trigger(frequencyHz);
          lastFollowMidiRef.current = midi;
          followActiveRef.current = true;
        } else {
          voices.piano?.setFrequency(frequencyHz);
          voices.guitar?.setFrequency(frequencyHz);
        }
      });
    },
    [ensureFollowVoices, releaseFollowVoices]
  );

  const stop = useCallback(() => {
    stopDemo();
    releaseFollowVoices();
  }, [releaseFollowVoices, stopDemo]);

  return {
    playTone,
    playSequence,
    setInstrumentFollow,
    updateInstrumentFollow,
    stop,
    isPlaying: isPlayingRef.current,
  };
}
