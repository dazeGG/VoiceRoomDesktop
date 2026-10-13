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

## Keep the display awake in voice

While the renderer reports an active voice connection through `voiceRoomDesktopHotkeys.configure({ active: true })`, the shell holds a `prevent-display-sleep` power blocker, so the screen does not dim or turn off while you talk, stream, or watch a stream. The blocker is released when voice ends (`active: false`, navigation, renderer failure, quit) and while the screen is locked. No extra web API is needed.

## Background throttling outside voice

During a call (voice reported through `voiceRoomDesktopHotkeys.configure({ active: true })` or `voiceRoomDesktopCall.setState({ active: true })`) the main window runs its timers at full speed even when it is hidden in the tray or behind a game, so meters, the realtime heartbeat and the overlay keep working. In that state Chromium also reports the page as visible. Outside a call a hidden window is throttled like a background browser tab: the page sees `document.visibilityState === 'hidden'`, `requestAnimationFrame` stops and timers run about once a second. Measured on Electron 41 and 44: an unthrottled hidden window kept running `requestAnimationFrame` at the monitor rate (240 times a second on a 240 Hz display).

- On Electron 44 both switches take effect at once, even while the window is hidden. A call that starts from the tray is never held back, and one that ends there stops costing right away. Electron 41 applied "throttling allowed" only on the next hide.
- `IntensiveWakeUpThrottling` is disabled. Without that, Chromium cuts a page that has been hidden for 5 minutes to one timer a minute, which would starve the 15 s realtime heartbeat.

## System events and game mode

The hosted web app receives system events through `window.voiceRoomDesktopSystem`:

```js
const { gameMode, windowVisible } = await window.voiceRoomDesktopSystem.getState();
const stopState = window.voiceRoomDesktopSystem.onState(({ gameMode, windowVisible }) => {});
const stopWake = window.voiceRoomDesktopSystem.onWake(({ reason }) => {}); // 'resume' | 'unlock-screen'
```

- **Game mode** works like Discord's. It is on during a call while a detected game is on screen and the Voice Room window is not in front. It comes from the overlay's game detection, so it needs the overlay setting on (Windows). The web app pauses looping animations, which nobody sees then. They resume as soon as the window is focused.
- **windowVisible** is `false` while the main window is hidden in the tray or minimized. During a call the page reads as visible even then, so this is the only way it can tell. The web app stops receiving remote video (cameras and screens) while nobody can see it, and keeps voices and stream audio. It does not see a window covered by a game; that is game mode.
- **Wake** fires after sleep and after unlocking the screen. During a call the page reads as visible, so it never gets a `visibilitychange` there. This tells the web app to check its realtime socket at once, instead of waiting out the heartbeat timeout.
- Only the configured Voice Room page receives these events. A shell older than this contract has no `voiceRoomDesktopSystem`, so the web app must feature-detect it.

## Autostart

The hosted web app renders desktop-only autostart switches through `window.voiceRoomDesktopAutostart`:

```js
const settings = await window.voiceRoomDesktopAutostart.getSettings();
// { supported: true, openAtLogin: false, startMinimized: false }

await window.voiceRoomDesktopAutostart.setSettings({ openAtLogin: true, startMinimized: true });
```

- `openAtLogin` registers a login item: the `HKCU\...\Run` entry on Windows (the original executable for portable builds), a login item on macOS. On Windows it reads as `false` when the entry is disabled in Task Manager, and enabling it again re-enables the entry.
- `startMinimized` starts the login launch hidden: in the tray on Windows (via the `--hidden` argument), without a window on macOS (click the Dock icon to open it). The preference is kept in `desktop-settings.json` in the user data folder, so it can be set while autostart is off.
- Development builds report `{ supported: false, reason: 'unsupported' }`.

A hidden launch skips the update splash (see below) and retries loading Voice Room in the background every 30 seconds until the network is up, instead of showing an error dialog at login.

## Taskbar badge and attention

The hosted web app can mirror unread activity on the app icon and ask for attention while the window is in the background through `window.voiceRoomDesktopAttention`:

```js
await window.voiceRoomDesktopAttention.setBadgeCount(3); // 0 clears the badge

const result = await window.voiceRoomDesktopAttention.requestAttention({ critical: false });
// { ok: true, requested: false } when the window is already focused
```

- macOS: `setBadgeCount` shows the number on the Dock icon. `requestAttention` bounces the Dock icon once, or until the app is activated when `critical: true`.
- Windows: `setBadgeCount` shows a red dot over the taskbar button (the count is exposed as its accessible description) and re-applies it when the window returns from the tray. `requestAttention` flashes the taskbar button until the window is focused. A window hidden to the tray has no taskbar button, so `requestAttention` returns `{ ok: false, reason: 'window-hidden' }`; show a desktop notification instead.

