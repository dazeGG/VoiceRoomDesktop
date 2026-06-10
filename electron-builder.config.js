'use strict';

const buildHash = (process.env.VOICE_ROOM_BUILD_HASH || '').trim();
const outputDir = (process.env.VOICE_ROOM_DIST_DIR || 'dist').trim();

module.exports = {
  appId: 'ru.dazinho.voiceroom',
  productName: 'Voice Room',
  publish: {
    provider: 'github',
    owner: 'dazeGG',
    repo: 'VoiceRoomDesktop'
  },
  artifactName: buildHash
    ? `\${productName}-\${version}-${buildHash}-\${os}-\${arch}.\${ext}`
    : '${productName}-${version}-${os}-${arch}.${ext}',
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
      {
        target: 'portable',
        arch: ['x64']
      }
    ]
  }
};
