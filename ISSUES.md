# Streaming Issues

## Current Problems

### 1. Video Encoder Creation Error
- **Error**: `Encoder creation error` or `The provided resolution (1280x720) has a coded area (1280*720=921600) which exceeds the maximum coded area (414720) supported by the AVC level (3.0)`
- **Cause**: Codec string `avc1.42E01E` specifies AVC Level 3.0 which has a max coded area of 414720 pixels. 1280x720 = 921600 pixels exceeds this limit.
- **Solution**: Use codec `avc1.42001E` which specifies Level 3.1 (supports up to 1280x720)

### 2. Audio Channel Count Error
- **Error**: `Unsupported channel count; expected range from 1 to 32, received 0`
- **Cause**: When combining project audio and microphone, one of the tracks may have 0 channels in its settings
- **Solution**: Default to 2 channels when channelCount is 0 or undefined

### 3. First Frame Not a Keyframe
- **Issue**: Twitch requires an IDR (keyframe) frame immediately to start playing the stream
- **Solution**: Force first frame to be a keyframe (`framesEncoded === 0`)

### 4. FFmpeg stdin vs FIFO
- **Issue**: Original code wrote to FFmpeg stdin which doesn't work properly for RTMP streaming
- **Solution**: Use named pipes (FIFOs) - FFmpeg reads from FIFO, client writes to FIFO

### 5. FFmpeg Re-encoding
- **Issue**: Server receives H.264 from WebCodecs but re-encodes with libx264
- **Note**: This is intentional for now as passthrough requires more complex handling

### 6. Audio Encoder Closes Prematurely
- **Error**: `Failed to execute 'encode' on 'AudioEncoder': Cannot call 'encode' on a closed codec`
- **Cause**: Audio encoder closes when one track ends but the other is still sending data
- **Status**: Needs investigation

---

## Fixed Issues

- [x] Video codec Level 3.0 vs 3.1 support
- [x] FIFO creation using mkfifo instead of fs.mkSync
- [x] Cleanup function failing with "Invalid argument '.'"
- [x] Keyframe not sent on first frame
- [x] Audio channel count default when 0
- [x] Start.sh not building streaming server properly
- [x] **RTMP URL double-slash bug** — ingestUrl had trailing slash causing `rtmp://live.twitch.tv/app//live_KEY` (invalid). Fixed with `buildRtmpUrl()` that strips trailing slashes.
- [x] **Race condition: client goes LIVE before server is ready** — client was setting status=`"live"` and sending frames before the server had opened FIFO write streams or started FFmpeg. Fixed: client now awaits `{ type: "started" }` from server before sending any frames.
- [x] **Race condition: FFmpeg spawned before FIFO write-end was open** — server created FFmpeg first (which blocks on FIFO read), then opened write streams. Fixed: write streams open first, small 50ms delay, then FFmpeg spawns.
- [x] **Double `framesEncoded` increment** — counter was incremented in both the VideoEncoder `output` callback and the encode loop, causing keyframe decisions to be wrong. Fixed with a separate `localFrameCount` for encode-loop scheduling.

---

## Logs to Check

### Browser Console (F12)
Look for:
- `[Streaming] Video encoder error:`
- `[Streaming] Audio encoder error:`
- `[Streaming] Wrote video to FIFO:`
- `[Streaming] Server confirmed stream started` ← must appear before LIVE

### Server Terminal
Look for:
- `[Server] Binary data received, length: ... type: video`
- `[Server] Wrote video to FIFO: ... bytes`
- `FFmpeg:` logs showing RTMP connection status
- `FFmpeg: ... Connection to rtmp://` ← confirms FFmpeg reached Twitch