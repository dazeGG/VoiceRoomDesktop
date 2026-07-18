'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

test('Electron MessagePortMain carries cloned ArrayBuffer frame payloads', { timeout: 15000 }, async () => {
  const electronPath = require('electron');
  const fixturePath = path.join(__dirname, 'fixtures', 'message-port-arraybuffer-electron.js');
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;

  let child = null;
  const result = await new Promise((resolve, reject) => {
    child = spawn(electronPath, [fixturePath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Electron MessagePortMain fixture timed out.'));
    }, 10000);
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
  assert.match(result.stdout, /message-port-arraybuffer-clone-ok/);
});
