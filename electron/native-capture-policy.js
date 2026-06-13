'use strict';

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

    const PORT_MESSAGE_TYPE = 'voice-room-native-capture-port';
    const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

    const hasChromiumAudioRequest = (constraints) => {
      if (!constraints || typeof constraints !== 'object') return false;
      return Boolean(constraints.audio);
    };

    const canTryNativeOnly = (constraints) => {
      // Chromium loopback audio can only be obtained through the original
      // getDisplayMedia stream. Safe-system audio is started through the
      // desktop audio bridge, so video-only getDisplayMedia calls may skip
      // Chromium video capture entirely.
      return !hasChromiumAudioRequest(constraints) && typeof MediaStream !== 'undefined';
    };

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
      try {
        if ('contentHint' in generator) generator.contentHint = 'detail';
      } catch {}
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
          const format = message.format === 'NV12' ? 'NV12' : 'BGRX';
          const init = {
            codedHeight: message.height,
            codedWidth: message.width,
            format,
            timestamp: Math.round(performance.now() * 1000),
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
      watchdog.unref?.();

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
      if (canTryNativeOnly(constraints) && bridge.prepare) {
        let preparedSession = null;
        let preparedNative = null;
        try {
          preparedSession = await bridge.prepare();
          if (preparedSession?.ok) {
            const port = await waitForPort(preparedSession.sessionId, 4000);
            preparedNative = createNativeVideoTrack(port, preparedSession.sessionId);
            await preparedNative.waitForFirstFrame(4000);
            bridge.commitPrepared?.(preparedSession.sourceId)?.catch?.(() => {});
            return new MediaStream([preparedNative.generator]);
          }
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
        if (!session?.ok) return stream;

        const port = await waitForPort(session.sessionId, 4000);
        native = createNativeVideoTrack(port, session.sessionId);
        await native.waitForFirstFrame(4000);

        // Replace only the video track, keeping the original MediaStream object
        // and its audio tracks in place. The web app associates Chromium loopback
        // audio with this exact stream identity, so returning a freshly built
        // MediaStream on this fallback path can silently drop the stream's sound.
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
