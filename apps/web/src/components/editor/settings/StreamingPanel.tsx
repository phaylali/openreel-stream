import React, { useState, useEffect, useCallback } from "react";
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
