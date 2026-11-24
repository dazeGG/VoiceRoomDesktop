'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { preparePrebuilt } = require('../scripts/native-voice-prebuilt');

test('WebRTC verifies downloaded and restored archive bytes before extracting', async (t) => {
  const crate = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-prebuilt-'));
  t.after(() => fs.rmSync(crate, { recursive: true, force: true }));
  const good = 'expected archive bytes';
  let content = 'unexpected archive bytes';
  let downloads = 0;
  let extracts = 0;
  const options = {
    sha256: createHash('sha256').update(good).digest('hex'),
    download: () => {
      downloads += 1;
      return new Response(content);
    },
    extract: (archive, folder) => {
      extracts += 1;
      assert.equal(fs.readFileSync(archive, 'utf8'), good);
      const output = path.join(folder, 'win-x64-release');
      fs.mkdirSync(output);
      fs.writeFileSync(path.join(output, 'libwebrtc.lib'), 'verified library');
    }
  };

  await assert.rejects(preparePrebuilt(crate, options), /SHA-256 mismatch/);
  assert.equal(extracts, 0);
  content = good;
  const output = await preparePrebuilt(crate, options);
  const library = path.join(output, 'libwebrtc.lib');
  assert.equal(fs.readFileSync(library, 'utf8'), 'verified library');
  fs.writeFileSync(library, 'changed library');
  await preparePrebuilt(crate, options);
  assert.equal(fs.readFileSync(library, 'utf8'), 'verified library');

  fs.writeFileSync(path.join(path.dirname(output), 'webrtc-win-x64-release.zip'), 'corrupt cache');
  await assert.rejects(preparePrebuilt(crate, options), /SHA-256 mismatch/);
  assert.equal(downloads, 2);
  assert.equal(extracts, 2);
});
