import { WebSocketServer, WebSocket } from "ws";
import { spawn, ChildProcess } from "child_process";
import { createWriteStream, createReadStream, existsSync, unlinkSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PORT = parseInt(process.env.PORT || "8081", 10);

interface StreamSession {
  ws: WebSocket;
  ffmpeg: ChildProcess | null;
  videoFifo: string;
  audioFifo: string;
  config: StreamConfig | null;
  startTime: number;
}

interface StreamConfig {
  ingestUrl: string;
  streamKey: string;
  quality: string;
  hasAudio: boolean;
}

interface WSMessage {
  type: "start" | "stop" | "pause" | "resume" | "config" | "stats";
  data?: unknown;
}

const sessions = new Map<string, StreamSession>();

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function error(msg: string) {
  console.error(`[${new Date().toISOString()}] ERROR: ${msg}`);
}

function createFifos(sessionId: string): { videoFifo: string; audioFifo: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), `stream-${sessionId}-`));
  const videoFifo = join(tmpDir, "video");
  const audioFifo = join(tmpDir, "audio");
  
  require("fs").mkSync(videoFifo);
  require("fs").mkSync(audioFifo);
  
  return { videoFifo, audioFifo };
}

function cleanupFifos(videoFifo: string, audioFifo: string) {
  try {
    const dir = require("path").dirname(videoFifo);
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    error(`Cleanup error: ${e}`);
  }
}

function startFFmpeg(session: StreamSession): ChildProcess | null {
  if (!session.config) {
    error("No config for session");
    return null;
  }

  const { videoFifo, audioFifo } = session;
  const rtmpUrl = `${session.config.ingestUrl}/${session.config.streamKey}`;
  
  log(`Starting FFmpeg, RTMP: ${rtmpUrl}`);

  const ffmpegArgs = [
    "-re",
    "-fflags",
    "genpts+discardcorrupt",
    "-i",
    videoFifo,
  ];

  if (session.config.hasAudio) {
    ffmpegArgs.push("-i", audioFifo);
  }

  ffmpegArgs.push(
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-b:v",
    getBitrate(session.config.quality),
    "-maxrate",
    getBitrate(session.config.quality),
    "-bufsize",
    getBitrate(session.config.quality),
    "-g",
    "60",
    "-keyint_min",
    "60",
    "-sc_threshold",
    "0",
  );

  if (session.config.hasAudio) {
    ffmpegArgs.push(
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "44100",
      "-ac",
      "2"
    );
  } else {
    ffmpegArgs.push("-an");
  }

  ffmpegArgs.push(
    "-f",
    "flv",
    "-flvflags",
    "no_duration_filesize",
    rtmpUrl
  );

  const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  ffmpeg.stderr.on("data", (data) => {
    const str = data.toString();
    if (str.includes("error") || str.includes("Error") || str.includes("failed")) {
      error(`FFmpeg: ${str.slice(0, 200)}`);
    } else {
      log(`FFmpeg: ${str.slice(0, 100)}`);
    }
  });

  ffmpeg.on("error", (err) => {
    error(`FFmpeg spawn error: ${err.message}`);
  });

  ffmpeg.on("exit", (code) => {
    log(`FFmpeg exited with code ${code}`);
  });

  return ffmpeg;
}

function getBitrate(quality: string): string {
  const map: Record<string, string> = {
    "720p": "4000k",
    "1080p": "6000k",
    "1440p": "10000k",
    "4K": "20000k",
  };
  return map[quality] || "6000k";
}

