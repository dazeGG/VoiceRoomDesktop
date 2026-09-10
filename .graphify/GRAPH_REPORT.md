# Graph Report - .  (2026-09-10)

## Corpus Check
- label mode - file stats not available

## Summary
- 1098 nodes · 2268 edges · 60 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output
- Edge kinds: contains: 791 · MODIFIES: 556 · calls: 300 · PARENT_OF: 200 · ON_BRANCH: 175 · imports: 130 · imports_from: 81 · method: 35


## Graph Freshness
- Built from Git commit: `b2df28d`
- Compare this hash to `git rev-parse HEAD` before trusting freshness-sensitive graph output.
## God Nodes (most connected - your core abstractions)
1. `FakeElement` - 19 edges
2. `wmain()` - 17 edges
3. `HandleKeyEvent()` - 11 edges
4. `fail()` - 11 edges
5. `runCaptureLifecycle()` - 10 edges
6. `startSession()` - 9 edges
7. `init()` - 9 edges
8. `postToRenderer()` - 8 edges
9. `normalizeScreenQualityId()` - 8 edges
10. `renderSources()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `039ebd2 fix(capture): stabilize native desktop stream delivery` --ON_BRANCH--> `main`  [EXTRACTED]
  git → git  _Bridges community 12 → community 5_
- `039ebd2 fix(capture): stabilize native desktop stream delivery` --PARENT_OF--> `66db40a ci: run Electron tests under virtual display`  [EXTRACTED]
  git → git  _Bridges community 12 → community 39_
- `05af749 Improve release build diagnostics` --ON_BRANCH--> `main`  [EXTRACTED]
  git → git  _Bridges community 10 → community 5_
- `07033f2 Release v1.2.1` --ON_BRANCH--> `main`  [EXTRACTED]
  git → git  _Bridges community 36 → community 5_
- `075a504 Add macOS process-tap audio exclusion and Windows capture diagnostics` --ON_BRANCH--> `main`  [EXTRACTED]
  git → git  _Bridges community 14 → community 5_

## Communities

### Community 0 - "Packaged Startup Fixes"
Cohesion: 0.05
Nodes (54): 272adc4 docs: document release notes format, 3e4312e Merge PR #12: fix desktop capture bootstrap export, 61f29aa Fix runtime config path test in clean checkout, 694a91b fix: resolve packaged desktop startup failures, 6e84220 Fix packaged startup file coverage, 8273de2 Merge PR #11: fix packaged startup file coverage, 8df90c3 Release v1.1.6, c54f198 Fix desktop capture bootstrap export (+46 more)

### Community 1 - "Auto-Update Gate Fallback"
Cohesion: 0.06
Nodes (41): 0e9fc98 docs: document update fallback behavior, 4b8d43d fix: disable macOS auto-update until Apple code signing is ready, 8011aa5 Merge pull request #10 from dazeGG/fix/update-gate-fallback, 86aba2b test: cover update gate fallback flows, 9b3bb0c fix: make update gate fallback one shot, c85827c Release v1.1.11, dbfd70d fix: package update gate state module, e422b08 Merge branch 'release/1.1.11' (+33 more)

### Community 2 - "Logger and IPC Wiring"
Cohesion: 0.05
Nodes (46): 37a9dcd Merge pull request #5 from dazeGG/fix/media-device-permissions, 6eb6914 Merge pull request #3 from dazeGG/polish/p3-audit-polish, 9e2706b Merge pull request #4 from dazeGG/fix/p2-p3-audit-polish, a27781f fix: close P2/P3 audit items and packager logger whitelist, bfe2c95 fix: grant media and speaker-selection for device enumeration, c992285 polish: close P3 audit items (platforms docs + electron-log), configureDesktopCaptureIpc(), configureScreenPickerIpc() (+38 more)

### Community 3 - "App Bootstrap and Layout"
Cohesion: 0.07
Nodes (38): createAppBootstrap(), {
  createAppTopbarView,
  installDesktopLayoutCss
}, path, { session }, { WINDOW_BACKGROUND, getMainWindowChromeOptions }, 1d57ca9 Merge branch 'release/1.1.10', 3cb3e13 Fix lobby preview chat layout in the desktop shell., 470d28e Fix desktop chat rail sizing under the shell topbar. (+30 more)

### Community 4 - "Screen Picker UI"
Cohesion: 0.10
Nodes (35): assertPickerElements(), closePopover(), createFallbackPreviewNodes(), createLucidePlaceholder(), createPreviewSpan(), createSourceAppIcon(), createSourceButton(), elements (+27 more)

### Community 5 - "Main Branch Release History"
Cohesion: 0.10
Nodes (37): main, 0b896fe chore(release): v1.1.1-dev.7, 153397d feat(capture): pass screen quality caps to native capture, 160a98f fix(windows): keep capture border disable best-effort, 1aa5692 Stop native audio helper on renderer shutdown, 1b3d514 perf: optimize native capture pipeline, 21b8686 chore: bump version to 1.1.1-dev.6, 246a9dc chore: bump version to 1.1.1-dev.2 (+29 more)

### Community 6 - "Windows Native Hotkeys Helper"
Cohesion: 0.12
Nodes (34): CloseShutdownInfrastructure(), EmitHotkey(), EmitReady(), FindCode(), ForegroundKeyboardLayout(), ForgetDownKey(), HandleKeyEvent(), HasRememberedSharedKey() (+26 more)

### Community 7 - "macOS Capture Permission"
Cohesion: 0.07
Nodes (25): 12cb3ec fix: restore macOS capture and sync picker icons (#18), 56a281b Release v1.2.2, b2df28d Merge pull request #20 from dazeGG/release/1.2.2, { app, BrowserWindow }, path, { afterEach, it }, assert, Module (+17 more)

### Community 8 - "Desktop Capture State"
Cohesion: 0.07
Nodes (22): { BrowserWindow, desktopCapturer }, clearDesktopCaptureSourceSnapshot(), clearPendingDesktopCaptureSource(), {
  createMacScreenCaptureAccessError,
  getFrameScopeKey,
  isTrustedFrame,
  isTrustedOrigin,
  openMacScreenCaptureSettings
}, desktopCapturePickerSessions, desktopCaptureSourceSnapshots, getDesktopCapturePickerSessionForEvent(), getDesktopCaptureSourceForSelection() (+14 more)

### Community 9 - "Security and Dev Diagnostics"
Cohesion: 0.10
Nodes (19): 5819f35 fix: add update failure fallback gate, 6e33393 chore(release): v1.1.2, 8c0c493 Merge pull request #9 from dazeGG/refactor/electron-folder-reorg, 9573901 Release v1.1.3, 9ed18ce refactor(electron): reorganize into domain folders, { BrowserWindow, shell }, path, mac (+11 more)

### Community 10 - "Release Build Stabilization"
Cohesion: 0.09
Nodes (25): 05af749 Improve release build diagnostics, 2cb6a19 chore: bump version to 1.1.0-dev.6 (rollback test build, no WGC/label), 34ececf chore: bump version to 1.1.0-dev.3 for lightweight dev pre-release, 4e15b13 Update app icon assets, 5debe80 fix: prune dist for every build and match the Voice-Room artifact slug, 604d30b feat: show a faint baked-in build label (version · hash) in the app, 67f196f revert: drop WGC capture flags and in-app build label, 6e8324a fix: restore WGC after picker cancellation fix (+17 more)

### Community 11 - "Screen Picker UI Tests"
Cohesion: 0.11
Nodes (11): assert, createPickerHarness(), { describe, it }, FakeElement, findAll(), findFirst(), fs, makeElement() (+3 more)

### Community 12 - "Capture Quality Profiles"
Cohesion: 0.11
Nodes (24): 039ebd2 fix(capture): stabilize native desktop stream delivery, 08caf8b Merge branch 'release/1.1.14', 3c7a3d8 feat: redesign screen picker with games/text stream presets., 485f92f test: cover source profile and add screen picker UI tests, cb93123 feat: add 'source' quality preset for full-resolution capture (no downscale), createScreenProfileId(), DESKTOP_AUDIO_MODES, getSourceType() (+16 more)

### Community 13 - "Windows Screen Cursor Capture"
Cohesion: 0.12
Nodes (19): CaptureSession, Fail(), FrameCallbackLease, FrameCallbackState, FrameWriter, HandleSignal(), LogEvent(), LogReconfigured() (+11 more)

### Community 14 - "Native Audio Build"
Cohesion: 0.12
Nodes (22): 075a504 Add macOS process-tap audio exclusion and Windows capture diagnostics, 3e2f41c Forward only whole audio frames over IPC to fix white-noise stream audio, 5eb23d8 Set Windows stdout to binary mode to fix white-noise stream audio, c6a1959 Fix Windows process-loopback activation (agile handler) and format, cefa69f Release v1.0.3: native stream audio (macOS process tap, Windows loopback), binDir, buildMacOS(), buildWindows() (+14 more)

### Community 15 - "Early Project Milestones"
Cohesion: 0.12
Nodes (20): 0aebf15 fix(tray): document Windows tray smoke coverage, 135245a feat: add blocking auto-update gate and unit tests, 155cf3a Merge pull request #8 from dazeGG/feature/windows-close-to-tray, 20e2ea7 test(tray): cover Windows tray lifecycle, 2951ab8 Initialize desktop shell project, 378465d docs: add SignPath code signing policy and privacy notes, 38cafa6 Merge pull request #1 from dazeGG/docs/signpath-policy, 601036a polish: improve picker a11y, recovery screen, and CSP (+12 more)

### Community 16 - "Windows Capture Smoke Test"
Cohesion: 0.22
Nodes (21): appendFrames(), assertCaptureAlive(), consumeBytes(), createCaptureProcess(), createWindowCaptureTarget(), discardBytes(), fail(), framePayloadBytes() (+13 more)

### Community 17 - "Native Hotkey Backend"
Cohesion: 0.11
Nodes (17): bindingToHelperArgument(), createNativeHotkeyBackend(), findNativeHotkeyHelper(), fs, HOTKEY_ACTIONS, HOTKEY_PHASES, isHotkeyAction(), normalizeReadyMessage() (+9 more)

### Community 18 - "Capture Relay Sessions"
Cohesion: 0.25
Nodes (19): {
  appendFrameChunk,
  createFrameState
}, attachChild(), {
  buildReconfigureStdinPayload,
  NATIVE_CAPTURE_PROTOCOL_VERSION,
  normalizeReconfigureCommand
}, { createRestartPolicy }, failPendingReconfigures(), finishPendingReconfigure(), finishSession(), handleHelperEvent() (+11 more)

### Community 19 - "Desktop Hotkey Controller"
Cohesion: 0.14
Nodes (13): ALL_ACTIONS, bindingIdentity(), bindingToAccelerator(), createDesktopHotkeyController(), domCodeToAcceleratorKey(), GLOBAL_ACTIONS, NAMED_KEYS, {
  ACTION_CHANNEL,
  CONFIGURE_CHANNEL,
  STATUS_CHANNEL,
  SUSPEND_CHANNEL,
  bindingIdentity,
  bindingToAccelerator,
  createDesktopHotkeyController,
  domCodeToAcceleratorKey
} (+5 more)

### Community 20 - "Native Capture Process Management"
Cohesion: 0.15
Nodes (15): { app, MessageChannelMain, utilityProcess }, cleanupSession(), { execFile }, failReconfigureRequests(), findScreenCursorCaptureHelper(), fs, getNativeCaptureCapabilities(), isNativeCaptureEnabled() (+7 more)

### Community 21 - "Native Hotkeys Build"
Cohesion: 0.16
Nodes (17): 198cf78 fix(ci): build universal mac helper on Intel runner, 41a1b6e fix(ci): verify universal mac helper architectures, d68c2f4 fix(release): prepare desktop 1.2.0, fed46c1 Merge branch 'release/1.2.0' into develop, binDir, buildMacOS(), buildWindows(), ensureDir() (+9 more)

### Community 22 - "Window Lifecycle and Tray"
Cohesion: 0.18
Nodes (12): assert, { describe, it }, {
  isAltF4Input,
  shouldHideToTrayOnClose,
  shouldQuitWhenAllWindowsClosed,
  shouldUseWindowsTray
}, assert, { createWindowLifecycleController }, { describe, it }, createWindowLifecycleController(), {
  isAltF4Input,
  shouldHideToTrayOnClose,
  shouldQuitWhenAllWindowsClosed,
  shouldUseWindowsTray
} (+4 more)

### Community 23 - "Initial Capture Profile Tests"
Cohesion: 0.12
Nodes (8): assert, { EventEmitter }, FakeChild, FakePort, fs, Module, { NATIVE_CAPTURE_PROTOCOL_VERSION }, { test }

### Community 24 - "Media Device Filtering"
Cohesion: 0.19
Nodes (14): AUDIO_DEVICE_KINDS, buildDefaultToConcreteRemaps(), filterEnumeratedMediaDevices(), findConcreteDuplicate(), getDefaultDeviceName(), getInjectableMediaDeviceRuntime(), getMediaDeviceFilterInjectScript(), isConcreteDuplicateOfDefault() (+6 more)

### Community 25 - "Capture Restart Policy"
Cohesion: 0.18
Nodes (13): 27903e0 Merge branch 'release/1.1.13', 421993d docs: document applyProfile API in README., 5ab9bfc Release v1.1.13, 647affa Merge branch 'release/1.1.12', 72dbcaa test: add capture reconfigure and restart policy coverage., 81b50a1 Release v1.1.12, a0ace3b chore: update OMX model routing, c2c6dfb feat: add live capture profile switching via applyProfile IPC. (+5 more)

### Community 26 - "Relay Lifecycle Tests"
Cohesion: 0.14
Nodes (9): 7af5325 fix(capture): harden timed-out session recovery, 99f32c8 test(capture): exercise native stream lifecycles, assert, { describe, it }, { EventEmitter }, FakeChild, {
  FRAME_HEADER_BYTES,
  FRAME_MAGIC
}, Module (+1 more)

### Community 27 - "Desktop Notifications"
Cohesion: 0.20
Nodes (9): a259a05 Fix desktop notification delivery reporting, activeNotifications, configureDesktopNotificationsIpc(), sanitizeNotificationPayload(), sanitizeString(), showDesktopNotification(), assert, {
  CHANNEL,
  configureDesktopNotificationsIpc,
  sanitizeNotificationPayload
} (+1 more)

### Community 28 - "Desktop Capture IPC"
Cohesion: 0.23
Nodes (13): { BrowserWindow, ipcMain }, {
  createScreenProfileId,
  getScreenQualityMaxHeight,
  getScreenQualityMaxWidth,
  normalizeApplyProfileRequest,
  normalizeDesktopCapturePickerSelection,
  normalizeScreenFpsId,
  normalizeScreenQualityId
}, desktopCaptureState, {
  ensureMacMicrophoneAccess,
  getFrameScopeKey,
  isTrustedFrame,
  isTrustedOrAppLoadingFrame,
  openMacMicrophoneSettings,
  openMacScreenCaptureSettings
}, log, {
  reconfigureNativeCaptureSession,
  startNativeCaptureSession,
  stopNativeCaptureSession
}, { startSafeSystemAudioCapture, stopSafeSystemAudioCapture }, getScreenQualityMaxHeight() (+5 more)

### Community 29 - "Preload Bridge"
Cohesion: 0.22
Nodes (10): closePort(), { contextBridge, ipcRenderer }, desktopRuntime, evictOldestPortEntry(), forwardNativeCapturePort(), isNativeCaptureSessionId(), pendingNativeCapturePorts, removePortEntry() (+2 more)

### Community 30 - "MessagePort ArrayBuffer Fixture"
Cohesion: 0.15
Nodes (10): { app, BrowserWindow, ipcMain, MessageChannelMain }, fail(), finish(), {
  getNativeCaptureInjectScript
}, http, {
  NATIVE_CAPTURE_PROTOCOL_VERSION
}, path, { randomUUID } (+2 more)

### Community 31 - "Relay Termination Fixture"
Cohesion: 0.23
Nodes (12): { app, MessageChannelMain, utilityProcess }, fail(), finish(), isProcessRunning(), {
  NATIVE_CAPTURE_PROTOCOL_VERSION
}, path, run(), sleep() (+4 more)

### Community 32 - "Native System Audio"
Cohesion: 0.20
Nodes (12): { app }, EMPTY_AUDIO_BUFFER, findSafeSystemAudioHelper(), fs, getNativeAudioCapabilities(), getSafeSystemAudioHelperArgs(), hasNativeSafeLoopbackAudio(), log (+4 more)

### Community 33 - "Main Startup Tests"
Cohesion: 0.14
Nodes (4): assert, Module, path, test

### Community 34 - "Native Capture Contract"
Cohesion: 0.23
Nodes (10): buildReconfigureStdinPayload(), hasChromiumAudioRequest(), isCompatibleNativeCaptureSession(), isNativeOnlyDisplayMediaCandidate(), normalizeReconfigureCommand(), getNativeCaptureInjectScript(), {
  NATIVE_CAPTURE_PORT_MESSAGE_TYPE,
  NATIVE_CAPTURE_PROTOCOL_VERSION,
  hasChromiumAudioRequest,
  isCompatibleNativeCaptureSession,
  isNativeOnlyDisplayMediaCandidate
}, assert (+2 more)

### Community 35 - "Capture Session Failure Tests"
Cohesion: 0.17
Nodes (8): assert, { describe, it }, { EventEmitter }, FakePort, FakeRelay, fs, loadCaptureSessionHarness(), Module

### Community 36 - "Capture Geometry"
Cohesion: 0.27
Nodes (9): 07033f2 Release v1.2.1, 3a5a7d4 chore: refresh OMX model guidance, 44d32ea Merge pull request #15 from dazeGG/agent/desktop-stream-quality, 4f753e5 Merge pull request #16 from dazeGG/release/1.2.1, f0a3eec Merge pull request #17 from dazeGG/release/1.2.1, Expect(), main(), ComputeOutputSize() (+1 more)

### Community 37 - "System Idle Time"
Cohesion: 0.22
Nodes (5): a60636a Merge branch 'release/1.2.0', configureDesktopIdleIpc(), assert, {
  CHANNEL,
  configureDesktopIdleIpc
}, { describe, it }

### Community 38 - "Live Capture Reconfigure"
Cohesion: 0.18
Nodes (9): handleReconfigure(), parseHelperStderrChunk(), writeReconfigureToChild(), assert, { EventEmitter }, fs, {
  handleHelperEvent,
  handleReconfigure,
  parseHelperStderrChunk
}, { it } (+1 more)

### Community 39 - "Electron MessagePort CI Tests"
Cohesion: 0.27
Nodes (9): 200bf74 fix(capture): make native port handoff race-free, 66db40a ci: run Electron tests under virtual display, 6f3475f test: exercise renderer MessagePort clone path, b01e0d7 test: support Electron IPC smoke on Linux CI, cfd1e3b fix(capture): recover stalled native stream sessions, assert, path, { spawn } (+1 more)

### Community 40 - "Native Capture Build"
Cohesion: 0.22
Nodes (9): binDir, buildWindows(), fs, nativeDir, path, rootDir, run(), { spawnSync } (+1 more)

### Community 41 - "Capture Inject Script Tests"
Cohesion: 0.20
Nodes (4): assert, { describe, it }, { getNativeCaptureInjectScript }, {
  NATIVE_CAPTURE_PROTOCOL_VERSION,
  NATIVE_CAPTURE_PORT_MESSAGE_TYPE
}

### Community 42 - "Windows Capture Source Tests"
Cohesion: 0.20
Nodes (9): assert, { describe, it }, fs, geometrySource, path, relaySource, relayTerminationFixtureSource, runtimeSmokeSource (+1 more)

### Community 43 - "Windows Menu Policy"
Cohesion: 0.28
Nodes (7): 45a9f89 Release v1.1.4, 7a1ff06 Release v1.1.5, 86f4ae5 fix: disable Windows application menu, assert, { disableWindowsApplicationMenu }, test, disableWindowsApplicationMenu()

### Community 44 - "Media Permissions and NSIS"
Cohesion: 0.22
Nodes (9): 533bbf5 fix: use space-free artifact slug so auto-update download resolves, 6273ac3 fix: hide duplicate system audio devices and keep default only, 6df1a95 build: add Windows nsis target so auto-update works, keep portable exe, 6e1072c fix: prefer WGC screen capture on Windows to drop phantom game cursor, aba97b3 fix: dedupe audio devices without breaking LiveKit device selection, aca7434 fix: bundle media device filter helpers into injected page script, c8085e3 fix: skip update gate for packaged dev builds, cf6c3dc fix: unblock media permissions during page load and warm up devices (+1 more)

### Community 45 - "Windows Capture Feature Policy"
Cohesion: 0.39
Nodes (7): getWindowsCaptureFeaturePolicy(), isWindows11OrNewerRelease(), normalizeWgcOverride(), parseWindowsBuildNumber(), assert, { describe, it }, {
  WGC_SCREEN_CAPTURER_FEATURE,
  getWindowsCaptureFeaturePolicy,
  isWindows11OrNewerRelease,
  parseWindowsBuildNumber
}

### Community 46 - "Runtime Config Generation"
Cohesion: 0.28
Nodes (8): envPath, fs, loadDotEnv(), outputPath, path, readVoiceRoomUrl(), rootDir, writeRuntimeConfig()

### Community 47 - "Release Version Validator Tests"
Cohesion: 0.22
Nodes (7): assert, { describe, it }, packageJson, path, rootDir, { spawnSync }, validator

### Community 48 - "Preload Runtime Tests"
Cohesion: 0.29
Nodes (7): 120e03f feat(desktop): add global voice hotkeys, e904615 feat(desktop): expose system idle time, assert, fs, path, test, vm

### Community 49 - "Relay Flow Control"
Cohesion: 0.25
Nodes (7): handleChildStdinError(), handleRendererMessage(), setHelperPaused(), writeChildCommand(), assert, {
  failPendingReconfigures,
  handleChildStdinError,
  handleRendererMessage,
  postToRenderer
}, { it }

### Community 50 - "Top Bar Drag Release"
Cohesion: 0.38
Nodes (7): 10cfbc0 Revert "Release v1.1.9-dev.1", 1800993 Merge branch 'release/1.1.9' into develop, 22d09db Merge branch 'release/1.1.9', 3b4093d chore: ignore graphify-out directory, 58b329f fix(window): drag the top bar instead of a max-z overlay strip, 6229310 Release v1.1.9-dev.1, c861054 Release v1.1.9

### Community 51 - "Notifications and Branding Release"
Cohesion: 0.33
Nodes (7): 69011b0 feat(desktop): add native notification bridge, 7a857bd docs(release): clarify artifact publishing workflow, 8ff383a chore(branding): replace desktop application icons, a98021f Release v1.1.14, da8d824 Merge branch 'release/1.1.14' into develop, dd5ee2b fix(desktop): allow room audio autoplay, ffef93f docs: document source quality profile and update applyProfile example

### Community 52 - "Release Version Validator"
Cohesion: 0.29
Nodes (6): fs, packageJson, path, rootDir, tag, tagVersion

### Community 53 - "Windows Tray Smoke Check"
Cohesion: 0.29
Nodes (6): checklist, checklistPath, fs, missingChecks, path, requiredChecks

### Community 54 - "Capture Geometry Tests"
Cohesion: 0.29
Nodes (6): assert, fs, os, path, { spawnSync }, { test }

### Community 55 - "Capture Frame Parsing"
Cohesion: 0.53
Nodes (5): appendFrameChunk(), createFrameState(), getFramePayloadBytes(), takeBytes(), toFrameArrayBuffer()

### Community 56 - "Capture Frame Tests"
Cohesion: 0.33
Nodes (3): assert, { describe, it }, {
  FRAME_FLAG_FORMAT_NV12,
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  appendFrameChunk,
  createFrameState
}

### Community 57 - "Fake Renderer Port"
Cohesion: 0.40
Nodes (1): FakeRendererPort

### Community 58 - "Capture Backend Diagnostics"
Cohesion: 0.50
Nodes (4): 605b73b Add dev capture backend diagnostics, 8e54f8a chore: bump version to 1.1.0-dev.10, b70930b feat: restore build label and add WebRTC internals shortcut, f6da4cb feat: add native cursor-correct capture

### Community 59 - "Native Capture Timing Fixes"
Cohesion: 0.67
Nodes (3): 12498b5 fix(win): align native NV12 color space with renderer tags., 510074a perf: improve native capture relay and frame timing., c34178c fix: restore text mode when desktop picker opens at 5fps.

## Knowledge Gaps
- **377 isolated node(s):** `buildHash`, `outputDir`, `{ session }`, `path`, `{ WINDOW_BACKGROUND, getMainWindowChromeOptions }` (+372 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Fake Renderer Port`** (1 nodes): `FakeRendererPort`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `FakeRendererPort` connect `Fake Renderer Port` to `Relay Lifecycle Tests`?**
  _High betweenness centrality (0.007) - this node is a cross-community bridge._
- **What connects `buildHash`, `outputDir`, `{ session }` to the rest of the system?**
  _377 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Packaged Startup Fixes` be split into smaller, more focused modules?**
  _Cohesion score 0.05499735589635114 - nodes in this community are weakly interconnected._
- **Should `Auto-Update Gate Fallback` be split into smaller, more focused modules?**
  _Cohesion score 0.06184012066365008 - nodes in this community are weakly interconnected._
- **Should `Logger and IPC Wiring` be split into smaller, more focused modules?**
  _Cohesion score 0.0473469387755102 - nodes in this community are weakly interconnected._
- **Should `App Bootstrap and Layout` be split into smaller, more focused modules?**
  _Cohesion score 0.07293868921775898 - nodes in this community are weakly interconnected._
- **Should `Screen Picker UI` be split into smaller, more focused modules?**
  _Cohesion score 0.1039136302294197 - nodes in this community are weakly interconnected._