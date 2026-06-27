<p align="center">
  <img src="images/logo.jpg" alt="AI Vocal Coach logo" width="160" />
</p>

<h1 align="center">Interactive AI Vocal Coach</h1>

<p align="center">
  A real-time AI-powered vocal coaching application built with <strong>Next.js</strong>, <strong>LiveKit WebRTC</strong>, and <strong>OpenAI Realtime Multimodal Audio</strong>.
</p>

## Architecture

![System architecture diagram](images/diagram.png)

## Data Protocol

| Direction | Type | Shape |
|-----------|------|-------|
| Client → Agent | `SONG_SELECTED` | `{ "type": "SONG_SELECTED", "song_id": "en001a", "songname": "Alphabet", "tempo": 100 }` |
| Client → Agent | `VOCAL_METRICS` | `{ "type": "VOCAL_METRICS", "volume_db": -22.4, "pitch_hz": 277.2, "syllable": "b_ii", "expected_pitch_hz": 277.2, "pitch_delta_cents": -42, "on_pitch": false }` |
| Client → Agent | `SYLLABLE_RESULT` | `{ "type": "SYLLABLE_RESULT", "syllable": "b_ii", "issue": "sharp", "pitch_error_cents": 42 }` |
| Client → Agent | `CRITICAL_ERROR` | `{ "type": "CRITICAL_ERROR", "reason": "PITCH_OFF_TARGET", "syllable": "b_ii", "expected_hz": 277.2, "actual_hz": 295.0 }` |
| Client → Agent | `ANALYSIS_SNAPSHOT` | `{ "type": "ANALYSIS_SNAPSHOT", "pitch_hz": 277.2, "pitch_confidence": 0.82, "clarity": 0.65, "note_name": "C#4" }` |
| Agent → Client | Session Control | `{ "action": "PAUSE_TRACK" \| "RESUME_TRACK" \| "PLAY_REFERENCE_TONE" \| "PLAY_LYRIC_LINE" \| "REQUEST_ANALYSIS", ... }` |

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.10+
- A [LiveKit Cloud](https://livekit.io) project (or self-hosted server)
- An [OpenAI API key](https://platform.openai.com) with Realtime API access

### 1. Backend

```bash
cd backend
cp .env.example .env
# Fill in LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, OPENAI_API_KEY

python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python main.py dev
```

### 2. Frontend

```bash
cd frontend
cp .env.example .env.local
# Fill in NEXT_PUBLIC_LIVEKIT_URL

npm install
npm run dev
```

### 3. Generate a Token

Use the LiveKit CLI to generate a test token:

```bash
livekit-cli create-token \
  --api-key <YOUR_KEY> \
  --api-secret <YOUR_SECRET> \
  --join --room "coaching-room" \
  --identity "student-1" \
  --valid-for 24h
```

Paste the token into the UI or pass it as a `?token=...&serverUrl=...` query parameter.

## Project Structure

```
├── backend/
│   ├── .env.example
│   ├── requirements.txt
│   └── main.py              # LiveKit Agent server
├── frontend/
│   ├── .env.example
│   ├── package.json
│   ├── src/
│   │   ├── app/
│   │   │   ├── globals.css   # Tailwind + design tokens
│   │   │   ├── layout.tsx    # Root layout with Inter font
│   │   │   └── page.tsx      # Entry point + pre-join UI
│   │   ├── components/
│   │   │   ├── LiveKitProvider.tsx   # Room wrapper + connection badge
│   │   │   └── VocalDashboard.tsx   # Main coaching UI
│   │   └── hooks/
│   │       └── useVocalAnalyzer.ts  # Web Audio API analysis hook
│   └── ...config files
└── README.md
```
