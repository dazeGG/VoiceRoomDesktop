'use strict';

const BLACKLIST_NAMES = new Set([
  'applicationframehost.exe',
  'brave.exe',
  'chrome.exe',
  'code - insiders.exe',
  'code.exe',
  'cmd.exe',
  'devenv.exe',
  'discord.exe',
  'discordcanary.exe',
  'discordptb.exe',
  'dwm.exe',
  'eadesktop.exe',
  'electron.exe',
  'epicgameslauncher.exe',
  'epicwebhelper.exe',
  'explorer.exe',
  'firefox.exe',
  'galaxyclient.exe',
  'grok.exe',
  'leagueclient.exe',
  'leagueclientux.exe',
  'lockapp.exe',
  'msedge.exe',
  'notepad.exe',
  'obs32.exe',
  'obs64.exe',
  'opera.exe',
  'origin.exe',
  'powershell.exe',
  'pwsh.exe',
  'riotclientservices.exe',
  'riotclientux.exe',
  'runtimebroker.exe',
  'searchhost.exe',
  'shellexperiencehost.exe',
  'slack.exe',
  'spotify.exe',
  'startmenuexperiencehost.exe',
  'steam.exe',
  'steamwebhelper.exe',
  'systemsettings.exe',
  'taskmgr.exe',
  'telegram.exe',
  'textinputhost.exe',
  'ubisoftconnect.exe',
  'upc.exe',
  'vivaldi.exe',
  'voice room.exe',
  'windowsterminal.exe',
  'zoom.exe'
]);

const LAUNCHER_PATH_MARKERS = [
  '\\battle.net\\',
  '\\ea desktop\\',
  '\\epic games\\launcher\\',
  '\\gog galaxy\\',
  '\\origin\\',
  '\\riot games\\riot client\\',
  '\\steam\\steam.exe',
  '\\ubisoft connect\\'
];

const GAME_PATH_MARKERS = [
  '\\ea games\\',
  '\\epic games\\',
  '\\gog galaxy\\games\\',
  '\\origin games\\',
  '\\program files\\oculus\\software\\',
  '\\riot games\\',
  '\\steamapps\\common\\',
  '\\steamapps\\sourcemods\\',
  '\\ubisoft\\ubisoft game launcher\\games\\',
  '\\xboxgames\\'
];

const MAX_ALLOWED_EXECUTABLES = 32;
const MAX_EXECUTABLE_LENGTH = 260;

function normalizePath(value) {
  return String(value || '').replace(/\//g, '\\').trim().toLowerCase();
}

function fileName(value) {
  const normalized = normalizePath(value);
  const slash = normalized.lastIndexOf('\\');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function sanitizeAllowedExecutables(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = normalizePath(item).slice(0, MAX_EXECUTABLE_LENGTH);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= MAX_ALLOWED_EXECUTABLES) break;
  }
  return Object.freeze(result);
}

function isAllowedExecutable(exe, allowedExecutables) {
  const pathNorm = normalizePath(exe);
  const name = fileName(pathNorm);
  for (const allowed of allowedExecutables) {
    if (allowed === pathNorm || allowed === name) return true;
  }
  return false;
}

function classifyForegroundApp(payload, options = {}) {
  const exe = typeof payload?.exe === 'string' ? payload.exe : '';
  const pathNorm = normalizePath(exe);
  const name = fileName(pathNorm);
  const allowedExecutables = sanitizeAllowedExecutables(options.allowedExecutables);

  if (!name) return Object.freeze({ exe: pathNorm, game: false, name: '', reason: 'unknown' });
  if (BLACKLIST_NAMES.has(name)) {
    return Object.freeze({ exe: pathNorm, game: false, name, reason: 'blacklist' });
  }
  if (isAllowedExecutable(pathNorm, allowedExecutables)) {
    return Object.freeze({ exe: pathNorm, game: true, name, reason: 'allowlist' });
  }
  if (LAUNCHER_PATH_MARKERS.some((marker) => pathNorm.includes(marker))) {
    return Object.freeze({ exe: pathNorm, game: false, name, reason: 'launcher' });
  }
  if (name === 'riotclientservices.exe' || name === 'leagueclientux.exe' || name === 'leagueclient.exe') {
    return Object.freeze({ exe: pathNorm, game: false, name, reason: 'launcher' });
  }
  if (GAME_PATH_MARKERS.some((marker) => pathNorm.includes(marker))) {
    if (pathNorm.includes('\\epic games\\launcher\\')) {
      return Object.freeze({ exe: pathNorm, game: false, name, reason: 'launcher' });
    }
    if (pathNorm.includes('\\riot games\\riot client\\')) {
      return Object.freeze({ exe: pathNorm, game: false, name, reason: 'launcher' });
    }
    return Object.freeze({ exe: pathNorm, game: true, name, reason: 'install-path' });
  }
  return Object.freeze({ exe: pathNorm, game: false, name, reason: 'not-a-game' });
}

function parseForegroundPayload(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return normalizeForegroundPayload(raw);
  }
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return normalizeForegroundPayload(JSON.parse(raw));
  } catch {
    return null;
  }
}

function normalizeForegroundPayload(source) {
  if (!source || typeof source !== 'object') return null;
  const exe = typeof source.exe === 'string' ? source.exe.trim() : '';
  if (!exe) return null;
  const boundsSource = source.bounds && typeof source.bounds === 'object' ? source.bounds : {};
  const x = Number(boundsSource.x);
  const y = Number(boundsSource.y);
  const width = Number(boundsSource.width);
  const height = Number(boundsSource.height);
  return Object.freeze({
    bounds: Object.freeze({
      height: Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0,
      width: Number.isFinite(width) ? Math.max(0, Math.round(width)) : 0,
      x: Number.isFinite(x) ? Math.round(x) : 0,
      y: Number.isFinite(y) ? Math.round(y) : 0
    }),
    exe,
    pid: Number.isInteger(source.pid) ? source.pid : 0,
    title: typeof source.title === 'string' ? source.title.slice(0, 200) : ''
  });
}

function describeForeground(classification) {
  if (!classification?.name) return { game: false, label: 'Нет активного окна', reason: 'unknown' };
  return {
    exe: classification.exe,
    game: classification.game === true,
    label: classification.name,
    reason: classification.reason
  };
}

module.exports = {
  BLACKLIST_NAMES,
  classifyForegroundApp,
  describeForeground,
  fileName,
  normalizePath,
  parseForegroundPayload,
  sanitizeAllowedExecutables
};
