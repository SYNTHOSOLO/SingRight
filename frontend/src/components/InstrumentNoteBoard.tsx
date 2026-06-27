"use client";

import { useEffect, useMemo, useState } from "react";
import { Guitar, Piano } from "lucide-react";
import {
  type DemoInstrument,
  GUITAR_OPEN_MIDI,
  midiToGuitarPosition,
  midiToNoteName,
  noteNameToMidi,
  pianoKeysInRange,
} from "@/lib/audio/notes";

interface InstrumentNoteBoardProps {
  liveNote?: string | null;
  targetNote?: string | null;
  demoNotes?: string[];
  demoActiveNote?: string | null;
  instrument?: DemoInstrument;
  coachDemonstrating?: boolean;
  className?: string;
}

type BoardTab = "piano" | "guitar";

function normalizeNote(name: string | null | undefined): string | null {
  if (!name || name === "—") return null;
  return name.toUpperCase().replace("♯", "#").replace("♭", "B");
}

function noteSet(...names: (string | null | undefined)[]): Set<number> {
  const set = new Set<number>();
  for (const n of names) {
    const norm = normalizeNote(n);
    if (!norm) continue;
    const midi = noteNameToMidi(norm);
    if (midi !== null) set.add(midi);
  }
  return set;
}

function PianoBoard({
  liveMidis,
  targetMidis,
  demoActiveMidis,
}: {
  liveMidis: Set<number>;
  targetMidis: Set<number>;
  demoActiveMidis: Set<number>;
}) {
  const keys = useMemo(() => pianoKeysInRange(), []);
  const whiteKeys = keys.filter((k) => !k.isBlack);

  return (
    <div className="overflow-x-auto">
      <div className="relative min-w-[280px]">
        <div className="flex h-[4.5rem] items-end gap-px">
          {whiteKeys.map((key) => {
            const isLive = liveMidis.has(key.midi);
            const isTarget = targetMidis.has(key.midi);
            const isDemo = demoActiveMidis.has(key.midi);
            const label = key.name.replace("#", "♯");

            let bg = "bg-zinc-100";
            if (isDemo) bg = "bg-fuchsia-500 ring-2 ring-fuchsia-300";
            else if (isLive) bg = "bg-cyan-400 ring-2 ring-cyan-300";
            else if (isTarget) bg = "bg-amber-400/90 ring-2 ring-amber-300";

            return (
              <div
                key={key.midi}
                className={`relative flex h-full min-w-[24px] flex-1 flex-col items-center justify-end rounded-b-md border border-zinc-400/30 pb-1 ${bg} transition-colors duration-100`}
              >
                <span className="text-[9px] font-bold text-zinc-700">{label}</span>
              </div>
            );
          })}
        </div>
        <div className="pointer-events-none absolute inset-x-0 top-0 flex h-12 items-start">
          {keys.map((key) => {
            if (!key.isBlack) return null;
            const whiteIndex = keys
              .slice(0, keys.indexOf(key))
              .filter((k) => !k.isBlack).length;
            const leftPct = ((whiteIndex - 0.35) / whiteKeys.length) * 100;
            const isLive = liveMidis.has(key.midi);
            const isTarget = targetMidis.has(key.midi);
            const isDemo = demoActiveMidis.has(key.midi);

            let bg = "bg-zinc-800";
            if (isDemo) bg = "bg-fuchsia-600 ring-2 ring-fuchsia-300";
            else if (isLive) bg = "bg-cyan-500 ring-2 ring-cyan-300";
            else if (isTarget) bg = "bg-amber-500 ring-2 ring-amber-300";

            return (
              <div
                key={key.midi}
                className={`absolute h-full w-[14px] -translate-x-1/2 rounded-b-sm border border-zinc-600 ${bg} transition-colors duration-100`}
                style={{ left: `${leftPct}%` }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function GuitarBoard({
  liveMidis,
  targetMidis,
  demoActiveMidis,
}: {
  liveMidis: Set<number>;
  targetMidis: Set<number>;
  demoActiveMidis: Set<number>;
}) {
  const stringLabels = ["e", "B", "G", "D", "A", "E"];
  const frets = 13;

  const highlighted = useMemo(() => {
    const dots: {
      stringIndex: number;
      fret: number;
      kind: "live" | "target" | "demo";
    }[] = [];
    const addDots = (midis: Set<number>, kind: "live" | "target" | "demo") => {
      for (const midi of midis) {
        const pos = midiToGuitarPosition(midi);
        if (pos) dots.push({ stringIndex: pos.stringIndex, fret: pos.fret, kind });
      }
    };
    addDots(demoActiveMidis, "demo");
    addDots(liveMidis, "live");
    addDots(targetMidis, "target");
    return dots;
  }, [liveMidis, targetMidis, demoActiveMidis]);

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[280px] rounded-lg border border-amber-900/40 bg-gradient-to-b from-amber-950/60 to-amber-900/30 p-3">
        <div className="grid gap-0.5">
          {GUITAR_OPEN_MIDI.map((openMidi, stringIndex) => (
            <div key={stringIndex} className="flex items-center gap-2">
              <span className="w-4 text-center text-[10px] font-bold text-amber-200/80">
                {stringLabels[stringIndex]}
              </span>
              <div className="relative flex flex-1 items-center">
                {Array.from({ length: frets }, (_, fret) => {
                  const dot = highlighted.find(
                    (d) => d.stringIndex === stringIndex && d.fret === fret
                  );
                  const noteAtFret = midiToNoteName(openMidi + fret);
                  const dotColor =
                    dot?.kind === "demo"
                      ? "bg-fuchsia-500 ring-fuchsia-300"
                      : dot?.kind === "live"
                      ? "bg-cyan-400 ring-cyan-300"
                      : dot?.kind === "target"
                      ? "bg-amber-400 ring-amber-300"
                      : "";

                  return (
                    <div
                      key={fret}
                      className="relative flex h-8 flex-1 items-center justify-center border-r border-amber-700/50 last:border-r-0"
                    >
                      {fret > 0 && fret % 3 === 0 && stringIndex === 2 && (
                        <span className="pointer-events-none absolute -top-3 text-[8px] text-amber-500/60">
                          {fret}
                        </span>
                      )}
                      {dot ? (
                        <span
                          className={`flex h-5 w-5 items-center justify-center rounded-full text-[7px] font-bold text-white ring-2 ${dotColor}`}
                          title={noteAtFret}
                        >
                          {noteAtFret.replace(/\d/, "")}
                        </span>
                      ) : (
                        fret === 0 && (
                          <span className="h-2 w-2 rounded-full bg-amber-600/40" />
                        )
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function InstrumentNoteBoard({
  liveNote,
  targetNote,
  demoNotes = [],
  demoActiveNote,
  instrument = "both",
  coachDemonstrating = false,
  className = "",
}: InstrumentNoteBoardProps) {
  const [tab, setTab] = useState<BoardTab>(
    instrument === "guitar" ? "guitar" : "piano"
  );

  const liveMidis = noteSet(liveNote);
  const targetMidis = noteSet(targetNote);
  const demoActiveMidis = noteSet(demoActiveNote);
  const allDemoMidis = noteSet(...demoNotes);

  const showPiano = instrument === "piano" || instrument === "both";
  const showGuitar = instrument === "guitar" || instrument === "both";
  const activeTab =
    instrument === "both" ? tab : instrument === "guitar" ? "guitar" : "piano";

  const demoLabel =
    demoActiveNote ?? (demoNotes.length ? demoNotes.join(" → ") : null);

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <section className={`glass-card shrink-0 overflow-hidden ${className}`}>
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <Piano className="h-3.5 w-3.5 text-violet-400" />
        <h2 className="text-xs font-semibold text-[var(--color-text-secondary)]">
          Note Board
        </h2>
        <span className="hidden text-[9px] text-[var(--color-text-muted)] sm:inline">
          <span className="text-cyan-400">■</span> you{" "}
          <span className="text-amber-400">■</span> target{" "}
          <span className="text-fuchsia-400">■</span> demo
        </span>
        {showPiano && showGuitar && (
          <div className="ml-auto flex rounded-full bg-white/5 p-0.5">
            <button
              type="button"
              onClick={() => setTab("piano")}
              className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold transition ${
                activeTab === "piano"
                  ? "bg-violet-600 text-white"
                  : "text-[var(--color-text-muted)]"
              }`}
            >
              Piano
            </button>
            <button
              type="button"
              onClick={() => setTab("guitar")}
              className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold transition ${
                activeTab === "guitar"
                  ? "bg-amber-600 text-white"
                  : "text-[var(--color-text-muted)]"
              }`}
            >
              Guitar
            </button>
          </div>
        )}
      </div>

      <div className="px-3 py-2.5">
        {coachDemonstrating && demoLabel && (
          <p className="mb-1.5 rounded-md bg-fuchsia-500/10 px-2 py-0.5 text-center text-[10px] text-fuchsia-300">
            <Guitar className="mr-1 inline h-3 w-3" />
            Coach demo: <strong>{demoLabel.replace(/#/g, "♯")}</strong>
          </p>
        )}

        {!coachDemonstrating && liveNote && liveNote !== "—" && (
          <p className="mb-1.5 text-center text-[10px] text-cyan-400">
            Singing: <strong>{liveNote.replace("#", "♯")}</strong>
          </p>
        )}

        {activeTab === "piano" && showPiano ? (
          <PianoBoard
            liveMidis={liveMidis}
            targetMidis={targetMidis}
            demoActiveMidis={
              coachDemonstrating
                ? new Set([...demoActiveMidis, ...allDemoMidis])
                : demoActiveMidis
            }
          />
        ) : showGuitar ? (
          <GuitarBoard
            liveMidis={liveMidis}
            targetMidis={targetMidis}
            demoActiveMidis={
              coachDemonstrating
                ? new Set([...demoActiveMidis, ...allDemoMidis])
                : demoActiveMidis
            }
          />
        ) : null}

        {mounted && demoNotes.length > 0 && (
          <div className="mt-1.5 flex flex-wrap justify-center gap-1">
            {demoNotes.map((n, idx) => (
              <span
                key={`${n}-${idx}`}
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  normalizeNote(n) === normalizeNote(demoActiveNote)
                    ? "bg-fuchsia-500/30 text-fuchsia-200 ring-1 ring-fuchsia-400"
                    : "bg-white/5 text-[var(--color-text-muted)]"
                }`}
              >
                {n.replace("#", "♯")}
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
