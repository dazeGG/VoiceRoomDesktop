'use strict';

const { app, shell, systemPreferences } = require('electron');
const log = require('../logger');

function getMacMicrophoneAccessStatus() {
  if (process.platform !== 'darwin') return 'not-applicable';
  try {
    return systemPreferences.getMediaAccessStatus('microphone');
  } catch {
    return 'unknown';
  }
}

async function ensureMacMicrophoneAccess() {
  if (process.platform !== 'darwin') {
    return { granted: true, platform: process.platform, status: 'not-applicable' };
  }

  const status = getMacMicrophoneAccessStatus();
  if (status === 'granted') {
    return { granted: true, platform: process.platform, status };
  }
  if (status === 'denied' || status === 'restricted') {
    return { granted: false, platform: process.platform, status };
  }

  const granted = await systemPreferences.askForMediaAccess('microphone');
  return {
    granted,
    platform: process.platform,
    status: getMacMicrophoneAccessStatus()
  };
}

async function grantMacMediaPermission(details = {}) {
  const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  const wantsAudio = mediaTypes.length === 0 || mediaTypes.includes('audio');
  const wantsVideo = mediaTypes.includes('video');
  const prompts = [];

  if (wantsAudio) prompts.push(systemPreferences.askForMediaAccess('microphone'));
  if (wantsVideo) prompts.push(systemPreferences.askForMediaAccess('camera'));

  if (!prompts.length) return true;

  const results = await Promise.all(prompts);
  return results.every(Boolean);
}

function openMacMicrophoneSettings() {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone').catch((error) => {
    log.warn('Failed to open macOS Microphone settings:', error);
  });
}

function getMacScreenCaptureStatus() {
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch {
    return 'unknown';
  }
}

function createMacScreenCaptureAccessError(cause) {
  const status = getMacScreenCaptureStatus();
  const appName = app.getName() || 'Voice Room';
  const devHint = process.defaultApp ? ' При запуске через npm run electron разрешение может называться Electron.' : '';
  const causeText = cause?.message ? `\nElectron: ${cause.message}` : '';
  const error = new Error(
    [
      'macOS не дала приложению доступ к записи экрана.',
      `Статус Screen Recording: ${status}.`,
      `Откройте System Settings -> Privacy & Security -> Screen & System Audio Recording и включите ${appName}.${devHint}`,
      'После изменения полностью закройте и снова откройте приложение.'
    ].join('\n') + causeText
  );
  error.name = 'ScreenCapturePermissionError';
  return error;
}

function openMacScreenCaptureSettings(options = {}) {
  const now = Date.now();
  if (!options.force && now - openMacScreenCaptureSettings.lastOpenAt < 5000) return;

  openMacScreenCaptureSettings.lastOpenAt = now;
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').catch((error) => {
    log.warn('Failed to open macOS Screen Recording settings:', error);
  });
}
openMacScreenCaptureSettings.lastOpenAt = 0;

function assertMacScreenCaptureAccess() {
  if (process.platform !== 'darwin') return;

  const status = getMacScreenCaptureStatus();
  if (status === 'granted' || status === 'unknown') return;

  openMacScreenCaptureSettings();
  throw createMacScreenCaptureAccessError();
}

module.exports = {
  assertMacScreenCaptureAccess,
  createMacScreenCaptureAccessError,
  ensureMacMicrophoneAccess,
  getMacMicrophoneAccessStatus,
  getMacScreenCaptureStatus,
  grantMacMediaPermission,
  openMacMicrophoneSettings,
  openMacScreenCaptureSettings
};
