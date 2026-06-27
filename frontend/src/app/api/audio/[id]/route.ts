import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";

// Serve WAV backing tracks from the shared alphabet_data directory.
// The song ID maps to: <repo-root>/alphabet_data/wav/<id>.wav
// Example: GET /api/audio/en001a → returns en001a.wav as audio/wav

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Sanitise: only allow alphanumeric IDs to prevent path traversal
  if (!/^[a-z0-9]+$/i.test(id)) {
    return NextResponse.json({ error: "Invalid song ID" }, { status: 400 });
  }

  const candidates = [
    // Next.js run from 'frontend' dir, referencing parent 'alphabet_data'
    path.resolve(process.cwd(), "..", "alphabet_data", "wav", `${id}.wav`),
    // Next.js run from workspace root, referencing 'alphabet_data'
    path.resolve(process.cwd(), "alphabet_data", "wav", `${id}.wav`),
    // Next.js run from 'frontend' dir, referencing local public songs
    path.resolve(process.cwd(), "public", "songs", `${id}.wav`),
    // Next.js run from workspace root, referencing frontend public songs
    path.resolve(process.cwd(), "frontend", "public", "songs", `${id}.wav`),
  ];

  let buffer: Buffer | null = null;
  let lastError: Error | null = null;

  for (const candidate of candidates) {
    try {
      buffer = await fs.readFile(candidate);
      break;
    } catch (err: any) {
      lastError = err;
    }
  }

  if (!buffer) {
    return NextResponse.json(
      {
        error: `Song not found: ${id}`,
        message: lastError?.message,
        searchedPaths: candidates,
      },
      { status: 404 }
    );
  }

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(buffer.length),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
