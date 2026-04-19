import { WebSocketServer, WebSocket } from "ws";
import { spawn, execSync, ChildProcess } from "child_process";
import { existsSync } from "fs";

const PORT = parseInt(process.env.PORT || "8081", 10);

interface StreamSession {
  ws: WebSocket;
  ffmpeg: ChildProcess | null;
  config: StreamConfig | null;
  startTime: number;
  hasReceivedData: boolean;
  lastFFmpegLog?: number;
  restartCount?: number;
  rtmpConnected: boolean;
  rtmpConnectTime: number | null;
  totalBytesReceived: number;
  framesReceived: number;
  frameBuffer: Buffer[];
  frameSize: number;
  frameTimestamp: number;
  parsingHeader: boolean;
  headerBytesRead: number;
  audioEncoderRunning: boolean;
}

interface StreamConfig {
  ingestUrl: string;
  streamKey: string;
  quality: string;
  bitrate: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  amdDriver?: "mesa" | "vulkan" | "auto";
  isTestStream?: boolean;
}

interface WSMessage {
  type: "start" | "stop" | "pause" | "resume" | "config" | "stats" | "started" | "stopped" | "paused" | "resumed" | "error";
  data?: unknown;
}

const sessions = new Map<string, StreamSession>();

function log(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function error(...args: unknown[]) {
  console.error(`[${new Date().toISOString()}] ERROR:`, ...args);
}

function debug(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] DEBUG:`, ...args);
}

function checkAMDGPU(driverPreference: "mesa" | "vulkan" | "auto" = "auto"): { available: boolean; device: string | null; driver: string } {
  const driversToTry = driverPreference === "auto"
    ? ["radeonsi", "amdvlk"]
    : driverPreference === "vulkan"
      ? ["amdvlk"]
      : ["radeonsi"];

  for (const driver of driversToTry) {
    try {
      const env = {
        ...process.env,
        LIBVA_DRIVER_NAME: driver,
        LIBVA_DRIVERS_PATH: "/usr/lib/dri",
      };

      log(`Trying AMD driver: ${driver}`);
      const vainfo = execSync("vainfo 2>&1", { encoding: "utf8", env });

      if (vainfo.includes("AMD") || vainfo.includes("Radeon") || vainfo.includes("radeonsi") || vainfo.includes("AMDVLK")) {
        if (existsSync("/dev/dri/renderD128")) {
          const gpuMatch = vainfo.match(/AMD Radeon[^)]+/);
          log(`✓ AMD GPU detected with ${driver}: ${gpuMatch ? gpuMatch[0] : "AMD GPU"}`);
          return { available: true, device: "/dev/dri/renderD128", driver };
        }
      }
    } catch (e) {
      debug(`VAAPI check failed for ${driver}: ${e}`);
    }
  }

  return { available: false, device: null, driver: "none" };
}

function buildFFmpegArgs(config: StreamConfig, amdGpu: { available: boolean; device: string | null; driver: string }): string[] {
  const args: string[] = [
    "-hide_banner",
    "-loglevel", "verbose",
  ];

  const gopSize = config.fps * 2;
  const bitrateK = Math.round(config.bitrate / 1000) + "k";

  log(`Stream config: ${config.width}x${config.height} @ ${config.fps}fps, ${bitrateK} bitrate, driver: ${amdGpu.driver}`);

  args.push(
    "-f", "image2pipe",
    "-framerate", config.fps.toString(),
    "-i", "pipe:0",
  );

  if (amdGpu.available && amdGpu.device) {
    log(`Using AMD VCN hardware encoder (h264_vaapi) with ${amdGpu.driver} driver`);
    args.push(
      "-vaapi_device", amdGpu.device,
      "-vf", `format=nv12|vaapi,hwupload,scale_vaapi=w=${config.width}:h=${config.height}`,
      "-c:v", "h264_vaapi",
      "-qp:v", "23",
      "-bf", "0",
      "-rc_mode", "CBR",
    );
  } else {
    log(`AMD GPU not available, using CPU encoding (libx264)`);
    args.push(
      "-vf", `scale=${config.width}:${config.height}`,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
    );
  }

  args.push(
    "-b:v", bitrateK,
    "-maxrate", bitrateK,
    "-bufsize", Math.round(config.bitrate * 2 / 1000) + "k",
    "-r", config.fps.toString(),
    "-g", gopSize.toString(),
    "-keyint_min", gopSize.toString(),
    "-sc_threshold", "0",
  );

  if (config.hasAudio) {
    args.push(
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "48000",
      "-ac", "2",
    );
  } else {
    args.push("-an");
  }

  const rtmpUrl = buildRtmpUrl(config.ingestUrl, config.streamKey);
  args.push(
    "-f", "fifo",
    "-fifo_format", "flv",
    "-attempt_recovery", "1",
    "-recover_any_error", "1",
    "-recovery_wait_time", "1",
    "-drop_pkts_on_overflow", "1",
    "-max_recovery_attempts", "0",
    "-flvflags", "no_duration_filesize",
    rtmpUrl,
  );

  return args;
}

function buildRtmpUrl(ingestUrl: string, streamKey: string): string {
  const base = ingestUrl.replace(/\/+$/, "");
  return `${base}/${streamKey}`;
}

function startFFmpeg(session: StreamSession): ChildProcess | null {
  if (!session.config) {
    error("No config for session");
    return null;
  }

  const config = session.config;
  const driverPreference = config.amdDriver || "auto";
  const amdGpu = checkAMDGPU(driverPreference);

  const rtmpUrl = buildRtmpUrl(config.ingestUrl, config.streamKey);
  log(`Starting FFmpeg, RTMP: ${rtmpUrl.replace(config.streamKey, "***")}`);

  if (amdGpu.available) {
    log(`GPU encoding: AMD VCN on ${amdGpu.device} using ${amdGpu.driver} driver`);
  } else {
    log("GPU encoding: Not available, using CPU");
  }

  const ffmpegArgs = buildFFmpegArgs(config, amdGpu);
  log("FFmpeg args:", ffmpegArgs.join(" "));

  const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  ffmpeg.stderr.on("data", (data) => {
    const str = data.toString().trim();

    if (str.includes("Opening") && str.includes("for writing")) {
      log("🎬 FFmpeg: Opening RTMP connection to Twitch...");
    }
    else if (str.includes("Connected")) {
      session.rtmpConnected = true;
      session.rtmpConnectTime = Date.now();
      log("✅ RTMP CONNECTED TO TWITCH! Stream is live on Twitch!");
      session.ws.send(JSON.stringify({
        type: "stats",
        data: { rtmpConnected: true, rtmpConnectTime: session.rtmpConnectTime },
      }));
    }
    else if (str.includes("Error") || str.includes("error") || str.includes("broken") || str.includes("pipe") || str.includes("failed") || str.includes("disconnect")) {
      error("FFmpeg:", str.slice(0, 400));
      if (str.includes("Connection refused") || str.includes("Connection reset")) {
        session.rtmpConnected = false;
        session.ws.send(JSON.stringify({
          type: "error",
          data: "RTMP connection to Twitch lost. Check your stream key and ingest URL.",
        }));
      }
    }
    else if (str.includes("speed=") || str.includes("frame=") || str.includes("bitrate=")) {
      const now = Date.now();
      if (!session.lastFFmpegLog || now - session.lastFFmpegLog > 15000) {
        log("📊 FFmpeg status:", str.slice(0, 150));
        session.lastFFmpegLog = now;
      }
    }
    else if (!session.hasReceivedData) {
      log("FFmpeg init:", str.slice(0, 200));
    }
  });

  ffmpeg.stdin?.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "EPIPE") {
      debug("FFmpeg stdin EPIPE (expected on exit)");
    } else {
      error(`FFmpeg stdin error: ${err.message}`);
    }
  });

  ffmpeg.stdout.on("data", (data) => {
    log("FFmpeg stdout:", data.toString().slice(0, 100));
  });

  ffmpeg.on("error", (err) => {
    error(`FFmpeg spawn error: ${err.message}`);
    session.ws.send(JSON.stringify({
      type: "error",
      data: `FFmpeg error: ${err.message}`
    }));
  });

  ffmpeg.on("exit", (code) => {
    log(`🔴 FFmpeg exited with code ${code}`);
    if (session.rtmpConnected) {
      log("📡 Stream was successfully sent to Twitch before FFmpeg exited");
    }
    session.ffmpeg = null;

    if (code !== 0 && code !== null) {
      log(`FFmpeg crashed with code ${code}`);

      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({
          type: "error",
          data: `FFmpeg crashed (code ${code}). Please stop and restart stream.`
        }));
        session.ws.send(JSON.stringify({ type: "stopped" }));
      }
    } else {
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: "stopped" }));
      }
    }
  });

  return ffmpeg;
}

async function handleMessage(ws: WebSocket, sessionId: string, msg: WSMessage) {
  const session = sessions.get(sessionId);
  if (!session) return;

  switch (msg.type) {
    case "start": {
      const data = msg.data as StreamConfig;
      log("Received start message:", JSON.stringify(data).slice(0, 200));

      session.config = data;
      session.startTime = Date.now();
      session.hasReceivedData = false;
      session.rtmpConnected = false;
      session.rtmpConnectTime = null;
      session.totalBytesReceived = 0;
      session.framesReceived = 0;
      session.frameBuffer = [];
      session.frameSize = 0;
      session.frameTimestamp = 0;
      session.parsingHeader = true;
      session.headerBytesRead = 0;
      session.audioEncoderRunning = false;

      session.ffmpeg = startFFmpeg(session);
      if (!session.ffmpeg) {
        ws.send(JSON.stringify({ type: "error", data: "Failed to start FFmpeg" }));
        return;
      }

      log(`Stream started: ${sessionId}, quality: ${data.quality}`);
      ws.send(JSON.stringify({ type: "started" }));

      const statsInterval = setInterval(() => {
        if (session.ws.readyState !== WebSocket.OPEN) {
          clearInterval(statsInterval);
          return;
        }

        const duration = (Date.now() - session.startTime) / 1000;
        ws.send(JSON.stringify({
          type: "stats",
          data: {
            duration,
            bitrate: data.bitrate,
            fps: 30,
            isConnected: true,
            rtmpConnected: session.rtmpConnected,
            totalBytesReceived: session.totalBytesReceived,
            framesReceived: session.framesReceived,
          },
        }));
      }, 5000);

      break;
    }

    case "stop": {
      log(`Stream stopping: ${sessionId}`);

      if (session.ffmpeg && session.ffmpeg.stdin && !session.ffmpeg.stdin.destroyed) {
        session.ffmpeg.stdin.end();
      }

      if (session.ffmpeg) {
        setTimeout(() => {
          if (session.ffmpeg && !session.ffmpeg.killed) {
            session.ffmpeg.kill("SIGTERM");
          }
        }, 2000);
      }

      session.config = null;
      ws.send(JSON.stringify({ type: "stopped" }));
      break;
    }

    case "pause":
      ws.send(JSON.stringify({ type: "paused" }));
      break;

    case "resume":
      ws.send(JSON.stringify({ type: "resumed" }));
      break;

    default:
      log(`Unknown message type: ${msg.type}`);
  }
}

const wss = new WebSocketServer({ port: PORT });

wss.on("listening", () => {
  log(`Streaming server listening on port ${PORT}`);

  const gpu = checkAMDGPU();
  if (gpu.available) {
    log(`✓ AMD GPU detected: ${gpu.device}`);
    log(`✓ Hardware encoding available: h264_vaapi`);
  } else {
    log(`⚠ No AMD GPU detected, will use CPU encoding (libx264)`);
  }
});

wss.on("connection", (ws, req) => {
  const sessionId = Math.random().toString(36).slice(2, 10);

  const session: StreamSession = {
    ws,
    ffmpeg: null,
    config: null,
    startTime: 0,
    hasReceivedData: false,
    lastFFmpegLog: 0,
    restartCount: 0,
    rtmpConnected: false,
    rtmpConnectTime: null,
    totalBytesReceived: 0,
    framesReceived: 0,
    frameBuffer: [],
    frameSize: 0,
    frameTimestamp: 0,
    parsingHeader: true,
    headerBytesRead: 0,
    audioEncoderRunning: false,
  };

  sessions.set(sessionId, session);
  log(`Client connected: ${sessionId}, from ${req.socket.remoteAddress}`);

  ws.on("message", (data) => {
    try {
      if (Buffer.isBuffer(data)) {
        try {
          const str = data.toString('utf8');
          const msg: WSMessage = JSON.parse(str);
          log(`Text message received: ${msg.type}`);
          handleMessage(ws, sessionId, msg);
          return;
        } catch {
        }

        if (!session.config) {
          error(`Cannot write data: no config (start message not received yet?)`);
          return;
        }

        if (!session.ffmpeg || !session.ffmpeg.stdin || session.ffmpeg.stdin.destroyed) {
          error(`Cannot write data: FFmpeg not running`);
          return;
        }

        session.totalBytesReceived += data.length;

        if (data.length === 12) {
          const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
          const typeByte = view.getUint8(0);
          const length = view.getUint32(2);
          const timestamp = Number(view.getBigUint64(6));

          if (typeByte === 0x01) {
            session.frameSize = length;
            session.frameTimestamp = timestamp;
            session.frameBuffer = [];
            session.parsingHeader = false;
            session.headerBytesRead = 0;
            session.framesReceived++;
          } else if (typeByte === 0x02) {
            session.audioEncoderRunning = true;
            session.frameSize = length;
            session.frameBuffer = [];
            session.parsingHeader = false;
            session.headerBytesRead = 0;
          }
          return;
        }

        if (!session.parsingHeader && session.frameSize > 0) {
          session.frameBuffer.push(data);
          session.headerBytesRead += data.length;

          if (session.headerBytesRead >= session.frameSize) {
            const frameData = Buffer.concat(session.frameBuffer);
            session.ffmpeg.stdin.write(frameData);

            if (!session.hasReceivedData) {
              log(`✓ First video frame received for ${sessionId}, size: ${frameData.length} bytes`);
              session.hasReceivedData = true;
            }

            session.frameBuffer = [];
            session.frameSize = 0;
            session.headerBytesRead = 0;
          }
        }
      }
    } catch (e) {
      error(`Message error: ${e}`);
    }
  });

  ws.on("close", () => {
    log(`Client disconnected: ${sessionId}`);

    if (session.ffmpeg && session.ffmpeg.stdin && !session.ffmpeg.stdin.destroyed) {
      session.ffmpeg.stdin.end();
    }

    if (session.ffmpeg && !session.ffmpeg.killed) {
      setTimeout(() => {
        if (session.ffmpeg && !session.ffmpeg.killed) {
          session.ffmpeg.kill("SIGTERM");
        }
      }, 1000);
    }

    sessions.delete(sessionId);
  });

  ws.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "EPIPE") {
      debug("WebSocket EPIPE (expected)");
    } else {
      error(`WebSocket error: ${err.message}`);
    }
  });
});

process.on("SIGINT", () => {
  log("Shutting down...");
  for (const [, session] of sessions) {
    if (session.ffmpeg && !session.ffmpeg.killed) {
      session.ffmpeg.kill("SIGTERM");
    }
  }
  wss.close();
  process.exit(0);
});