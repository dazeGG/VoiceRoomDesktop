'use strict';

function shouldUseWindowsTray(platform = process.platform) {
  return platform === 'win32';
}

function shouldHideToTrayOnClose({ isExplicitQuit = false, platform = process.platform } = {}) {
  return shouldUseWindowsTray(platform) && !isExplicitQuit;
}

function shouldQuitWhenAllWindowsClosed({
  isExplicitQuit = false,
  platform = process.platform,
  trayEnabled = false
} = {}) {
  if (platform === 'darwin') return false;
  if (shouldUseWindowsTray(platform) && trayEnabled && !isExplicitQuit) return false;
  return true;
}

function isAltF4Input(input = {}) {
  const key = String(input.key || '').toLowerCase();
  return input.type === 'keyDown' && Boolean(input.alt) && key === 'f4';
}

module.exports = {
  isAltF4Input,
  shouldHideToTrayOnClose,
  shouldQuitWhenAllWindowsClosed,
  shouldUseWindowsTray
};
