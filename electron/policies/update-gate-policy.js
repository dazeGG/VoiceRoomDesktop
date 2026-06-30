'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Squirrel.Mac requires Developer ID signing + notarization. Flip to true after
// Apple signing is configured in CI and electron-builder.config.js.
const MAC_AUTO_UPDATE_ENABLED = false;

function readBuildProfile(appPath = '') {
  if (!appPath) return null;

  try {
    return JSON.parse(fs.readFileSync(path.join(appPath, 'electron', 'build-profile.json'), 'utf8'));
  } catch {
    return null;
  }
}

function shouldRunUpdateGateState({
  isPackaged,
  previewEnabled = false,
  appPath = '',
  buildProfile = null,
  platform = process.platform,
  macAutoUpdateEnabled = MAC_AUTO_UPDATE_ENABLED
} = {}) {
  if (!isPackaged || previewEnabled) return false;

  const profile = buildProfile || readBuildProfile(appPath);
  if (profile?.channel === 'dev') return false;

  if (platform === 'darwin' && !macAutoUpdateEnabled) return false;

  return true;
}

module.exports = {
  MAC_AUTO_UPDATE_ENABLED,
  readBuildProfile,
  shouldRunUpdateGateState
};