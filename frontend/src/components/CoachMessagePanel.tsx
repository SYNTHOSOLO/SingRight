"use client";

import { useEffect, useRef } from "react";
import { MessageSquare } from "lucide-react";

export type VisualCueTone = "positive" | "corrective" | "neutral";

export interface VisualCue {
  text: string;
  tone: VisualCueTone;
}

export interface CoachMessage {
  id: string;
  text: string;
  tone?: VisualCueTone;
  kind: "cue" | "tip" | "note";
}

const VISUAL_CUE_STYLES: Record<
  VisualCueTone,
  { bg: string; text: string }
> = {
  positive: {
    bg: "from-emerald-500/20 to-teal-500/15",
    text: "text-emerald-200",
  },
  corrective: {
    bg: "from-amber-500/20 to-rose-500/15",
    text: "text-amber-100",
  },
  neutral: {
    bg: "from-violet-500/20 to-cyan-500/15",
    text: "text-violet-100",
  },
};

interface CoachMessagePanelProps {
  visualCue: VisualCue | null;
  messages: CoachMessage[];
  isActive: boolean;
  coachingMode: "karaoke" | "conversational";
  nonInterruptMode?: boolean;
}

export default function CoachMessagePanel({
  visualCue,
  messages,
  isActive,
  coachingMode,
  nonInterruptMode = false,
}: CoachMessagePanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, visualCue?.text]);

  const placeholder =
    coachingMode === "karaoke"
      ? "Coach tips appear here — no need to pause or interrupt your singing."
      : nonInterruptMode
      ? "Silent cues and tips — coach won't interrupt while you sing."
      : "Coach messages and quick cues appear here.";

  return (
    <section className="glass-card glow-cyan flex min-h-0 shrink-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
        <MessageSquare className="h-3.5 w-3.5 text-cyan-400" />
        <h2 className="text-xs font-semibold text-[var(--color-text-secondary)]">
          Coach Messages
        </h2>
        {(coachingMode === "karaoke" || nonInterruptMode) && (
          <span className="ml-1 rounded-full bg-cyan-500/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-cyan-300">
            Silent
          </span>
        )}
      </div>

      <div
        className={`relative flex min-h-[72px] shrink-0 items-center justify-center border-b border-[var(--color-border-subtle)] px-4 py-3 ${
          visualCue
            ? `bg-gradient-to-br ${VISUAL_CUE_STYLES[visualCue.tone].bg}`
            : "bg-[#0a0a0f]/40"
        }`}
      >
        {visualCue ? (
          <p
            key={visualCue.text}
            className={`visual-cue-pop text-center text-2xl font-black tracking-tight sm:text-3xl ${
              VISUAL_CUE_STYLES[visualCue.tone].text
            }`}
          >
            {visualCue.text}
          </p>
        ) : (
          <p className="text-center text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            {isActive ? placeholder : "Start a session to receive coaching tips."}
          </p>
        )}
      </div>

      <div
        ref={scrollRef}
        className="flex max-h-[108px] min-h-[56px] flex-col gap-1.5 overflow-y-auto px-3 py-2 scrollbar-thin scrollbar-thumb-zinc-800"
      >
        {messages.length === 0 ? (
          <p className="py-1 text-[11px] italic text-[var(--color-text-muted)]">
            {isActive
              ? "Waiting for coach tips…"
              : "Key messages from your coach will show up here."}
          </p>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
                msg.kind === "cue"
                  ? "border border-cyan-500/20 bg-cyan-500/10 font-semibold text-cyan-100"
                  : msg.kind === "tip"
                  ? "border border-violet-500/20 bg-violet-500/10 text-[var(--color-text-secondary)]"
                  : "bg-white/5 text-[var(--color-text-secondary)]"
              }`}
            >
              {msg.text}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
