/**
 * Shared types for streaming feature
 */

export type StreamQuality = "720p" | "1080p" | "1440p" | "4K";

export interface AudioConfig {
  includeProjectAudio: boolean;
  includeMicrophone: boolean;
}

export interface StreamConfig {
  quality: StreamQuality;
  audio: AudioConfig;
  twitchStreamKey: string;
  ingestUrl: string;
  serverUrl: string;
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
