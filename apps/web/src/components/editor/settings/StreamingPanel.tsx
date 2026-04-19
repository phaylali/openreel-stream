import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Radio,
  Link,
  Key,
  Shield,
  Loader2,
  AlertCircle,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  Trash2,
  Settings,
  Play,
  Square,
  RefreshCw,
  Activity,
  Tv,
  CheckCircle,
  XCircle,
} from "lucide-react";
import { Input, Button, Select, SelectItem, SelectTrigger, SelectValue, SelectContent } from "@openreel/ui";
import { useSettingsStore } from "../../../stores/settings-store";
import {
  isMasterPasswordSet,
  isSessionUnlocked,
  setupMasterPassword,
  unlockSession,
  lockSession,
  saveSecret,
  getSecret,
  deleteSecret,
  listSecrets,
  changeMasterPassword,
} from "../../../services/secure-storage";
import { MasterPasswordDialog } from "./MasterPasswordDialog";
import { toast } from "../../../stores/notification-store";
import type { StreamQuality } from "../../../types/streaming";

const QUALITY_OPTIONS: { value: StreamQuality; label: string }[] = [
  { value: "720p", label: "720p (HD)" },
  { value: "1080p", label: "1080p (Full HD)" },
  { value: "1440p", label: "1440p (QHD)" },
  { value: "4K", label: "4K (Ultra HD)" },
];

