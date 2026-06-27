# Interactive AI Vocal Coach

A real-time AI-powered vocal coaching application built with **Next.js**, **LiveKit WebRTC**, and **OpenAI Realtime Multimodal Audio**.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (Next.js Frontend)                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────────────────┐  │
│  │ Mic Capture  │→ │ Web Audio   │→ │ useVocalAnalyzer Hook  │  │
│  │ (getUserMedia)│  │ AnalyserNode│  │ RMS→dB + Autocorr.    │  │
│  └─────────────┘  └─────────────┘  │ Pitch Detection        │  │
│                                     └──────────┬─────────────┘  │
│                                                │                │
│  ┌─────────────────────────────────────────────▼──────────────┐ │
│  │ VocalDashboard — LiveKit Data Channels                     │ │
│  │  • Sends VOCAL_METRICS every 250ms                         │ │
│  │  • Sends CRITICAL_ERROR on debug triggers                  │ │
│  │  • Receives PAUSE_TRACK / RESUME_TRACK / SHOW_TIPS         │ │
│  └─────────────────────────────────────────────┬──────────────┘ │
└────────────────────────────────────────────────│────────────────┘
                                                 │ WebRTC
                                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  LiveKit Server (SFU)                                           │
└────────────────────────────────────────────────│────────────────┘
                                                 │
                                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Python Agent Backend (LiveKit Agents)                           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ VocalCoachAgent (livekit-agents)                          │   │
│  │  • OpenAI Realtime Model (shimmer voice, VAD)            │   │
│  │  • @llm.ai_callable: control_session_playback            │   │
│  │  • data_received listener:                                │   │
│  │    – VOCAL_METRICS → inject into conversation context     │   │
│  │    – CRITICAL_ERROR → interrupt + pause + barge-in        │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Data Protocol

| Direction | Type | Shape |
|-----------|------|-------|
| Client → Agent | `VOCAL_METRICS` | `{ "type": "VOCAL_METRICS", "volume_db": -22.4, "pitch_hz": 440.0 }` |
| Client → Agent | `CRITICAL_ERROR` | `{ "type": "CRITICAL_ERROR", "reason": "PITCH_DISTORTION_OUT_OF_BOUNDS" }` |
| Agent → Client | Session Control | `{ "action": "PAUSE_TRACK" \| "RESUME_TRACK", "coach_notes": "..." }` |

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
