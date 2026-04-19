#!/bin/bash
# OpenReel Video - Local Development Start Script

set -e

echo "=== OpenReel Video - Dev Setup ==="

# Check for FFmpeg (required for streaming server)
if ! command -v ffmpeg &> /dev/null; then
  echo "WARNING: FFmpeg is not installed. Streaming server will not work."
  echo "Install FFmpeg with: sudo apt install ffmpeg (Linux) or brew install ffmpeg (macOS)"
  echo "Press any key to continue without streaming support, or Ctrl+C to exit"
  read -n 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  pnpm install
fi

# Build WASM modules if not built
if [ ! -d "packages/core/src/wasm/build" ]; then
  echo "Building WASM modules..."
  pnpm build:wasm
fi

# Install streaming server dependencies if needed
if [ ! -d "apps/streaming-server/node_modules" ]; then
  echo "Installing streaming server dependencies..."
  cd apps/streaming-server && pnpm install --ignore-scripts
  cd ../..
fi

# Function to start streaming server
start_streaming_server() {
  cd apps/streaming-server
  pnpm dev &
  STREAMING_PID=$!
  cd ../..
  echo "Streaming server started (PID: $STREAMING_PID)"
}

# Start streaming server in background
if command -v ffmpeg &> /dev/null; then
  echo "Starting streaming server on ws://localhost:8081..."
  start_streaming_server
else
  echo "Skipping streaming server (FFmpeg not found)"
fi

# Cleanup function
cleanup() {
  if [ -n "$STREAMING_PID" ]; then
    echo "Stopping streaming server..."
    kill $STREAMING_PID 2>/dev/null || true
  fi
}

# Trap exit to cleanup
trap cleanup EXIT

# Start web dev server
echo "Starting dev server at http://localhost:5174"
pnpm dev -- --port 5174