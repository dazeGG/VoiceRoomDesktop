'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const {
  getFrameKey,
  getFrameScopeKey,
  getOriginFromUrl,
  isPermissionContextTrusted,
  isTrustedDisplayMediaRequest,
  isTrustedFrame,
  isTrustedOrigin,
  isTrustedOrAppLoadingFrame,
  isTrustedUrl,
  isTransitionalWebContentsUrl,
  readRuntimeConfig,
  resolvePermissionContextOrigin,
  setTrustedOrigin
} = require('../electron/security/origin');

afterEach(() => {
  setTrustedOrigin('');
});

describe('security-origin', () => {
  it('parses and matches trusted origins', () => {
    setTrustedOrigin('https://voice.example');

    assert.equal(getOriginFromUrl('https://voice.example/app?x=1'), 'https://voice.example');
    assert.equal(getOriginFromUrl('not a valid url'), '');
    assert.equal(isTrustedOrigin('https://voice.example'), true);
    assert.equal(isTrustedUrl('https://voice.example/app'), true);
    assert.equal(isTrustedUrl('https://other.example/app'), false);
  });

  it('identifies trusted frames and display-media requests', () => {
    setTrustedOrigin('https://voice.example');
    const frame = { url: 'https://voice.example/app' };
    const request = { frame, securityOrigin: '' };

    assert.equal(isTrustedFrame(frame), true);
    assert.equal(isTrustedDisplayMediaRequest(request), true);
    assert.equal(isTrustedFrame({ url: 'https://other.example/app' }), false);
  });

  it('treats transitional about: URLs as app-loading frames when trusted origin is set', () => {
    setTrustedOrigin('https://voice.example');

    assert.equal(isTransitionalWebContentsUrl('about:blank'), true);
    assert.equal(isTrustedOrAppLoadingFrame({ url: 'about:blank' }), true);
    assert.equal(isTrustedOrAppLoadingFrame({ url: 'https://other.example/app' }), false);
  });

  it('resolves trusted permission contexts from request metadata and fallback URLs', () => {
    setTrustedOrigin('https://voice.example');
    const webContents = {
      getURL: () => 'about:blank'
    };

    assert.equal(resolvePermissionContextOrigin(webContents, {}, '', undefined), 'https://voice.example');
    assert.equal(isPermissionContextTrusted(webContents), true);

    const frame = { processId: 1, routingId: 2 };
    const topFrame = { isDestroyed: () => false, processId: 9, routingId: 8 };
    assert.equal(getFrameKey(frame), '1:2');
    assert.equal(getFrameScopeKey({ ...frame, top: topFrame }), '9:8');
  });

  it('reads the generated runtime config from the electron root', () => {
    const configPath = path.join(__dirname, '..', 'electron/runtime-config.json');
    const originalConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
    const expectedConfig = { voiceRoomUrl: 'https://voice.example' };

    try {
      fs.writeFileSync(configPath, `${JSON.stringify(expectedConfig, null, 2)}\n`);

      assert.deepEqual(readRuntimeConfig(), expectedConfig);
    } finally {
      if (originalConfig === null) {
        fs.rmSync(configPath, { force: true });
      } else {
        fs.writeFileSync(configPath, originalConfig);
      }
    }
  });
});
