"use client";

import { AlertTriangle, BarChart3, CheckCircle2 } from "lucide-react";
import type { SyllableResult } from "@/lib/songs/types";
import {
  getSessionSummary,
  isMajorIssue,
} from "@/hooks/useSyllableTracker";

interface PerformanceIssuesProps {
  completedResults: SyllableResult[];
  /** Show only the latest N issues in the compact strip */
  maxVisibleIssues?: number;
}

function formatIssue(result: SyllableResult): string {
  switch (result.issue) {
    case "sharp":
      return `${Math.round(result.pitchErrorCents)}¢ sharp`;
    case "flat":
      return `${Math.round(Math.abs(result.pitchErrorCents))}¢ flat`;
    case "quiet":
      return "too quiet";
    case "missed":
      return "missed";
    default:
      return "on pitch";
  }
}

export default function PerformanceIssues({
  completedResults,
  maxVisibleIssues = 4,
}: PerformanceIssuesProps) {
  const problems = completedResults.filter((r) => r.issue !== "ok");
  const summary = getSessionSummary(completedResults);
  const recentProblems = problems.slice(-maxVisibleIssues).reverse();
  const hasData = completedResults.length > 0;

  return (
    <section className="glass-card glow-cyan shrink-0 overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-cyan-400" />
          <h3 className="text-sm font-semibold text-[var(--color-text-secondary)]">
            Performance Analysis
          </h3>
        </div>

        {hasData ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 font-semibold text-emerald-400">
              {summary.onPitchPct}% on pitch
            </span>
            <span className="text-[var(--color-text-muted)]">
              Avg {summary.avgCentsError}¢
            </span>
            {summary.worstSyllable && (
              <span className="text-amber-400/90">
                Focus: {summary.worstSyllable.replace(/_/g, "·")}
              </span>
            )}
          </div>
        ) : (
          <p className="text-xs text-[var(--color-text-muted)]">
            Sing along to see syllable-level feedback.
          </p>
        )}

        {hasData && problems.length === 0 && (
          <div className="ml-auto flex items-center gap-1.5 text-xs text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            All syllables on target
          </div>
        )}
      </div>

      {recentProblems.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto border-t border-[var(--color-border-subtle)] px-3 py-1.5 scrollbar-thin scrollbar-thumb-zinc-800">
          {recentProblems.map((result, idx) => (
            <div
              key={`${result.token}-${result.start}-${idx}`}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] ${
                isMajorIssue(result.issue)
                  ? "border-rose-500/30 bg-rose-500/5"
                  : "border-amber-500/30 bg-amber-500/5"
              }`}
            >
              <AlertTriangle
                className={`h-3 w-3 shrink-0 ${
                  isMajorIssue(result.issue) ? "text-rose-400" : "text-amber-400"
                }`}
              />
              <span className="font-medium text-[var(--color-text-primary)]">
                {result.token.replace(/_/g, "·")}
              </span>
              <span className="text-[var(--color-text-muted)]">
                {formatIssue(result)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
