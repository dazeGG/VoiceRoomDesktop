'use strict';

const {
  NATIVE_CAPTURE_PORT_MESSAGE_TYPE,
  NATIVE_CAPTURE_PROTOCOL_VERSION,
  hasChromiumAudioRequest,
  isCompatibleNativeCaptureSession,
  isNativeOnlyDisplayMediaCandidate
} = require('../native/capture-contract');

// Main-world wrapper around getDisplayMedia for the native cursor-correct
// capture path (Windows). Screen sources can use a native-first video path so
// Chromium never opens a temporary WGC video capture that paints a local yellow
// border. Window sources and Chromium loopback-audio requests keep the regular
// getDisplayMedia grant first, then swap the video track for native frames. Any
// native failure falls back to the untouched Chromium stream.
function getNativeCaptureInjectScript() {
  return `(() => {
    if (window.__voiceRoomNativeCaptureInstalled) return;
    window.__voiceRoomNativeCaptureInstalled = true;

    const bridge = window.voiceRoomNativeCaptureBridge;
    if (!bridge?.start || !navigator.mediaDevices?.getDisplayMedia) return;
    if (typeof MediaStreamTrackGenerator === 'undefined' || typeof VideoFrame === 'undefined') return;

    const NATIVE_CAPTURE_PROTOCOL_VERSION = ${JSON.stringify(NATIVE_CAPTURE_PROTOCOL_VERSION)};
    const PORT_MESSAGE_TYPE = ${JSON.stringify(NATIVE_CAPTURE_PORT_MESSAGE_TYPE)};
    const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

    const hasChromiumAudioRequest = ${hasChromiumAudioRequest.toString()};
    const isCompatibleNativeCaptureSession = ${isCompatibleNativeCaptureSession.toString()};
    const isNativeOnlyDisplayMediaCandidate = ${isNativeOnlyDisplayMediaCandidate.toString()};

    const waitForPort = (sessionId, timeoutMs) => new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Native capture port timed out.'));
      }, timeoutMs);
      const onMessage = (event) => {
        if (event.source !== window) return;
        if (event.data?.type !== PORT_MESSAGE_TYPE || event.data.sessionId !== sessionId) return;
        if (event.data.protocolVersion !== NATIVE_CAPTURE_PROTOCOL_VERSION) return;
        const port = event.ports?.[0];
        if (!port) return;
        cleanup();
        resolve(port);
      };
      window.addEventListener('message', onMessage);
    });

    const createNativeVideoTrack = (port, sessionId) => {
      // Deliberately no contentHint here: the hosted app owns it. It applies
      // 'motion' (games) or 'detail' (text mode) per user-selected stream mode
      // and only when the track arrives without a hint — hardcoding one would
      // lock every desktop stream into a single encoder degradation profile.
      const generator = new MediaStreamTrackGenerator({ kind: 'video' });
      const writer = generator.writable.getWriter();
      let closed = false;
      let sawFrame = false;
      let epochOffsetUs = null;
      let lastRelayStats = null;
      let pixelFormat;
      const counters = {
        framesDroppedBackpressure: 0,
        framesDroppedCreate: 0,
        framesReceived: 0,
        framesWritten: 0
      };

      window.__voiceRoomNativeCaptureStats = () => ({
        ...counters,
        pixelFormat,
        relay: lastRelayStats,
        sessionId
      });

      const normalizePixelFormat = (value) => {
        const normalized = String(value || '').toUpperCase();
        return normalized === 'NV12' || normalized === 'BGRX' ? normalized : undefined;
      };

      const normalizeFrameData = (data) => {
        if (data instanceof ArrayBuffer) return data;
        if (!ArrayBuffer.isView(data)) return null;
        if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data.buffer;
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      };

      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(watchdog);
        try { delete window.__voiceRoomNativeCaptureStats; } catch {}
        try { port.postMessage({ type: 'stop' }); } catch {}
        try { port.close(); } catch {}
        writer.close().catch(() => {});
        bridge.stop?.(sessionId)?.catch?.(() => {});
      };

      port.onmessage = (event) => {
        const message = event.data;
        if (!message || closed) return;
        if (message.type === 'end') {
          stop();
          return;
        }
        if (message.type === 'stats') {
          lastRelayStats = message;
          return;
        }
        if (message.type === 'format') {
          const nextPixelFormat = normalizePixelFormat(message.pixelFormat);
          if (nextPixelFormat) pixelFormat = nextPixelFormat;
          return;
        }
        if (message.type !== 'frame' || !message.data) return;
        // Release the relay's MessagePort slot as soon as this event reaches
        // the renderer. The writer.desiredSize check below independently
        // protects the encoder queue; this ack prevents raw frames from piling
        // up cross-process while the renderer event loop is busy.
        try { port.postMessage({ type: 'frame-ack' }); } catch {}
        counters.framesReceived += 1;
        if (generator.readyState === 'ended') {
          stop();
          return;
        }
        // The encoder is behind: drop the frame instead of queueing memory.
        if (writer.desiredSize !== null && writer.desiredSize <= 0) {
          counters.framesDroppedBackpressure += 1;
          return;
        }

        let frame = null;
        try {
          const data = normalizeFrameData(message.data);
          if (!data) return;
          const format = normalizePixelFormat(message.format) || 'BGRX';
          pixelFormat = format;
          // Prefer the helper's own capture timestamp over "now": the pipe/
          // utility-process/MessagePort hop between capture and here adds
          // scheduling jitter that would otherwise leak into encoder pacing.
          // Anchor the native clock to performance.now() once per track so
          // downstream consumers still see a plausible epoch, then advance it
          // using only native deltas (GetTickCount64 is monotonic, so this
          // never goes backwards or wraps in practice).
          const captureTimestampMs = typeof message.timestampMs === 'number' ? message.timestampMs : null;
          if (captureTimestampMs !== null && epochOffsetUs === null) {
            epochOffsetUs = (performance.now() * 1000) - (captureTimestampMs * 1000);
          }
          const timestamp = captureTimestampMs !== null
            ? Math.round((captureTimestampMs * 1000) + epochOffsetUs)
            : Math.round(performance.now() * 1000);
          const init = {
            codedHeight: message.height,
            codedWidth: message.width,
            format,
            timestamp,
            transfer: [data]
          };
          if (format === 'NV12') {
            init.layout = [
              { offset: 0, stride: message.width },
              { offset: message.width * message.height, stride: message.width }
            ];
            init.colorSpace = {
              fullRange: false,
              matrix: 'bt709',
              primaries: 'bt709',
              transfer: 'bt709'
            };
          }
          frame = new VideoFrame(data, init);
        } catch {
          counters.framesDroppedCreate += 1;
          return;
        }
        try {
          writer.write(frame).then(() => {
            if (closed) return;
            counters.framesWritten += 1;
            sawFrame = true;
          }).catch(() => {
            try { frame.close(); } catch {}
            stop();
          });
        } catch {
          try { frame.close(); } catch {}
          stop();
        }
      };
      port.start?.();

      // generator.stop() does not fire an "ended" event on itself, so poll the
      // readyState to shut the helper down once the app ends the stream.
      const watchdog = setInterval(() => {
        if (generator.readyState === 'ended') stop();
      }, 1000);
      watchdog.unref?.();

      const waitForFirstFrame = (timeoutMs) => new Promise((resolve, reject) => {
        const startedAt = performance.now();
        const poll = setInterval(() => {
          if (closed) {
            clearInterval(poll);
            reject(new Error('Native capture stopped before producing a writable frame.'));
          } else if (sawFrame) {
            clearInterval(poll);
            resolve();
          } else if (performance.now() - startedAt > timeoutMs) {
            clearInterval(poll);
            reject(new Error('Native capture produced no frames.'));
          }
        }, 50);
      });

      return { generator, stop, waitForFirstFrame };
    };

    navigator.mediaDevices.getDisplayMedia = async function voiceRoomGetDisplayMedia(constraints) {
      if (isNativeOnlyDisplayMediaCandidate(constraints, {
        mediaStreamAvailable: typeof MediaStream !== 'undefined'
      }) && bridge.prepare) {
        let preparedSession = null;
        let preparedNative = null;
        try {
          preparedSession = await bridge.prepare();
          if (isCompatibleNativeCaptureSession(preparedSession)) {
            const port = await waitForPort(preparedSession.sessionId, 4000);
            preparedNative = createNativeVideoTrack(port, preparedSession.sessionId);
            await preparedNative.waitForFirstFrame(4000);
            bridge.commitPrepared?.(preparedSession.sourceId)?.catch?.(() => {});
            return new MediaStream([preparedNative.generator]);
          }
          if (preparedSession?.ok) bridge.stop?.(preparedSession.sessionId)?.catch?.(() => {});
        } catch {
          preparedNative?.stop?.();
          if (preparedSession?.ok) bridge.stop?.(preparedSession.sessionId)?.catch?.(() => {});
        }
      }

      const stream = await originalGetDisplayMedia(constraints);
      let session = null;
      let native = null;
      try {
        session = await bridge.start();
        if (!isCompatibleNativeCaptureSession(session)) {
          if (session?.ok) bridge.stop?.(session.sessionId)?.catch?.(() => {});
          return stream;
        }

        const port = await waitForPort(session.sessionId, 4000);
        native = createNativeVideoTrack(port, session.sessionId);
        await native.waitForFirstFrame(4000);

        // Contract: the fallback/loopback path must preserve the exact
        // MediaStream object returned by Chromium. The hosted app associates
        // desktop audio and cleanup with this object identity; returning a
        // freshly built MediaStream here can silently drop the stream's sound.
        const previousVideoTracks = stream.getVideoTracks();
        stream.addTrack(native.generator);
        for (const track of previousVideoTracks) {
          stream.removeTrack(track);
          try { track.stop(); } catch {}
        }
        return stream;
      } catch {
        native?.stop?.();
        if (session?.ok) bridge.stop?.(session.sessionId)?.catch?.(() => {});
        return stream;
      }
    };
  })();`;
}

module.exports = {
  getNativeCaptureInjectScript
};
