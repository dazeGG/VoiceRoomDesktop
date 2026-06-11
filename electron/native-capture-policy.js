'use strict';

// Main-world wrapper around getDisplayMedia for the native cursor-correct
// capture path (Windows). The regular getDisplayMedia call still happens —
// it drives the picker handshake, permissions and loopback audio — but its
// video track (where Chromium bakes a cursor that ignores app-level hiding)
// is swapped for a MediaStreamTrackGenerator fed by the native helper's
// frames. Any failure falls back to the untouched Chromium stream.
function getNativeCaptureInjectScript() {
  return `(() => {
    if (window.__voiceRoomNativeCaptureInstalled) return;
    window.__voiceRoomNativeCaptureInstalled = true;

    const bridge = window.voiceRoomNativeCaptureBridge;
    if (!bridge?.start || !navigator.mediaDevices?.getDisplayMedia) return;
    if (typeof MediaStreamTrackGenerator === 'undefined' || typeof VideoFrame === 'undefined') return;

    const PORT_MESSAGE_TYPE = 'voice-room-native-capture-port';
    const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

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
        const port = event.ports?.[0];
        if (!port) return;
        cleanup();
        resolve(port);
      };
      window.addEventListener('message', onMessage);
    });

    const createNativeVideoTrack = (port, sessionId) => {
      const generator = new MediaStreamTrackGenerator({ kind: 'video' });
      const writer = generator.writable.getWriter();
      let closed = false;
      let sawFrame = false;

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
        if (message.type !== 'frame' || !message.data) return;
        if (generator.readyState === 'ended') {
          stop();
          return;
        }
        // The encoder is behind: drop the frame instead of queueing memory.
        if (writer.desiredSize !== null && writer.desiredSize <= 0) return;

        let frame = null;
        try {
          const data = normalizeFrameData(message.data);
          if (!data) return;
          frame = new VideoFrame(data, {
            codedHeight: message.height,
            codedWidth: message.width,
            format: 'BGRX',
            timestamp: Math.round(performance.now() * 1000),
            transfer: [data]
          });
        } catch {
          return;
        }
        sawFrame = true;
        writer.write(frame).catch(() => {
          try { frame.close(); } catch {}
          stop();
        });
      };
      port.start?.();

      // generator.stop() does not fire an "ended" event on itself, so poll the
      // readyState to shut the helper down once the app ends the stream.
      const watchdog = setInterval(() => {
        if (generator.readyState === 'ended') stop();
      }, 1000);

      const waitForFirstFrame = (timeoutMs) => new Promise((resolve, reject) => {
        const startedAt = performance.now();
        const poll = setInterval(() => {
          if (sawFrame) {
            clearInterval(poll);
            resolve();
          } else if (closed || performance.now() - startedAt > timeoutMs) {
            clearInterval(poll);
            reject(new Error('Native capture produced no frames.'));
          }
        }, 50);
      });

      return { generator, stop, waitForFirstFrame };
    };

    navigator.mediaDevices.getDisplayMedia = async function voiceRoomGetDisplayMedia(constraints) {
      const stream = await originalGetDisplayMedia(constraints);
      let session = null;
      let native = null;
      try {
        session = await bridge.start();
        if (!session?.ok) return stream;

        const port = await waitForPort(session.sessionId, 4000);
        native = createNativeVideoTrack(port, session.sessionId);
        await native.waitForFirstFrame(4000);

        // Replace only the video track, keeping the original MediaStream object
        // and its audio tracks in place. The web app associates the stream's
        // audio (loopback track here, or a safe-system track it mixes in later)
        // with this exact stream identity, so returning a freshly built
        // MediaStream can silently drop the stream's sound.
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
