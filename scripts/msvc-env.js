'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Native Windows helpers compile with cl.exe. CI loads it with ilammy/msvc-dev-cmd;
// locally we find Visual Studio or Build Tools through vswhere and load vcvars64,
// so `npm run build:win:dev` works from a plain terminal.
const VC_TOOLS_COMPONENT = 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64';
const MISSING_MSVC_MESSAGE = [
  'cl.exe was not found, so the Windows native helpers cannot be built.',
  'Install Visual Studio 2022 Build Tools with MSVC x64 and a Windows 11 SDK, for example:',
  '  winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"',
  'or run the build from a Developer Command Prompt.'
].join('\n');

function pathValue(env) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path');
  return key ? String(env[key] || '') : '';
}

function hasExecutableOnPath(executable, { env = process.env, fs: fsModule = fs } = {}) {
  return pathValue(env)
    .split(';')
    .filter(Boolean)
    .some((dir) => fsModule.existsSync(path.win32.join(dir, executable)));
}

function findVcvars64({ env = process.env, fs: fsModule = fs, spawn = spawnSync } = {}) {
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vswhere = path.win32.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fsModule.existsSync(vswhere)) return '';

  const result = spawn(vswhere, [
    '-latest',
    '-products', '*',
    '-requires', VC_TOOLS_COMPONENT,
    '-property', 'installationPath'
  ], { encoding: 'utf8', windowsHide: true });
  const installationPath = String(result.stdout || '').split(/\r?\n/)[0].trim();
  if (result.status !== 0 || !installationPath) return '';

  const vcvars = path.win32.join(installationPath, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  return fsModule.existsSync(vcvars) ? vcvars : '';
}

function parseSetOutput(stdout) {
  const env = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    // cmd also prints per-drive entries such as "=C:=C:\work"; they are not variables.
    if (separator <= 0) continue;
    env[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return env;
}

function resolveMsvcEnv({
  platform = process.platform,
  env = process.env,
  fs: fsModule = fs,
  spawn = spawnSync
} = {}) {
  if (platform !== 'win32') return { env: null, error: 'MSVC is only available on Windows.' };
  if (hasExecutableOnPath('cl.exe', { env, fs: fsModule })) return { env, source: 'PATH' };

  const vcvars = findVcvars64({ env, fs: fsModule, spawn });
  if (!vcvars) return { env: null, error: MISSING_MSVC_MESSAGE };

  const result = spawn('cmd.exe', ['/d', '/s', '/c', `"call "${vcvars}" >nul && set"`], {
    encoding: 'utf8',
    env,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: true
  });
  const loaded = result.status === 0 ? parseSetOutput(result.stdout) : {};
  if (!hasExecutableOnPath('cl.exe', { env: loaded, fs: fsModule })) {
    return { env: null, error: `${vcvars} did not put cl.exe on PATH.\n${MISSING_MSVC_MESSAGE}` };
  }
  return { env: loaded, source: vcvars };
}

function requireMsvcEnv(label) {
  const resolved = resolveMsvcEnv();
  if (resolved.env) return resolved.env;
  console.error(`${label}: ${resolved.error}`);
  process.exit(1);
}

module.exports = {
  MISSING_MSVC_MESSAGE,
  findVcvars64,
  hasExecutableOnPath,
  parseSetOutput,
  requireMsvcEnv,
  resolveMsvcEnv
};
