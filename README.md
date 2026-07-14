# Voice Room Desktop

Electron desktop shell for Voice Room. It opens the hosted Voice Room web app from `VOICE_ROOM_URL` and provides desktop-only screen capture and window controls.

## Desktop runtime detection

The preload exposes a stable desktop marker for the hosted web app:

```js
window.voiceRoomDesktop // { isDesktop, isElectron, platform, version }
window.voiceRoomRuntime // same payload, kept for existing integrations
```

It also marks the document before `DOMContentLoaded`:

```css
.is-desktop .home-app {
  display: none;
}
```

Use the CSS hook when the web app needs to hide browser-only UI, such as the desktop download card, without a first-paint flash.

## Global voice hotkeys

The hosted web app can register microphone mute, output mute, and push-to-talk through `window.voiceRoomDesktopHotkeys`. The shell starts its native keyboard listener only while the renderer reports an active voice connection, then unregisters everything on leave, completed document navigation, renderer failure, or app quit. Bindings use DOM physical `KeyboardEvent.code` values, so switching keyboard layouts does not change the assigned key.

```js
const result = await window.voiceRoomDesktopHotkeys.configure({
  active: true,
  configurationId: 1, // increment for every replacement configuration
  bindings: {
    'mic-mute': { code: 'KeyM', ctrlKey: false, metaKey: true, altKey: false, shiftKey: true },
    'output-mute': null,
    'push-to-talk': { code: 'Space', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }
  }
});

const removeListener = window.voiceRoomDesktopHotkeys.onAction(({ action, phase }) => {
  // phase is "pressed" or "released"; push-to-talk uses both.
});
```

The macOS helper uses a passive Core Graphics event tap and the Windows helper uses a non-blocking low-level keyboard hook. Both observe real key-up events without consuming input, so push-to-talk closes even while another application is focused. On first use, macOS may ask for **System Settings → Privacy & Security → Input Monitoring** permission; reconnect to voice after granting it. Rebinding temporarily suspends action delivery, and duplicate chords are rejected deterministically.

The helper is tied to the Electron process through its stdin pipe. Screen lock and system sleep release push-to-talk and stop the listener; registration is restored only after every lock/suspend reason has cleared. This prevents an orphan listener or a lost key-up from leaving the microphone open.

If the native helper is missing or exits, the shell releases push-to-talk immediately and falls back to Electron global shortcuts for the two toggle actions. That fallback requires a modifier for letters, digits, punctuation, and navigation keys; function keys and Print Screen may be used without modifiers. The renderer receives a status update so it stops suppressing its focused-window fallback.

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
// low = 540 (legacy), balanced = 720, high = 1080, source = no shell downscale.
// The selected source is already staged for the next getDisplayMedia call.
// openPicker always uses safe-system audio with allowEchoFallback: false.
// Use selectSource directly when you need Chromium loopback fallback.
```

During an active native capture session, the hosted web app can live-switch capture
quality without restarting the stream:

```js
const result = await window.voiceRoomDesktopCapture.applyProfile({
  qualityId: 'source',
  fpsId: '5'
});
// result.ok === false with reason 'no-active-session' on macOS or browser paths;
// callers should fall back to videoTrack.applyConstraints(...) in that case.
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

### Windows local capture border

Windows may show a local yellow border while a display or window is being captured. This is an OS capture indicator and is not expected to be encoded into the outgoing stream. For video-only screen shares on Windows, the desktop shell uses native DXGI frames directly when the native cursor-correct helper is available, so Chromium does not need to open a temporary WGC video capture that can paint the local border. Chromium loopback-audio requests and native-helper failures still fall back to the regular `getDisplayMedia` path.

That fallback intentionally preserves the exact `MediaStream` object returned by Chromium: desktop audio routing and cleanup are tied to stream identity. The native capture bridge also carries an explicit session protocol version between preload, main, the relay, and the renderer wrapper so future helper/runtime changes fail closed to the Chromium stream instead of silently mixing incompatible capture paths.

Window capture still depends on Windows.Graphics.Capture. The helper requests borderless capture best-effort, but Windows can ignore that request when the OS build or app capability model does not allow it. In that case capture remains functional and the local border is treated as an OS limitation rather than a stream artifact. For diagnostics, set `VOICE_ROOM_CHROMIUM_WGC=0` or `VOICE_ROOM_CHROMIUM_WGC=1` to force the Chromium screen-capturer feature off or on.

## Auto-update

Packaged builds check GitHub Releases on startup before opening Voice Room.

- if an update is available, the app downloads and installs it before launch
- if the update check or download fails, the app checks whether Voice Room itself is reachable
- if Voice Room is reachable, the launch screen shows the update error and an explicit button to enter the app without updating
- if Voice Room is unreachable too, the app stays on the launch screen and shows a site-unavailable error

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