function handleMessage(ws: WebSocket, sessionId: string, msg: WSMessage) {
  const session = sessions.get(sessionId);
  if (!session) return;

  switch (msg.type) {
    case "start": {
      console.log("[Server] Received start message:", JSON.stringify(msg.data).slice(0, 500));
      const data = msg.data as StreamConfig;
      console.log("[Server] Config - ingestUrl:", data.ingestUrl, "streamKey:", data.streamKey?.slice(0, 10), "quality:", data.quality);
      session.config = data;
      session.startTime = Date.now();
      
      const { videoFifo, audioFifo } = createFifos(sessionId);
      session.videoFifo = videoFifo;
      session.audioFifo = audioFifo;
      console.log("[Server] FIFOs created:", videoFifo, audioFifo);
      
      session.ffmpeg = startFFmpeg(session);
      console.log("[Server] FFmpeg started:", session.ffmpeg ? "yes" : "no");
      
      if (!session.ffmpeg) {
        ws.send(JSON.stringify({ type: "error", data: "Failed to start FFmpeg" }));
        return;
      }

      log(`Stream started: ${sessionId}, quality: ${data.quality}, hasAudio: ${data.hasAudio}`);
      ws.send(JSON.stringify({ type: "started" }));
      break;
    }

    case "stop": {
      log(`Stream stopping: ${sessionId}`);
      
      if (session.ffmpeg) {
        session.ffmpeg.stdin?.end();
        session.ffmpeg.kill("SIGTERM");
        session.ffmpeg = null;
      }
      
      cleanupFifos(session.videoFifo, session.audioFifo);
      session.config = null;
      
      ws.send(JSON.stringify({ type: "stopped" }));
      break;
    }

    case "pause": {
      // Note: Pausing stdin doesn't actually pause FFmpeg encoding
      // This is a no-op but keeps the protocol consistent
      ws.send(JSON.stringify({ type: "paused" }));
      break;
    }

    case "resume": {
      // See note above
      ws.send(JSON.stringify({ type: "resumed" }));
      break;
    }

    case "config": {
      if (msg.data) {
        session.config = { ...session.config, ...(msg.data as StreamConfig) };
      }
      break;
    }

    default:
      log(`Unknown message type: ${msg.type}`);
  }
}

function handleBinaryData(session: StreamSession, data: ArrayBuffer | SharedArrayBuffer) {
  if (!session.ffmpeg || !session.config) return;
  
  const buffer = new Uint8Array(data);
  const type = buffer[0];
  
  const payload = buffer.slice(1);
  
  if (type === 0) {
    session.ffmpeg.stdin?.write(Buffer.from(payload));
  } else if (type === 1 && session.config.hasAudio) {
    session.ffmpeg.stdin?.write(Buffer.from(payload));
  }
}

function sendStats(session: StreamSession) {
  if (!session.config) return;
  
  const duration = (Date.now() - session.startTime) / 1000;
  const stats = {
    duration,
    bitrate: parseInt(getBitrate(session.config.quality)) * 1000,
    fps: 60,
  };
  
  session.ws.send(JSON.stringify({ type: "stats", data: stats }));
}

const wss = new WebSocketServer({ port: PORT });

wss.on("listening", () => {
  log(`Streaming server listening on port ${PORT}`);
});

wss.on("connection", (ws, req) => {
  const sessionId = Math.random().toString(36).slice(2, 10);
  const session: StreamSession = {
    ws,
    ffmpeg: null,
    videoFifo: "",
    audioFifo: "",
    config: null,
    startTime: 0,
  };
  
  sessions.set(sessionId, session);
  log(`Client connected: ${sessionId}, from ${req.socket.remoteAddress}`);

  ws.on("message", (data) => {
    try {
      if (Buffer.isBuffer(data) && data.length > 1) {
        console.log("[Server] Binary data received, length:", data.length);
        const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.length);
        handleBinaryData(session, ab);
      } else if (typeof data === "string") {
        const msgStr: string = data;
        console.log("[Server] Text message received:", msgStr.slice(0, 100));
        const msg: WSMessage = JSON.parse(msgStr);
        handleMessage(ws, sessionId, msg);
      }
    } catch (e) {
      error(`Message error: ${e}`);
    }
  });

  ws.on("close", () => {
    log(`Client disconnected: ${sessionId}`);
    
    if (session.ffmpeg) {
      session.ffmpeg.stdin?.end();
      session.ffmpeg.kill("SIGTERM");
    }
    
    cleanupFifos(session.videoFifo, session.audioFifo);
    sessions.delete(sessionId);
  });

  ws.on("error", (err) => {
    error(`WebSocket error: ${err.message}`);
  });
});

process.on("SIGINT", () => {
  log("Shutting down...");
  for (const [, session] of sessions) {
    if (session.ffmpeg) {
      session.ffmpeg.kill("SIGTERM");
    }
  }
  wss.close();
  process.exit(0);
});