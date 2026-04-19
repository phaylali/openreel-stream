# OpenReel Development Notes

This document contains detailed technical information about the OpenReel project, with special focus on the live streaming implementation.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Monorepo Structure](#monorepo-structure)
3. [Streaming Implementation](#streaming-implementation)
4. [WebCodecs API Usage](#webcodecs-api-usage)
5. [Streaming Server Architecture](#streaming-server-architecture)
6. [Secure Storage Pattern](#secure-storage-pattern)
7. [State Management](#state-management)
8. [UI Components](#ui-components)
9. [Development Workflow](#development-workflow)
10. [Troubleshooting](#troubleshooting)

---

## Project Overview

**OpenReel Video** is a browser-based professional video editor built with:
- **React 18** + **TypeScript** for UI
- **Zustand** for state management
- **WebCodecs** for hardware video encoding/decoding
- **WebGPU** for GPU-accelerated rendering (with Canvas2D fallback)
- **Web Audio API** for professional audio processing
- **THREE.js** for 3D transforms and effects
- **IndexedDB** for local project storage
- **Node.js + ws + FFmpeg** for streaming server

---

## Monorepo Structure

```
openreel/
├── apps/
│   ├── web/                      # Main React application
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── components/        # React UI components
│   │   │   │   └── editor/       # Editor interface components
│   │   │   │       ├── Toolbar.tsx
│   │   │   │       ├── Timeline.tsx
│   │   │   │       ├── Preview.tsx
│   │   │   │       ├── InspectorPanel.tsx
│   │   │   │       ├── StreamingDialog.tsx
│   │   │   │       └── settings/
│   │   │   │           ├── SettingsDialog.tsx
│   │   │   │           ├── StreamingPanel.tsx
│   │   │   │           └── ...
│   │   │   ├── stores/           # Zustand stores
│   │   │   │   ├── settings-store.ts
│   │   │   │   ├── streaming-store.ts
│   │   │   │   └── ...
│   │   │   ├── services/          # Business logic services
│   │   │   │   ├── streaming-service.ts
│   │   │   │   ├── secure-storage.ts
│   │   │   │   └── ...
│   │   │   ├── types/
│   │   │   │   └── streaming.ts
│   │   │   └── ...
│   │   └── vite.config.ts
│   │
│   └── streaming-server/         # Streaming relay server
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           └── index.ts          # WebSocket + FFmpeg server
│
├── packages/
│   └── core/                     # Core engines (video, audio, graphics)
│       └── src/
│           ├── video/
│           ├── audio/
│           ├── graphics/
│           ├── text/
│           ├── export/
│           └── storage/
│
├── start.sh                       # Development startup script
├── package.json                   # Root package.json (pnpm workspace)
└── tsconfig.base.json             # Base TypeScript configuration
```

---

## Streaming Implementation

### Architecture Overview

The streaming feature uses a **client-side WebCodecs + WebSocket + FFmpeg** pipeline:

1. **Client (Browser)**: Captures canvas frames, encodes with WebCodecs (H.264/AAC), sends via WebSocket
2. **Streaming Server**: Receives encoded frames, writes to named pipes (FIFOs), FFmpeg pipes to Twitch RTMP
3. **Twitch**: Receives RTMP stream

### Key Files

| File | Purpose |
|------|---------|
| `apps/web/src/services/streaming-service.ts` | Main streaming client service |
| `apps/web/src/stores/streaming-store.ts` | Zustand store for streaming state |
| `apps/web/src/types/streaming.ts` | TypeScript type definitions |
| `apps/web/src/components/editor/StreamingDialog.tsx` | Live streaming UI dialog |
| `apps/web/src/components/editor/settings/StreamingPanel.tsx` | Streaming settings panel |
| `apps/streaming-server/src/index.ts` | WebSocket + FFmpeg server |

### Client-Side Service (`streaming-service.ts`)

The `StreamingService` class handles:

1. **Connection Management**
   - WebSocket connection to streaming server
   - Binary frame transfer (type byte: 0=video, 1=audio)
   - Reconnection logic (planned)

2. **Canvas Capture**
   ```typescript
   private findCanvas(): HTMLCanvasElement | null {
     // Tries multiple selectors to find the preview canvas
     const selectors = [
       "#preview-canvas",
       "canvas.w-full.h-full.object-contain",
       "canvas[class*='w-full'][class*='h-full']",
       "div.relative canvas",
       "div[class*='bg-black'] canvas",
     ];
     // Falls back to any canvas >= 640x360
   }
   ```

3. **Video Encoding (WebCodecs)**
   ```typescript
   this.videoEncoder = new VideoEncoder({
     output: async (chunk) => {
       const buffer = await chunk.arrayBuffer();
       this.sendVideoData(buffer);
       chunk.close();
     },
     error: (err) => { /* error handling */ },
   });

   this.videoEncoder.configure({
     codec: "avc1.42E01E",  // H.264 baseline
     width: quality.width,
     height: quality.height,
     bitrate: quality.bitrate,
     framerate: captureFps,
     hardwareAcceleration: "prefer-hardware",
   });
   ```

4. **Audio Capture**
   - Project audio: taps Web Audio graph master output via `@openreel/core`
   - Microphone: `navigator.mediaDevices.getUserMedia({ audio: true })`
   - Mixed into single `MediaStream`
   - Encoded with `AudioEncoder` (AAC codec)

5. **Event Handling**
   - Uses custom `SimpleEmitter` class (not Node's EventEmitter)
   - Events: `statusChange`, `error`, `stats`, `start`, `stop`, `pause`, `resume`

### Type Definitions (`streaming.ts`)

```typescript
export type StreamQuality = "720p" | "1080p" | "1440p" | "4K";

export interface AudioConfig {
  includeProjectAudio: boolean;
  includeMicrophone: boolean;
}

export interface StreamConfig {
  quality: StreamQuality;
  audio: AudioConfig;
  twitchStreamKey: string;
  ingestUrl: string;      // e.g., rtmp://live.twitch.tv/app
  serverUrl: string;      // e.g., ws://localhost:8081
}

export interface StreamStats {
  duration: number;
  framesEncoded: number;
  framesSent: number;
  droppedFrames: number;
  bitrate: number;
  isConnected: boolean;
}

export type StreamStatus =
  | "idle"
  | "connecting"
  | "live"
  | "paused"
  | "stopping"
  | "error";
```

### Quality Settings

```typescript
const QUALITY_MAP: Record<StreamQuality, { width: number; height: number; bitrate: number }> = {
  "720p":  { width: 1280, height: 720,  bitrate: 4_000_000 },
  "1080p": { width: 1920, height: 1080, bitrate: 6_000_000 },
  "1440p": { width: 2560, height: 1440, bitrate: 10_000_000 },
  "4K":    { width: 3840, height: 2160, bitrate: 20_000_000 },
};
```

---

## WebCodecs API Usage

### VideoEncoder Configuration

```typescript
const videoEncoder = new VideoEncoder({
  output: (chunk, metadata) => {
    // chunk is EncodedVideoChunk
    const buffer = chunk.buffer;  // ArrayBuffer of encoded data
    chunk.close();  // Must call to release resources
  },
  error: (error) => {
    console.error("Video encoding error:", error.message);
  }
});

videoEncoder.configure({
  codec: "avc1.42E01E",  // H.264 baseline profile
  width: 1920,
  height: 1080,
  bitrate: 6_000_000,  // 6 Mbps
  framerate: 60,
  hardwareAcceleration: "prefer-hardware",
});

// Encoding frames
videoEncoder.encode(frame, { keyFrame: false });  // keyFrame=true for I-frames
await videoEncoder.flush();  // Ensure all frames are encoded
videoEncoder.close();  // Release encoder
```

### AudioEncoder Configuration

```typescript
const audioEncoder = new AudioEncoder({
  output: (chunk) => {
    const buffer = chunk.buffer;  // ArrayBuffer of AAC data
    chunk.close();
  },
  error: (error) => { /* ... */ }
});

audioEncoder.configure({
  codec: "aac",
  sampleRate: 48000,
  numberOfChannels: 2,
  bitrate: 128_000,  // 128 kbps
});
```

### MediaStreamTrackProcessor

Used to process canvas/video frames:

```typescript
const processor = new MediaStreamTrackProcessor<VideoFrame>({
  track: canvasStream.getVideoTracks()[0] as MediaStreamVideoTrack,
});
const reader = processor.readable.getReader();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  // value is VideoFrame
  videoEncoder.encode(value, { keyFrame: false });
  value.close();  // Must close to release
}
```

### Important Notes

1. **`chunk.close()`** - Must call to release encoded chunk resources
2. **`chunk.arrayBuffer()`** - Returns Promise<ArrayBuffer> (not synchronous)
3. **`chunk.buffer`** - Direct access to ArrayBuffer (faster than async method)
4. **TypeScript types** - WebCodecs types may not be fully defined; use type casting
5. **Hardware acceleration** - `prefer-hardware` for best performance, graceful fallback

---

## Streaming Server Architecture

### Server Overview

The streaming server (`apps/streaming-server/`) is a Node.js application that:
1. Listens for WebSocket connections on port 8081
2. Creates named pipes (FIFOs) for each streaming session
3. Spawns FFmpeg to read from FIFOs and output to Twitch RTMP
4. Handles session lifecycle (start, stop, pause, resume)

### Server File Structure

```
apps/streaming-server/
├── package.json
│   {
│     "name": "@openreel/streaming-server",
│     "scripts": {
│       "dev": "PORT=8081 tsx watch src/index.ts",
│       "build": "tsc",
│       "start": "node dist/index.js"
│     },
│     "dependencies": {
│       "ws": "^8.18.0"
│     },
│     "devDependencies": {
│       "tsx": "^4.19.0",
│       "typescript": "^5.4.5"
│     }
│   }
│
├── tsconfig.json
├── src/
│   └── index.ts    # Main server code
└── dist/           # Compiled JavaScript (after build)
```

### Server Code Structure

```typescript
// Imports
import { WebSocketServer, WebSocket } from "ws";
import { spawn, ChildProcess } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join, dirname } from "path";

// Constants
const PORT = parseInt(process.env.PORT || "8081", 10);

// Types
interface StreamSession {
  ws: WebSocket;
  ffmpeg: ChildProcess | null;
  videoFifo: string;
  audioFifo: string;
  config: StreamConfig | null;
  startTime: number;
}

// Session management
const sessions = new Map<string, StreamSession>();

// WebSocket server setup
const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws, req) => {
  const sessionId = generateSessionId();
  const session = createSession(ws);
  
  sessions.set(sessionId, session);
  
  ws.on("message", handleMessage);
  ws.on("close", () => cleanupSession(sessionId));
});

// Message handling
function handleMessage(data: Buffer | string) {
  if (Buffer.isBuffer(data) && data.length > 1) {
    // Binary frame: type byte + payload
    // 0 = video, 1 = audio
    const type = data[0];
    const payload = data.slice(1);
    writeToFifo(type, payload);
  } else if (typeof data === "string") {
    // JSON message: start, stop, pause, resume
    const msg = JSON.parse(data);
    handleCommand(msg);
  }
}

// FFmpeg process
function startFFmpeg(session: StreamSession): ChildProcess {
  const rtmpUrl = `${session.config.ingestUrl}/${session.config.streamKey}`;
  
  return spawn("ffmpeg", [
    "-re",
    "-fflags", "genpts+discardcorrupt",
    "-i", session.videoFifo,
    ...(session.config.hasAudio ? ["-i", session.audioFifo] : []),
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-b:v", getBitrate(session.config.quality),
    ...(session.config.hasAudio ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"]),
    "-f", "flv",
    rtmpUrl
  ], { stdio: ["pipe", "pipe", "pipe"] });
}
```

### FFmpeg Pipeline

```
Client (WebCodecs) → WebSocket → Named Pipe (video) → FFmpeg → RTMP → Twitch
                                              ↘ Named Pipe (audio) ↗
```

FFmpeg arguments:
- `-re` - Read input at native frame rate (real-time)
- `-fflags genpts+discardcorrupt` - Generate PTS, discard corrupt frames
- `-c:v libx264` - H.264 video codec
- `-preset ultrafast` - Fastest encoding preset
- `-tune zerolatency` - Optimize for low latency
- `-f flv` - FLV container for RTMP

### Named Pipes (FIFOs)

Created using `mkfifo` (via Node's `fs.mkSync`):
- Video FIFO: `/tmp/stream-{sessionId}/video`
- Audio FIFO: `/tmp/stream-{sessionId}/audio`

Cleaned up on session end.

---

## Secure Storage Pattern

Stream keys are stored securely using AES-256-GCM encryption:

### Storage Service (`apps/web/src/services/secure-storage.ts`)

```typescript
// Key derivation from master password
const key = await crypto.subtle.importKey(
  "raw",
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password)),
  "AES-GCM",
  false,
  ["encrypt", "decrypt"]
);

// Encrypt
const iv = crypto.getRandomValues(new Uint8Array(12));
const encrypted = await crypto.subtle.encrypt(
  { name: "AES-GCM", iv },
  key,
  plaintext
);

// Store: { iv: Array.from(iv), data: Array.from(encrypted) }
```

### Usage in Streaming

```typescript
// In StreamingPanel.tsx
const { getSecret } = await import("../../../services/secure-storage");
const streamKey = await getSecret("twitch-stream-key");

// In StreamingService
const startMsg = {
  type: "start",
  data: {
    ingestUrl: config.ingestUrl,
    streamKey: config.twitchStreamKey,  // Decrypted key
    // ...
  },
};
this.websocket.send(JSON.stringify(startMsg));
```

---

## State Management

### Streaming Store (`streaming-store.ts`)

```typescript
interface StreamingState {
  isStreaming: boolean;
  isPaused: boolean;
  status: StreamStatus;
  error: string | null;
  stats: StreamStats | null;
  config: StreamConfig | null;
  
  // Actions
  setStatus: (status: StreamStatus) => void;
  setError: (error: string | null) => void;
  setStats: (stats: StreamStats) => void;
  startStream: (config: StreamConfig) => Promise<void>;
  stopStream: () => void;
  pauseStream: () => void;
  resumeStream: () => void;
}

export const useStreamingStore = create<StreamingState>()((set) => ({
  isStreaming: false,
  isPaused: false,
  status: "idle",
  // ...
}));
```

### Settings Store (`settings-store.ts`)

Streaming settings (non-secret) persisted via Zustand persist middleware:

```typescript
interface SettingsState {
  // ...
  streamingSettings: {
    twitch: {
      channelName: string;
      ingestUrl: string;
      streamKeyId: string;  // ID for secure storage lookup
      serverUrl: string;
      preferredQuality: StreamQuality;
      includeAudio: boolean;
      micEnabled: boolean;
    };
  };
  // ...
}
```

---

## UI Components

### Toolbar (`Toolbar.tsx`)

The "Go Live" button next to "Record":

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <button
      onClick={() => setIsStreamingOpen(true)}
      disabled={!isStreamingConfigured}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg ${
        isStreamingConfigured
          ? "bg-purple/10 hover:bg-purple/20 text-purple"
          : "bg-muted text-muted-foreground cursor-not-allowed"
      }`}
    >
      <Radio size={14} className="fill-current" />
      <span className="text-sm font-medium">Go Live</span>
    </button>
  </TooltipTrigger>
  <TooltipContent>
    <p>{isStreamingConfigured ? "Start Twitch Stream" : "Configure Twitch in Settings first"}</p>
  </TooltipContent>
</Tooltip>
```

### Streaming Dialog (`StreamingDialog.tsx`)

States:
- **Idle**: Show configuration, "Go Live" button
- **Connecting**: Spinner while connecting to server
- **Live**: Show stats (duration, frames, bitrate), Pause/Stop controls
- **Paused**: Show paused state, Resume/Stop controls
- **Error**: Show error message, Retry button

### Settings Panel (`StreamingPanel.tsx`)

Tabs:
1. **Twitch Configuration**: Channel name, RTMP ingest URL, stream key
2. **Stream Defaults**: Default quality, audio options, server URL
3. **Test & Connect**: Test server connectivity

---

## Development Workflow

### Running the Project

```bash
# Option 1: Use start.sh (recommended)
./start.sh

# Option 2: Manual startup
# Terminal 1: Streaming server
cd apps/streaming-server
pnpm dev  # or: node dist/index.js

# Terminal 2: Web dev server
pnpm dev
```

### Important Ports

| Port | Service |
|------|---------|
| 5173 | Web dev server (Vite) |
| 8081 | Streaming server (WebSocket) |

### Type Checking

```bash
# Web app
cd apps/web && pnpm typecheck

# Streaming server
cd apps/streaming-server && pnpm typecheck

# All
pnpm typecheck
```

### Building

```bash
# Build everything
pnpm build

# Build streaming server
cd apps/streaming-server && pnpm build
```

---

## Troubleshooting

### Issue: "Canvas element not found"

**Cause**: Canvas selector not finding the preview canvas.

**Solution**:
1. Ensure you're in the editor view (not on a blank page)
2. The canvas should have `w-full h-full object-contain bg-black` classes
3. Check browser console for debug logs showing found canvases
4. Minimum canvas size: 640x360

### Issue: "WebSocket connection failed"

**Cause**: Streaming server not running.

**Solution**:
```bash
# Check if server is running
lsof -i :8081

# Start server manually
cd apps/streaming-server && pnpm dev

# Or with node directly
cd apps/streaming-server && node dist/index.js
```

### Issue: "FFmpeg not found"

**Cause**: FFmpeg not installed on system.

**Solution**:
```bash
# Linux
sudo apt install ffmpeg

# macOS
brew install ffmpeg

# Check installation
ffmpeg -version
```

### Issue: Stream not appearing on Twitch

**Possible causes**:
1. **Invalid RTMP URL** - Check Twitch ingest server (e.g., `rtmp://live.twitch.tv/app`)
2. **Invalid stream key** - Verify key in Twitch Dashboard
3. **FFmpeg crash** - Check server console for errors
4. **Firewall** - Ensure port 1935 (RTMP) is open

**Debug steps**:
1. Test WebSocket connection: `curl -v ws://localhost:8081/`
2. Check server logs for "Stream started" message
3. Verify FFmpeg process is running: `ps aux | grep ffmpeg`
4. Check Twitch Studio or OBS to confirm stream key works

### Known Limitations

1. **Pause doesn't pause FFmpeg** - Pausing the stream sends a message but doesn't actually pause the FFmpeg process (input frames are just discarded)
2. **No reconnection** - If WebSocket disconnects mid-stream, no automatic reconnection
3. **Browser compatibility** - WebCodecs requires Chrome 94+, Edge 94+, or other modern browsers

---

## File Reference

### Key Implementation Files

| Path | Lines | Purpose |
|------|-------|---------|
| `apps/web/src/services/streaming-service.ts` | ~600 | Main streaming client |
| `apps/web/src/stores/streaming-store.ts` | ~115 | State management |
| `apps/web/src/types/streaming.ts` | ~35 | Type definitions |
| `apps/web/src/components/editor/StreamingDialog.tsx` | ~270 | Live streaming UI |
| `apps/web/src/components/editor/settings/StreamingPanel.tsx` | ~520 | Settings UI |
| `apps/web/src/components/editor/Toolbar.tsx` | ~1100 | Toolbar with Go Live button |
| `apps/streaming-server/src/index.ts` | ~320 | WebSocket + FFmpeg server |

---

## Future Enhancements

Planned streaming improvements:
1. **Kick and YouTube support** - Different RTMP endpoints
2. **Reconnection logic** - Auto-reconnect on disconnect
3. **Better pause/resume** - Actual FFmpeg stream control
4. **Stream presets** - Save/load different streaming configs
5. **Multi-platform streaming** - Stream to multiple platforms simultaneously
6. **Recording while streaming** - Save stream to file locally

---

*Last updated: 2026-04-19*
*This document is maintained as part of the OpenReel project.*