'use strict';

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const revision = 'webrtc-a545de4';
const variant = 'win-x64-release';
// GitHub release asset 667477709 for the revision selected by Cargo.lock.
const digest = '862403fcb248c7d8803487e4c22b8821c6130e89100cb9c69be95ef45ff46146';
const url = `https://github.com/livekit/rust-sdks/releases/download/${revision}/webrtc-${variant}.zip`;

async function verifyArchive(archive, expected) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error('WebRTC archive SHA-256 mismatch');
}

async function preparePrebuilt(crate, {
  sha256 = digest,
  download = () => fetch(url, { signal: AbortSignal.timeout(120000) }),
  extract = (archive, destination) => {
    const tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
    const result = spawnSync(tar, ['-xf', archive, '-C', destination], { windowsHide: true, stdio: 'inherit' });
    if (result.status !== 0) throw new Error('WebRTC archive extraction failed');
  }
} = {}) {
  const cache = path.join(crate, '.webrtc', revision);
  const archive = path.join(cache, `webrtc-${variant}.zip`);
  fs.mkdirSync(cache, { recursive: true });
  const staging = fs.mkdtempSync(path.join(cache, 'staging-'));
  try {
    if (fs.existsSync(archive)) {
      // Snapshot the cached file before verifying it and extracting its contents.
      fs.copyFileSync(archive, path.join(staging, 'webrtc.zip'));
    } else {
      const response = await download();
      if (!response.ok || !response.body) throw new Error(`WebRTC download failed (HTTP ${response.status})`);
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(path.join(staging, 'webrtc.zip')));
    }
    const stagedArchive = path.join(staging, 'webrtc.zip');
    await verifyArchive(stagedArchive, sha256);
    await extract(stagedArchive, staging);
    const prebuilt = path.join(cache, variant);
    // Cache the verified ZIP. Always regenerate the extracted files from it.
    fs.rmSync(prebuilt, { recursive: true, force: true });
    fs.renameSync(path.join(staging, variant), prebuilt);
    if (!fs.existsSync(archive)) fs.renameSync(stagedArchive, archive);
    return prebuilt;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { preparePrebuilt };
