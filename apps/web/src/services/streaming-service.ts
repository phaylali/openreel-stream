import type { StreamQuality, StreamConfig, StreamStats, StreamStatus, AudioConfig } from "../types/streaming";

const QUALITY_MAP: Record<StreamQuality, { width: number; height: number; bitrate: number }> = {
  "720p": { width: 1280, height: 720, bitrate: 4_000_000 },
  "1080p": { width: 1920, height: 1080, bitrate: 6_000_000 },
  "1440p": { width: 2560, height: 1440, bitrate: 10_000_000 },
  "4K": { width: 3840, height: 2160, bitrate: 20_000_000 },
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
  private videoEncoder: VideoEncoder | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private canvasStream: MediaStream | null = null;
  private canvasTrack: MediaStreamVideoTrack | null = null;
  private audioStream: MediaStream | null = null;
  private videoReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private audioReader: ReadableStreamDefaultReader<AudioData> | null = null;
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
  private projectAudioDest: MediaStreamAudioDestinationNode | null = null;
  private masterGainNode: GainNode | null = null;
  private _micStream: MediaStream | null = null;
  private _stopping = false;

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
    return typeof VideoEncoder !== "undefined" && typeof AudioEncoder !== "undefined";
  }

  async connect(serverUrl: string): Promise<void> {
    if (this.status === "connecting" || this.status === "live" || this.status === "paused") {
      throw new StreamingError(`Already connected or streaming (${this.status})`);
    }

    this.setStatus("connecting");

    return new Promise<void>((resolve, reject) => {
      try {
        this.websocket = new WebSocket(serverUrl);
        this.websocket.binaryType = "arraybuffer";

        this.websocket.onopen = () => {
          this.stats.isConnected = true;
          this.emit("statusChange", this.status);
          resolve();
        };

        this.websocket.onclose = (event) => {
          this.stats.isConnected = false;
          this.handleDisconnect(event.code, event.reason);
        };

        this.websocket.onerror = () => {
          this.setStatus("error");
          this.emit("error", "WebSocket connection error");
          reject(new Error("WebSocket connection failed"));
        };

        this.websocket.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      } catch (err) {
        this.setStatus("error");
        reject(err);
      }
    });
  }

  async startStream(config: StreamConfig): Promise<void> {
    if (!StreamingService.isSupported()) {
      throw new StreamingError("WebCodecs not supported in this browser");
    }

    const currentStatus = this.status;
    if (currentStatus === "live" || currentStatus === "paused") {
      throw new StreamingError(`Already ${currentStatus}`);
    }
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      throw new StreamingError("WebSocket not connected");
    }

    this.config = config;
    this.startTime = Date.now();
    this.pausedTime = 0;
    this._stopping = false;

    try {
      const canvas = this.findCanvas();
      if (!canvas) {
        throw new StreamingError("Canvas element not found");
      }

      await this.startVideoCapture(canvas);

      if (config.audio.includeProjectAudio || config.audio.includeMicrophone) {
        await this.startAudioCapture(config.audio);
      }

      const startMsg: WebSocketMessage = {
        type: "start",
        data: {
          ingestUrl: config.ingestUrl,
          streamKey: config.twitchStreamKey,
          quality: config.quality,
          hasAudio: config.audio.includeProjectAudio || config.audio.includeMicrophone,
        },
      };
      this.websocket.send(JSON.stringify(startMsg));

      this.setStatus("live");
      this.startStatsInterval();
      this.emit("start");
    } catch (err) {
      this.setStatus("error");
      const msg = err instanceof Error ? err.message : "Failed to start stream";
      this.emit("error", msg);
      throw err;
    }
  }

  stopStream(): void {
    this.setStatus("stopping");
    this._stopping = true;
    this.stopStatsInterval();

    if (this.videoReader) {
      this.videoReader.cancel().catch(() => {});
      this.videoReader = null;
    }
    if (this.videoEncoder) {
      try {
        this.videoEncoder.flush().catch(() => {});
        this.videoEncoder.close();
      } catch { }
      this.videoEncoder = null;
    }
    if (this.canvasTrack) {
      this.canvasTrack.stop();
      this.canvasTrack = null;
    }
    if (this.canvasStream) {
      this.canvasStream = null;
    }

    if (this.audioReader) {
      this.audioReader.cancel().catch(() => {});
      this.audioReader = null;
    }
    if (this.audioEncoder) {
      try {
        this.audioEncoder.flush().catch(() => {});
        this.audioEncoder.close();
      } catch { }
      this.audioEncoder = null;
    }

    if (this.projectAudioDest && this.masterGainNode) {
      try {
        this.masterGainNode.disconnect(this.projectAudioDest);
      } catch { }
      this.projectAudioDest = null;
      this.masterGainNode = null;
    }
    if (this.audioStream) {
      this.audioStream.getTracks().forEach((t) => t.stop());
      this.audioStream = null;
    }
    if (this._micStream) {
      this._micStream.getTracks().forEach((t) => t.stop());
      this._micStream = null;
    }

    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      const stopMsg: WebSocketMessage = { type: "stop" };
      this.websocket.send(JSON.stringify(stopMsg));
    }

    this.setStatus("idle");
    this.emit("stop");
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
      if (msg.type === "stats") {
        this.stats = { ...this.stats, ...(msg.data as Partial<StreamStats>) };
        this.emit("stats", this.getStats());
      } else if (msg.type === "error") {
        this.emit("error", msg.data as string);
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
    console.log("[Streaming] Searching for canvas...");
    const allCanvases = document.querySelectorAll<HTMLCanvasElement>("canvas");
    console.log("[Streaming] Found canvases:", allCanvases.length);
    allCanvases.forEach((c, i) => {
      console.log(`[Streaming] Canvas ${i}:`, c.width, "x", c.height, c.className);
    });
    
    // Try multiple selectors to find the preview canvas
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
    
    // Fallback: find any canvas in the preview area
    for (const canvas of allCanvases) {
      if (canvas.width >= 640 && canvas.height >= 360) {
        console.log("[Streaming] Found fallback canvas:", canvas.width, "x", canvas.height);
        return canvas;
      }
    }
    
    console.log("[Streaming] No suitable canvas found");
    return null;
  }

  private sendVideoData(buffer: ArrayBuffer): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;
    const data = new Uint8Array(1 + buffer.byteLength);
    data[0] = 0;
    new Uint8Array(data.buffer, 1).set(new Uint8Array(buffer));
    this.websocket.send(data.buffer);
    this.stats.framesSent++;
  }

  private sendAudioData(buffer: ArrayBuffer): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;
    const data = new Uint8Array(1 + buffer.byteLength);
    data[0] = 1;
    new Uint8Array(data.buffer, 1).set(new Uint8Array(buffer));
    this.websocket.send(data.buffer);
  }

  private async startVideoCapture(canvas: HTMLCanvasElement): Promise<void> {
    if (!this.config) throw new Error("Config not set");

    const quality = QUALITY_MAP[this.config.quality];
    const captureFps = 60;
    this.canvasStream = canvas.captureStream(captureFps);
    this.canvasTrack = this.canvasStream.getVideoTracks()[0] as MediaStreamVideoTrack;

    this.videoEncoder = new VideoEncoder({
      output: async (chunk) => {
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
          this.stats.framesEncoded++;
          try {
            const chunkAny = chunk as unknown as { arrayBuffer(): Promise<ArrayBuffer>; close(): void };
            const buffer = await chunkAny.arrayBuffer();
            this.sendVideoData(buffer);
          } catch (e) {
            console.error("Failed to get video chunk buffer:", e);
          }
        }
        (chunk as unknown as { close(): void }).close();
      },
      error: (err) => {
        this.emit("error", `Video encoder error: ${err.message}`);
      },
    });

    try {
      this.videoEncoder.configure({
        codec: "avc1.42E01E",
        width: quality.width,
        height: quality.height,
        bitrate: quality.bitrate,
        framerate: captureFps,
        hardwareAcceleration: "prefer-hardware",
      });
    } catch (e) {
      throw new StreamingError(`H.264 encoder not available: ${e}`);
    }

    const processor = new MediaStreamTrackProcessor({ track: this.canvasTrack });
    const reader = processor.readable.getReader();
    this.videoReader = reader;

    const encodeLoop = async () => {
      while (!this._stopping) {
        try {
          const result = await reader.read();
          if (result.done) break;
          const value = result.value;
          if (!value) continue;

          if (this.status === "live") {
            const isKeyframe = this.stats.framesEncoded % (captureFps * 2) === 0;
            try {
              this.videoEncoder!.encode(value, { keyFrame: isKeyframe });
              this.stats.framesEncoded++;
            } catch {
              this.stats.droppedFrames++;
            }
            value.close();
          } else if (this.status === "paused") {
            value.close();
          }
        } catch (err) {
          if (!this._stopping) {
            this.emit("error", `Video encoding error: ${err}`);
          }
          break;
        }
      }
      try {
        await reader.closed;
      } catch { }
    };

    encodeLoop().catch((err) => {
      if (!this._stopping) {
        this.emit("error", `Video loop crashed: ${err.message}`);
      }
    });
  }

  private async startAudioCapture(audioConfig: AudioConfig): Promise<void> {
    try {
      let audioCtx: AudioContext | null = null;
      let masterGain: GainNode | null = null;

      try {
        const coreMod = await import("@openreel/core");
        const audioGraph = coreMod.getRealtimeAudioGraph();
        audioCtx = (audioGraph as unknown as { getAudioContext(): AudioContext | null }).getAudioContext?.() ?? null;
        masterGain = (audioGraph as unknown as { getMasterGain(): GainNode | null }).getMasterGain?.() ?? null;
      } catch (e) {
        console.error("Failed to load audio graph", e);
      }

      if (!audioCtx || !masterGain) {
        this.emit("warning", "Audio context not available, skipping project audio");
        return;
      }

      const dest = audioCtx.createMediaStreamDestination();
      this.projectAudioDest = dest;
      this.masterGainNode = masterGain;
      masterGain.connect(dest);

      let micStream: MediaStream | null = null;
      if (audioConfig.includeMicrophone) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
          this.emit("warning", `Microphone unavailable: ${err}`);
        }
      }

      const combined = new MediaStream();
      const projectTrack = dest.stream.getAudioTracks()[0];
      if (projectTrack) {
        combined.addTrack(projectTrack);
      }
      if (micStream) {
        const micTrack = micStream.getAudioTracks()[0];
        if (micTrack) {
          combined.addTrack(micTrack);
        }
        this._micStream = micStream;
      }

      if (combined.getAudioTracks().length === 0) {
        throw new Error("No audio tracks available");
      }

      this.audioStream = combined;

      this.audioEncoder = new AudioEncoder({
        output: async (chunk) => {
          if (this.websocket?.readyState === WebSocket.OPEN) {
            try {
              const chunkAny = chunk as unknown as { arrayBuffer(): Promise<ArrayBuffer>; close(): void };
              const buffer = await chunkAny.arrayBuffer();
              this.sendAudioData(buffer);
            } catch (e) {
              console.error("Failed to get audio chunk buffer:", e);
            }
          }
          (chunk as unknown as { close(): void }).close();
        },
        error: (err) => {
          this.emit("error", `Audio encoder error: ${err.message}`);
        },
      });

      this.audioEncoder.configure({
        codec: "aac",
        sampleRate: audioCtx.sampleRate,
        numberOfChannels: 2,
        bitrate: 160_000,
      });

      const track = combined.getAudioTracks()[0] as MediaStreamAudioTrack;
      const processor = new MediaStreamTrackProcessor({ track });
      const reader = processor.readable.getReader();
      this.audioReader = reader;

      const audioLoop = async () => {
        while (!this._stopping) {
          try {
            const result = await reader.read();
            if (result.done) break;
            const value = result.value;
            if (!value) continue;

            if (this.status === "live") {
              while (this.audioEncoder && this.audioEncoder.encodeQueueSize > 5) {
                await new Promise((r) => setTimeout(r, 10));
              }
              if (this.audioEncoder) {
                this.audioEncoder.encode(value);
              }
            } else if (this.status === "paused") {
              value.close();
            }
          } catch (err) {
            if (!this._stopping) {
              this.emit("error", `Audio processing error: ${err}`);
            }
            break;
          }
        }
        try {
          await reader.closed;
        } catch { }
      };

      audioLoop().catch((err) => {
        if (!this._stopping) {
          this.emit("error", `Audio loop crashed: ${err.message}`);
        }
      });
    } catch (err) {
      this.emit("error", `Audio setup failed: ${err}`);
    }
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