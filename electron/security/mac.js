'use strict';

const { t } = require('../localization');

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
  const appName = app.getName() || 'VoiceRoom';
  const devHint = process.defaultApp ? t('macDevHint') : '';
  const causeText = cause?.message ? `\nElectron: ${cause.message}` : '';
  const error = new Error(
    [
      t('macCaptureDenied'),
      t('macCaptureStatus', { status }),
      t('macCaptureSettings', { appName, devHint }),
      t('macCaptureReadd'),
      t('macCaptureRestart')
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

module.exports = {
  createMacScreenCaptureAccessError,
  ensureMacMicrophoneAccess,
  getMacMicrophoneAccessStatus,
  getMacScreenCaptureStatus,
  grantMacMediaPermission,
  openMacMicrophoneSettings,
  openMacScreenCaptureSettings
};
