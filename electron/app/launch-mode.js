'use strict';

const HIDDEN_LAUNCH_ARG = '--hidden';
const RELAUNCH_INTENT_FILE = 'relaunch-intent.json';
// An intent older than this belongs to an install that never relaunched the app
// (for example the user cancelled it); ignore it instead of starting hidden.
const RELAUNCH_INTENT_TTL_MS = 10 * 60_000;

function resolveStartHidden({
  argv = [],
  platform = process.platform,
  loginItemSettings = null,
  startMinimized = false,
  relaunchIntent = null
} = {}) {
  if (relaunchIntent?.startHidden === true) return true;
  if (argv.includes(HIDDEN_LAUNCH_ARG)) return true;
  // macOS login items cannot carry arguments; ask the OS whether this launch
  // came from the login item and apply the stored preference.
  if (platform === 'darwin') {
    return startMinimized === true && loginItemSettings?.wasOpenedAtLogin === true;
  }
  return false;
}

function writeRelaunchIntent({ fs, path, userDataPath, startHidden, now = Date.now() }) {
  try {
    fs.writeFileSync(
      path.join(userDataPath, RELAUNCH_INTENT_FILE),
      JSON.stringify({ createdAt: now, startHidden: Boolean(startHidden) })
    );
    return true;
  } catch {
    return false;
  }
}

function consumeRelaunchIntent({ fs, path, userDataPath, now = Date.now() }) {
  const filePath = path.join(userDataPath, RELAUNCH_INTENT_FILE);
  let intent = null;
  try {
    intent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }

  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // A stale file expires through the TTL check below.
  }

  const createdAt = Number(intent?.createdAt);
  if (!Number.isFinite(createdAt) || now - createdAt > RELAUNCH_INTENT_TTL_MS || createdAt > now) {
    return null;
  }
  return { startHidden: intent.startHidden === true };
}

module.exports = {
  HIDDEN_LAUNCH_ARG,
  RELAUNCH_INTENT_FILE,
  RELAUNCH_INTENT_TTL_MS,
  consumeRelaunchIntent,
  resolveStartHidden,
  writeRelaunchIntent
};
