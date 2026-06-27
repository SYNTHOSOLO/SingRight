import type { DemoInstrument } from "@/lib/audio/notes";

export interface PlayRequest {
  pitch: string;
  instrument: DemoInstrument;
}

/**
 * Detect explicit user requests like "play G3 on piano" or "play 440 Hz".
 */
export function parsePlayRequest(text: string): PlayRequest | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const hasPlayIntent =
    /\b(play|sample|demonstrate|hear|show\s+(?:me\s+)?(?:the\s+)?(?:note|pitch))\b/i.test(
      trimmed
    );
  if (!hasPlayIntent) return null;

  let instrument: DemoInstrument = "piano";
  const hasPiano = /\bpiano\b/i.test(trimmed);
  const hasGuitar = /\bguitar\b/i.test(trimmed);
  if (hasPiano && hasGuitar) instrument = "both";
  else if (hasGuitar) instrument = "guitar";
  else if (hasPiano) instrument = "piano";

  const hzMatch = trimmed.match(/\b(\d+(?:\.\d+)?)\s*(?:hz|hertz)\b/i);
  if (hzMatch) {
    return { pitch: hzMatch[1], instrument };
  }

  const notePatterns = [
    /\b([A-G](?:#|b|♯|♭)\d)\b/i,
    /\b([A-G]\d)\b/i,
    /\b(?:note|pitch)\s+([A-G](?:#|b|♯|♭)?\d?)\b/i,
    /\bplay(?:\s+[a-z]+){0,10}\s+([A-G](?:#|b|♯|♭)?\d?)\b/i,
    /\b([A-G](?:#|b|♯|♭)?\d?)\s+pitch\b/i,
  ];

  for (const pattern of notePatterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      const pitch = match[1].replace(/\s+/g, "").replace(/♯/g, "#").replace(/♭/g, "b");
      if (/^[A-G]/i.test(pitch)) {
        return { pitch, instrument };
      }
    }
  }

  return null;
}

export function playRequestKey(req: PlayRequest): string {
  return `${req.pitch.toLowerCase()}|${req.instrument}`;
}
