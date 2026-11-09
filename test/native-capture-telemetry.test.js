'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { resolveMsvcEnv } = require('../scripts/msvc-env');

test('compiled native pipeline telemetry counts frames and exposes stalls', (context) => {
  const windows = process.platform === 'win32';
  const msvc = windows ? resolveMsvcEnv() : null;
  if (windows && !msvc.env) {
    assert.ok(!process.env.CI, msvc.error);
    context.skip(msvc.error);
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-room-capture-telemetry-'));
  const outputPath = path.join(tempDir, windows ? 'capture-telemetry.exe' : 'capture-telemetry');
  const fixturePath = path.join(__dirname, 'fixtures', 'capture-telemetry.cpp');
  const compiler = windows ? 'cl.exe' : process.env.CXX || 'c++';
  const args = windows
    ? ['/nologo', '/EHsc', '/std:c++17', '/W4', '/WX', '/O2', `/Fe:${outputPath}`, `/Fo:${path.join(tempDir, 'capture-telemetry.obj')}`, fixturePath]
    : ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-O2', fixturePath, '-o', outputPath];

  try {
    const compile = spawnSync(compiler, args, {
      cwd: tempDir, env: msvc?.env || process.env, encoding: 'utf8', windowsHide: true
    });
    if (compile.error?.code === 'ENOENT' && !process.env.CI) {
      context.skip(`${compiler} is unavailable on this developer machine.`);
      return;
    }
    assert.equal(compile.error, undefined, compile.error?.message);
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const run = spawnSync(outputPath, [], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.error, undefined, run.error?.message);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const reports = run.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(reports.length, 3);
    assert.equal(reports[0].acquireAttempts, 2);
    assert.equal(reports[0].acquireEmpty, 1);
    assert.equal('callbackArrivals' in reports[0], false);
    assert.equal(reports[1].callbackArrivals, 2);
    assert.equal(reports[2].event, 'pipeline');
    context.diagnostic(run.stdout.trim());
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});
