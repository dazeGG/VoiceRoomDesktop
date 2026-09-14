'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { parseSetOutput, resolveMsvcEnv } = require('../scripts/msvc-env');

const BUILD_TOOLS = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools';
const VSWHERE = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
const VCVARS = `${BUILD_TOOLS}\\VC\\Auxiliary\\Build\\vcvars64.bat`;
const CL_DIR = `${BUILD_TOOLS}\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64`;

function fakeFs(files) {
  const existing = new Set(files);
  return { existsSync: (filePath) => existing.has(filePath) };
}

describe('msvc environment for native Windows helpers', () => {
  it('uses cl.exe already on PATH without looking for Visual Studio', () => {
    const env = { Path: `C:\\Windows;${CL_DIR}` };
    const resolved = resolveMsvcEnv({
      env,
      fs: fakeFs([`${CL_DIR}\\cl.exe`]),
      platform: 'win32',
      spawn: () => { throw new Error('vswhere must not run'); }
    });
    assert.equal(resolved.env, env);
    assert.equal(resolved.source, 'PATH');
  });

  it('loads vcvars64 from the Build Tools that vswhere reports', () => {
    const commands = [];
    const spawn = (command) => {
      commands.push(command);
      if (command === VSWHERE) return { status: 0, stdout: `${BUILD_TOOLS}\r\n` };
      return {
        status: 0,
        stdout: `=C:=C:\\work\r\nPath=C:\\Windows;${CL_DIR}\r\nINCLUDE=${BUILD_TOOLS}\\include;a=b\r\n`
      };
    };
    const resolved = resolveMsvcEnv({
      env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', Path: 'C:\\Windows' },
      fs: fakeFs([VSWHERE, VCVARS, `${CL_DIR}\\cl.exe`]),
      platform: 'win32',
      spawn
    });
    assert.equal(resolved.source, VCVARS);
    assert.deepEqual(commands, [VSWHERE, 'cmd.exe']);
    assert.equal(resolved.env.INCLUDE, `${BUILD_TOOLS}\\include;a=b`);
    assert.ok(Object.keys(resolved.env).every((key) => key && !key.startsWith('=')));
  });

  it('explains how to install MSVC when neither PATH nor vswhere has it', () => {
    const resolved = resolveMsvcEnv({
      env: { Path: 'C:\\Windows' },
      fs: fakeFs([]),
      platform: 'win32',
      spawn: () => ({ status: 1, stdout: '' })
    });
    assert.equal(resolved.env, null);
    assert.match(resolved.error, /cl\.exe was not found/);
    assert.match(resolved.error, /Build Tools/);
  });

  it('reports a vcvars run that still leaves cl.exe missing', () => {
    const resolved = resolveMsvcEnv({
      env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', Path: 'C:\\Windows' },
      fs: fakeFs([VSWHERE, VCVARS]),
      platform: 'win32',
      spawn: (command) => (command === VSWHERE
        ? { status: 0, stdout: BUILD_TOOLS }
        : { status: 0, stdout: 'Path=C:\\Windows\r\n' })
    });
    assert.equal(resolved.env, null);
    assert.match(resolved.error, /did not put cl\.exe on PATH/);
  });

  it('parses cmd set output and skips per-drive entries', () => {
    assert.deepEqual(parseSetOutput('=C:=C:\\x\r\nA=1\r\nB=x=y\r\n\r\nnoise'), { A: '1', B: 'x=y' });
  });
});
