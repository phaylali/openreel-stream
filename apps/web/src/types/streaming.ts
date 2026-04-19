/**
 * Shared types for streaming feature
 */

export type StreamQuality = "720p" | "1080p" | "1440p" | "4K";

export interface AudioConfig {
  includeProjectAudio: boolean;
  includeMicrophone: boolean;
}

export interface StreamConfig {
  quality: string;  // Allow custom quality strings like "1080p60"
  audio: AudioConfig;
  twitchStreamKey: string;
  ingestUrl: string;
  serverUrl: string;
  amdDriver?: "mesa" | "vulkan" | "auto";
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
