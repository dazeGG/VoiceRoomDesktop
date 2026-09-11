'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const {
  HIDDEN_LAUNCH_ARG,
  RELAUNCH_INTENT_FILE,
  RELAUNCH_INTENT_TTL_MS,
  consumeRelaunchIntent,
  resolveStartHidden,
  writeRelaunchIntent
} = require('../electron/app/launch-mode');

function tempUserData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-room-launch-mode-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}

describe('resolveStartHidden', () => {
  it('starts hidden for the Windows login-item argument only', () => {
    assert.equal(resolveStartHidden({ argv: ['Voice Room.exe', HIDDEN_LAUNCH_ARG], platform: 'win32' }), true);
    assert.equal(resolveStartHidden({ argv: ['Voice Room.exe'], platform: 'win32', startMinimized: true }), false);
  });

  it('uses the stored preference for macOS login-item launches', () => {
    const openedAtLogin = { wasOpenedAtLogin: true };

    assert.equal(resolveStartHidden({ loginItemSettings: openedAtLogin, platform: 'darwin', startMinimized: true }), true);
    assert.equal(resolveStartHidden({ loginItemSettings: openedAtLogin, platform: 'darwin', startMinimized: false }), false);
    assert.equal(resolveStartHidden({ loginItemSettings: { wasOpenedAtLogin: false }, platform: 'darwin', startMinimized: true }), false);
  });

  it('honours a hidden relaunch intent left by a background update', () => {
    assert.equal(resolveStartHidden({ platform: 'win32', relaunchIntent: { startHidden: true } }), true);
    assert.equal(resolveStartHidden({ platform: 'win32', relaunchIntent: { startHidden: false } }), false);
  });
});

describe('relaunch intent file', () => {
  it('round-trips once and removes the file', (t) => {
    const userDataPath = tempUserData(t);

    assert.equal(writeRelaunchIntent({ fs, path, startHidden: true, userDataPath, now: 5_000 }), true);
    assert.deepEqual(consumeRelaunchIntent({ fs, path, userDataPath, now: 6_000 }), { startHidden: true });
    assert.equal(fs.existsSync(path.join(userDataPath, RELAUNCH_INTENT_FILE)), false);
    assert.equal(consumeRelaunchIntent({ fs, path, userDataPath, now: 6_000 }), null);
  });

  it('ignores stale, future, and corrupt intents', (t) => {
    const userDataPath = tempUserData(t);
    const filePath = path.join(userDataPath, RELAUNCH_INTENT_FILE);

    writeRelaunchIntent({ fs, path, startHidden: true, userDataPath, now: 0 });
    assert.equal(consumeRelaunchIntent({ fs, path, userDataPath, now: RELAUNCH_INTENT_TTL_MS + 1 }), null);
    assert.equal(fs.existsSync(filePath), false);

    writeRelaunchIntent({ fs, path, startHidden: true, userDataPath, now: 10_000 });
    assert.equal(consumeRelaunchIntent({ fs, path, userDataPath, now: 1_000 }), null);

    fs.writeFileSync(filePath, '{not json');
    assert.equal(consumeRelaunchIntent({ fs, path, userDataPath, now: 1_000 }), null);
  });
});
