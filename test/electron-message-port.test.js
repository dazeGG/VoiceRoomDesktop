'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

test('production native capture bridge writes cloned BGRX and NV12 frames in Electron', { timeout: 20000 }, async () => {
  const electronPath = require('electron');
  const fixturePath = path.join(__dirname, 'fixtures', 'message-port-arraybuffer-electron.js');
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  // GitHub-hosted Linux runners cannot install Electron's chrome-sandbox with
  // the root-owned setuid permissions Chromium requires. This is a local IPC
  // fixture with no untrusted content, so disable the sandbox only for that
  // child process; packaged application behavior is unchanged.
  const electronArgs = process.platform === 'linux'
    ? ['--no-sandbox', fixturePath]
    : [fixturePath];
  delete env.ELECTRON_RUN_AS_NODE;

  let child = null;
  const result = await new Promise((resolve, reject) => {
    child = spawn(electronPath, electronArgs, {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Electron production native-capture fixture timed out.'));
    }, 15000);
    let stderr = '';
    let stdout = '';
    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr, stdout });
    });
  });

  assert.equal(result.code, 0, result.stderr || `Electron exited with ${result.signal}`);
  assert.match(result.stdout, /production-native-capture-bridge-ok/);
});
