#!/bin/bash

# Start Frontend Server
echo "💻 Starting Next.js Dev Server..."
cd "$(dirname "$0")/frontend"
npm run dev
