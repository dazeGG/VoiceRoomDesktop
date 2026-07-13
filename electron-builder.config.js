'use strict';

const buildHash = (process.env.VOICE_ROOM_BUILD_HASH || '').trim();
const outputDir = (process.env.VOICE_ROOM_DIST_DIR || 'dist').trim();
// Dev builds (prerelease tags / `--dev`) ship a lightweight artifact set with no
// auto-update plumbing: just the macOS .dmg installers and a single portable
// Windows .exe — matching the older releases. Stable builds add the auto-update
// targets (mac .zip, Windows nsis installer) plus their latest*.yml + .blockmap.
const isDevBuild = (process.env.VOICE_ROOM_DEV_BUILD || '') === '1';

// Base artifact name shared by every target.
//
// The product slug is hard-coded as "Voice-Room" instead of ${productName}
// on purpose: productName is "Voice Room" (with a space), and a space in the
// filename breaks auto-update. electron-builder rewrites the space to a hyphen
// in latest.yml, while GitHub rewrites it to a dot in the uploaded asset name —
// so the URL in latest.yml (Voice-Room-…) never matches the asset (Voice.Room-…)
// and electron-updater 404s on download. A space-free slug keeps all three
// (on-disk file, GitHub asset, latest.yml url) identical.
const artifactBase = buildHash
  ? `Voice-Room-\${version}-${buildHash}-\${os}-\${arch}`
  : 'Voice-Room-${version}-${os}-${arch}';

module.exports = {
  appId: 'ru.dazinho.voiceroom',
  productName: 'Voice Room',
  publish: {
    provider: 'github',
    owner: 'dazeGG',
    repo: 'VoiceRoomDesktop'
  },
  artifactName: `${artifactBase}.\${ext}`,
  directories: {
    output: outputDir
  },
  asarUnpack: [
    'native/bin/**/*'
  ],
  files: [
    'assets/logo/icon.ico',
    'electron/app/bootstrap.js',
    'electron/build-profile.json',
    'electron/desktop-capture/index.js',
    'electron/desktop-capture/state.js',
    'electron/dev/diagnostics.js',
    'electron/policies/desktop-capture.js',
    'electron/logger.js',
    'electron/policies/media-device.js',
    'electron/main.js',
    'electron/native/audio.js',
    'electron/notifications.js',
    'electron/native-capture-contract.js',
    'electron/native/capture-contract.js',
    'electron/native/capture.js',
    'electron/native/capture-frames.js',
    'electron/policies/native-capture.js',
    'electron/policies/native-capture-restart.js',
    'electron/policies/windows-capture.js',
    'electron/window/app-topbar-view.js',
    'electron/window/bootstrap.js',
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
    'electron/ui/screen-picker.js',
    'electron/policies/update-gate-policy.js',
    'electron/policies/update-gate-state.js',
    'electron/policies/update-gate.js',
    'electron/ui/update-preload.js',
    'electron/ui/update-splash.css',
    'electron/ui/update-splash.html',
    'electron/ui/update-splash.js',
    'native/bin/**/*',
    'package.json'
  ],
  mac: {
    category: 'public.app-category.social-networking',
    hardenedRuntime: false,
    icon: 'assets/logo/icon.icns',
    identity: null,
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
      NSMicrophoneUsageDescription: 'Voice Room использует микрофон для голосового чата.',
      NSScreenCaptureDescription: 'Voice Room использует запись экрана для демонстрации экрана участникам комнаты.',
      NSAudioCaptureUsageDescription: 'Voice Room использует системный звук во время демонстрации экрана, если он доступен.',
      NSCameraUsageDescription: 'Voice Room не использует камеру, но системный WebRTC-диалог может запросить это разрешение.'
    }
  },
  win: {
    icon: 'assets/logo/icon.ico',
    legalTrademarks: 'Voice Room',
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
    artifactName: `${artifactBase}-setup.\${ext}`
  }
};
