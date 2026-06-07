'use strict';

const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const envPath = path.join(rootDir, '.env');
const outputPath = path.join(rootDir, 'electron', 'runtime-config.json');

function loadDotEnv() {
  if (!fs.existsSync(envPath)) return {};

  return fs
    .readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .reduce((env, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return env;

      const separator = trimmed.indexOf('=');
      if (separator === -1) return env;

      const key = trimmed.slice(0, separator).trim();
      const rawValue = trimmed.slice(separator + 1).trim();
      env[key] = rawValue.replace(/^(['"])(.*)\1$/, '$2');
      return env;
    }, {});
}

function readVoiceRoomUrl() {
  const dotEnv = loadDotEnv();
  const value = process.env.VOICE_ROOM_URL || dotEnv.VOICE_ROOM_URL;
  if (!value) {
    throw new Error('Set VOICE_ROOM_URL in .env before running Electron or building desktop artifacts.');
  }

  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('VOICE_ROOM_URL must use https, localhost, or 127.0.0.1.');
  }

  return url.toString().replace(/\/$/, '');
}

function writeRuntimeConfig() {
  const voiceRoomUrl = readVoiceRoomUrl();
  fs.writeFileSync(`${outputPath}.tmp`, `${JSON.stringify({ voiceRoomUrl }, null, 2)}\n`);
  fs.renameSync(`${outputPath}.tmp`, outputPath);
}

try {
  writeRuntimeConfig();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
