'use strict';

const SETTINGS_FILE = 'desktop-settings.json';

function createDesktopSettingsStore({ app, fs, path, log = console } = {}) {
  function filePath() {
    return path.join(app.getPath('userData'), SETTINGS_FILE);
  }

  function read() {
    try {
      const stored = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
      return stored;
    } catch {
      return {};
    }
  }

  function write(next) {
    const target = filePath();
    const tempPath = `${target}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(next && typeof next === 'object' ? next : {}));
    fs.renameSync(tempPath, target);
  }

  function patch(partial) {
    const current = read();
    const next = {
      ...current,
      ...(partial && typeof partial === 'object' && !Array.isArray(partial) ? partial : {})
    };
    try {
      write(next);
      return next;
    } catch (error) {
      log.warn?.('Failed to write desktop settings:', error);
      throw error;
    }
  }

  return { filePath, patch, read, write };
}

module.exports = {
  SETTINGS_FILE,
  createDesktopSettingsStore
};
