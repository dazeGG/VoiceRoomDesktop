'use strict';

const buildHash = (process.env.VOICE_ROOM_BUILD_HASH || '').trim();
const outputDir = (process.env.VOICE_ROOM_DIST_DIR || 'dist').trim();

// Base artifact name shared by every target. Both Windows targets emit a .exe,
// so each one appends a distinct suffix below to avoid clobbering the other.
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
    'electron/build-profile.json',
    'electron/desktop-capture-policy.js',
    'electron/logger.js',
    'electron/media-device-policy.js',
    'electron/main.js',
    'electron/native-audio.js',
    'electron/shell-theme.js',
    'electron/shell-tokens.css',
    'electron/preload.js',
    'electron/renderer-recovery.css',
    'electron/renderer-recovery.html',
    'electron/renderer-recovery.js',
    'electron/runtime-config.json',
    'electron/screen-picker-preload.js',
    'electron/screen-picker-preview.html',
    'electron/screen-picker-preview.css',
    'electron/screen-picker.js',
    'electron/update-gate-policy.js',
    'electron/update-gate.js',
    'electron/update-preload.js',
    'electron/update-splash.css',
    'electron/update-splash.html',
    'electron/update-splash.js',
    'native/bin/**/*',
    'package.json'
  ],
  mac: {
    category: 'public.app-category.social-networking',
    hardenedRuntime: false,
    icon: 'assets/logo/icon.icns',
    identity: null,
    target: [
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
    target: [
      // nsis = installed app that electron-updater can auto-update (this target
      // emits latest.yml + .blockmap, which the update gate needs). portable =
      // no-install standalone .exe kept as a convenience download.
      // Caveat: only the nsis install auto-updates in place; a portable copy that
      // hits the update gate will download and run the nsis installer instead.
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
  nsis: {
    artifactName: `${artifactBase}-setup.\${ext}`
  },
  portable: {
    artifactName: `${artifactBase}-portable.\${ext}`
  }
};
