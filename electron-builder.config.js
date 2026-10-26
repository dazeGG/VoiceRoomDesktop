'use strict';

const buildHash = (process.env.VOICE_ROOM_BUILD_HASH || '').trim();
const outputDir = (process.env.VOICE_ROOM_DIST_DIR || 'dist').trim();
// Dev builds (prerelease tags / `--dev`) ship a lightweight artifact set with no
// auto-update plumbing: just the macOS .dmg installers and a single portable
// Windows .exe — matching the older releases. Stable builds add the auto-update
// targets (mac .zip, Windows nsis installer) plus their latest*.yml + .blockmap.
const isDevBuild = (process.env.VOICE_ROOM_DEV_BUILD || '') === '1';

// Base artifact name shared by every target. The slug must stay free of
// spaces: electron-builder rewrites a space to a hyphen in latest.yml while
// GitHub rewrites it to a dot in the uploaded asset name, so the URL in
// latest.yml would never match the asset and electron-updater 404s. It was
// "Voice-Room" up to 1.4.6; the site picks assets by their suffix
// (-mac-arm64.dmg, -win-x64-setup.exe), not by the slug.
const artifactBase = buildHash
  ? `VoiceRoom-\${version}-${buildHash}-\${os}-\${arch}`
  : 'VoiceRoom-${version}-${os}-${arch}';

module.exports = {
  appId: 'ru.dazinho.voiceroom',
  // "Voice Room" up to 1.4.6. It names the executable and the .app bundle,
  // not the user data folder: Electron takes that from package.json `name`
  // (voice-room-desktop), which never changed. electron/autostart.js moves
  // the Windows autostart entry from the old executable.
  productName: 'VoiceRoom',
  publish: {
    provider: 'github',
    owner: 'dazeGG',
    repo: 'VoiceRoomDesktop'
  },
  artifactName: `${artifactBase}.\${ext}`,
  // Installers (nsis, mac Info.plist) register the link scheme; dev builds use
  // their own scheme so they never capture production links.
  protocols: [
    {
      name: 'VoiceRoom',
      schemes: [isDevBuild ? 'voiceroom-dev' : 'voiceroom']
    }
  ],
  directories: {
    output: outputDir
  },
  asarUnpack: [
    'native/bin/**/*',
    'native/overlay/windows/**/*'
  ],
  files: [
    'assets/call/*.png',
    'assets/logo/icon.ico',
    'assets/logo/icon.png',
    'assets/logo/themes/*.ico',
    'assets/logo/themes/*.png',
    'electron/call-controls.js',
    'electron/system-events.js',
    'electron/update-bridge.js',
    'electron/window/background-throttling.js',
    'electron/deep-links.js',
    'electron/diagnostics.js',
    'electron/window/call-surfaces.js',
    'electron/window/state.js',
    'electron/app/bootstrap.js',
    'electron/app/launch-mode.js',
    'electron/build-profile.json',
    'electron/desktop-capture/index.js',
    'electron/desktop-capture/state.js',
    'electron/dev/diagnostics.js',
    'electron/policies/desktop-capture.js',
    'electron/logger.js',
    'electron/policies/media-device.js',
    'electron/main.js',
    'electron/hotkeys.js',
    'electron/native/hotkeys.js',
    'electron/idle.js',
    'electron/process-load.js',
    'electron/attention.js',
    'electron/app-icon.js',
    'electron/autostart.js',
    'electron/keep-awake.js',
    'electron/native/audio.js',
    'electron/notifications.js',
    'electron/desktop-settings.js',
    'electron/overlay.js',
    'electron/overlay-foreground.js',
    'electron/policies/overlay.js',
    'electron/policies/overlay-games.js',
    'electron/ui/overlay-preload.js',
    'electron/ui/overlay.css',
    'electron/ui/overlay.html',
    'electron/ui/overlay.js',
    'electron/native-capture-contract.js',
    'electron/native/capture-contract.js',
    'electron/native/capture.js',
    'electron/native/capture-frames.js',
    'electron/policies/native-capture.js',
    'electron/policies/native-capture-restart.js',
    'electron/policies/windows-capture.js',
    'electron/window/open-admin.js',
    'electron/window/app-topbar-view.js',
    'electron/window/bootstrap.js',
    'electron/window/context-menu.js',
    'electron/window/lifecycle-policy.js',
    'electron/window/lifecycle.js',
    'electron/window/menu-policy.js',
    'electron/window/tray-icon.js',
    'electron/native/capture-relay.js',
    'electron/shell-theme.js',
    'electron/shell-tokens.css',
    'electron/preload.js',
    'electron/security/index.js',
    'electron/security/mac.js',
    'electron/security/origin.js',
    'electron/ui/app-topbar.css',
    'electron/ui/app-topbar.html',
    'electron/ui/renderer-recovery.css',
    'electron/ui/renderer-recovery.html',
    'electron/ui/renderer-recovery.js',
    'electron/runtime-config.json',
    'electron/ui/screen-picker-preload.js',
    'electron/ui/screen-picker-preview.html',
    'electron/ui/screen-picker-preview.css',
    'electron/ui/screen-picker-icons.js',
    'electron/ui/screen-picker.js',
    'electron/policies/update-gate-policy.js',
    'electron/policies/update-gate-state.js',
    'electron/policies/update-background.js',
    'electron/policies/update-gate.js',
    'electron/ui/update-preload.js',
    'electron/ui/update-splash.css',
    'electron/ui/update-splash.html',
    'electron/ui/update-splash.js',
    'native/bin/**/*',
    'native/overlay/windows/foreground.ps1',
    'node_modules/lucide/dist/umd/lucide.min.js',
    'package.json'
  ],
  mac: {
    category: 'public.app-category.social-networking',
    hardenedRuntime: false,
    icon: 'assets/logo/icon.icns',
    target: isDevBuild
      ? [
          {
            target: 'dmg',
            arch: ['arm64', 'x64']
          }
        ]
      : [
          {
            target: 'dmg',
            arch: ['arm64', 'x64']
          },
          {
            target: 'zip',
            arch: ['arm64', 'x64']
          }
        ],
    extendInfo: {
      NSMicrophoneUsageDescription: 'VoiceRoom использует микрофон для голосового чата.',
      NSScreenCaptureDescription: 'VoiceRoom использует запись экрана для демонстрации экрана участникам комнаты.',
      NSAudioCaptureUsageDescription: 'VoiceRoom использует системный звук во время демонстрации экрана, если он доступен.',
      NSCameraUsageDescription: 'VoiceRoom не использует камеру, но системный WebRTC-диалог может запросить это разрешение.'
    }
  },
  win: {
    icon: 'assets/logo/icon.ico',
    legalTrademarks: 'VoiceRoom',
    // Dev: single portable .exe (no auto-update; the dev channel skips the update
    // gate anyway). Stable: nsis installer (emits latest.yml + .blockmap so
    // electron-updater can auto-update in place) plus the portable .exe as a
    // no-install convenience download.
    target: isDevBuild
      ? [
          {
            target: 'portable',
            arch: ['x64']
          }
        ]
      : [
          {
            target: 'nsis',
            arch: ['x64']
          },
          {
            target: 'portable',
            arch: ['x64']
          }
        ]
  },
  // Only nsis needs a suffix: in stable builds it coexists with the portable .exe,
  // so it takes "-setup" while portable keeps the plain base name.
  nsis: {
    artifactName: `${artifactBase}-setup.\${ext}`,
    // Removes the (possibly disabled) autostart Run entry on uninstall.
    include: 'build/installer.nsh'
  }
};
