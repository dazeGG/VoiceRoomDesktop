'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { getNativeCaptureInjectScript } = require('../electron/native-capture-policy');

// Runs the injected main-world script against a mock window/navigator pair.
// The script must never break getDisplayMedia: when the native path is
// unavailable or refuses to start, the original stream is returned untouched.
function runInjectScript({ window, navigator, withGenerators = true }) {
  const script = getNativeCaptureInjectScript();
  const runner = new Function(
    'window',
    'navigator',
    'MediaStreamTrackGenerator',
    'VideoFrame',
    'MediaStream',
    'performance',
    script
  );
  class FakeGenerator {}
  class FakeVideoFrame {}
  class FakeMediaStream {}
  runner(
    window,
    navigator,
    withGenerators ? FakeGenerator : undefined,
    withGenerators ? FakeVideoFrame : undefined,
    FakeMediaStream,
    { now: () => 0 }
  );
}

function createFakeStream() {
  return {
    getAudioTracks: () => [],
    getVideoTracks: () => []
  };
}

function createNavigator(stream) {
  return {
    mediaDevices: {
      getDisplayMedia: async () => stream
    }
  };
}

describe('getNativeCaptureInjectScript', () => {
  it('produces a syntactically valid script', () => {
    assert.doesNotThrow(() => new Function(getNativeCaptureInjectScript()));
  });

  it('does not wrap getDisplayMedia when the bridge is missing', () => {
    const stream = createFakeStream();
    const navigator = createNavigator(stream);
    const original = navigator.mediaDevices.getDisplayMedia;

    runInjectScript({ window: { addEventListener() {} }, navigator });

    assert.equal(navigator.mediaDevices.getDisplayMedia, original);
  });

  it('does not wrap getDisplayMedia when MediaStreamTrackGenerator is unavailable', () => {
    const stream = createFakeStream();
    const navigator = createNavigator(stream);
    const original = navigator.mediaDevices.getDisplayMedia;
    const window = {
      addEventListener() {},
      voiceRoomNativeCaptureBridge: { start: async () => ({ ok: true }) }
    };

    runInjectScript({ window, navigator, withGenerators: false });

    assert.equal(navigator.mediaDevices.getDisplayMedia, original);
  });

  it('falls back to the original stream when the native session refuses to start', async () => {
    const stream = createFakeStream();
    const navigator = createNavigator(stream);
    const window = {
      addEventListener() {},
      removeEventListener() {},
      voiceRoomNativeCaptureBridge: { start: async () => ({ ok: false, reason: 'helper-missing' }) }
    };

    runInjectScript({ window, navigator });

    assert.notEqual(navigator.mediaDevices.getDisplayMedia, undefined);
    const result = await navigator.mediaDevices.getDisplayMedia({ video: true });
    assert.equal(result, stream);
  });

  it('falls back to the original stream when starting the session throws', async () => {
    const stream = createFakeStream();
    const navigator = createNavigator(stream);
    const window = {
      addEventListener() {},
      removeEventListener() {},
      voiceRoomNativeCaptureBridge: {
        start: async () => {
          throw new Error('ipc failure');
        }
      }
    };

    runInjectScript({ window, navigator });

    const result = await navigator.mediaDevices.getDisplayMedia({ video: true });
    assert.equal(result, stream);
  });

  it('installs only once per page', () => {
    const stream = createFakeStream();
    const navigator = createNavigator(stream);
    const window = {
      addEventListener() {},
      voiceRoomNativeCaptureBridge: { start: async () => ({ ok: false }) }
    };

    runInjectScript({ window, navigator });
    const wrapped = navigator.mediaDevices.getDisplayMedia;
    runInjectScript({ window, navigator });

    assert.equal(navigator.mediaDevices.getDisplayMedia, wrapped);
    assert.equal(window.__voiceRoomNativeCaptureInstalled, true);
  });
});
