#!/bin/bash

# Start Backend Agent
echo "🐍 Starting Python Vocal Coach Agent..."
cd "$(dirname "$0")/backend"
source .venv/bin/activate
python main.py dev
