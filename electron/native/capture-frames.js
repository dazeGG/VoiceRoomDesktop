'use strict';

// Binary frame protocol shared with native/capture/windows/ScreenCursorCapture.cpp:
// 24-byte header (u32 magic 'VRF1', u32 width, u32 height, u32 flags,
// i64 timestampMs) followed by top-down frame payload. flags bit0 means
// cursor drawn; bit1 means NV12 payload, otherwise width * height * 4 BGRX.
const FRAME_MAGIC = 0x31465256;
const FRAME_HEADER_BYTES = 24;
const FRAME_FLAG_FORMAT_NV12 = 1 << 1;
const MAX_FRAME_DIMENSION = 16384;

function createFrameState() {
  return {
    chunks: [],
    chunkBytes: 0,
    expectedFrame: null
  };
}

function appendFrameChunk(state, chunk) {
  const frames = [];
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.chunks.push(buffer);
  state.chunkBytes += buffer.length;

  for (;;) {
    if (!state.expectedFrame) {
      if (state.chunkBytes < FRAME_HEADER_BYTES) return { frames };
      const header = takeBytes(state, FRAME_HEADER_BYTES);
      const magic = header.readUInt32LE(0);
      const width = header.readUInt32LE(4);
      const height = header.readUInt32LE(8);
      const flags = header.readUInt32LE(12);
      const timestampMs = Number(header.readBigInt64LE(16));

      if (magic !== FRAME_MAGIC || !width || !height
        || width > MAX_FRAME_DIMENSION || height > MAX_FRAME_DIMENSION) {
        return { error: { reason: 'corrupted', message: 'Native capture stream is corrupted.' }, frames };
      }
      if ((flags & FRAME_FLAG_FORMAT_NV12) && ((width % 2) !== 0 || (height % 2) !== 0)) {
        return { error: { reason: 'corrupted', message: 'Native NV12 frame has odd dimensions.' }, frames };
      }
      state.expectedFrame = {
        flags,
        height,
        payloadBytes: getFramePayloadBytes(width, height, flags),
        timestampMs,
        width
      };
    }

    if (state.chunkBytes < state.expectedFrame.payloadBytes) return { frames };
    const frame = state.expectedFrame;
    state.expectedFrame = null;
    const payload = takeBytes(state, frame.payloadBytes);
    frames.push({
      data: toFrameArrayBuffer(payload),
      flags: frame.flags,
      format: (frame.flags & FRAME_FLAG_FORMAT_NV12) ? 'NV12' : 'BGRX',
      height: frame.height,
      timestampMs: frame.timestampMs,
      type: 'frame',
      width: frame.width
    });
  }
}

function getFramePayloadBytes(width, height, flags) {
  if (flags & FRAME_FLAG_FORMAT_NV12) {
    return width * height + Math.floor(width * height / 2);
  }
  return width * height * 4;
}

// Consumes exactly `length` bytes from the buffered stdout chunks with a
// single copy for multi-chunk reads (frames span ~128 pipe chunks; repeated
// Buffer.concat per chunk would be quadratic).
function takeBytes(state, length) {
  state.chunkBytes -= length;

  const first = state.chunks[0];
  if (first.length === length) {
    state.chunks.shift();
    return first;
  }
  if (first.length > length) {
    state.chunks[0] = first.subarray(length);
    return first.subarray(0, length);
  }

  const result = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const chunk = state.chunks[0];
    const needed = length - offset;
    if (chunk.length <= needed) {
      chunk.copy(result, offset);
      offset += chunk.length;
      state.chunks.shift();
    } else {
      chunk.copy(result, offset, 0, needed);
      state.chunks[0] = chunk.subarray(needed);
      offset += needed;
    }
  }
  return result;
}

function toFrameArrayBuffer(buffer) {
  if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
    return buffer.buffer;
  }
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

module.exports = {
  FRAME_FLAG_FORMAT_NV12,
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  MAX_FRAME_DIMENSION,
  appendFrameChunk,
  createFrameState,
  getFramePayloadBytes,
  takeBytes,
  toFrameArrayBuffer
};
