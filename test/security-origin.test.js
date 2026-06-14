'use strict';

const assert = require('node:assert/strict');
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
});
