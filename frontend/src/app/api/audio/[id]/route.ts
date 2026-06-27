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

  const wavPath = path.resolve(
    process.cwd(),
    "..",
    "alphabet_data",
    "wav",
    `${id}.wav`
  );

  try {
    const buffer = await fs.readFile(wavPath);
    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(buffer.length),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: `Song not found: ${id}` }, { status: 404 });
  }
}