The web app owns the count: send the current value whenever it changes, including `0` once everything is read and again after a page reload. Counts are floored and capped at 9999; anything that is not a finite number clears the badge.

## App icon follows the web theme

Each colour theme of the web app has its own app icon (same logo, the theme's accent). The web app reports its theme through `window.voiceRoomDesktopAppIcon`; the shell swaps the icon and remembers it:

```js
await window.voiceRoomDesktopAppIcon.setTheme('graphite-ice');
// { supported: true, theme: 'graphite-ice' }

const state = await window.voiceRoomDesktopAppIcon.getTheme();
// { supported: true, theme: 'graphite-ice' }
```

| Theme id | Accent | Icon |
| --- | --- | --- |
| `graphite-volt` (default) | lime | the installed icon (`assets/logo/icon.*`) |
| `graphite-ice` | cyan | `assets/logo/themes/graphite-ice.*` |
| `graphite-coral` | coral | `assets/logo/themes/graphite-coral.*` |

- Contract: the web app owns the theme. Call `setTheme(id)` on every start and on every change, with the id it stores in `data-theme`; the shell does not poll. Calling it again with the current theme is a no-op. An id the shell does not know returns `{ supported: true, theme: <current>, reason: 'unknown-theme' }` and changes nothing, so a theme the web app adds later keeps the last known icon until the desktop shell ships its icon. New themes are added in `electron/app-icon.js` and rendered with `npm run icons:call`.
- Windows: the window / taskbar button icon, the tray icon and the tray "in call" badge change. macOS: the Dock icon changes. Linux reports `{ supported: false, reason: 'unsupported' }`.
- The last reported theme is kept in `desktop-settings.json`, so the next launch (including a hidden autostart) shows it before the web app has loaded.
- The executable, the installer, a pinned taskbar shortcut and the macOS app bundle icon are baked in at build time and stay the default icon.
- Web apps older than this contract never call it and keep the default icon; a shell older than this contract has no `voiceRoomDesktopAppIcon`, so the web app must feature-detect it.

## Notifications

The hosted web app shows native notifications through `window.voiceRoomDesktopNotifications`:

```js
await window.voiceRoomDesktopNotifications.show({
  title: 'Alice',
  body: 'Привет!',
  tag: 'dm:user-1',        // optional
  route: '/?dm=user-1'     // optional
});
// { ok: true } | { ok: false, reason }
```

- Notifications are silent: the web app plays its own sound.
- macOS: unsigned builds cannot show native notifications on Electron 42+, so `show()` answers `{ ok: false, reason: 'failed' }` there until the app is code-signed.
- A notification with the same `tag` as one still shown replaces it, and the old one is also removed from the Windows Action Center / macOS Notification Center.
- Clicking a notification with a `route` opens it like a link (see below): `/?dm=<userId>`, `/?room=<roomId>&message=<messageId>` or `/r/<roomId>`. Any other route, or none, only brings the window to the front.

## Context menu and spellcheck

Right-clicking where the page has no menu of its own shows a native menu: spelling suggestions and "Добавить в словарь" on a misspelled word, "Вырезать / Копировать / Вставить / Выделить всё" in text fields, "Копировать" for selected text, "Копировать ссылку" on web links and "Копировать изображение" on images. Menus that the web app opens itself take precedence.

On Windows the spellchecker checks Russian and English in addition to the OS language. macOS uses the system spellchecker and its languages.

## Links (`voiceroom://`)

Release builds register the `voiceroom://` scheme; development and unpackaged builds use `voiceroom-dev://`, so they never capture production links.

| Link | Opens |
|------|-------|
| `voiceroom://r/<roomId>` | `/r/<roomId>` (joins voice) |
| `voiceroom://?room=<roomId>&message=<messageId>` | the mention preview, without joining voice |
| `voiceroom://?dm=<userId>` | the direct message thread |
| `voiceroom://` | just the window |

Anything else only brings the window to the front.

- The NSIS installer registers the scheme for the current user (`build/installer.nsh`, removed again on uninstall) and the macOS app bundle declares it in `Info.plist`, so links work before the first launch. On launch, installed builds re-register it; the portable build takes it only when no other installation owns it.
- A link that starts the app opens its route as the first page, never starts hidden, and still goes through the update gate.
- A link that arrives while the app runs restores the window and is handed to the page:

```js
const removeListener = window.voiceRoomDesktopLinks.onOpen((link) => {
  // { kind: 'room', roomId } | { kind: 'mention', roomId, messageId, route }
  // | { kind: 'dm', dmId } | { kind: 'app' }; each also carries `route`.
});
```

Subscribing tells the shell that the page routes links itself; links received while the page was loading are delivered right after the subscription. A page that has not subscribed within 5 seconds of loading (an older web client) is navigated to the link's route instead — after a native "Перейти / Отмена" confirmation when a voice call is active.

## Call controls in the tray, taskbar and Dock

The web app mirrors the active call into the OS through `window.voiceRoomDesktopCall`:

```js
await window.voiceRoomDesktopCall.setState({
  active: true,
  roomId: 'abc123',
  roomName: 'Гостиная',
  micMuted: false,
  outputMuted: false
});
await window.voiceRoomDesktopCall.setState({ active: false });

const removeListener = window.voiceRoomDesktopCall.onAction(({ action }) => {
  // 'toggle-mic' | 'toggle-output' | 'disconnect'
});
```

- Windows: during a call the tray menu gets "Выключить/Включить микрофон", "Выключить/Включить звук" and "Отключиться", the tray tooltip shows the room name and the tray icon gets a green dot. The taskbar thumbnail toolbar shows the same three buttons, with icons for the current state; it is re-applied when the window returns from the tray.
- macOS: the Dock menu shows the same three items during a call.
- Outside a call nothing extra is shown. "Отключиться" acts immediately, like the in-app button.
- The call ends on the shell side when the page navigates to a new document, crashes or closes, so stale controls never outlive the page.

The glyphs in `assets/call` are rendered from lucide and the app logo by `npm run icons:call`; commit the PNGs after changing either.

## In-game overlay

While you are in voice, the shell can show a Discord-style HUD over a **detected game**: avatars and optional names. Silent participants are shown at 50 % opacity and whoever is speaking turns fully opaque at once, like Discord. Mic-off and sound-off icons and a «Стрим» badge follow the avatar or name. In the right corners each row is mirrored so the avatars stay against the edge of the game. The overlay stays over the game when another window takes focus, as long as the game is not minimized and the focused window does not cover it; a window on another monitor, the desktop and the taskbar do not count. Same-origin avatar paths from the web app (`/api/avatars/…`) are resolved against `VOICE_ROOM_URL`. It is a separate window glued to the game's window, not an in-process DirectX hook. Browsers, Explorer, Discord and launchers are ignored. Steam / Epic / Riot / Xbox install folders count as games; anything else can be added from settings.

It does **not** appear over exclusive fullscreen. Switch the game to borderless / fullscreen windowed. The hosted web app exposes the same note and the controls through `window.voiceRoomDesktopOverlay`:

```js
const settings = await window.voiceRoomDesktopOverlay.getSettings();
// { enabled, anchor, avatarSize, showNames, allowedExecutables }

await window.voiceRoomDesktopOverlay.setSettings({
  enabled: true,
  anchor: 'top-left', // top-left | top-right | bottom-left | bottom-right
  avatarSize: 'medium', // small (28 px) | medium (36 px) | large (46 px)
  showNames: true,
  allowedExecutables: ['mygame.exe']
});
const foreground = await window.voiceRoomDesktopOverlay.getForeground();
// { game, label, reason, exe, title } — the last window before Voice Room, not Voice Room itself
await window.voiceRoomDesktopOverlay.addGame(foreground.exe); // browsers, launchers and Voice Room are refused

await window.voiceRoomDesktopOverlay.setSnapshot({
  participants: [
    { id: 'self', name: 'Вы', self: true, speaking: true, micMuted: false, outputMuted: false, streaming: false }
  ]
});
```

The HUD never takes input: every click goes to the game, and there is no overlay hotkey. Game detection runs only during a call or while the settings screen asks for it. It uses the native `VoiceRoomForeground.exe` helper, which reacts to window events (focus, move, resize, minimize) instead of polling and reports per-monitor DPI-aware bounds, so the HUD lands on the game on scaled monitors too. When the helper is missing or keeps dying before its first report, the shell falls back to the older PowerShell poller (`native/overlay/windows/foreground.ps1`); `VOICE_ROOM_NATIVE_FOREGROUND=0` forces that fallback. The HUD raises itself again on every report and after a GPU process restart, so a game that makes its own window topmost does not bury it. Overlay preferences live in `desktop-settings.json` next to autostart.

## Window size and position

The main window reopens with its last size, position and maximized state (stored in `window-state.json` in the user data folder). Fullscreen is not restored. When the saved position is no longer visible — a disconnected monitor, a smaller display — the window keeps its size (shrunk to fit if needed) and is centered on the primary display.

## Diagnostics

The web app exposes support helpers through `window.voiceRoomDesktopDiagnostics`, and the Windows tray has the same two actions under "Диагностика":

```js
await window.voiceRoomDesktopDiagnostics.setContext({ userId: 'u1', roomId: 'abc123' });
await window.voiceRoomDesktopDiagnostics.copyInfo();        // { ok: true }, text in the clipboard
await window.voiceRoomDesktopDiagnostics.openLogsFolder();  // { ok: true } | { ok: false, reason }
const info = await window.voiceRoomDesktopDiagnostics.getInfo(); // structured data plus `text`
```

The summary lists the app version, channel and package type, Electron/Chromium/Node versions, OS, locale, GPU feature status, native helper availability, stream health (native capture and stream audio state, helper restarts, how the last capture ended), overlay state (watcher backend, visibility, detected game's file name), GPU process crashes since launch, Chromium process CPU and memory by process type (`app.getAppMetrics()`; CPU is a percentage of one core since the previous reading, and the native helpers are not included), update and autostart state, whether voice is active, and the user and room ids from `setContext`. It never includes file paths or the OS user name.

For measurements, `VOICE_ROOM_PERF_LOG=1` writes one `Performance: voice=…, processes: …` line to the log every 10 seconds. That makes it easy to compare a call, the tray or a game before and after a change.

## Supported platforms

| Platform | Status | Notes |
|----------|--------|-------|
| macOS 13+ (Apple Silicon / Intel) | Supported | Native safe-system audio via ScreenCaptureKit. Unsigned builds show no native notifications (see [docs/code-signing.md](docs/code-signing.md)) |
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
// low = 540 (legacy), balanced = 720, high = 1080,
// source = up to 3840x2160 (2560x1440 above 30 fps): raw frames are copied
// between processes, so even "source" keeps a ceiling.
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

On Windows, a window share picked with «Только звук этого окна» in the stream picker captures only the app behind that window (its process tree; Store apps resolve through their frame host). The page needs no changes: `startSafeSystem` picks the window up from the last picker selection, and the helper falls back to all system sound minus Voice Room if the window is already gone.

A helper that dies mid-stream is restarted under the same `sessionId` with the same format, so the page keeps its audio track and hears only a short gap. The page receives `{ event: 'restarting', attempt, delayMs }` for each restart and `{ event: 'exit' }` only once the shell gives up (after roughly a minute of failures). The video capture helper follows the same budget: three immediate restarts, then growing pauses while the stream holds its last frame, so a GPU driver reset no longer ends the share.

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

Hidden launches (autostart to tray, background update relaunch) run the same check silently: no splash, errors never block, and an available update is left to the background updater.

While the app runs, it checks GitHub Releases again every 4 hours (15 minutes after a failed check, and on wake from sleep once 4 hours have passed) and downloads updates silently. A downloaded update is installed:

- when the user quits the app for real (tray "Выход", Alt+F4);
- from the tray menu item "Установить обновление X.Y.Z", which restarts the app with its window open;
- automatically once the window has stayed in the tray for 10 minutes with no voice connection; the app relaunches back into the tray.

Development builds started with `npm run electron` skip the update gate and background updates. macOS auto-update stays disabled until Apple code signing is ready.

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

Release and dev builds from CI point at `https://voiceroom.ru`.

### Windows native helpers

`npm run electron` and every Windows build compile the native helpers (screen capture, system audio, global hotkeys, overlay foreground watcher) with MSVC. Install Visual Studio 2022 Build Tools with MSVC x64 and a Windows 11 SDK once:

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

A Developer Command Prompt is not required. When `cl.exe` is not on `PATH`, the build scripts find the Build Tools through `vswhere` and load `vcvars64.bat` themselves. Without MSVC they stop with an install hint.

## Commands

`npm run preview:picker` opens the picker UI with mock sources only. It does not use the Electron preload bridge, so it is for layout review rather than real screen capture.

```bash
npm run electron
npm run preview:picker
npm run build
npm run build:mac
npm run build:win
npm run build:win:dev
npm run build:mac:dev
npm run check
npm test
```

Build artifacts are written to `dist/`. Dev builds (`build:*:dev`) produce a portable Windows `.exe` or macOS `.dmg` in `dist/dev/<commit>/`, with a `-dirty` suffix when the tree has uncommitted changes. They use the `dev` channel and the `voiceroom-dev://` scheme.

Releases are built by GitHub Actions from version tags. See [docs/releasing.md](docs/releasing.md).
