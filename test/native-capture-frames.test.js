'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  FRAME_FLAG_FORMAT_NV12,
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  appendFrameChunk,
  createFrameState
} = require('../electron/native/capture-frames');

function makeFrame({ flags = FRAME_FLAG_FORMAT_NV12, height = 4, timestampMs = 123n, width = 4 } = {}) {
  const payloadBytes = flags & FRAME_FLAG_FORMAT_NV12
    ? width * height + Math.floor(width * height / 2)
    : width * height * 4;
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32LE(FRAME_MAGIC, 0);
  header.writeUInt32LE(width, 4);
  header.writeUInt32LE(height, 8);
  header.writeUInt32LE(flags, 12);
  header.writeBigInt64LE(timestampMs, 16);
  const payload = Buffer.alloc(payloadBytes);
  for (let index = 0; index < payload.length; ++index) payload[index] = index % 251;
  return { buffer: Buffer.concat([header, payload]), payload };
}

function arrayBufferToBuffer(arrayBuffer) {
  return Buffer.from(arrayBuffer, 0, arrayBuffer.byteLength);
}

describe('native capture frame parser', () => {
  it('parses a frame split across 64 KB chunks', () => {
    const state = createFrameState();
    const frame = makeFrame({ height: 1080, width: 1920 });
    let result = { frames: [] };

    for (let offset = 0; offset < frame.buffer.length; offset += 64 * 1024) {
      result = appendFrameChunk(state, frame.buffer.subarray(offset, offset + 64 * 1024));
    }

    assert.equal(result.error, undefined);
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0].format, 'NV12');
    assert.equal(result.frames[0].height, 1080);
    assert.equal(result.frames[0].width, 1920);
    assert.deepEqual(arrayBufferToBuffer(result.frames[0].data), frame.payload);
  });

  it('parses a frame in one chunk', () => {
    const state = createFrameState();
    const frame = makeFrame({ flags: 0, height: 3, width: 5 });
    const result = appendFrameChunk(state, frame.buffer);

    assert.equal(result.error, undefined);
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0].format, 'BGRX');
    assert.deepEqual(arrayBufferToBuffer(result.frames[0].data), frame.payload);
  });

  it('rejects garbage magic', () => {
    const state = createFrameState();
    const frame = makeFrame();
    frame.buffer.writeUInt32LE(0, 0);
    const result = appendFrameChunk(state, frame.buffer);

    assert.equal(result.frames.length, 0);
    assert.equal(result.error.reason, 'corrupted');
  });

  it('rejects NV12 with odd dimensions', () => {
    const state = createFrameState();
    const frame = makeFrame({ height: 5, width: 5 });
    const result = appendFrameChunk(state, frame.buffer.subarray(0, FRAME_HEADER_BYTES));

    assert.equal(result.frames.length, 0);
    assert.equal(result.error.reason, 'corrupted');
  });
});
