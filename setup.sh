#!/bin/bash
set -e

echo "🚀 Starting SingRight Setup..."

# Determine script directory
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Setup Backend
echo "🐍 Setting up Python Backend..."
cd "$DIR/backend"
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
    echo "✅ Python virtual environment created."
else
    echo "ℹ️ Python virtual environment already exists."
fi

echo "📦 Installing backend dependencies..."
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
echo "✅ Backend dependencies installed."

# Setup Frontend
echo "💻 Setting up Next.js Frontend..."
cd "$DIR/frontend"
echo "📦 Installing frontend npm dependencies..."
npm install
echo "✅ Frontend dependencies installed."

# Link reference audio for karaoke playback
echo "🎵 Linking alphabet test audio..."
mkdir -p "$DIR/frontend/public/songs"
if [ -f "$DIR/alphabet_data/wav/en001a.wav" ]; then
    ln -sf "$DIR/alphabet_data/wav/en001a.wav" "$DIR/frontend/public/songs/en001a.wav"
    echo "✅ Linked en001a.wav to frontend/public/songs/"
else
    echo "⚠️  alphabet_data/wav/en001a.wav not found — skip audio link."
fi

echo "🎉 Setup complete! Use the run scripts to start the application."
