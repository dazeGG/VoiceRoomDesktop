# Voice Room Desktop

Electron desktop shell for Voice Room. It opens the hosted Voice Room web app from `VOICE_ROOM_URL` and provides desktop-only screen capture and window controls.

## Supported platforms

| Platform | Status | Notes |
|----------|--------|-------|
| macOS 12+ (Apple Silicon / Intel) | Supported | Native safe-system audio via ScreenCaptureKit |
| Windows 10+ (x64) | Supported | Native safe-system audio via WASAPI process loopback |
| Linux | Not supported | No builds or native audio helpers for Linux |

CI produces macOS and Windows release artifacts only. Use the browser on unsupported platforms.

## Microphone and speaker devices

The hosted web app lists microphones and speakers through `navigator.mediaDevices`. Until microphone access is granted, Chromium returns placeholder devices with empty `label` and `deviceId`.

Desktop shell behavior:

- grants `media` and `speaker-selection` permissions for the configured Voice Room origin
- on macOS, triggers the system microphone prompt through `systemPreferences.askForMediaAccess('microphone')`
- exposes `window.voiceRoomDesktopAudio.ensureMediaAccess()` for the web app to request macOS access before device enumeration

Recommended web app flow:

```js
if (window.voiceRoomDesktopAudio?.ensureMediaAccess) {
  await window.voiceRoomDesktopAudio.ensureMediaAccess();
}

await navigator.mediaDevices.getUserMedia({ audio: true });
const devices = await navigator.mediaDevices.enumerateDevices();
```

If macOS microphone access was denied earlier, open system settings with:

```js
await window.voiceRoomDesktopAudio.openSettings({ target: 'microphone' });
```

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
// selection.maxHeight contains the native Windows capture height cap:
// low = 720, balanced = 1080, high = 1440.
// The selected source is already staged for the next getDisplayMedia call.
// openPicker always uses safe-system audio with allowEchoFallback: false.
// Use selectSource directly when you need Chromium loopback fallback.
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

## Screen share limits

The desktop shell supports one active screen share flow at a time from this client:

- one pending capture source staged for the next `getDisplayMedia` call
- one active native safe-system audio session

Starting a new share replaces the previous one. Watching other participants' streams is not limited by the desktop shell.

## Auto-update

Packaged builds check GitHub Releases on startup before opening Voice Room.

- if an update is available, the app downloads and installs it before launch
- if the update server is unreachable, the app stays on the launch screen and does not open Voice Room

Development builds started with `npm run electron` skip the update gate.

## Code signing policy

Free code signing for Windows release artifacts is provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

| Role | Members |
|------|---------|
| Authors / Committers | [@dazeGG](https://github.com/dazeGG) |
| Reviewers | [@dazeGG](https://github.com/dazeGG) |
| Approvers | [@dazeGG](https://github.com/dazeGG) |

See [docs/code-signing.md](docs/code-signing.md) for the release signing flow and artifact scope.

## Diagnostics

Packaged builds write local log files through `electron-log` (no remote telemetry).

| Platform | Log file |
|----------|----------|
| macOS | `~/Library/Logs/Voice Room/main.log` |
| Windows | `%APPDATA%\\Voice Room\\logs\\main.log` |

Development builds also print warnings and errors to the terminal.

## Privacy

This desktop shell does not collect or send telemetry on its own.

It only makes network requests to:

- GitHub Releases, to check for and download application updates
- the configured Voice Room URL (`https://voiceroom.ru` in production builds)

The hosted Voice Room web application has its own privacy policy.

## Setup

Create a local `.env`:

```dotenv
VOICE_ROOM_URL=https://voice.example.com
```

## Commands

`npm run preview:picker` opens the picker UI with mock sources only. It does not use the Electron preload bridge, so it is for layout review rather than real screen capture.

```bash
npm run electron
npm run preview:picker
npm run build
npm run build:mac
npm run build:win
npm run check
npm test
```

Build artifacts are written to `dist/`.

Releases are built by GitHub Actions from version tags. See [docs/releasing.md](docs/releasing.md).
