'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { describe, it } = require('node:test');

const rootDir = path.join(__dirname, '..');
const validator = path.join(rootDir, 'scripts', 'validate-release-version.js');
const packageJson = require('../package.json');

function runValidator(tag) {
  return spawnSync(process.execPath, [validator, tag], {
    cwd: rootDir,
    encoding: 'utf8'
  });
}

describe('validate-release-version', () => {
  it('accepts the current package version tag', () => {
    const result = runValidator(`v${packageJson.version}`);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it('rejects tags that do not match package.json', () => {
    const result = runValidator('v0.0.0');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match package\.json/i);
  });

  it('rejects malformed tags', () => {
    const result = runValidator('release-1');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must look like v1\.2\.0/i);
  });
});