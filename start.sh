#!/bin/bash
# OpenReel Universal Launcher
# Starts both web app and streaming server with AMD GPU encoding support

echo "🎬 OpenReel - Universal Streaming Launcher"
echo "==========================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

cd "$(dirname "$0")" || exit 1

# Check dependencies
echo -n "Checking dependencies... "
if ! command -v pnpm &> /dev/null; then
    echo -e "${RED}✗${NC}"
    echo "ERROR: pnpm not found. Install with: npm install -g pnpm"
    exit 1
fi

if ! command -v ffmpeg &> /dev/null; then
    echo -e "${RED}✗${NC}"
    echo "ERROR: ffmpeg not found. Install with: sudo pacman -S ffmpeg"
    exit 1
fi

echo -e "${GREEN}✓${NC}"

# Check for AMD GPU
echo -n "Checking GPU... "

# Set AMD GPU environment variables for VAAPI
export LIBVA_DRIVER_NAME=radeonsi
export LIBVA_DRIVERS_PATH=/usr/lib/dri

if vainfo 2>/dev/null | grep -qi "amd\|radeon"; then
    GPU=$(vainfo 2>/dev/null | grep -oP "AMD Radeon [^)]+" | head -1)
    echo -e "${GREEN}✓${NC} $GPU"
    
    if [ -e /dev/dri/renderD128 ]; then
        echo -e "  ${GREEN}✓${NC} Hardware encoding: h264_vaapi (AMD VCN)"
        echo -e "  ${GREEN}✓${NC} CPU will be FREE for gaming!"
    else
        echo -e "  ${YELLOW}⚠${NC} VAAPI device not found, using CPU encoding"
    fi
else
    echo -e "${YELLOW}⚠${NC} No AMD GPU detected, using CPU encoding (libx264)"
fi

echo ""

# Function to cleanup processes on exit
cleanup() {
    echo ""
    echo "Shutting down servers..."
    kill $WEB_PID $SERVER_PID 2>/dev/null
    sleep 2
    # Force kill if needed
    kill -9 $WEB_PID $SERVER_PID 2>/dev/null
    exit 0
}
trap cleanup INT TERM

# Check if ports are available
check_port() {
    lsof -Pi :$1 -sTCP:LISTEN -t >/dev/null 2>&1
}

if check_port 5173; then
    echo -e "${YELLOW}⚠ Port 5173 in use${NC}"
fi

if check_port 8081; then
    echo -e "${YELLOW}⚠ Port 8081 in use - killing existing server${NC}"
    lsof -ti:8081 | xargs kill -9 2>/dev/null || true
    sleep 1
fi

echo ""

# Start streaming server
echo -e "${BLUE}▶ Starting streaming server on port 8081...${NC}"
cd apps/streaming-server

# Check if dependencies installed
if [ ! -d "node_modules" ]; then
    echo "Installing streaming server dependencies..."
    pnpm install
fi

# Use tsx to run TypeScript directly (no build needed)
# Set AMD GPU environment variables for VAAPI
export LIBVA_DRIVER_NAME=radeonsi
export LIBVA_DRIVERS_PATH=/usr/lib/dri
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/radeon_icd.json
PORT=8081 npx tsx src/index.ts &
SERVER_PID=$!
cd ../..

# Wait for server to start
sleep 3

# Check if server started successfully
if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo -e "${RED}✗ Streaming server failed to start${NC}"
    echo "Check logs above for errors"
    exit 1
fi

# Start web dev server
echo -e "${BLUE}▶ Starting web dev server on port 5173...${NC}"
cd apps/web

# Check if dependencies installed
if [ ! -d "node_modules" ]; then
    echo "Installing web app dependencies..."
    pnpm install
fi

pnpm run dev &
WEB_PID=$!
cd ../..

# Wait for web server
sleep 3

if ! kill -0 $WEB_PID 2>/dev/null; then
    echo -e "${RED}✗ Web server failed to start${NC}"
    kill $SERVER_PID 2>/dev/null
    exit 1
fi

echo ""
echo -e "${GREEN}✓ Both servers started successfully!${NC}"
echo ""
echo "📱 Web app:      http://localhost:5173"
echo "📡 Stream server: ws://localhost:8081"
echo ""
echo "🎮 How to stream:"
echo "   1. Open http://localhost:5173 in ANY browser"
echo "   2. Click 'Start Streaming' button"
echo "   3. GPU encodes stream, CPU stays free for games!"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop both servers${NC}"
echo ""

# Keep script running and wait for processes
wait $WEB_PID $SERVER_PID
