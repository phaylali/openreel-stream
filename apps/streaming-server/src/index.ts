import { WebSocketServer, WebSocket } from "ws";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "module";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { URL } from "url";

const require = createRequire(import.meta.url);
const gstreamer = require("gstreamer-superficial");

const PORT = parseInt(process.env.PORT || "8081", 10);
const HTTP_PORT = PORT + 1;

interface StreamSession {
  ws: WebSocket;
  pipeline: any;
  appsrc: any;
  config: StreamConfig | null;
  startTime: number;
  hasReceivedData: boolean;
  lastLog?: number;
  rtmpConnected: boolean;
  rtmpConnectTime: number | null;
  totalBytesReceived: number;
  framesReceived: number;
  useGpu: boolean;
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

function buildGstPipeline(config: StreamConfig, useGpu: boolean): string {
  const gopSize = config.fps * 2;
  const bitrateK = Math.round(config.bitrate / 1000);

  log(`GStreamer config: ${config.width}x${config.height} @ ${config.fps}fps, ${bitrateK}k bitrate, GPU: ${useGpu}`);

  const encoder = useGpu
    ? `vah264enc bitrate=${bitrateK} target-usage=4 ! video/x-h264,profile=main,level=(string)4.0`
    : `x264enc bitrate=${bitrateK} speed-preset=ultrafast tune=zerolatency ! video/x-h264,profile=main,level=(string)4.0`;

  const rtmpUrl = buildRtmpUrl(config.ingestUrl, config.streamKey);

  let pipeline = `appsrc name=src format=time is-live=true block=false ! ` +
    `matroskademux name=demux ` +
    `demux. ! queue ! vp8dec ! videoconvert ! video/x-raw,format=NV12 ! ${encoder} ! ` +
    `h264parse ! ` +
    `flvmux name=mux streamable=true ! ` +
    `queue ! ` +
    `rtmpsink location="${rtmpUrl}"`;

  if (config.hasAudio) {
    pipeline = pipeline.replace(
      `flvmux name=mux streamable=true`,
      `demux. ! queue ! opusdec ! audioconvert ! audioresample ! audio/x-raw,format=S16LE,rate=48000,channels=2 ! voaacenc bitrate=128000 ! aacparse ! flvmux name=mux streamable=true`
    );
  }

  return pipeline;
}

function buildRtmpUrl(ingestUrl: string, streamKey: string): string {
  const base = ingestUrl.replace(/\/+$/, "");
  return `${base}/${streamKey}`;
}

function startGStreamer(session: StreamSession): boolean {
  if (!session.config) {
    error("No config for session");
    return false;
  }

  const config = session.config;
  const driverPreference = config.amdDriver || "auto";
  const amdGpu = checkAMDGPU(driverPreference);

  session.useGpu = amdGpu.available;
  const pipelineStr = buildGstPipeline(config, session.useGpu);

  const rtmpUrl = buildRtmpUrl(config.ingestUrl, config.streamKey);
  log(`Starting GStreamer, RTMP: ${rtmpUrl.replace(config.streamKey, "***")}`);
  log(`Pipeline: ${pipelineStr}`);

  if (session.useGpu) {
    log(`GPU encoding: VA-API H.264 on ${amdGpu.device} using ${amdGpu.driver} driver`);
  } else {
    log(`GPU encoding: Not available, using CPU (x264enc)`);
  }

  try {
    session.pipeline = new gstreamer.Pipeline(pipelineStr);

    session.appsrc = session.pipeline.findChild("src");
    if (!session.appsrc) {
      error("Could not find appsrc element in pipeline");
      return false;
    }

    session.appsrc.set("caps", `video/x-vp8,width=${config.width},height=${config.height},framerate=${config.fps}/1`);

    session.pipeline.on("error", (err: Error) => {
      error("GStreamer pipeline error:", err);
      session.ws.send(JSON.stringify({
        type: "error",
        data: `GStreamer error: ${err.message}`
      }));
    });

    session.pipeline.on("eos", () => {
      log("GStreamer EOS received");
    });

    session.pipeline.setPlaying(true);
    log("GStreamer pipeline started");
    return true;
  } catch (err) {
    error(`Failed to create GStreamer pipeline: ${err}`);
    session.ws.send(JSON.stringify({
      type: "error",
      data: `GStreamer error: ${err}`
    }));
    return false;
  }
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

      if (session.pipeline) {
        try {
          session.pipeline.sendEos();
          setTimeout(() => {
            if (session.pipeline) {
              session.pipeline.setPlaying(false);
            }
          }, 2000);
        } catch (e) {
          debug(`Error sending EOS: ${e}`);
        }
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
    log(`✓ Hardware encoding available: vah264enc`);
  } else {
    log(`⚠ No AMD GPU detected, will use CPU encoding (x264enc)`);
  }
});

wss.on("connection", (ws, req) => {
  const sessionId = Math.random().toString(36).slice(2, 10);

  const session: StreamSession = {
    ws,
    pipeline: null,
    appsrc: null,
    config: null,
    startTime: 0,
    hasReceivedData: false,
    lastLog: 0,
    rtmpConnected: false,
    rtmpConnectTime: null,
    totalBytesReceived: 0,
    framesReceived: 0,
    useGpu: false,
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

        if (!session.pipeline) {
          if (!startGStreamer(session)) {
            return;
          }
        }

        if (!session.appsrc) {
          error(`Cannot write data: appsrc not available`);
          return;
        }

        try {
          const buffer = Buffer.from(data);
          const gstBuffer = gstreamer.Buffer.fromData(buffer);
          session.appsrc.emit("push-buffer", gstBuffer);
          session.totalBytesReceived += data.length;
          session.framesReceived++;

          if (!session.hasReceivedData) {
            log(`✓ First WebM chunk received for ${sessionId}, size: ${data.length} bytes`);
            session.hasReceivedData = true;
          }
        } catch (e) {
          error(`Failed to push buffer to GStreamer: ${e}`);
        }
      }
    } catch (e) {
      error(`Message error: ${e}`);
    }
  });

  ws.on("close", () => {
    log(`Client disconnected: ${sessionId}`);

    if (session.pipeline) {
      try {
        session.pipeline.sendEos();
        setTimeout(() => {
          if (session.pipeline) {
            session.pipeline.setPlaying(false);
          }
        }, 1000);
      } catch (e) {
        debug(`Error on close: ${e}`);
      }
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
    if (session.pipeline) {
      try {
        session.pipeline.setPlaying(false);
      } catch (e) {
        debug(`Error stopping pipeline: ${e}`);
      }
    }
  }
  wss.close();
  process.exit(0);
});

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname === "/api/twitch/live" && req.method === "GET") {
    const channel = url.searchParams.get("channel");
    if (!channel) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Missing channel parameter" }));
      return;
    }

    try {
      const clientId = url.searchParams.get("client_id") || "kimne78kx3ncx6brgo4mv6wki5h1ko";
      const twitchRes = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(channel)}`, {
        headers: { "Client-ID": clientId },
      });
      const body: unknown = await twitchRes.json();
      const twitchData = body as { data?: unknown[] };
      const isLive = twitchData.data && twitchData.data.length > 0;

      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ channel, isLive, data: twitchData.data }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  } else {
    res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

httpServer.listen(HTTP_PORT, () => {
  log(`HTTP API server listening on port ${HTTP_PORT}`);
});