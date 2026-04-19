const { WebSocket } = require('ws');
const { spawn } = require('child_process');

// Test script to verify the streaming pipeline works
// This creates a simple test pattern and streams it to Twitch

const WS_URL = 'ws://localhost:8081';
const TWITCH_STREAM_KEY = process.env.TWITCH_STREAM_KEY || 'live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

console.log('🧪 Testing OpenReel Streaming Pipeline');
console.log('=====================================\n');

// Create WebSocket connection
const ws = new WebSocket(WS_URL);

let ffmpegProcess = null;
let dataCount = 0;

ws.on('open', () => {
  console.log('✓ Connected to streaming server');
  
  // Send start config
  const config = {
    type: 'start',
    data: {
      ingestUrl: 'rtmp://live.twitch.tv/app',
      streamKey: TWITCH_STREAM_KEY,
      quality: '720p',
      bitrate: 4000000,
      width: 1280,
      height: 720,
      fps: 30,
      hasAudio: false,
    }
  };
  
  console.log('→ Sending stream config...');
  ws.send(JSON.stringify(config));
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    console.log('← Server:', msg.type);
    
    if (msg.type === 'started') {
      console.log('✓ Server confirmed stream started');
      console.log('→ Starting FFmpeg directly...\n');
      
      // Start FFmpeg directly to receive data
      const ffmpegArgs = [
        '-hide_banner',
        '-loglevel', 'info',
        '-f', 'webm',
        '-i', '-',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-b:v', '4000k',
        '-maxrate', '4000k',
        '-bufsize', '8000k',
        '-r', '30',
        '-g', '60',
        '-an',
        '-f', 'flv',
        `rtmp://live.twitch.tv/app/${TWITCH_STREAM_KEY}`
      ];
      
      ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
      
      ffmpegProcess.stderr.on('data', (d) => {
        const str = d.toString();
        if (str.includes('frame=') || str.includes('speed=') || str.includes('Error')) {
          console.log('FFmpeg:', str.trim().slice(0, 100));
        }
      });
      
      ffmpegProcess.on('exit', (code) => {
        console.log(`\nFFmpeg exited with code ${code}`);
        ws.close();
        process.exit(0);
      });
      
      // Generate test pattern after 1 second
      setTimeout(() => {
        console.log('→ Generating test WebM data...');
        generateTestData();
      }, 1000);
    }
  } catch (e) {
    // Binary data
    if (ffmpegProcess && ffmpegProcess.stdin && !ffmpegProcess.stdin.destroyed) {
      dataCount++;
      if (dataCount <= 5) {
        console.log(`← Received binary data #${dataCount}: ${data.length} bytes`);
      }
      ffmpegProcess.stdin.write(data);
    }
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
});

ws.on('close', () => {
  console.log('\n✓ Test complete');
  if (ffmpegProcess && !ffmpegProcess.killed) {
    ffmpegProcess.stdin?.end();
    ffmpegProcess.kill('SIGTERM');
  }
});

// Generate test WebM data using FFmpeg
function generateTestData() {
  const testFfmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-f', 'lavfi',
    '-i', 'testsrc=duration=5:size=1280x720:rate=30',
    '-c:v', 'libvpx-vp9',
    '-b:v', '4000k',
    '-deadline', 'realtime',
    '-cpu-used', '8',
    '-f', 'webm',
    '-'
  ]);
  
  let chunkCount = 0;
  
  testFfmpeg.stdout.on('data', (chunk) => {
    chunkCount++;
    if (chunkCount <= 3) {
      console.log(`→ Generated chunk #${chunkCount}: ${chunk.length} bytes`);
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk);
    }
  });
  
  testFfmpeg.on('exit', () => {
    console.log('→ Test data generation complete');
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'stop' }));
      ws.close();
    }, 2000);
  });
}

// Timeout after 30 seconds
setTimeout(() => {
  console.log('\n⏱️ Test timeout reached');
  ws.close();
}, 30000);
