'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
  buildProfile = null
} = {}) {
  if (!isPackaged || previewEnabled) return false;

  const profile = buildProfile || readBuildProfile(appPath);
  if (profile?.channel === 'dev') return false;

  return true;
}

module.exports = {
  readBuildProfile,
  shouldRunUpdateGateState
};