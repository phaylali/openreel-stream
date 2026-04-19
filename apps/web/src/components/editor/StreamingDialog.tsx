import React, { useEffect, useMemo } from "react";
import {
  Radio,
  Square,
  Loader2,
  Play,
  Pause,
  AlertCircle,
  X,
} from "lucide-react";
import { Button } from "@openreel/ui";
import { useStreamingStore } from "../../stores/streaming-store";
import { useSettingsStore } from "../../stores/settings-store";
import { toast } from "../../stores/notification-store";

interface StreamingDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export const StreamingDialog: React.FC<StreamingDialogProps> = ({ isOpen, onClose }) => {
  const streamingStore = useStreamingStore();
  const { streamingSettings } = useSettingsStore();

  const { status, error, stats } = streamingStore;

  // Format duration as HH:MM:SS
  const formattedDuration = useMemo(() => {
    if (!stats) return "00:00:00";
    const hrs = Math.floor(stats.duration / 3600);
    const mins = Math.floor((stats.duration % 3600) / 60);
    const secs = Math.floor(stats.duration % 60);
    return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }, [stats?.duration]);

  // Format bitrate in kbps
  const formattedBitrate = useMemo(() => {
    if (!stats) return "0 kbps";
    const kbps = Math.round(stats.bitrate / 1000);
    return `${kbps.toLocaleString()} kbps`;
  }, [stats?.bitrate]);

  // Handle start streaming
  const handleStart = async () => {
    try {
      const serverUrl = streamingSettings.twitch.serverUrl;
      const ingestUrl = streamingSettings.twitch.ingestUrl;
      // Retrieve stream key from secure storage
      const { getSecret } = await import("../../services/secure-storage");
      const streamKey = await getSecret("twitch-stream-key");
      if (!streamKey) {
        toast.error("Stream key missing", "Set your Twitch stream key in Settings > Streaming.");
        return;
      }
      const cfg = {
        quality: streamingSettings.twitch.preferredQuality,
        audio: {
          includeProjectAudio: streamingSettings.twitch.includeAudio,
          includeMicrophone: streamingSettings.twitch.micEnabled,
        },
        twitchStreamKey: streamKey,
        ingestUrl,
        serverUrl,
        amdDriver: streamingSettings.twitch.amdDriver,
      };
      await streamingStore.startStream(cfg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start stream";
      toast.error("Stream error", msg);
    }
  };

  // Handle stop
  const handleStop = () => {
    streamingStore.stopStream();
    onClose();
  };

  // Handle pause/resume
  const handlePause = () => streamingStore.pauseStream();
  const handleResume = () => streamingStore.resumeStream();

  // Cleanup on close/unmount
  useEffect(() => {
    if (!isOpen && (status === "live" || status === "paused")) {
      // Force stop if dialog closed while streaming
      streamingStore.stopStream();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // Idle/not started
  if (status === "idle" || status === "connecting" || status === "error") {
    return (
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
        <div className="bg-background-secondary border border-border rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${status === "connecting" ? "bg-primary/20" : "bg-purple/20"}`}>
                {status === "connecting" ? (
                  <Loader2 size={20} className="text-primary animate-spin" />
                ) : (
                  <Radio size={20} className="text-purple" />
                )}
              </div>
              <div>
                <h2 className="text-lg font-semibold text-text-primary">
                  {status === "connecting" ? "Connecting..." : "Go Live on Twitch"}
                </h2>
                <p className="text-xs text-text-muted">
                  {status === "connecting"
                    ? "Establishing connection to streaming server..."
                    : "Stream your editor canvas to Twitch"}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-background-tertiary text-text-muted hover:text-text-primary transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          {status === "error" && (
            <div className="mb-4 p-3 bg-error/10 border border-error/30 rounded-lg flex items-start gap-2">
              <AlertCircle size={16} className="text-error mt-0.5" />
              <div>
                <p className="text-sm text-error font-medium">Connection failed</p>
                <p className="text-xs text-text-secondary mt-1">{error || "Unknown error"}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={handleStart}
                >
                  Retry
                </Button>
              </div>
            </div>
          )}

          {status === "idle" && (
            <div className="mb-6">
              <div className="space-y-2 text-sm mb-4">
                <div className="flex justify-between">
                  <span className="text-text-secondary">Channel</span>
                  <span className="text-text-primary font-medium">
                    {streamingSettings.twitch.channelName || "Not set"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">Quality</span>
                  <span className="text-text-primary">{streamingSettings.twitch.preferredQuality}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">Audio</span>
                  <span className="text-text-primary">
                    {streamingSettings.twitch.includeAudio ? "Project + Mic" : "Video only"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">Server</span>
                  <span className="text-text-primary font-mono text-xs">{streamingSettings.twitch.serverUrl}</span>
                </div>
              </div>

              <Button onClick={handleStart} className="w-full">
                <Radio size={16} className="mr-2" />
                Go Live
              </Button>
            </div>
          )}

          {status === "connecting" && (
            <div className="flex items-center justify-center py-4">
              <Loader2 size={24} className="text-primary animate-spin" />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Live - Non-blocking floating panel (allows editing while streaming)
  if (status === "live" || status === "paused") {
    return (
      <div className="fixed bottom-4 right-4 z-50">
        <div className="bg-background-secondary border-2 border-purple rounded-xl p-4 w-72 shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded-full ${status === "live" ? "bg-red-500 animate-pulse" : "bg-amber-500"} `} />
              <span className="text-lg font-bold text-text-primary">
                {status === "live" ? "LIVE" : "PAUSED"}
              </span>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-background-tertiary text-text-muted hover:text-text-primary"
              title="Minimize (stream continues)"
            >
              <X size={16} />
            </button>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div className="bg-background-tertiary rounded-lg p-2 text-center">
              <div className="text-lg font-mono text-text-primary">{formattedDuration}</div>
              <div className="text-xs text-text-muted uppercase">Duration</div>
            </div>
            <div className="bg-background-tertiary rounded-lg p-2 text-center">
              <div className="text-lg font-mono text-text-primary">{formattedBitrate}</div>
              <div className="text-xs text-text-muted uppercase">Bitrate</div>
            </div>
          </div>

          {/* Additional stats */}
          {stats && (
            <div className="text-xs text-text-muted mb-3 space-y-0.5">
              <div className="flex justify-between">
                <span>Frames:</span>
                <span>{stats.framesEncoded} / {stats.framesSent}</span>
              </div>
              <div className="flex justify-between">
                <span>Dropped:</span>
                <span>{stats.droppedFrames}</span>
              </div>
            </div>
          )}

          {/* Controls */}
          <div className="flex gap-2">
            {status === "live" ? (
              <>
                <Button variant="outline" size="sm" className="flex-1" onClick={handlePause}>
                  <Pause size={14} className="mr-1" />
                  Pause
                </Button>
                <Button variant="destructive" size="sm" className="flex-1" onClick={handleStop}>
                  <Square size={14} className="mr-1 fill-current" />
                  Stop
                </Button>
              </>
            ) : (
              <>
                <Button variant="default" size="sm" className="flex-1" onClick={handleResume}>
                  <Play size={14} className="mr-1" />
                  Resume
                </Button>
                <Button variant="destructive" size="sm" className="flex-1" onClick={handleStop}>
                  <Square size={14} className="mr-1 fill-current" />
                  Stop
                </Button>
              </>
            )}
          </div>
          
          <div className="mt-2 text-xs text-text-muted text-center">
            You can edit sources while streaming
          </div>
        </div>
      </div>
    );
  }

  return null;
};
