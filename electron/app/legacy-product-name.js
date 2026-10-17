'use strict';

// 1.4.7 renamed the product from "Voice Room" to "VoiceRoom". Electron names
// the user data folder after the product (and macOS the log folder too), so
// without this the first launch after the update would start a second, empty
// profile next to the old one. It runs before anything opens the profile and
// moves the old folders over; when the new one is already a live profile, the
// old one is a leftover and goes, so the two never sit side by side.

const LEGACY_PRODUCT_NAME = 'Voice Room';
const LEGACY_EXECUTABLE = 'Voice Room.exe';
// Chromium writes it into every profile it opens.
const PROFILE_MARKER = 'Local State';

function legacyFolders({ app, path, platform, homedir }) {
  const userData = app.getPath('userData');
  const folders = [
    {
      from: path.join(app.getPath('appData'), LEGACY_PRODUCT_NAME),
      to: userData,
      liveMarker: path.join(userData, PROFILE_MARKER),
      profile: true
    }
  ];
  if (platform === 'darwin') {
    const logs = path.join(homedir, 'Library', 'Logs');
    folders.push({ from: path.join(logs, LEGACY_PRODUCT_NAME), to: path.join(logs, app.getName()), profile: false });
  }
  return folders;
}

function moveFolder({ fs, folder }) {
  const { from, to, liveMarker } = folder;
  if (!fs.existsSync(from)) return 'none';
  if (fs.existsSync(to)) {
    // Both exist. A live new profile wins and the old one is a leftover (logs
    // always are); a new folder that holds no profile yet gives way instead.
    if (!liveMarker || fs.existsSync(liveMarker)) {
      fs.rmSync(from, { force: true, recursive: true });
      return 'removed';
    }
    fs.rmSync(to, { force: true, recursive: true });
  }
  fs.renameSync(from, to);
  return 'moved';
}

/**
 * Moves the "Voice Room" folders to the new name. Returns what happened to
 * each, for the log once it is open. A profile that cannot be moved (a file
 * still locked) stays in use for this run; the next launch tries again.
 */
function migrateLegacyProductFolders({ app, fs, path, platform = process.platform, homedir }) {
  if (!app.isPackaged || app.getName() === LEGACY_PRODUCT_NAME) return [];
  return legacyFolders({ app, path, platform, homedir }).map((folder) => {
    try {
      return { from: folder.from, result: moveFolder({ fs, folder }) };
    } catch (error) {
      if (folder.profile) app.setPath('userData', folder.from);
      return { error: error?.message || String(error), from: folder.from, result: 'failed' };
    }
  });
}

module.exports = {
  LEGACY_EXECUTABLE,
  LEGACY_PRODUCT_NAME,
  migrateLegacyProductFolders
};
