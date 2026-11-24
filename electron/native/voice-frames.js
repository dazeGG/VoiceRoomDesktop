'use strict';

const MAX_FRAME = 64 * 1024;
const VERSION = Object.freeze({ major: 1, minor: 1 });
const decoder = new TextDecoder('utf-8', { fatal: true });

function encode(frame) {
  const body = Buffer.from(JSON.stringify(frame));
  if (body.length > MAX_FRAME) throw new Error('frame-size');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function createDecoder(onFrame) {
  const header = Buffer.alloc(4);
  let body = null;
  let used = 0;
  return (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      const target = body || header;
      const copied = chunk.copy(target, used, offset, offset + target.length - used);
      offset += copied;
      used += copied;
      if (used !== target.length) continue;
      used = 0;
      if (!body) {
        const size = header.readUInt32LE();
        if (!size || size > MAX_FRAME) throw new Error('frame-size');
        body = Buffer.allocUnsafe(size);
      } else {
        const frame = JSON.parse(decoder.decode(body));
        body = null;
        onFrame(frame);
      }
    }
  };
}

module.exports = { createDecoder, encode, MAX_FRAME, VERSION };
