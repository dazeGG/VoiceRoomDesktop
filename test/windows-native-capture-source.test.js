'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'native', 'capture', 'windows', 'ScreenCursorCapture.cpp'),
  'utf8'
);
const relaySource = fs.readFileSync(
  path.join(__dirname, '..', 'electron', 'native', 'capture-relay.js'),
  'utf8'
);

describe('Windows native capture helper source contract', () => {
  it('keeps the BGRX fallback within the selected output size', () => {
    assert.match(
      source,
      /WriteBgrxFrame\(width, height, outputSize\.width, outputSize\.height, cursorDrawn\)/
    );
    assert.match(
      source,
      /WriteStatus WriteBgrxFrame\(uint32_t sourceWidth,\s*uint32_t sourceHeight,\s*uint32_t outputWidth,\s*uint32_t outputHeight,\s*bool cursorDrawn\)/
    );
    assert.match(source, /WriteFrameHeader\(outputWidth, outputHeight, flags\)/);
    assert.doesNotMatch(source, /falling back to full-resolution BGRX frames/);
  });

  it('fits ultrawide sources inside both selected geometry ceilings', () => {
    assert.match(
      source,
      /ComputeOutputSize\(uint32_t width,\s*uint32_t height,\s*uint32_t maxWidth,\s*uint32_t maxHeight\)/
    );
    assert.match(source, /width <= maxWidth && height <= maxHeight/);
    assert.match(
      source,
      /static_cast<uint64_t>\(width\) \* maxHeight >= static_cast<uint64_t>\(height\) \* maxWidth/
    );
    assert.match(source, /outputWidth > maxWidth \|\| outputHeight > maxHeight/);
    assert.match(source, /maxWidth_\.load\(\),\s*maxHeight_\.load\(\)/);
    assert.match(relaySource, /'--max-width',\s*String\(session\.maxWidth\)/);

    const fit = (width, height, maxWidth, maxHeight) => {
      if (width <= maxWidth && height <= maxHeight) {
        const outputWidth = width & ~1;
        const outputHeight = height & ~1;
        return outputWidth >= 2 && outputHeight >= 2
          ? { height: outputHeight, width: outputWidth }
          : { height, width };
      }
      if (width * maxHeight >= height * maxWidth) {
        const outputWidth = maxWidth & ~1;
        return {
          height: Math.max(2, Math.round((height * outputWidth) / width)) & ~1,
          width: outputWidth
        };
      }
      const outputHeight = maxHeight & ~1;
      return {
        height: outputHeight,
        width: Math.max(2, Math.round((width * outputHeight) / height)) & ~1
      };
    };

    assert.deepEqual(fit(3440, 1440, 1920, 1080), { height: 804, width: 1920 });
    assert.deepEqual(fit(2560, 1080, 1920, 1080), { height: 810, width: 1920 });
    assert.deepEqual(fit(1920, 1200, 1920, 1080), { height: 1080, width: 1728 });
    assert.deepEqual(fit(1280, 720, 1920, 1080), { height: 720, width: 1280 });
    assert.deepEqual(fit(1537, 865, 1920, 1080), { height: 864, width: 1536 });
    assert.deepEqual(fit(1279, 719, 1280, 720), { height: 718, width: 1278 });
  });

  it('keeps odd-sized WGC windows on the even-dimension GPU path without upscaling', () => {
    assert.match(source, /if \(width <= maxWidth && height <= maxHeight\) \{/);
    assert.match(source, /const uint32_t outputWidth = MakeEvenDimension\(width\)/);
    assert.match(source, /const uint32_t outputHeight = MakeEvenDimension\(height\)/);
    assert.match(source, /outputWidth >= 2 && outputHeight >= 2/);
  });

  it('reports the actual frame pixel format after NV12 fallback or recovery', () => {
    assert.match(
      source,
      /LogFormat\(uint32_t width,\s*uint32_t height,\s*uint32_t fps,\s*const char\* pixelFormat\)/
    );
    assert.match(
      source,
      /LogFrameFormatIfChanged\(\s*outputSize\.width, outputSize\.height, fps, telemetryEpoch, true\)/
    );
    assert.match(
      source,
      /if \(bgrxStatus == WriteStatus::kWrote\) \{\s*LogFrameFormatIfChanged\(\s*outputSize\.width, outputSize\.height, fps, telemetryEpoch, false\)/
    );
    assert.match(source, /pixelFormatNv12 \? "nv12" : "bgrx"/);
  });

  it('does not report BGRX when staging Map fails before a frame is written', () => {
    const bgrxStart = source.indexOf('WriteStatus WriteBgrxFrame(');
    const bgrxEnd = source.indexOf('\n  void Reset()', bgrxStart);
    assert.ok(bgrxStart >= 0 && bgrxEnd > bgrxStart);
    const bgrxWriter = source.slice(bgrxStart, bgrxEnd);

    assert.match(
      bgrxWriter,
      /if \(FAILED\(d3dContext_->Map\([\s\S]*?\)\)\) \{\s*return WriteStatus::kFailedBeforeWrite;\s*\}/
    );
    assert.match(bgrxWriter, /return ok \? WriteStatus::kWrote : WriteStatus::kPipeClosed/);
    assert.doesNotMatch(bgrxWriter, /LogFrameFormatIfChanged/);
    assert.match(source, /return bgrxStatus != WriteStatus::kPipeClosed/);
    assert.doesNotMatch(source, /if \(bgrxStatus != WriteStatus::kPipeClosed\) \{\s*LogFrameFormatIfChanged/);
  });

  it('re-emits actual frame telemetry after reconfigure without a speculative NV12 event', () => {
    assert.equal((source.match(/\bLogFormat\(/g) || []).length, 2);
    assert.match(source, /formatTelemetryEpoch_\.fetch_add\(1\)/);
    assert.match(source, /loggedFormatTelemetryEpoch_ == telemetryEpoch/);
    assert.match(source, /formatTelemetryEpoch_\.load\(\)/);
    assert.doesNotMatch(source, /LogFormat\(outputSize\.width, outputSize\.height, fps_\.load\(\)\)/);
  });

  it('bounds renderer MessagePort frame backlog', () => {
    assert.match(relaySource, /MAX_RENDERER_FRAMES_IN_FLIGHT = 2/);
    assert.match(relaySource, /session\.framesInFlight >= MAX_RENDERER_FRAMES_IN_FLIGHT/);
    assert.match(relaySource, /event\.data\?\.type === 'frame-ack'/);
    assert.match(relaySource, /framesDroppedBackpressure/);
  });

  it('uses the MessagePortMain-supported cloned ArrayBuffer path', () => {
    assert.match(relaySource, /session\.port\.postMessage\(message\);/);
    assert.doesNotMatch(relaySource, /postMessage\(message,\s*message\.data/);
    assert.doesNotMatch(relaySource, /postMessage\(message,\s*\[message\.data\]/);
  });
});
