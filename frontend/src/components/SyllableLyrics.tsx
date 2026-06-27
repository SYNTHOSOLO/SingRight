"use client";

import type { SongBundle, SyllableResult } from "@/lib/songs/types";
import { issueSeverity } from "@/hooks/useSyllableTracker";

interface SyllableLyricsProps {
  song: SongBundle;
  activeLyricLineIdx: number;
  activeSyllableToken: string | null;
  completedResults: SyllableResult[];
}

function resultForToken(
  results: SyllableResult[],
  token: string,
  start?: number
): SyllableResult | undefined {
  if (start !== undefined) {
    return results.find((r) => r.token === token && r.start === start);
  }
  return results.find((r) => r.token === token);
}

export default function SyllableLyrics({
  song,
  activeLyricLineIdx,
  activeSyllableToken,
  completedResults,
}: SyllableLyricsProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-8">
      {song.lineGroups.map((group, lineIdx) => {
        const isActiveLine = lineIdx === activeLyricLineIdx;
        const isPastLine = activeLyricLineIdx > lineIdx;

        return (
          <div
            key={lineIdx}
            className={`w-full text-center transition-all duration-300 ${
              isActiveLine
                ? "lyric-active scale-105"
                : isPastLine
                ? "opacity-50"
                : "lyric-inactive opacity-60"
            }`}
          >
            <p
              className={`text-xl font-bold leading-relaxed sm:text-2xl ${
                isActiveLine ? "" : "text-sm"
              }`}
            >
              {group.phoneticTokens.map((token, tokenIdx) => {
                const syllable = group.syllables[tokenIdx];
                const result = syllable
                  ? resultForToken(completedResults, token, syllable.start)
                  : resultForToken(completedResults, token);
                const isActiveToken =
                  isActiveLine && token === activeSyllableToken;
                const severity = result ? issueSeverity(result.issue) : null;

                let colorClass = "text-[var(--color-text-secondary)]";
                if (isActiveToken) {
                  colorClass = "text-violet-300 underline decoration-violet-400";
                } else if (severity === "ok") {
                  colorClass = "text-emerald-400/80";
                } else if (severity === "minor") {
                  colorClass = "text-amber-400/80";
                } else if (severity === "major") {
                  colorClass = "text-rose-400/80";
                }

                return (
                  <span key={`${lineIdx}-${tokenIdx}`} className={colorClass}>
                    {tokenIdx > 0 ? " " : ""}
                    {token.replace(/_/g, "·")}
                  </span>
                );
              })}
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-secondary)] opacity-70">
              {group.lyricText}
            </p>
          </div>
        );
      })}
    </div>
  );
}
