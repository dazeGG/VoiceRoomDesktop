'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  NATIVE_CAPTURE_PROTOCOL_VERSION,
  NATIVE_CAPTURE_PORT_MESSAGE_TYPE
} = require('../electron/native/capture-contract');
const { getNativeCaptureInjectScript } = require('../electron/policies/native-capture');

// Runs the injected main-world script against a mock window/navigator pair.
// The script must never break getDisplayMedia: when the native path is
// unavailable or refuses to start, the original stream is returned untouched.
function runInjectScript({ createWriter, window, navigator, withGenerators = true }) {
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
        getWriter: () => createWriter?.() || ({
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
    let statsAfterFormat = null;
    let frameDispatchedResolve;
    let resolveReady;
    let resolveWrite;
    let writerDesiredSize = 0;
    const portMessages = [];
    const frameDispatched = new Promise((resolve) => { frameDispatchedResolve = resolve; });
    const writerReady = new Promise((resolve) => { resolveReady = resolve; });
    const writeAccepted = new Promise((resolve) => { resolveWrite = resolve; });
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
      postMessage(message) { portMessages.push(message); },
      start() {
        setImmediate(() => {
          this.onmessage?.({
            data: {
              fps: 30,
              height: 1080,
              pixelFormat: 'nv12',
              type: 'format',
              width: 1920
            }
          });
          statsAfterFormat = window.__voiceRoomNativeCaptureStats?.();
          this.onmessage?.({
            data: {
              data: new ArrayBuffer(16),
              format: 'BGRX',
              height: 2,
              type: 'frame',
              width: 2
            }
          });
          frameDispatchedResolve();
        });
      }
    };
    const window = {
      addEventListener(type, handler) {
        listeners.set(type, handler);
        if (type === 'message') {
          setImmediate(() => handler({
            data: {
              protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
              sessionId: 'native-1',
              type: NATIVE_CAPTURE_PORT_MESSAGE_TYPE
            },
            ports: [port],
            source: window
          }));
        }
      },
      removeEventListener(type) { listeners.delete(type); },
      voiceRoomNativeCaptureBridge: {
        commitPrepared: async (sourceId) => { committedSourceId = sourceId; },
        prepare: async () => ({
          ok: true,
          protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
          sessionId: 'native-1',
          sourceId: 'screen:1:0'
        }),
        start: async () => { throw new Error('should not use Chromium fallback'); },
        stop: async () => {}
      }
    };

    runInjectScript({
      createWriter: () => ({
        close: async () => {},
        get desiredSize() { return writerDesiredSize; },
        ready: writerReady,
        write: () => writeAccepted
      }),
      window,
      navigator
    });

    const resultPromise = navigator.mediaDevices.getDisplayMedia({ video: true });
    await frameDispatched;
    assert.deepEqual(portMessages, []);

    writerDesiredSize = 1;
    resolveReady();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(portMessages, [{ type: 'frame-ack' }]);

    port.onmessage?.({
      data: {
        data: new ArrayBuffer(16),
        format: 'BGRX',
        height: 2,
        type: 'frame',
        width: 2
      }
    });
    assert.deepEqual(portMessages, [{ type: 'frame-ack' }]);
    resolveWrite();
    const result = await resultPromise;
    assert.equal(originalCalls, 0);
    assert.equal(committedSourceId, 'screen:1:0');
    assert.equal(result.getVideoTracks().length, 1);
    assert.deepEqual(portMessages, [{ type: 'frame-ack' }, { type: 'frame-ack' }]);
    assert.equal(statsAfterFormat?.pixelFormat, 'NV12');
    assert.equal(window.__voiceRoomNativeCaptureStats().pixelFormat, 'BGRX');
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

  it('falls back to Chromium when the first native frame cannot enter the generator', async () => {
    let committed = false;
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
        if (type === 'message') {
          setImmediate(() => handler({
            data: {
              protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
              sessionId: 'native-write-fails',
              type: NATIVE_CAPTURE_PORT_MESSAGE_TYPE
            },
            ports: [port],
            source: window
          }));
        }
      },
      removeEventListener() {},
      voiceRoomNativeCaptureBridge: {
        commitPrepared: async () => { committed = true; },
        prepare: async () => ({
          ok: true,
          protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
          sessionId: 'native-write-fails',
          sourceId: 'screen:1:0'
        }),
        start: async () => ({ ok: false, reason: 'native-write-fails' }),
        stop: async () => {}
      }
    };

    runInjectScript({
      createWriter: () => ({
        desiredSize: 1,
        close: async () => {},
        write: async () => { throw new Error('generator rejected frame'); }
      }),
      window,
      navigator
    });

    const result = await navigator.mediaDevices.getDisplayMedia({ video: true });
    assert.equal(result, stream);
    assert.equal(originalCalls, 1);
    assert.equal(committed, false);
  });

  it('falls back when a native session has an incompatible protocol version', async () => {
    let originalCalls = 0;
    let stoppedSessionId = '';
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
        prepare: async () => ({
          ok: true,
          protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION + 1,
          sessionId: 'native-bad',
          sourceId: 'screen:1:0'
        }),
        start: async () => ({ ok: false, reason: 'no-granted-source' }),
        stop: async (sessionId) => { stoppedSessionId = sessionId; }
      }
    };

    runInjectScript({ window, navigator });

    const result = await navigator.mediaDevices.getDisplayMedia({ video: true });
    assert.equal(originalCalls, 1);
    assert.equal(result, stream);
    assert.equal(stoppedSessionId, 'native-bad');
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
