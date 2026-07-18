'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('compiled native capture geometry fits every profile without a JS reimplementation', (context) => {
  if (process.platform === 'win32') {
    context.skip('The production helper is compiled directly by the Windows release job.');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-room-capture-geometry-'));
  const outputPath = path.join(tempDir, 'capture-geometry');
  const fixturePath = path.join(__dirname, 'fixtures', 'capture-geometry.cpp');
  const compiler = process.env.CXX || 'c++';

  try {
    const compile = spawnSync(compiler, ['-std=c++17', '-O2', fixturePath, '-o', outputPath], {
      encoding: 'utf8'
    });
    if (compile.error?.code === 'ENOENT' && !process.env.CI) {
      context.skip(`${compiler} is unavailable on this developer machine.`);
      return;
    }
    assert.equal(compile.error, undefined, compile.error?.message);
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);

    const run = spawnSync(outputPath, [], { encoding: 'utf8' });
    assert.equal(run.error, undefined, run.error?.message);
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});