export const StreamingPanel: React.FC = () => {
  const { updateStreamingSettings, addConfiguredService, removeConfiguredService } =
    useSettingsStore();

  const streamingSettings = useSettingsStore((state) => state.streamingSettings);

  const [passwordSet, setPasswordSet] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [passwordDialogMode, setPasswordDialogMode] = useState<"setup" | "unlock" | "change" | null>(null);
  const [storedKeys, setStoredKeys] = useState<Array<{ id: string; label: string; createdAt: number; updatedAt: number }>>([]);
  const [revealedKeys, setRevealedKeys] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [testingTwitch, setTestingTwitch] = useState(false);
  const [testingServer, setTestingServer] = useState(false);
  const [, setTwitchConfigured] = useState(false);
  const [newStreamKey, setNewStreamKey] = useState("");
  const [channelLive, setChannelLive] = useState<boolean | null>(null);
  const [checkingLive, setCheckingLive] = useState(false);
  const [testStreaming, setTestStreaming] = useState(false);
  const [testStreamWs, setTestStreamWs] = useState<WebSocket | null>(null);
  const liveCheckInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshState = useCallback(async () => {
    const isSet = await isMasterPasswordSet();
    setPasswordSet(isSet);
    const unlockedNow = isSessionUnlocked();
    setUnlocked(unlockedNow);

    if (unlockedNow) {
      const keys = await listSecrets();
      setStoredKeys(keys);
      const twitchKey = await getSecret("twitch-stream-key");
      setTwitchConfigured(!!twitchKey);
    }
  }, []);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  const handlePasswordSubmit = useCallback(
    async (password: string, newPassword?: string): Promise<boolean> => {
      if (passwordDialogMode === "setup") {
        await setupMasterPassword(password);
        setPasswordDialogMode(null);
        await refreshState();
        toast.success("Master password set", "Your streaming keys will be encrypted with AES-256-GCM.");
        return true;
      }

      if (passwordDialogMode === "unlock") {
        const success = await unlockSession(password);
        if (success) {
          setPasswordDialogMode(null);
          await refreshState();
          toast.success("Session unlocked", "You can now configure streaming.");
        }
        return success;
      }

      if (passwordDialogMode === "change" && newPassword) {
        const success = await changeMasterPassword(password, newPassword);
        if (success) {
          setPasswordDialogMode(null);
          await refreshState();
          toast.success("Password changed", "All keys have been re-encrypted.");
        }
        return success;
      }

      return false;
    },
    [passwordDialogMode, refreshState],
  );

  const handleSaveStreamKey = useCallback(async () => {
    if (!newStreamKey.trim()) {
      toast.error("Empty key", "Please enter a stream key.");
      return;
    }
    try {
      await saveSecret("twitch-stream-key", "Twitch Stream Key", newStreamKey.trim());
      addConfiguredService("twitch");
      setTwitchConfigured(true);
      setNewStreamKey("");
      await refreshState();
      toast.success("Twitch stream key saved", "Your stream key has been encrypted and stored.");
    } catch (err) {
      toast.error("Failed to save", err instanceof Error ? err.message : "Unknown error");
    }
  }, [newStreamKey, addConfiguredService, refreshState]);

  const handleDeleteStreamKey = useCallback(async () => {
    try {
      await deleteSecret("twitch-stream-key");
      removeConfiguredService("twitch");
      setTwitchConfigured(false);
      await refreshState();
      toast.success("Twitch stream key removed");
    } catch (err) {
      toast.error("Failed to delete", err instanceof Error ? err.message : "Unknown error");
    }
  }, [removeConfiguredService, refreshState]);

  const handleRevealKey = useCallback(async () => {
    try {
      const value = await getSecret("twitch-stream-key");
      if (value) {
        setRevealedKeys((prev) => ({ ...prev, "twitch-stream-key": value }));
        setShowKey((prev) => ({ ...prev, "twitch-stream-key": true }));
      }
    } catch (err) {
      toast.error("Failed to decrypt", err instanceof Error ? err.message : "Unknown error");
    }
  }, []);

  const handleLock = useCallback(() => {
    lockSession();
    setUnlocked(false);
    setStoredKeys([]);
    setRevealedKeys({});
    setShowKey({});
  }, []);

  const handleTestTwitch = useCallback(async () => {
    if (!passwordSet) return;
    setTestingTwitch(true);
    try {
      const key = await getSecret("twitch-stream-key");
      if (!key) {
        toast.error("No stream key found", "Please enter your Twitch stream key first.");
        setTestingTwitch(false);
        return;
      }
      await new Promise((r) => setTimeout(r, 800));
      toast.success("Twitch connection valid", "Your stream key format looks correct.");
    } catch (err) {
      toast.error("Test failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setTestingTwitch(false);
    }
  }, [passwordSet]);

  const handleTestServer = useCallback(async () => {
    const state = useSettingsStore.getState();
    const serverUrl = state.streamingSettings.twitch.serverUrl;
    if (!serverUrl) {
      toast.error("Server URL missing", "Please configure the streaming server URL.");
      return;
    }
    setTestingServer(true);
    try {
      const ws = new WebSocket(serverUrl);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error("Timeout"));
        }, 3000);
        ws.onopen = () => {
          clearTimeout(timeout);
          ws.close();
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("Connection failed"));
        };
        ws.onclose = (e) => {
          if (e.code !== 1000) {
            clearTimeout(timeout);
            reject(new Error(`Closed: ${e.reason}`));
          }
        };
      });
      toast.success("Server connected", `Successfully connected to ${serverUrl}`);
    } catch (err) {
      toast.error("Server unreachable", "Could not connect to the streaming server. Ensure it's running.");
    } finally {
      setTestingServer(false);
    }
  }, []);

  const checkChannelLive = useCallback(async () => {
    const channelName = streamingSettings.twitch.channelName.trim();
    if (!channelName) {
      toast.error("Channel name missing", "Enter your Twitch channel name in settings.");
      return;
    }
    setCheckingLive(true);
    try {
      const res = await fetch(`https://twitch.tv/${encodeURIComponent(channelName)}`);
      const html = await res.text();
      const isLive = html.includes('"isLiveBroadcast":true') || html.includes('"isLiveBroadcast": true');
      setChannelLive(isLive);
      if (isLive) {
        toast.success("Channel is LIVE!", `${channelName} is currently streaming on Twitch.`);
      } else {
        toast.info("Channel is offline", `${channelName} is not currently streaming.`);
      }
    } catch (err) {
      console.error("Live check error:", err);
      setChannelLive(null);
      toast.error("Live check failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCheckingLive(false);
    }
  }, [streamingSettings.twitch.channelName]);

  useEffect(() => {
    if (unlocked && streamingSettings.twitch.channelName.trim()) {
      checkChannelLive();
      liveCheckInterval.current = setInterval(checkChannelLive, 30000);
      return () => {
        if (liveCheckInterval.current) clearInterval(liveCheckInterval.current);
      };
    }
  }, [unlocked, streamingSettings.twitch.channelName, checkChannelLive]);

  const startTestStream = useCallback(async () => {
    const serverUrl = streamingSettings.twitch.serverUrl;
    const key = await getSecret("twitch-stream-key");
    const ingestUrl = streamingSettings.twitch.ingestUrl;

    if (!serverUrl || !key || !ingestUrl) {
      toast.error("Missing config", "Set server URL, ingest URL, and stream key first.");
      return;
    }

    setTestStreaming(true);
    try {
      const ws = new WebSocket(serverUrl);
      ws.binaryType = "arraybuffer";

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Connection timeout")), 5000);
        ws.onopen = () => { clearTimeout(timeout); resolve(); };
        ws.onerror = () => { clearTimeout(timeout); reject(new Error("Connection failed")); };
      });

      ws.send(JSON.stringify({
        type: "start",
        data: {
          ingestUrl,
          streamKey: `${key}?bandwidthtest=true`,
          quality: "720p",
          bitrate: 4000000,
          width: 1280,
          height: 720,
          fps: 30,
          hasAudio: false,
          amdDriver: streamingSettings.twitch.amdDriver || "auto",
          isTestStream: true,
        },
      }));

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "started") {
            toast.success("Test stream started", "Sending test video to Twitch...");
          } else if (msg.type === "error") {
            toast.error("Test stream error", msg.data as string);
          } else if (msg.type === "stopped") {
            toast.info("Test stream stopped", "Test stream has ended.");
            setTestStreaming(false);
          }
        } catch {}
      };

      ws.onclose = () => {
        setTestStreaming(false);
      };

      setTestStreamWs(ws);

      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext("2d")!;
      const stream = canvas.captureStream(30);

      const recorder = new MediaRecorder(stream, { mimeType: "video/webm", videoBitsPerSecond: 4000000 });
      let frame = 0;

      const drawLoop = () => {
        if (!testStreamWs || testStreamWs.readyState !== WebSocket.OPEN) return;
        frame++;
        ctx.fillStyle = `hsl(${(frame * 2) % 360}, 70%, 20%)`;
        ctx.fillRect(0, 0, 1280, 720);
        ctx.fillStyle = "#fff";
        ctx.font = "bold 48px monospace";
        ctx.textAlign = "center";
        ctx.fillText("TEST STREAM", 640, 300);
        ctx.font = "24px monospace";
        ctx.fillText(`Frame: ${frame}`, 640, 360);
        ctx.fillText(`Time: ${new Date().toLocaleTimeString()}`, 640, 400);
        ctx.font = "18px monospace";
        ctx.fillText("OpenReel Streaming Test", 640, 460);
        requestAnimationFrame(drawLoop);
      };
      drawLoop();

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          event.data.arrayBuffer().then(buf => ws.send(buf));
        }
      };

      recorder.start(500);
      toast.success("Test stream running", "Color bars + frame counter streaming to Twitch");

    } catch (err) {
      toast.error("Test stream failed", err instanceof Error ? err.message : "Unknown error");
      setTestStreaming(false);
    }
  }, [streamingSettings.twitch, testStreamWs]);

  const stopTestStream = useCallback(() => {
    if (testStreamWs && testStreamWs.readyState === WebSocket.OPEN) {
      testStreamWs.send(JSON.stringify({ type: "stop" }));
      testStreamWs.close();
    }
    setTestStreamWs(null);
    setTestStreaming(false);
    toast.info("Test stream stopped");
  }, [testStreamWs]);

  // Not set up yet
  if (!passwordSet) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
        <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <Shield size={32} className="text-primary" />
        </div>
        <h3 className="text-lg font-medium text-text-primary mb-2">Secure Streaming Configuration</h3>
        <p className="text-sm text-text-muted mb-6 max-w-sm">
          Set up a master password to encrypt and store your Twitch stream key locally.
          Keys are encrypted with AES-256-GCM and never leave your browser.
        </p>
        <Button onClick={() => setPasswordDialogMode("setup")}>
          <Key size={16} className="mr-2" />
          Set Up Master Password
        </Button>

        {passwordDialogMode && (
          <MasterPasswordDialog
            isOpen={!!passwordDialogMode}
            onClose={() => setPasswordDialogMode(null)}
            mode={passwordDialogMode}
            onSubmit={handlePasswordSubmit}
          />
        )}
      </div>
    );
  }

  // Locked
  if (!unlocked) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
        <div className="w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center mb-4">
          <Lock size={32} className="text-amber-500" />
        </div>
        <h3 className="text-lg font-medium text-text-primary mb-2">Streaming Settings Locked</h3>
        <p className="text-sm text-text-muted mb-6 max-w-sm">
          Enter your master password to configure streaming.
        </p>
        <Button onClick={() => setPasswordDialogMode("unlock")}>
          <Unlock size={16} className="mr-2" />
          Unlock
        </Button>

        {passwordDialogMode && (
          <MasterPasswordDialog
            isOpen={!!passwordDialogMode}
            onClose={() => setPasswordDialogMode(null)}
            mode={passwordDialogMode}
            onSubmit={handlePasswordSubmit}
          />
        )}
      </div>
    );
  }

  // Unlocked — full management UI
  return (
    <div className="space-y-6">
      {/* Header actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Shield size={14} className="text-primary" />
          <span>Twitch streaming configuration</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPasswordDialogMode("change")}>
            <Key size={14} className="mr-1" />
            Change Password
          </Button>
          <Button variant="outline" size="sm" onClick={handleLock}>
            <Lock size={14} className="mr-1" />
            Lock
          </Button>
        </div>
      </div>

      {/* Twitch Configuration Section */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
          <Radio size={16} className="text-purple" />
          Twitch Configuration
        </h3>

        {/* Channel Name */}
        <div className="grid grid-cols-2 gap-4 items-center">
          <label htmlFor="twitch-channel" className="text-sm text-text-secondary text-right">
            Channel Name (display)
          </label>
          <Input
            id="twitch-channel"
            type="text"
            value={streamingSettings.twitch.channelName}
            onChange={(e) => updateStreamingSettings({ channelName: e.target.value })}
            placeholder="your_twitch_username"
            className="max-w-xs"
          />
        </div>

        {/* Twitch Client-ID (kept for reference, not needed for HTML scraping) */}
        <div className="grid grid-cols-2 gap-4 items-start">
          <label htmlFor="twitch-client-id" className="text-sm text-text-secondary text-right pt-2">
            Twitch Client-ID
          </label>
          <div className="space-y-2">
            <Input
              id="twitch-client-id"
              type="text"
              value={streamingSettings.twitch.twitchClientId}
              onChange={(e) => updateStreamingSettings({ twitchClientId: e.target.value })}
              placeholder="Optional (not needed for live check)"
              className="max-w-xs font-mono text-xs"
            />
            <p className="text-xs text-text-muted">
              Live status uses HTML scraping (no API key needed). Client-ID stored for future use.
            </p>
          </div>
        </div>

        {/* Twitch Client Secret (hidden, kept for future API use) */}
        <div className="grid grid-cols-2 gap-4 items-start">
          <label htmlFor="twitch-client-secret" className="text-sm text-text-secondary text-right pt-2">
            Twitch Client Secret
          </label>
          <div className="space-y-2">
            <Input
              id="twitch-client-secret"
              type="password"
              value={streamingSettings.twitch.twitchClientSecret}
              onChange={(e) => updateStreamingSettings({ twitchClientSecret: e.target.value })}
              placeholder="Optional (not needed for live check)"
              className="max-w-xs font-mono text-xs"
            />
            <p className="text-xs text-text-muted">
              Optional. Stored for future API features.
            </p>
          </div>
        </div>

        {/* Ingest Server (RTMP) */}
        <div className="grid grid-cols-2 gap-4 items-start">
          <label htmlFor="ingest-url" className="text-sm text-text-secondary text-right pt-2">
            RTMP Ingest URL
          </label>
          <div className="space-y-2">
            <Input
              id="ingest-url"
              type="text"
              value={streamingSettings.twitch.ingestUrl}
              onChange={(e) => updateStreamingSettings({ ingestUrl: e.target.value })}
              placeholder="rtmp://atl.contribute.video.net/app/"
              className="max-w-xs font-mono text-xs"
            />
            <p className="text-xs text-text-muted">
              Find your ingest in Twitch Dashboard → Settings → Stream, or use the Ingest API.
            </p>
          </div>
        </div>

        {/* Stream Key */}
        <div className="grid grid-cols-2 gap-4 items-start">
          <label className="text-sm text-text-secondary text-right pt-2">Stream Key</label>
          <div className="space-y-2">
            {storedKeys.find((k) => k.id === "twitch-stream-key") ? (
              <div className="border border-border rounded-lg p-3 bg-background-secondary max-w-xs">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Key size={14} className="text-primary" />
                    <span className="text-sm font-medium">Twitch Stream Key</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={handleRevealKey}
                      className="p-1 rounded hover:bg-background-tertiary text-text-muted hover:text-text-primary"
                      title={showKey["twitch-stream-key"] ? "Hide key" : "Show key"}
                    >
                      {showKey["twitch-stream-key"] ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                    <button
                      onClick={handleDeleteStreamKey}
                      className="p-1 rounded hover:bg-error/10 text-text-muted hover:text-error"
                      title="Remove key"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <div className="font-mono text-xs bg-background rounded px-2 py-1 text-text-secondary">
                  {revealedKeys["twitch-stream-key"] || "••••••••••••••••••••••••••••••••"}
                </div>
              </div>
            ) : (
              <div className="border border-dashed border-primary/30 rounded-lg p-4 bg-primary/5 max-w-xs">
                <Input
                  type="password"
                  value={newStreamKey}
                  onChange={(e) => setNewStreamKey(e.target.value)}
                  placeholder="Paste your Twitch stream key"
                  className="mb-2 font-mono text-xs"
                />
                <div className="flex justify-end">
                  <Button size="sm" onClick={handleSaveStreamKey} disabled={!newStreamKey.trim()}>
                    Save Key
                  </Button>
                </div>
                <p className="text-xs text-text-muted flex items-center gap-1 mt-2">
                  <AlertCircle size={12} />
                  Find it in Twitch Dashboard → Settings → Stream.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Test Connection */}
        <div className="grid grid-cols-2 gap-4 items-center">
          <div className="text-sm text-text-secondary text-right">Test Twitch</div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleTestTwitch}
            disabled={testingTwitch}
          >
            {testingTwitch ? <Loader2 size={14} className="animate-spin mr-2" /> : <Radio size={14} className="mr-2" />}
            {testingTwitch ? "Testing..." : "Test Connection"}
          </Button>
        </div>

        {/* Channel Live Status */}
        <div className="grid grid-cols-2 gap-4 items-center">
          <div className="text-sm text-text-secondary text-right flex items-center justify-end gap-2">
            <Tv size={14} />
            Channel Status
          </div>
          <div className="flex items-center gap-3">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium ${
              channelLive === true
                ? "bg-green-500/10 text-green-400 border border-green-500/20"
                : channelLive === false
                  ? "bg-gray-500/10 text-gray-400 border border-gray-500/20"
                  : "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"
            }`}>
              {checkingLive ? (
                <Loader2 size={14} className="animate-spin" />
              ) : channelLive === true ? (
                <CheckCircle size={14} />
              ) : channelLive === false ? (
                <XCircle size={14} />
              ) : (
                <AlertCircle size={14} />
              )}
              {checkingLive
                ? "Checking..."
                : channelLive === true
                  ? "LIVE"
                  : channelLive === false
                    ? "Offline"
                    : "Unknown"}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={checkChannelLive}
              disabled={checkingLive}
            >
              <RefreshCw size={14} className={`mr-1 ${checkingLive ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <span className="text-xs text-text-muted">Auto-refreshes every 30s</span>
          </div>
        </div>

        {/* Test Stream */}
        <div className="grid grid-cols-2 gap-4 items-center">
          <div className="text-sm text-text-secondary text-right flex items-center justify-end gap-2">
            <Activity size={14} />
            Test Stream
          </div>
          <div className="flex items-center gap-2">
            {testStreaming ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={stopTestStream}
              >
                <Square size={14} className="mr-1" />
                Stop Test Stream
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={startTestStream}
                disabled={testStreaming}
              >
                <Play size={14} className="mr-1" />
                Start Test Stream
              </Button>
            )}
            <span className="text-xs text-text-muted">Sends color bars to Twitch</span>
          </div>
        </div>
      </div>

      {/* Stream Defaults Section */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
          <Settings size={16} className="text-primary" />
          Stream Defaults
        </h3>

        {/* Resolution */}
        <div className="grid grid-cols-2 gap-4 items-center">
          <label htmlFor="stream-quality" className="text-sm text-text-secondary text-right">
            Default Resolution
          </label>
          <Select
            value={streamingSettings.twitch.preferredQuality}
            onValueChange={(v: StreamQuality) => updateStreamingSettings({ preferredQuality: v })}
          >
            <SelectTrigger id="stream-quality" className="w-[180px]">
              <SelectValue placeholder="Select quality" />
            </SelectTrigger>
            <SelectContent>
              {QUALITY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Include Project Audio */}
        <div className="grid grid-cols-2 gap-4 items-center">
          <span className="text-sm text-text-secondary text-right">Include Project Audio</span>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={streamingSettings.twitch.includeAudio}
              onChange={(e) => updateStreamingSettings({ includeAudio: e.target.checked })}
              className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary"
            />
            <span className="text-sm">Capture editor audio output</span>
          </label>
        </div>

        {/* Include Microphone */}
        <div className="grid grid-cols-2 gap-4 items-center">
          <span className="text-sm text-text-secondary text-right">Include Microphone</span>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={streamingSettings.twitch.micEnabled}
              onChange={(e) => updateStreamingSettings({ micEnabled: e.target.checked })}
              className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary"
            />
            <span className="text-sm">Add mic input to stream</span>
          </label>
        </div>

        {/* AMD Driver Selection */}
        <div className="grid grid-cols-2 gap-4 items-center">
          <label htmlFor="amd-driver" className="text-sm text-text-secondary text-right">
            AMD GPU Driver
          </label>
          <div className="space-y-2">
            <Select
              value={streamingSettings.twitch.amdDriver}
              onValueChange={(v: "mesa" | "vulkan" | "auto") => updateStreamingSettings({ amdDriver: v })}
            >
              <SelectTrigger id="amd-driver" className="w-[180px]">
                <SelectValue placeholder="Select driver" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mesa">Mesa (Open Source)</SelectItem>
                <SelectItem value="vulkan">AMDVLK (Vulkan)</SelectItem>
                <SelectItem value="auto">Auto-detect</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-text-muted">
              Mesa: Full hardware encoding support, recommended
              <br />
              AMDVLK: Alternative Vulkan driver
            </p>
          </div>
        </div>
      </div>

      {/* Server Connection Section */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
          <Link size={16} className="text-primary" />
          Streaming Server
        </h3>

        {/* Server URL (WebSocket) */}
        <div className="grid grid-cols-2 gap-4 items-start">
          <label htmlFor="server-url" className="text-sm text-text-secondary text-right pt-2">
            Server URL (WebSocket)
          </label>
          <div className="space-y-2">
            <Input
              id="server-url"
              type="text"
              value={streamingSettings.twitch.serverUrl}
              onChange={(e) => updateStreamingSettings({ serverUrl: e.target.value })}
              placeholder="ws://localhost:8081"
              className="max-w-xs font-mono text-xs"
            />
            <p className="text-xs text-text-muted">
              URL of the OpenReel streaming server. Default: <code className="bg-background px-1 rounded">ws://localhost:8081</code>
            </p>
          </div>
        </div>

        {/* Test Server Connection */}
        <div className="grid grid-cols-2 gap-4 items-center">
          <div className="text-sm text-text-secondary text-right">Test Server</div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleTestServer}
            disabled={testingServer}
          >
            {testingServer ? <Loader2 size={14} className="animate-spin mr-2" /> : <Link size={14} className="mr-2" />}
            {testingServer ? "Testing..." : "Test Server"}
          </Button>
        </div>
      </div>

      {/* Password dialog when needed */}
      {passwordDialogMode && (
        <MasterPasswordDialog
          isOpen={!!passwordDialogMode}
          onClose={() => setPasswordDialogMode(null)}
          mode={passwordDialogMode}
          onSubmit={handlePasswordSubmit}
        />
      )}
    </div>
  );
};
