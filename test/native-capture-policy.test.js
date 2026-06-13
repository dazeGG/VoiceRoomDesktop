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
  class FakeGenerator {
    constructor() {
      this.readyState = 'live';
      this.writable = {
        getWriter: () => ({
          desiredSize: 1,
          close: async () => {},
          write: async () => {}
        })
      };
    }
  }
  class FakeVideoFrame {
    constructor(data, init) {
      this.data = data;
      this.init = init;
    }
    close() {}
  }
  class FakeMediaStream {
    constructor(tracks = []) {
      this.tracks = tracks;
    }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video' || !track.kind); }
  }
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


  it('returns a native-only stream without opening Chromium video capture when prepare succeeds', async () => {
    let originalCalls = 0;
    let committedSourceId = '';
    const navigator = {
      mediaDevices: {
        getDisplayMedia: async () => {
          originalCalls += 1;
          return createFakeStream();
        }
      }
    };
    const listeners = new Map();
    const port = {
      close() {},
      postMessage() {},
      start() {
        setImmediate(() => {
          this.onmessage?.({
            data: {
              data: new ArrayBuffer(16),
              format: 'BGRX',
              height: 2,
              type: 'frame',
              width: 2
            }
          });
        });
      }
    };
    const window = {
      addEventListener(type, handler) {
        listeners.set(type, handler);
        if (type === 'message') {
          setImmediate(() => handler({
            data: { sessionId: 'native-1', type: 'voice-room-native-capture-port' },
            ports: [port],
            source: window
          }));
        }
      },
      removeEventListener(type) { listeners.delete(type); },
      voiceRoomNativeCaptureBridge: {
        commitPrepared: async (sourceId) => { committedSourceId = sourceId; },
        prepare: async () => ({ ok: true, sessionId: 'native-1', sourceId: 'screen:1:0' }),
        start: async () => { throw new Error('should not use Chromium fallback'); },
        stop: async () => {}
      }
    };

    runInjectScript({ window, navigator });

    const result = await navigator.mediaDevices.getDisplayMedia({ video: true });
    assert.equal(originalCalls, 0);
    assert.equal(committedSourceId, 'screen:1:0');
    assert.equal(result.getVideoTracks().length, 1);
  });

  it('uses the original Chromium stream when native-only prepare is unavailable', async () => {
    let originalCalls = 0;
    const stream = createFakeStream();
    const navigator = {
      mediaDevices: {
        getDisplayMedia: async () => {
          originalCalls += 1;
          return stream;
        }
      }
    };
    const window = {
      addEventListener() {},
      removeEventListener() {},
      voiceRoomNativeCaptureBridge: {
        prepare: async () => ({ ok: false, reason: 'source-not-screen' }),
        start: async () => ({ ok: false, reason: 'no-granted-source' })
      }
    };

    runInjectScript({ window, navigator });

    const result = await navigator.mediaDevices.getDisplayMedia({ video: true });
    assert.equal(originalCalls, 1);
    assert.equal(result, stream);
  });

  it('does not try native-only capture when Chromium audio is requested', async () => {
    let prepared = false;
    const stream = createFakeStream();
    const navigator = createNavigator(stream);
    const window = {
      addEventListener() {},
      removeEventListener() {},
      voiceRoomNativeCaptureBridge: {
        prepare: async () => { prepared = true; return { ok: true }; },
        start: async () => ({ ok: false, reason: 'no-granted-source' })
      }
    };

    runInjectScript({ window, navigator });

    const result = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    assert.equal(prepared, false);
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
