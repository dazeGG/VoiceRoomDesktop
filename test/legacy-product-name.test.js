'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const { migrateLegacyProductFolders } = require('../electron/app/legacy-product-name');

function createHarness(t, { isPackaged = true, name = 'VoiceRoom' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-room-rename-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const appData = path.join(root, 'AppData');
  const home = path.join(root, 'home');
  fs.mkdirSync(appData, { recursive: true });
  const app = {
    isPackaged,
    paths: { appData, userData: path.join(appData, name) },
    getName: () => name,
    getPath: (key) => app.paths[key],
    setPath: (key, value) => {
      app.paths[key] = value;
    }
  };
  const legacyProfile = path.join(appData, 'Voice Room');
  const writeProfile = (dir, text) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Local State'), text);
  };
  const migrate = (options = {}) =>
    migrateLegacyProductFolders({ app, fs, homedir: home, path, platform: 'win32', ...options });
  return { app, appData, home, legacyProfile, migrate, writeProfile };
}

describe('legacy "Voice Room" folders', () => {
  it('moves the old profile to the new name, so settings and the session carry over', (t) => {
    const { app, legacyProfile, migrate, writeProfile } = createHarness(t);
    writeProfile(legacyProfile, 'old');

    assert.deepEqual(migrate().map(({ result }) => result), ['moved']);
    assert.equal(fs.existsSync(legacyProfile), false);
    assert.equal(fs.readFileSync(path.join(app.getPath('userData'), 'Local State'), 'utf8'), 'old');
  });

  it('removes a leftover old profile once the new one is in use, so the two never sit side by side', (t) => {
    const { app, legacyProfile, migrate, writeProfile } = createHarness(t);
    writeProfile(legacyProfile, 'old');
    writeProfile(app.getPath('userData'), 'new');

    assert.deepEqual(migrate().map(({ result }) => result), ['removed']);
    assert.equal(fs.existsSync(legacyProfile), false);
    assert.equal(fs.readFileSync(path.join(app.getPath('userData'), 'Local State'), 'utf8'), 'new');
  });

  it('lets the old profile replace a new folder that holds no profile yet', (t) => {
    const { app, legacyProfile, migrate, writeProfile } = createHarness(t);
    writeProfile(legacyProfile, 'old');
    fs.mkdirSync(path.join(app.getPath('userData'), 'logs'), { recursive: true });

    assert.deepEqual(migrate().map(({ result }) => result), ['moved']);
    assert.equal(fs.readFileSync(path.join(app.getPath('userData'), 'Local State'), 'utf8'), 'old');
    assert.equal(fs.existsSync(legacyProfile), false);
  });

  it('keeps using the old profile for this run when it cannot be moved', (t) => {
    const { app, legacyProfile, migrate, writeProfile } = createHarness(t);
    writeProfile(legacyProfile, 'old');
    const lockedFs = {
      ...fs,
      renameSync() {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
    };

    const [move] = migrate({ fs: lockedFs });
    assert.equal(move.result, 'failed');
    assert.equal(app.getPath('userData'), legacyProfile);
  });

  it('moves the macOS log folder too', (t) => {
    const { home, legacyProfile, migrate, writeProfile } = createHarness(t);
    writeProfile(legacyProfile, 'old');
    const logs = path.join(home, 'Library', 'Logs');
    fs.mkdirSync(path.join(logs, 'Voice Room'), { recursive: true });
    fs.writeFileSync(path.join(logs, 'Voice Room', 'main.log'), 'line');

    assert.deepEqual(migrate({ platform: 'darwin' }).map(({ result }) => result), ['moved', 'moved']);
    assert.equal(fs.readFileSync(path.join(logs, 'VoiceRoom', 'main.log'), 'utf8'), 'line');
    assert.equal(fs.existsSync(path.join(logs, 'Voice Room')), false);
  });

  it('leaves development runs and a fresh install alone', (t) => {
    const dev = createHarness(t, { isPackaged: false, name: 'voice-room-desktop' });
    dev.writeProfile(dev.legacyProfile, 'installed app');
    assert.deepEqual(dev.migrate(), []);
    assert.equal(fs.existsSync(dev.legacyProfile), true);

    const fresh = createHarness(t);
    assert.deepEqual(fresh.migrate().map(({ result }) => result), ['none']);
  });
});
