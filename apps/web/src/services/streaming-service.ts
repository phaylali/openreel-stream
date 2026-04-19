import type { StreamConfig, StreamStats, StreamStatus, AudioConfig } from "../types/streaming";

const QUALITY_MAP: Record<string, { width: number; height: number; bitrate: number; fps: number }> = {
  "720p": { width: 1280, height: 720, bitrate: 4_000_000, fps: 30 },
  "720p30": { width: 1280, height: 720, bitrate: 4_000_000, fps: 30 },
  "720p60": { width: 1280, height: 720, bitrate: 4_500_000, fps: 60 },
  "1080p": { width: 1920, height: 1080, bitrate: 4_500_000, fps: 30 },
  "1080p30": { width: 1920, height: 1080, bitrate: 4_500_000, fps: 30 },
  "1080p60": { width: 1920, height: 1080, bitrate: 5_000_000, fps: 60 },
  "1440p": { width: 2560, height: 1440, bitrate: 8_000_000, fps: 30 },
  "1440p30": { width: 2560, height: 1440, bitrate: 8_000_000, fps: 30 },
  "1440p60": { width: 2560, height: 1440, bitrate: 10_000_000, fps: 60 },
  "4K": { width: 3840, height: 2160, bitrate: 12_000_000, fps: 30 },
  "4K30": { width: 3840, height: 2160, bitrate: 12_000_000, fps: 30 },
  "4K60": { width: 3840, height: 2160, bitrate: 15_000_000, fps: 60 },
};

class StreamingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamingError";
  }
}

class SimpleEmitter {
  private listeners: Map<string, Set<Function>> = new Map();

  on(event: string, handler: Function): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  off(event: string, handler: Function): void {
    this.listeners.get(event)?.delete(handler);
  }

  once(event: string, handler: Function): () => void {
    const wrapper = (...args: unknown[]) => {
      this.off(event, wrapper);
      handler(...args);
    };
    return this.on(event, wrapper);
  }

  emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((handler) => {
      try {
        handler(...args);
      } catch (err) {
        console.error(`Event handler error for ${event}:`, err);
      }
    });
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}

interface WebSocketMessage {
  type: "start" | "stop" | "pause" | "resume" | "config" | "stats" | "started" | "stopped" | "paused" | "resumed" | "error";
  data?: unknown;
}

export class StreamingService extends SimpleEmitter {
  private websocket: WebSocket | null = null;
  private config: StreamConfig | null = null;
  private status: StreamStatus = "idle";
  private stats: StreamStats = {
    duration: 0,
    framesEncoded: 0,
    framesSent: 0,
    droppedFrames: 0,
    bitrate: 0,
    isConnected: false,
  };
  private statsInterval: number | null = null;
  private startTime: number = 0;
  private pausedTime: number = 0;
  private pauseStart: number = 0;
  private captureCanvas: HTMLCanvasElement | null = null;
  private captureContext: CanvasRenderingContext2D | null = null;
  private captureInterval: number | null = null;
  private _stopping = false;
  private audioContext: AudioContext | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private audioTimestamp = 0;
  private frameCount = 0;

  constructor() {
    super();
  }

  getStatus(): StreamStatus {
    return this.status;
  }

  getStats(): StreamStats {
    return { ...this.stats };
  }

  getConfig(): StreamConfig | null {
    return this.config;
  }

  static isSupported(): boolean {
    return typeof OffscreenCanvas !== "undefined";
  }

  async connect(serverUrl: string): Promise<void> {
    if (this.status === "connecting" || this.status === "live" || this.status === "paused") {
      throw new StreamingError(`Already connected or streaming (${this.status})`);
    }

    this.setStatus("connecting");
    console.log("[Streaming] Connecting to server:", serverUrl);

    return new Promise<void>((resolve, reject) => {
      try {
        this.websocket = new WebSocket(serverUrl);
        this.websocket.binaryType = "arraybuffer";

        this.websocket.onopen = () => {
          console.log("[Streaming] WebSocket connected!");
          this.stats.isConnected = true;
          this.emit("statusChange", this.status);
          resolve();
        };

        this.websocket.onclose = (event) => {
          console.log("[Streaming] WebSocket closed:", event.code, event.reason);
          this.stats.isConnected = false;
          this.handleDisconnect(event.code, event.reason);
        };

        this.websocket.onerror = (error) => {
          console.error("[Streaming] WebSocket error:", error);
          this.setStatus("error");
          this.emit("error", "WebSocket connection error");
          reject(new Error("WebSocket connection failed"));
        };

        this.websocket.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      } catch (err) {
        console.error("[Streaming] Connection error:", err);
        this.setStatus("error");
        reject(err);
      }
    });
  }

