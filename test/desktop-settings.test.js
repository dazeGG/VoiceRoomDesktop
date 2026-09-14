'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const { SETTINGS_FILE, createDesktopSettingsStore } = require('../electron/desktop-settings');

function createHarness(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-room-settings-'));
  t.after(() => fs.rmSync(userDataPath, { force: true, recursive: true }));
  const store = createDesktopSettingsStore({
    app: { getPath: () => userDataPath },
    fs,
    log: { warn() {} },
    path
  });
  return { store, userDataPath };
}

describe('desktop settings store', () => {
  it('returns an empty object when the file is missing or invalid', (t) => {
    const { store, userDataPath } = createHarness(t);
    assert.deepEqual(store.read(), {});
    fs.writeFileSync(path.join(userDataPath, SETTINGS_FILE), 'nope');
    assert.deepEqual(store.read(), {});
    fs.writeFileSync(path.join(userDataPath, SETTINGS_FILE), '[]');
    assert.deepEqual(store.read(), {});
  });

  it('patches without dropping unrelated keys', (t) => {
    const { store, userDataPath } = createHarness(t);
    store.patch({ startMinimized: true });
    store.patch({ overlay: { enabled: false } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDataPath, SETTINGS_FILE), 'utf8')), {
      overlay: { enabled: false },
      startMinimized: true
    });
  });
});
