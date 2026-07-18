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
const geometrySource = fs.readFileSync(
  path.join(__dirname, '..', 'native', 'capture', 'windows', 'CaptureGeometry.h'),
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

  it('wires both selected geometry ceilings into the compiled helper implementation', () => {
    assert.match(source, /#include "CaptureGeometry\.h"/);
    assert.match(
      geometrySource,
      /ComputeOutputSize\(uint32_t width,\s*uint32_t height,\s*uint32_t maxWidth,\s*uint32_t maxHeight\)/
    );
    assert.match(source, /maxWidth_\.load\(\),\s*maxHeight_\.load\(\)/);
    assert.match(relaySource, /'--max-width',\s*String\(session\.maxWidth\)/);
  });

  it('keeps odd-sized WGC windows on the even-dimension GPU path without upscaling', () => {
    assert.match(geometrySource, /if \(width <= maxWidth && height <= maxHeight\) \{/);
    assert.match(geometrySource, /const uint32_t outputWidth = MakeEvenDimension\(width\)/);
    assert.match(geometrySource, /const uint32_t outputHeight = MakeEvenDimension\(height\)/);
    assert.match(geometrySource, /outputWidth >= 2 && outputHeight >= 2/);
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
    assert.match(
      source,
      /return bgrxStatus == WriteStatus::kPipeClosed\s*\? FrameWriteResult::kPipeClosed\s*:\s*FrameWriteResult::kRecoverableFailure/
    );
    assert.doesNotMatch(source, /if \(bgrxStatus != WriteStatus::kPipeClosed\) \{\s*LogFrameFormatIfChanged/);
  });

  it('re-emits actual frame telemetry after reconfigure without a speculative NV12 event', () => {
    assert.equal((source.match(/\bLogFormat\(/g) || []).length, 2);
    assert.match(source, /formatTelemetryEpoch_\.fetch_add\(1\)/);
    assert.match(source, /loggedFormatTelemetryEpoch_ == telemetryEpoch/);
    assert.match(source, /formatTelemetryEpoch_\.load\(\)/);
    assert.doesNotMatch(source, /LogFormat\(outputSize\.width, outputSize\.height, fps_\.load\(\)\)/);
  });

  it('acknowledges reconfigure only with the profile applied by the helper', () => {
    assert.match(source, /const bool hasRequestId = ParseJsonUintField\(line, "requestId", &requestId\)/);
    assert.match(
      source,
      /const CaptureSession::ReconfigureResult applied = session->ApplyReconfigure\([\s\S]*?LogReconfigured\(requestId, applied\.fps, applied\.maxWidth, applied\.maxHeight\)/
    );
    assert.match(source, /if \(maxWidth >= 2 && maxWidth <= 16384\)/);
    assert.match(source, /if \(maxHeight >= 2 && maxHeight <= 16384\)/);
    assert.match(source, /std::lock_guard<std::mutex> guard\(frameMutex_\)/);
  });

  it('turns unrecoverable capture stalls into a non-zero helper exit for relay restart', () => {
    assert.match(source, /if \(RecreateDuplication\(\)\) continue;\s*SignalRuntimeFailure\("Desktop Duplication recovery failed\."\)/);
    assert.match(source, /SignalRuntimeFailure\("AcquireNextFrame failed\.", hr\)/);
    assert.match(source, /kMaxConsecutiveFrameWriteFailures = 3/);
    assert.match(source, /SignalRuntimeFailure\("Native capture frame processing failed repeatedly\."\)/);
    assert.match(source, /if \(session\.HasRuntimeFailure\(\)\) exitCode = 1/);
  });

  it('gates and drains in-flight WGC delegates before destroying session state', () => {
    assert.match(
      source,
      /class FrameCallbackState[\s\S]*?CaptureSession\* TryEnter\(\)[\s\S]*?void BeginStop\(\)[\s\S]*?void WaitForDrain\(\)/
    );
    assert.match(source, /frameCallbackState_ = std::make_shared<FrameCallbackState>\(this\)/);
    assert.match(source, /\[callbackState\][\s\S]*?FrameCallbackLease callback\(callbackState\)/);
    assert.doesNotMatch(source, /framePool_\.FrameArrived\([\s\S]*?\[this\]/);
    assert.match(
      source,
      /frameCallbackState_->BeginStop\(\)[\s\S]*?frameArrivedRevoker_\.revoke\(\);\s*closedRevoker_\.revoke\(\);\s*if \(frameCallbackState_\) frameCallbackState_->WaitForDrain\(\)/
    );
  });

  it('accepts helper pause commands and skips expensive frame conversion while paused', () => {
    assert.match(source, /line\.find\("set-paused"\)/);
    assert.match(source, /session->ApplyFlowControl\(paused\)/);
    assert.match(source, /if \(emit && !outputPaused_\.load\(\)\)/);
    assert.match(source, /if \(outputPaused_\.load\(\)\) return/);
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
