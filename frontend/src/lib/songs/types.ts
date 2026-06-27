export interface SongMetadata {
  songname: string;
  key_diff: number;
  tempo: number;
  time_signature: string;
}

export interface SyllableAnnotation {
  start: number;
  end: number;
  pitchMidi: number;
  token: string;
  expectedHz: number;
  lyricLineIdx: number;
  syllableInLineIdx: number;
}

export type SyllableIssue = "ok" | "sharp" | "flat" | "quiet" | "missed";

export interface SyllableResult {
  token: string;
  start: number;
  end: number;
  pitchErrorCents: number;
  timingOffsetMs: number;
  volumeOk: boolean;
  issue: SyllableIssue;
}

export interface LyricLineGroup {
  lyricText: string;
  phoneticTokens: string[];
  syllables: SyllableAnnotation[];
}

export interface SongBundle {
  id: string;
  audioSrc: string;
  metadata: SongMetadata;
  syllables: SyllableAnnotation[];
  lyricLines: string[];
  phoneticLines: string[];
  lineGroups: LyricLineGroup[];
  durationSec: number;
}
