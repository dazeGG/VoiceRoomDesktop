# Voice Room Desktop

Electron desktop shell for Voice Room. It opens the hosted Voice Room web app from `VOICE_ROOM_URL` and provides desktop-only screen capture and window controls.

## Desktop stream audio

The desktop shell exposes one UI-level audio intent for screen sharing: `Звук стрима`.

The hosted web app can read desktop capabilities with:

```js
const capabilities = await window.voiceRoomDesktopAudio?.getCapabilities();
```

When the user starts screen sharing, pass the toggle state to source selection:

```js
await window.voiceRoomDesktopCapture.selectSource(sourceId, {
  enabled: streamAudioEnabled,
  mode: 'safe-system',
  allowEchoFallback: true
});
```

The preferred desktop path is to let the shell own source selection:

```js
const selection = await window.voiceRoomDesktopCapture.openPicker({
  fpsId: '30',
  qualityId: 'balanced',
  streamAudioEnabled: true
});

// selection.profileId contains the chosen quality/FPS profile.
// The selected source is already staged for the next getDisplayMedia call.
```

`safe-system` is the Discord-like intent: capture system audio while excluding Voice Room playback. The Electron shell builds native helpers for this path:

- macOS: ScreenCaptureKit audio with `excludesCurrentProcessAudio`.
- Windows: WASAPI process loopback with the Voice Room process tree excluded.

When `capabilities.nativeSafeLoopback` is true, the hosted web app should start native audio and bridge the returned Float32 PCM into the screen-share audio track:

```js
const audioSession = await window.voiceRoomDesktopAudio.startSafeSystem({
  mode: 'safe-system'
});

const removeEventListener = window.voiceRoomDesktopAudio.onEvent(({ sessionId, event }) => {
  if (sessionId !== audioSession.sessionId) return;
  if (event.event === 'format') {
    // event.sampleRate, event.channels, event.sampleFormat === 'f32le'
  }
});

const removeDataListener = window.voiceRoomDesktopAudio.onData(({ sessionId, chunk }) => {
  if (sessionId !== audioSession.sessionId) return;
  // chunk contains interleaved Float32 little-endian PCM.
});
```

The web app is still responsible for converting these PCM chunks into a `MediaStreamTrack` (for example via `AudioWorklet` + `MediaStreamAudioDestinationNode`) and publishing that track as LiveKit screen audio. If the helper is unavailable, the shell can fall back to Chromium loopback when `allowEchoFallback` is enabled.

## Setup

Create a local `.env`:

```dotenv
VOICE_ROOM_URL=https://voice.example.com
```

## Commands

```bash
npm run electron
npm run build
npm run build:mac
npm run build:win
npm run check
```

Build artifacts are written to `dist/`.

Releases are built by GitHub Actions from version tags. See [docs/releasing.md](docs/releasing.md).