  async startStream(config: StreamConfig): Promise<void> {
    if (!StreamingService.isSupported()) {
      throw new StreamingError("OffscreenCanvas not supported in this browser");
    }

    const currentStatus = this.status;
    if (currentStatus === "live" || currentStatus === "paused") {
      throw new StreamingError(`Already ${currentStatus}`);
    }
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      throw new StreamingError("WebSocket not connected");
    }

    console.log("[Streaming] Starting stream with config:", config);
    this.config = config;
    this.startTime = Date.now();
    this.pausedTime = 0;
    this._stopping = false;
    this.frameCount = 0;
    this.audioTimestamp = 0;

    try {
      const sourceCanvas = this.findCanvas();
      if (!sourceCanvas) throw new StreamingError("Canvas element not found");
      console.log("[Streaming] Source canvas found:", sourceCanvas.width, "x", sourceCanvas.height);

      const quality = QUALITY_MAP[config.quality] || QUALITY_MAP["1080p30"];
      console.log(`[Streaming] Quality: ${quality.width}x${quality.height} @ ${quality.fps}fps, ${quality.bitrate/1000}kbps`);

      this.captureCanvas = document.createElement("canvas");
      this.captureCanvas.width = quality.width;
      this.captureCanvas.height = quality.height;
      this.captureContext = this.captureCanvas.getContext("2d", { alpha: false, willReadFrequently: false });
      if (!this.captureContext) throw new StreamingError("Could not create canvas context");

      this.captureContext.fillStyle = "#000000";
      this.captureContext.fillRect(0, 0, quality.width, quality.height);

      const streamConfig = {
        type: "start",
        data: {
          ingestUrl: config.ingestUrl,
          streamKey: config.twitchStreamKey,
          quality: config.quality,
          bitrate: quality.bitrate,
          width: quality.width,
          height: quality.height,
          fps: quality.fps,
          hasAudio: config.audio.includeMicrophone || config.audio.includeProjectAudio,
          amdDriver: config.amdDriver || "auto",
        },
      };
      console.log("[Streaming] Sending config to server:", JSON.stringify(streamConfig.data));
      this.websocket.send(JSON.stringify(streamConfig));

      if (config.audio.includeMicrophone || config.audio.includeProjectAudio) {
        await this.initAudioEncoder(config.audio);
      }

      this.startFrameCapture(sourceCanvas, quality);

      this.setStatus("live");
      this.startStatsInterval();
      this.emit("start");
      console.log("[Streaming] Stream is now LIVE!");

    } catch (err) {
      console.error("[Streaming] Failed to start stream:", err);
      this.setStatus("error");
      const msg = err instanceof Error ? err.message : "Failed to start stream";
      this.emit("error", msg);
      throw err;
    }
  }

  private async initAudioEncoder(audioConfig: AudioConfig): Promise<void> {
    console.log("[Streaming] Initializing audio encoder...");
    try {
      this.audioContext = new AudioContext({ sampleRate: 48000 });
      const audioTracks: MediaStreamTrack[] = [];

      if (audioConfig.includeMicrophone) {
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStream.getAudioTracks().forEach(track => audioTracks.push(track));
        console.log("[Streaming] Microphone audio added");
      }

      if (audioConfig.includeProjectAudio) {
        try {
          const coreMod = await import("@openreel/core");
          const audioGraph = coreMod.getRealtimeAudioGraph();
          const audioCtx = (audioGraph as unknown as { getAudioContext(): AudioContext | null }).getAudioContext?.() ?? null;
          const masterGain = (audioGraph as unknown as { getMasterGain(): GainNode | null }).getMasterGain?.() ?? null;
          if (audioCtx && masterGain) {
            const dest = this.audioContext.createMediaStreamDestination();
            masterGain.connect(dest);
            dest.stream.getAudioTracks().forEach(track => audioTracks.push(track));
            console.log("[Streaming] Project audio added");
          }
        } catch (e) {
          console.warn("[Streaming] Project audio unavailable:", e);
        }
      }

      if (audioTracks.length === 0) {
        console.log("[Streaming] No audio tracks available");
        return;
      }

      const source = this.audioContext.createMediaStreamSource(new MediaStream(audioTracks));

      this.audioEncoder = new AudioEncoder({
        output: (chunk, _metadata) => {
          if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;
          const buffer = new ArrayBuffer(chunk.byteLength);
          chunk.copyTo(buffer);
          const data = new Uint8Array(buffer);
          this.sendAudioFrame(data, chunk.timestamp);
        },
        error: (e) => console.error("[Streaming] AudioEncoder error:", e),
      });

      const supported = await AudioEncoder.isConfigSupported({
        codec: "mp4a.40.2",
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 128000,
      });

      if (!supported.supported) {
        console.warn("[Streaming] AAC encoder not supported, skipping audio");
        return;
      }

      this.audioEncoder.configure({
        codec: "mp4a.40.2",
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 128000,
      });

      const bufferSize = 1024;
      const processor = this.audioContext.createScriptProcessor(bufferSize, 2, 2);
      processor.onaudioprocess = (event) => {
        if (!this.audioEncoder || this.audioEncoder.state !== "configured") return;
        const inputBuffer = event.inputBuffer;
        const samplesL = inputBuffer.getChannelData(0);
        const samplesR = inputBuffer.getChannelData(1) || samplesL;
        const interleaved = new Float32Array(inputBuffer.length * 2);
        for (let i = 0; i < inputBuffer.length; i++) {
          interleaved[i * 2] = samplesL[i];
          interleaved[i * 2 + 1] = samplesR[i];
        }
        const audioData = new AudioData({
          format: "f32-planar",
          sampleRate: 48000,
          numberOfFrames: inputBuffer.length,
          numberOfChannels: 2,
          timestamp: this.audioTimestamp,
          data: new Float32Array(samplesL),
        });
        this.audioEncoder.encode(audioData);
        audioData.close();
        this.audioTimestamp += (inputBuffer.length / 48000) * 1_000_000;
      };

      source.connect(processor);
      processor.connect(this.audioContext.destination);
      console.log("[Streaming] Audio encoder configured");
    } catch (err) {
      console.warn("[Streaming] Audio encoder setup failed:", err);
    }
  }

  private sendAudioFrame(data: Uint8Array, timestamp: number): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;
    const header = new Uint8Array(12);
    const view = new DataView(header.buffer);
    view.setUint8(0, 0x02);
    view.setUint32(2, data.length);
    view.setBigUint64(6, BigInt(Math.floor(timestamp)));
    this.websocket.send(header);
    this.websocket.send(data);
  }

  private startFrameCapture(sourceCanvas: HTMLCanvasElement, quality: { width: number; height: number; fps: number }): void {
    if (!this.captureContext || !this.captureCanvas) return;

    const targetFps = quality.fps;
    const frameInterval = 1_000 / targetFps;
    let lastFrameTime = performance.now();
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 10;

    const captureLoop = (currentTime: number) => {
      if (!this.captureContext || !this.captureCanvas || this._stopping) return;

      const delta = currentTime - lastFrameTime;

      if (delta >= frameInterval) {
        lastFrameTime = currentTime - (delta % frameInterval);

        try {
          if (!sourceCanvas || sourceCanvas.width === 0 || sourceCanvas.height === 0) {
            const newCanvas = this.findCanvas();
            if (newCanvas && newCanvas !== sourceCanvas) {
              sourceCanvas = newCanvas;
            } else if (!newCanvas) {
              throw new Error("Canvas not found");
            }
          }

          this.captureContext.fillStyle = "#000000";
          this.captureContext.fillRect(0, 0, quality.width, quality.height);
          this.captureContext.drawImage(
            sourceCanvas,
            0, 0, sourceCanvas.width, sourceCanvas.height,
            0, 0, quality.width, quality.height
          );

          this.captureCanvas.toBlob((blob) => {
            if (!blob || !this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;
            blob.arrayBuffer().then(buf => {
              const data = new Uint8Array(buf);
              this.sendVideoFrame(data);
            });
          }, "image/jpeg", 0.92);

          this.stats.framesEncoded++;
          this.frameCount++;
          consecutiveErrors = 0;
        } catch (e) {
          consecutiveErrors++;
          if (consecutiveErrors >= maxConsecutiveErrors) {
            const recoveredCanvas = this.findCanvas();
            if (recoveredCanvas && recoveredCanvas !== sourceCanvas) {
              sourceCanvas = recoveredCanvas;
              consecutiveErrors = 0;
            }
          }
        }
      }

      this.captureInterval = requestAnimationFrame(captureLoop);
    };

    this.captureInterval = requestAnimationFrame(captureLoop);
    console.log("[Streaming] Frame capture started at", targetFps, "FPS (JPEG frames)");
  }

  private sendVideoFrame(data: Uint8Array): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;

    const header = new Uint8Array(12);
    const view = new DataView(header.buffer);
    view.setUint8(0, 0x01);
    view.setUint8(1, 0x00);
    view.setUint32(2, data.length);
    view.setBigUint64(6, BigInt(Date.now()));

    this.websocket.send(header);
    this.websocket.send(data);
    this.stats.framesSent++;

    if (this.stats.framesSent <= 3) {
      console.log(`[Streaming] Sent JPEG frame #${this.stats.framesSent}: ${data.length} bytes`);
    }
  }

  stopStream(): void {
    this.setStatus("stopping");
    this._stopping = true;
    this.stopStatsInterval();

    if (this.audioEncoder && this.audioEncoder.state !== "closed") {
      this.audioEncoder.flush().catch(() => {});
      this.audioEncoder.close();
    }
    this.audioEncoder = null;

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    if (this.captureInterval) {
      cancelAnimationFrame(this.captureInterval);
      this.captureInterval = null;
    }

    this.captureCanvas = null;
    this.captureContext = null;

    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify({ type: "stop" }));
    }

    this.setStatus("idle");
    this.emit("stop");
    console.log("[Streaming] Stream stopped");
  }

  pauseStream(): void {
    if (this.status !== "live") return;
    this.pauseStart = Date.now();
    this.setStatus("paused");
    this.emit("pause");
  }

  resumeStream(): void {
    if (this.status !== "paused") return;
    this.pausedTime += Date.now() - this.pauseStart;
    this.setStatus("live");
    this.emit("resume");
  }

  private setStatus(status: StreamStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.emit("statusChange", status);
    }
  }

  private startStatsInterval(): void {
    this.statsInterval = window.setInterval(() => {
      if (this.status === "live") {
        this.stats.duration = (Date.now() - this.startTime - this.pausedTime) / 1000;
      }
      this.emit("stats", this.getStats());
    }, 1000);
  }

  private stopStatsInterval(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (typeof data !== "string") return;
    try {
      const msg: WebSocketMessage = JSON.parse(data);
      console.log("[Streaming] Server message:", msg.type);

      if (msg.type === "stats") {
        this.stats = { ...this.stats, ...(msg.data as Partial<StreamStats>) };
        this.emit("stats", this.getStats());
      } else if (msg.type === "error") {
        console.error("[Streaming] Server error:", msg.data);
        this.emit("error", msg.data as string);
      } else if (msg.type === "started") {
        console.log("[Streaming] Server confirmed stream started");
      } else if (msg.type === "stopped") {
        console.log("[Streaming] Server confirmed stream stopped");
      }
    } catch { }
  }

  private handleDisconnect(code: number, reason: string): void {
    this.stats.isConnected = false;
    this.stopStatsInterval();
    if (this.status === "live" || this.status === "paused") {
      this.setStatus("idle");
      this.emit("error", `Disconnected: ${code} ${reason}`);
    } else {
      this.setStatus("idle");
    }
  }

  private findCanvas(): HTMLCanvasElement | null {
    const selectors = [
      "#preview-canvas",
      "canvas.w-full.h-full.object-contain",
      "canvas[class*='w-full'][class*='h-full']",
      "div.relative canvas",
      "div[class*='bg-black'] canvas",
    ];

    for (const sel of selectors) {
      const el = document.querySelector<HTMLCanvasElement>(sel);
      if (el && el.width > 0 && el.height > 0) {
        console.log("[Streaming] Found canvas with selector:", sel);
        return el;
      }
    }

    const allCanvases = document.querySelectorAll<HTMLCanvasElement>("canvas");
    for (const canvas of allCanvases) {
      if (canvas.width >= 640 && canvas.height >= 360) {
        console.log("[Streaming] Found fallback canvas:", canvas.width, "x", canvas.height);
        return canvas;
      }
    }

    console.log("[Streaming] No suitable canvas found");
    return null;
  }

  dispose(): void {
    if (this.status === "live" || this.status === "paused") {
      this.stopStream();
    }
    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }
    this.removeAllListeners();
  }

  onStop(callback: () => void): void {
    this.once("stop", callback);
  }
}

export const streamingService = new StreamingService();
export default streamingService;