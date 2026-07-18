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
    const successMarker = 'production-native-capture-bridge-ok';
    let drainTimer = null;
    let exitResult = null;
    let settled = false;
    child = spawn(electronPath, electronArgs, {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    let stdout = '';
    const destroyPipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(drainTimer);
      destroyPipes();
      callback();
    };
    const resolveExitedChild = () => {
      if (!exitResult || settled) return;
      if (stdout.includes(successMarker)) {
        settle(() => resolve({ ...exitResult, stderr, stdout }));
        return;
      }
      if (drainTimer) return;
      drainTimer = setTimeout(() => {
        settle(() => resolve({ ...exitResult, stderr, stdout }));
      }, 500);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      const diagnostics = [stderr, stdout].filter(Boolean).join('\n');
      settle(() => reject(new Error(
        `Electron production native-capture fixture timed out.${diagnostics ? `\n${diagnostics}` : ''}`
      )));
    }, 15000);
    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      resolveExitedChild();
    });
    child.once('error', (error) => {
      settle(() => reject(error));
    });
    // Chromium utility processes can briefly retain inherited stdio handles on
    // Linux after the Electron main process is gone. Wait for the fixture's
    // flushed success marker (or a bounded diagnostic drain), then explicitly
    // destroy both read pipes instead of waiting for descendant-owned handles.
    child.once('exit', (code, signal) => {
      if (settled) return;
      clearTimeout(timeout);
      exitResult = { code, signal };
      resolveExitedChild();
    });
  });

  assert.equal(result.code, 0, result.stderr || `Electron exited with ${result.signal}`);
  assert.match(result.stdout, /production-native-capture-bridge-ok/);
});
