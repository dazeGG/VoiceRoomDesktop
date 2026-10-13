# Graph Report - VoiceRoomDesktop  (2026-10-13)

## Corpus Check
- 144 files · ~99,632 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 12 file(s) not represented in the graph (top: .css 5, .ico 3, (none) 2)

## Summary
- 2173 nodes · 3864 edges · 117 communities (103 shown, 14 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 328 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `072cd8d0`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- electron-builder-config.test.js
- update-gate.js
- main.js
- app-topbar-view.test.js
- generate-call-icons.js
- FrameWriter
- SafeSystemAudioCapture.swift
- screen-picker-icon-pack.test.js
- desktop-autostart.test.js
- desktop-deep-links.test.js
- build-electron.js
- screen-picker-ui.test.js
- desktop-capture.js
- VoiceRoomHotkeys.swift
- build-native-audio.js
- ref_node_fs
- windows-native-capture-smoke.js
- native-hotkeys.test.js
- window-state.test.js
- createDesktopHotkeyController
- CaptureSession
- build-native-hotkeys.js
- createWindowLifecycleController
- desktop-capture-initial-profile-chain.test.js
- media-device.js
- screen-picker.js
- native-capture-relay-lifecycle.test.js
- desktop-notifications.test.js
- desktop-capture/state.js
- electron
- desktop-attention.test.js
- createBackgroundUpdateController
- desktop-overlay-games.test.js
- main-startup-policy.test.js
- ref_node_assert
- native-capture-session-failures.test.js
- createOverlayController
- desktop-idle.test.js
- capture-relay.js
- SafeSystemAudioCapture.cpp
- build-native-capture.js
- native-capture-policy.test.js
- windows-native-capture-source.test.js
- Voice Room Desktop
- electron/overlay.js
- windows-capture-policy.test.js
- create-electron-config.js
- validate-release-version.test.js
- preload-desktop-runtime.test.js
- security-origin.test.js
- .StartWindowCapture
- capture.js
- ref_node_path
- FrameCallbackState
- ref_node_child_process
- window-context-menu.test.js
- policies/overlay.js
- call-surfaces.test.js
- CaptureTarget
- DWORD
- ScreenCursorCapture.cpp
- scripts
- FakeWindow
- launch-mode.test.js
- call-surfaces.js
- mac.js
- wmain
- package.json
- desktop-keep-awake.test.js
- desktop-overlay.test.js
- ui/overlay.js
- .WriteFrame
- message-port-arraybuffer-electron.js
- desktop-call-controls.test.js
- audio.js
- msvc-env.js
- desktop-capture/index.js
- VoiceRoomHotkeys.cpp
- window/bootstrap.js
- mac-screen-capture-permission.test.js
- CaptureGeometry.h
- Binding
- ModifierState
- desktop-diagnostics.test.js
- WriteStatus
- Code signing policy
- createCallControlsController
- createDiagnosticsController
- ref_node_events
- wmain
- electron/diagnostics.js
- capture-contract.js
- FakeMainWindow
- Releasing Voice Room Desktop
- ScaleCoordinate
- EmitReady
- oh-my-codex - Intelligent Multi-Agent Orchestration
- positionWindow
- screen-picker-icons.js
- ReconfigureResult
- FakePort
- FakeWebContents
- Windows tray lifecycle smoke test
- update-splash.js
- LowLevelKeyboardProc
- VideoProcessorInputMode
- foreground.ps1
- dependencies
- FakeSender
- FakeSender
- electron-builder.config.js
- gameOnScreen
- devDependencies

## God Nodes (most connected - your core abstractions)
1. `FrameWriter` - 90 edges
2. `CaptureSession` - 68 edges
3. `createOverlayController()` - 42 edges
4. `createDesktopHotkeyController()` - 30 edges
5. `configureDesktopCaptureIpc()` - 24 edges
6. `Voice Room Desktop` - 24 edges
7. `electron` - 23 edges
8. `createWindowLifecycleController()` - 21 edges
9. `createDeepLinkController()` - 20 edges
10. `FakeWindow` - 20 edges

## Surprising Connections (you probably didn't know these)
- `Diagnostics` --references--> `setContext()`  [INFERRED]
  README.md → electron/diagnostics.js
- `createHarness()` --calls--> `createDiagnosticsController()`  [EXTRACTED]
  test/desktop-diagnostics.test.js → electron/diagnostics.js
- `iconFile()` --calls--> `resolveAppIconPath()`  [EXTRACTED]
  test/desktop-app-icon.test.js → electron/app-icon.js
- `createHarness()` --calls--> `createAppIconController()`  [EXTRACTED]
  test/desktop-app-icon.test.js → electron/app-icon.js
- `createHarness()` --calls--> `configureDesktopAttentionIpc()`  [EXTRACTED]
  test/desktop-attention.test.js → electron/attention.js

## Import Cycles
- None detected.

## Communities (117 total, 14 thin omitted)

### Community 0 - "electron-builder-config.test.js"
Cohesion: 0.16
Nodes (13): assert, builderConfig, collectHtmlAssetReferences(), collectLocalRequireGraph(), collectUtilityProcessForkTargets(), { describe, it }, fs, packageJson (+5 more)

### Community 1 - "update-gate.js"
Cohesion: 0.08
Nodes (36): { app, BrowserWindow, ipcMain }, attachAutoUpdaterHandlers(), {
  checkSiteAvailability,
  createSiteUnavailableState,
  createUpdateErrorState
}, configureUpdateGateIpc(), createUpdateSplashWindow(), getAutoUpdater(), log, path (+28 more)

### Community 2 - "main.js"
Cohesion: 0.03
Nodes (58): ALLOWED_SESSION_PERMISSIONS, { app, BrowserWindow, Menu, Tray, clipboard, dialog, globalShortcut, ipcMain, shell, nativeImage, nativeTheme, Notification, powerMonitor, powerSaveBlocker }, appIcon, autostart, callControls, callSurfaces, CHROMIUM_LOG_PATH, { configureDesktopAttentionIpc } (+50 more)

### Community 3 - "app-topbar-view.test.js"
Cohesion: 0.08
Nodes (33): createAppBootstrap(), configurePermissions(), createWindow(), launchApplication(), loadMainApplicationInBackground(), {
  createAppTopbarView,
  installDesktopLayoutCss
}, { MIN_WINDOW_SIZE }, path (+25 more)

### Community 4 - "generate-call-icons.js"
Cohesion: 0.05
Nodes (53): APP_ICON_THEMES, ASSETS_DIR, createAppIconController(), apply(), applyToDock(), applyToWindow(), attachWindow(), configureIpc() (+45 more)

### Community 5 - "FrameWriter"
Cohesion: 0.03
Nodes (51): FrameWriter, bgraStagingTexture_, bgraTexture_, bgrx_, bgrxScaleOutputHeight_, bgrxScaleOutputWidth_, bgrxScaleSourceHeight_, bgrxScaleSourceWidth_ (+43 more)

### Community 6 - "SafeSystemAudioCapture.swift"
Cohesion: 0.06
Nodes (19): AVFoundation, CoreAudio, CoreMedia, Darwin, Foundation, allProcessParents(), collectProcessTree(), installSignalHandlers() (+11 more)

### Community 7 - "screen-picker-icon-pack.test.js"
Cohesion: 0.15
Nodes (12): assert, createRoot(), { describe, it }, executeIconRuntime(), executeIconRuntimeWithoutLucide(), fs, html, iconRuntime (+4 more)

### Community 8 - "desktop-autostart.test.js"
Cohesion: 0.07
Nodes (33): createAutostartController(), applyLoginItem(), configureIpc(), getSettings(), isSupported(), readOpenAtLogin(), readStoredSettings(), setSettings() (+25 more)

### Community 9 - "desktop-deep-links.test.js"
Cohesion: 0.08
Nodes (30): createDeepLinkController(), attachWindow(), captureInitialArgv(), clearPending(), configureIpc(), deliver(), fallback(), handleArgv() (+22 more)

### Community 10 - "build-electron.js"
Cohesion: 0.12
Nodes (14): args, buildProfilePath, dev, electronBuilderCli, env, fs, hotkeyTargets, nativeBuildEnv() (+6 more)

### Community 11 - "screen-picker-ui.test.js"
Cohesion: 0.11
Nodes (11): assert, createPickerHarness(), { describe, it }, FakeElement, findAll(), findFirst(), fs, makeElement() (+3 more)

### Community 12 - "desktop-capture.js"
Cohesion: 0.16
Nodes (24): recordGrantedDesktopCapture(), setPendingDesktopCaptureSource(), createScreenProfileId(), DESKTOP_AUDIO_MODES, getScreenQualityMaxHeight(), getScreenQualityMaxWidth(), getSourceType(), modeToCapabilityKey() (+16 more)

### Community 13 - "VoiceRoomHotkeys.swift"
Cohesion: 0.10
Nodes (21): Carbon, CoreGraphics, Dispatch, Binding, .chord, carbonModifiers(), Chord, eventTapCallback() (+13 more)

### Community 14 - "build-native-audio.js"
Cohesion: 0.20
Nodes (13): binDir, buildMacOS(), buildWindows(), ensureDir(), fs, nativeDir, path, { requireMsvcEnv } (+5 more)

### Community 15 - "ref_node_fs"
Cohesion: 0.14
Nodes (12): cleanDist(), distDir, fs, packageJson, path, shouldKeepFile(), checklist, checklistPath (+4 more)

### Community 16 - "windows-native-capture-smoke.js"
Cohesion: 0.23
Nodes (22): appendFrames(), appendLineEvents(), assertCaptureAlive(), consumeBytes(), createCaptureProcess(), createWindowCaptureTarget(), discardBytes(), fail() (+14 more)

### Community 17 - "native-hotkeys.test.js"
Cohesion: 0.09
Nodes (29): bindingToHelperArgument(), canExecute(), createNativeHotkeyBackend(), childHasExited(), lookupHelper(), pendingShutdownsConfirmed(), queueTermination(), releaseActivePushToTalk() (+21 more)

### Community 18 - "window-state.test.js"
Cohesion: 0.08
Nodes (31): centerIn(), clamp(), createWindowStateController(), applyBounds(), matchDisplay(), readSavedState(), resolveInitialState(), stateFilePath() (+23 more)

### Community 19 - "createDesktopHotkeyController"
Cohesion: 0.08
Nodes (42): ALL_ACTIONS, bindingIdentity(), bindingToAccelerator(), createDesktopHotkeyController(), attachOwner(), clearRendererSuspension(), configure(), deactivate() (+34 more)

### Community 20 - "CaptureSession"
Cohesion: 0.05
Nodes (28): CaptureSession, closedRevoker_, consecutiveFrameWriteFailures_, contentSize_, d3dContext_, d3dDevice_, device_, duplication_ (+20 more)

### Community 21 - "build-native-hotkeys.js"
Cohesion: 0.19
Nodes (14): binDir, buildMacOS(), buildWindows(), ensureDir(), fs, nativeDir, path, { requireMsvcEnv } (+6 more)

### Community 22 - "createWindowLifecycleController"
Cohesion: 0.09
Nodes (25): createWindowLifecycleController(), attachMainWindow(), buildTrayMenu(), consumeExplicitCloseRequest(), installExplicitQuitShortcut(), installTray(), requestNextCloseQuit(), requestQuit() (+17 more)

### Community 23 - "desktop-capture-initial-profile-chain.test.js"
Cohesion: 0.15
Nodes (8): assert, { EventEmitter }, FakeChild, fs, loadInitialProfileHarness(), Module, { NATIVE_CAPTURE_PROTOCOL_VERSION }, { test }

### Community 24 - "media-device.js"
Cohesion: 0.21
Nodes (15): AUDIO_DEVICE_KINDS, buildDefaultToConcreteRemaps(), filterEnumeratedMediaDevices(), findConcreteDuplicate(), getDefaultDeviceName(), getInjectableMediaDeviceRuntime(), getMediaDeviceFilterInjectScript(), isConcreteDuplicateOfDefault() (+7 more)

### Community 25 - "screen-picker.js"
Cohesion: 0.12
Nodes (37): assertPickerElements(), cancelPicker(), closePopover(), createFallbackPreviewNodes(), createLucidePlaceholder(), createPreviewSpan(), createSourceAppIcon(), createSourceButton() (+29 more)

### Community 26 - "native-capture-relay-lifecycle.test.js"
Cohesion: 0.12
Nodes (8): assert, { describe, it }, { EventEmitter }, FakeChild, FakeRendererPort, {
  FRAME_HEADER_BYTES,
  FRAME_MAGIC
}, Module, { NATIVE_CAPTURE_PROTOCOL_VERSION }

### Community 27 - "desktop-notifications.test.js"
Cohesion: 0.20
Nodes (12): activeNotifications, configureDesktopNotificationsIpc(), describeNotificationError(), forget(), notificationsByTag, sanitizeNotificationPayload(), sanitizeString(), showDesktopNotification() (+4 more)

### Community 28 - "desktop-capture/state.js"
Cohesion: 0.09
Nodes (34): configureDesktopCaptureIpc(), configureScreenPickerIpc(), { BrowserWindow, desktopCapturer }, cancelDesktopCapturePickerSession(), clearDesktopCaptureSourceSnapshot(), clearPendingDesktopCaptureSource(), {
  createMacScreenCaptureAccessError,
  getFrameScopeKey,
  isTrustedFrame,
  isTrustedOrigin,
  openMacScreenCaptureSettings
}, desktopCapturePickerSessions (+26 more)

### Community 29 - "electron"
Cohesion: 0.06
Nodes (37): { BrowserWindow, shell }, createDevDiagnosticsController(), configureDevChromiumLogging(), installDevDiagnosticsShortcut(), isDevDiagnosticsEnabled(), openChromiumLogFile(), openWebRtcInternalsWindow(), path (+29 more)

### Community 30 - "desktop-attention.test.js"
Cohesion: 0.08
Nodes (21): configureDesktopAttentionIpc(), applyWindowsOverlay(), getOverlayIcon(), setWindowsBadge(), createBadgeOverlayBitmap(), describeBadgeCount(), distanceToSegment(), formatBadgeLabel() (+13 more)

### Community 31 - "createBackgroundUpdateController"
Cohesion: 0.10
Nodes (20): createBackgroundUpdateController(), canInstallQuietly(), checkNow(), evaluateApply(), getState(), handlers, installNow(), installPowerMonitor() (+12 more)

### Community 32 - "desktop-overlay-games.test.js"
Cohesion: 0.10
Nodes (22): createForegroundWatcher(), emit(), handleChunk(), resolveScript(), scheduleRestart(), spawnWatcher(), start(), fs (+14 more)

### Community 33 - "main-startup-policy.test.js"
Cohesion: 0.14
Nodes (4): assert, Module, path, test

### Community 34 - "ref_node_assert"
Cohesion: 0.22
Nodes (6): assert, {
  buildReconfigureStdinPayload,
  normalizeReconfigureCommand
}, { describe, it }, assert, { describe, it }, {
  normalizeApplyProfileRequest
}

### Community 35 - "native-capture-session-failures.test.js"
Cohesion: 0.17
Nodes (8): assert, { describe, it }, { EventEmitter }, FakePort, FakeRelay, fs, loadCaptureSessionHarness(), Module

### Community 36 - "createOverlayController"
Cohesion: 0.18
Nodes (29): createOverlayController(), addAllowedGame(), applyAlwaysOnTop(), attachMainWindow(), classify(), clearPreview(), configureIpc(), detachMainWindow() (+21 more)

### Community 37 - "desktop-idle.test.js"
Cohesion: 0.22
Nodes (5): configureDesktopIdleIpc(), assert, {
  CHANNEL,
  configureDesktopIdleIpc
}, createHarness(), { describe, it }

### Community 38 - "capture-relay.js"
Cohesion: 0.06
Nodes (50): buildReconfigureStdinPayload(), normalizeReconfigureCommand(), appendFrameChunk(), createFrameState(), getFramePayloadBytes(), takeBytes(), toFrameArrayBuffer(), {
  appendFrameChunk,
  createFrameState
} (+42 more)

### Community 39 - "SafeSystemAudioCapture.cpp"
Cohesion: 0.10
Nodes (6): ActivateProcessLoopbackAudioClient(), Fail(), HasArg(), LogEvent(), ReadDWORDArg(), wmain()

### Community 40 - "build-native-capture.js"
Cohesion: 0.20
Nodes (10): binDir, buildWindows(), fs, nativeDir, path, { requireMsvcEnv }, rootDir, run() (+2 more)

### Community 41 - "native-capture-policy.test.js"
Cohesion: 0.14
Nodes (6): getNativeCaptureInjectScript(), assert, { describe, it }, { getNativeCaptureInjectScript }, {
  NATIVE_CAPTURE_PROTOCOL_VERSION,
  NATIVE_CAPTURE_PORT_MESSAGE_TYPE
}, runInjectScript()

### Community 42 - "windows-native-capture-source.test.js"
Cohesion: 0.20
Nodes (9): assert, { describe, it }, fs, geometrySource, path, relaySource, relayTerminationFixtureSource, runtimeSmokeSource (+1 more)

### Community 43 - "Voice Room Desktop"
Cohesion: 0.08
Nodes (25): App icon follows the web theme, Auto-update, Autostart, Call controls in the tray, taskbar and Dock, Code signing policy, Commands, Context menu and spellcheck, Desktop runtime detection (+17 more)

### Community 44 - "electron/overlay.js"
Cohesion: 0.16
Nodes (21): {
  classifyForegroundApp,
  describeForeground,
  fileName,
  isGameCandidate,
  parseForegroundPayload
}, { createDesktopSettingsStore }, { createForegroundWatcher }, getForeground(), {
  OVERLAY_MARGIN_PX,
  boundsOverlap,
  isOverlayHtmlUrl,
  resolveOverlayBounds,
  sanitizeOverlaySettings,
  sanitizeOverlaySnapshot,
  shouldShowOverlay
}, path, BLACKLIST_NAMES, CANDIDATE_REASONS (+13 more)

### Community 45 - "windows-capture-policy.test.js"
Cohesion: 0.33
Nodes (7): getWindowsCaptureFeaturePolicy(), isWindows11OrNewerRelease(), normalizeWgcOverride(), parseWindowsBuildNumber(), assert, { describe, it }, {
  WGC_SCREEN_CAPTURER_FEATURE,
  getWindowsCaptureFeaturePolicy,
  isWindows11OrNewerRelease,
  parseWindowsBuildNumber
}

### Community 46 - "create-electron-config.js"
Cohesion: 0.28
Nodes (8): envPath, fs, loadDotEnv(), outputPath, path, readVoiceRoomUrl(), rootDir, writeRuntimeConfig()

### Community 47 - "validate-release-version.test.js"
Cohesion: 0.22
Nodes (7): assert, { describe, it }, packageJson, path, rootDir, { spawnSync }, validator

### Community 48 - "preload-desktop-runtime.test.js"
Cohesion: 0.12
Nodes (5): assert, fs, path, test, vm

### Community 49 - "security-origin.test.js"
Cohesion: 0.19
Nodes (21): fs, getFrameKey(), getFrameScopeKey(), getOriginFromUrl(), isPermissionContextTrusted(), isTransitionalWebContentsUrl(), isTrustedDisplayMediaRequest(), isTrustedFrame() (+13 more)

### Community 50 - ".StartWindowCapture"
Cohesion: 0.15
Nodes (10): Fail(), FrameWriteResult, kPipeClosed, kRecoverableFailure, kSkipped, kWrote, HandleSignal(), LogEvent() (+2 more)

### Community 51 - "capture.js"
Cohesion: 0.16
Nodes (19): { app, MessageChannelMain, utilityProcess }, cleanupSession(), { execFile }, failReconfigureRequests(), findScreenCursorCaptureHelper(), finishReconfigureRequest(), forceKillRelayTree(), fs (+11 more)

### Community 52 - "ref_node_path"
Cohesion: 0.14
Nodes (10): disableWindowsApplicationMenu(), fs, packageJson, path, rootDir, tag, tagVersion, assert (+2 more)

### Community 53 - "FrameCallbackState"
Cohesion: 0.12
Nodes (8): FrameCallbackLease, state_, FrameCallbackState, activeCallbacks_, drained_, mutex_, session_, stopping_

### Community 54 - "ref_node_child_process"
Cohesion: 0.14
Nodes (10): assert, path, { spawn }, { test }, assert, fs, os, path (+2 more)

### Community 55 - "window-context-menu.test.js"
Cohesion: 0.15
Nodes (12): appBootstrap, buildContextMenuTemplate(), configureSpellChecker(), installContextMenu(), isWebLink(), joinGroups(), PREFERRED_SPELLCHECK_LANGUAGES, resolveSpellCheckerLanguages() (+4 more)

### Community 56 - "policies/overlay.js"
Cohesion: 0.17
Nodes (18): loadSettings(), DEFAULT_OVERLAY_SETTINGS, sanitizeAllowedExecutables(), isOverlayHtmlUrl(), OVERLAY_ANCHORS, OVERLAY_AVATAR_SIZES, { sanitizeAllowedExecutables }, sanitizeAvatarAccent() (+10 more)

### Community 57 - "call-surfaces.test.js"
Cohesion: 0.11
Nodes (12): createWindowsTaskbarThemeReader(), refresh(), parseSystemUsesLightTheme(), ACTIVE, assert, {
  CALL_ICONS_DIR,
  PERSONALIZE_REGISTRY_KEY,
  buildThumbarButtons,
  createCallSurfaces,
  createWindowsTaskbarThemeReader,
  parseSystemUsesLightTheme,
  resolveCallIconPath
}, createHarness(), { describe, it } (+4 more)

### Community 58 - "CaptureTarget"
Cohesion: 0.11
Nodes (13): CaptureTarget, isWindow, monitor, monitorRect, window, FindMonitorByDeviceName(), GetWindowContentOrigin(), MonitorSearch (+5 more)

### Community 59 - "DWORD"
Cohesion: 0.18
Nodes (13): ConsoleControlHandler(), ForgetDownKey(), HandleKeyEvent(), HasRememberedSharedKey(), HasSharedVirtualKeyState(), MatchesPhysicalKey(), ParentPipeWatcher(), PhysicalKeyId() (+5 more)

### Community 60 - "ScreenCursorCapture.cpp"
Cohesion: 0.14
Nodes (4): LogReconfigured(), ParseJsonBoolField(), ParseJsonUintField(), StdinCommandLoop()

### Community 61 - "scripts"
Cohesion: 0.11
Nodes (18): scripts, build, build:dev, build:mac, build:mac:dev, build:win, build:win:dev, check (+10 more)

### Community 63 - "launch-mode.test.js"
Cohesion: 0.15
Nodes (12): consumeRelaunchIntent(), resolveStartHidden(), writeRelaunchIntent(), launchApplication(), resolveInitialStartHidden(), startBackgroundUpdates(), assert, { describe, it } (+4 more)

### Community 64 - "call-surfaces.js"
Cohesion: 0.21
Nodes (16): dispatch(), describeCallControls(), describeCallTooltip(), buildCallMenuItems(), buildThumbarButtons(), CALL_ICONS_DIR, createCallSurfaces(), apply() (+8 more)

### Community 65 - "mac.js"
Cohesion: 0.13
Nodes (11): { app }, log, mac, origin, { app, shell, systemPreferences }, createMacScreenCaptureAccessError(), ensureMacMicrophoneAccess(), getMacMicrophoneAccessStatus() (+3 more)

### Community 66 - "wmain"
Cohesion: 0.15
Nodes (14): CloseShutdownInfrastructure(), CodeDefinition, code, expectedVirtualKey, extended, scanCode, EmitHotkey(), FindCode() (+6 more)

### Community 67 - "package.json"
Cohesion: 0.12
Nodes (16): author, name, description, engines, node, license, main, name (+8 more)

### Community 68 - "desktop-keep-awake.test.js"
Cohesion: 0.17
Nodes (10): createKeepAwakeController(), dispose(), installPowerMonitor(), setScreenLocked(), setVoiceActive(), sync(), assert, { createKeepAwakeController } (+2 more)

### Community 69 - "desktop-overlay.test.js"
Cohesion: 0.12
Nodes (13): assert, CHROME, { createCallControlsController }, createHarness(), { createOverlayController, STATE_CHANNEL }, CS2, CUSTOM_GAME, { describe, it } (+5 more)

### Community 70 - "ui/overlay.js"
Cohesion: 0.21
Nodes (15): AVATAR_HUES, AVATAR_SIZES, avatarBackground(), avatarHue(), avatarInk(), createPerson(), element(), icon() (+7 more)

### Community 72 - "message-port-arraybuffer-electron.js"
Cohesion: 0.14
Nodes (10): { app, BrowserWindow, ipcMain, MessageChannelMain }, fail(), finish(), {
  getNativeCaptureInjectScript
}, http, {
  NATIVE_CAPTURE_PROTOCOL_VERSION
}, path, { randomUUID } (+2 more)

### Community 73 - "desktop-call-controls.test.js"
Cohesion: 0.16
Nodes (10): CALL_ACTIONS, INACTIVE_CALL_STATE, sameCallState(), sanitizeCallState(), stripControlCharacters(), {
  ACTION_CHANNEL,
  INACTIVE_CALL_STATE,
  STATE_CHANNEL,
  createCallControlsController,
  describeCallControls,
  describeCallTooltip,
  sanitizeCallState
}, ACTIVE, assert (+2 more)

### Community 74 - "audio.js"
Cohesion: 0.19
Nodes (14): diagnostics, { app }, canExecute(), EMPTY_AUDIO_BUFFER, findSafeSystemAudioHelper(), fs, getNativeAudioCapabilities(), getSafeSystemAudioHelperArgs() (+6 more)

### Community 75 - "msvc-env.js"
Cohesion: 0.19
Nodes (12): findVcvars64(), fs, hasExecutableOnPath(), MISSING_MSVC_MESSAGE, parseSetOutput(), path, pathValue(), resolveMsvcEnv() (+4 more)

### Community 76 - "desktop-capture/index.js"
Cohesion: 0.14
Nodes (7): { BrowserWindow, ipcMain }, {
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
}, { startSafeSystemAudioCapture, stopSafeSystemAudioCapture }

### Community 77 - "VoiceRoomHotkeys.cpp"
Cohesion: 0.31
Nodes (9): ForegroundKeyboardLayout(), InitializeDownKeyState(), InitializeModifierState(), IsKeyDown(), IsPhysicalKeyDown(), IsSharedKeyGroupDown(), NumpadNavigationVirtualKey(), SharedNavigationVirtualKey() (+1 more)

### Community 78 - "window/bootstrap.js"
Cohesion: 0.15
Nodes (11): configureWindowIpc(), { BrowserWindow, dialog }, { getMediaDeviceFilterInjectScript }, { getNativeCaptureCapabilities }, { getNativeCaptureInjectScript }, installBuildLabel(), installNativeCaptureBridge(), loadMainApplication() (+3 more)

### Community 79 - "mac-screen-capture-permission.test.js"
Cohesion: 0.15
Nodes (7): assert, { it }, Module, { afterEach, it }, assert, Module, stateModulePath

### Community 80 - "CaptureGeometry.h"
Cohesion: 0.24
Nodes (7): ComputeOutputSize(), FrameSize, height, width, MakeEvenDimension(), Expect(), main()

### Community 81 - "Binding"
Cohesion: 0.17
Nodes (12): Binding, action, active, key, modifiers, pressQueued, releaseQueued, PhysicalKey (+4 more)

### Community 82 - "ModifierState"
Cohesion: 0.17
Nodes (10): ModifierState, leftAlt, leftControl, leftMeta, leftShift, rightAlt, rightControl, rightMeta (+2 more)

### Community 83 - "desktop-diagnostics.test.js"
Cohesion: 0.18
Nodes (6): assert, {
  COPY_INFO_CHANNEL,
  GET_INFO_CHANNEL,
  OPEN_LOGS_CHANNEL,
  SET_CONTEXT_CHANNEL,
  createDiagnosticsController,
  resolvePackageType,
  sanitizeContextId,
  summarizeGpuStatus
}, createHarness(), { describe, it }, LOG_FILE, path

### Community 84 - "WriteStatus"
Cohesion: 0.24
Nodes (4): WriteStatus, kFailedBeforeWrite, kPipeClosed, kWrote

### Community 85 - "Code signing policy"
Cohesion: 0.25
Nodes (6): Artifact scope, Code signing policy, Current status, Privacy, Target Windows signing flow, Team roles

### Community 86 - "createCallControlsController"
Cohesion: 0.47
Nodes (8): createCallControlsController(), attachOwner(), configureIpc(), detachOwner(), notify(), reset(), setCurrentState(), setState()

### Community 87 - "createDiagnosticsController"
Cohesion: 0.42
Nodes (9): createDiagnosticsController(), configureIpc(), copyInfo(), getInfo(), openLogsFolder(), safely(), setContext(), sanitizeContextId() (+1 more)

### Community 88 - "ref_node_events"
Cohesion: 0.25
Nodes (5): assert, createAutoUpdater(), { describe, it }, EventEmitter, Module

### Community 89 - "wmain"
Cohesion: 0.39
Nodes (4): ParseSourceArg(), ReadStringArg(), ReadUIntArg(), wmain()

### Community 90 - "electron/diagnostics.js"
Cohesion: 0.38
Nodes (6): formatDiagnosticsText(), GPU_FEATURES, path, resolvePackageType(), summarizeGpuStatus(), yesNo()

### Community 91 - "capture-contract.js"
Cohesion: 0.48
Nodes (4): hasChromiumAudioRequest(), isCompatibleNativeCaptureSession(), isNativeOnlyDisplayMediaCandidate(), {
  NATIVE_CAPTURE_PORT_MESSAGE_TYPE,
  NATIVE_CAPTURE_PROTOCOL_VERSION,
  hasChromiumAudioRequest,
  isCompatibleNativeCaptureSession,
  isNativeOnlyDisplayMediaCandidate
}

### Community 93 - "Releasing Voice Room Desktop"
Cohesion: 0.33
Nodes (6): Configuration, Create a release, Pre-release CI, Releasing Voice Room Desktop, Signing, Versioning

### Community 94 - "ScaleCoordinate"
Cohesion: 0.33
Nodes (4): ScaleCoordinate, high, low, weight

### Community 95 - "EmitReady"
Cohesion: 0.33
Nodes (5): EmitReady(), Failure, action, reason, JsonEscape()

### Community 96 - "oh-my-codex - Intelligent Multi-Agent Orchestration"
Cohesion: 0.40
Nodes (4): Model Capability Table, oh-my-codex - Intelligent Multi-Agent Orchestration, Setup, Working agreements

### Community 97 - "positionWindow"
Cohesion: 0.40
Nodes (5): positionWindow(), setContentSize(), targetWorkArea(), toDipBounds(), resolveOverlayBounds()

### Community 98 - "screen-picker-icons.js"
Cohesion: 0.50
Nodes (4): getPickerIcons(), ICON_SIZES, PICKER_ICON_NAMES, renderPickerIcons()

### Community 99 - "ReconfigureResult"
Cohesion: 0.40
Nodes (4): ReconfigureResult, fps, maxHeight, maxWidth

### Community 102 - "Windows tray lifecycle smoke test"
Cohesion: 0.50
Nodes (3): Checks, Setup, Windows tray lifecycle smoke test

### Community 105 - "VideoProcessorInputMode"
Cohesion: 0.50
Nodes (4): VideoProcessorInputMode, kCopied, kDirect, kNone

### Community 106 - "foreground.ps1"
Cohesion: 0.83
Nodes (3): Get-ProcessExecutablePath(), Get-Snapshot(), Get-WindowBounds()

### Community 107 - "dependencies"
Cohesion: 0.50
Nodes (4): dependencies, electron-log, electron-updater, lucide

### Community 111 - "gameOnScreen"
Cohesion: 0.67
Nodes (3): gameOnScreen(), isShellSurface(), boundsOverlap()

### Community 113 - "devDependencies"
Cohesion: 0.67
Nodes (3): devDependencies, electron, electron-builder

## Knowledge Gaps
- **144 isolated node(s):** `AVFoundation`, `CoreAudio`, `CoreMedia`, `ScreenCaptureKit`, `width` (+139 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1082 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `electron` connect `electron` to `mac.js`, `main.js`, `app-topbar-view.test.js`, `update-gate.js`, `package.json`, `generate-call-icons.js`, `message-port-arraybuffer-electron.js`, `audio.js`, `desktop-capture/index.js`, `window/bootstrap.js`, `windows-native-capture-smoke.js`, `capture.js`, `ref_node_child_process`, `desktop-capture/state.js`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **What connects `AVFoundation`, `CoreAudio`, `CoreMedia` to the rest of the system?**
  _144 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `update-gate.js` be split into smaller, more focused modules?**
  _Cohesion score 0.07973421926910298 - nodes in this community are weakly interconnected._
- **Why does `createOverlayController()` connect `createOverlayController` to `positionWindow`, `main.js`, `desktop-overlay.test.js`, `desktop-autostart.test.js`, `electron/overlay.js`, `gameOnScreen`, `policies/overlay.js`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **Should `main.js` be split into smaller, more focused modules?**
  _Cohesion score 0.029850746268656716 - nodes in this community are weakly interconnected._
- **Why does `CaptureSession` connect `CaptureSession` to `ReconfigureResult`, `FrameWriter`, `.Initialize`, `.StartWindowCapture`, `FrameCallbackState`, `wmain`, `CaptureTarget`, `ScreenCursorCapture.cpp`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **Should `app-topbar-view.test.js` be split into smaller, more focused modules?**
  _Cohesion score 0.0753045404208195 - nodes in this community are weakly interconnected._