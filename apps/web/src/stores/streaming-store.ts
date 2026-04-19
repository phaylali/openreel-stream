import { create } from "zustand";
import { streamingService } from "../services/streaming-service";
import type { StreamConfig, StreamStats, StreamStatus } from "../types/streaming";

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
  setConfig: (config: StreamConfig) => void;
  updateStats: (partial: Partial<StreamStats>) => void;
  startStream: (config: StreamConfig) => Promise<void>;
  stopStream: () => void;
  pauseStream: () => void;
  resumeStream: () => void;
  reset: () => void;
}

export const useStreamingStore = create<StreamingState>()((set) => ({
  isStreaming: false,
  isPaused: false,
  status: "idle",
  error: null,
  stats: null,
  config: null,

  setStatus: (status) => {
    set({ status });
    if (status === "live") {
      set({ isStreaming: true, isPaused: false, error: null });
    } else if (status === "paused") {
      set({ isPaused: true });
    } else if (status === "idle" || status === "error") {
      set({ isStreaming: false, isPaused: false });
    }
  },

  setError: (error) => set({ error }),
  setStats: (stats) => set({ stats }),

  setConfig: (config) => set({ config }),

  updateStats: (partial) => {
    set((state) => ({
      stats: state.stats ? { ...state.stats, ...partial } : null,
    }));
  },

  startStream: async (config) => {
    const service = streamingService;

    // Already connecting or live?
    const currentStatus = service.getStatus();
    if (currentStatus === "connecting" || currentStatus === "live" || currentStatus === "paused") {
      throw new Error(`Cannot start: already ${currentStatus}`);
    }

    try {
      await service.connect(config.serverUrl);
      set({ config });
      await service.startStream(config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start stream";
      set({ error: msg });
      throw err;
    }
  },

  stopStream: () => {
    streamingService.stopStream();
  },

  pauseStream: () => {
    streamingService.pauseStream();
  },

  resumeStream: () => {
    streamingService.resumeStream();
  },

  reset: () => {
    set({
      isStreaming: false,
      isPaused: false,
      status: "idle",
      error: null,
      stats: null,
      config: null,
    });
  },
}));

// Global one-time event subscription to keep store in sync
streamingService.on("statusChange", (status: StreamStatus) => {
  useStreamingStore.getState().setStatus(status);
});
streamingService.on("error", (error: string) => {
  useStreamingStore.getState().setError(error);
});
streamingService.on("stats", (stats: StreamStats) => {
  useStreamingStore.getState().setStats(stats);
});

// Export type for external use if needed
export type { StreamingState };

