'use strict';

// Copies the VoiceRoom UI kit, compiled to plain CSS with its fonts, into
// electron/ui/kit/. The shell's own windows load it instead of drawing their
// own tokens and controls (VoiceRoom DESIGN.md, "Implementation constraints").
//
//   npm run kit:sync                       # VoiceRoom checked out next to this repo
//   VOICEROOM_REPO=/path/to/VoiceRoom npm run kit:sync
//
// The output is generated: never edit electron/ui/kit/ by hand, change the kit
// in VoiceRoom and sync again.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const kitDir = path.join(desktopRoot, 'electron', 'ui', 'kit');

function voiceRoomRepo(env = process.env) {
  return path.resolve(env.VOICEROOM_REPO || path.join(desktopRoot, '..', 'VoiceRoom'));
}

function syncUiKit({ repo = voiceRoomRepo(), outDir = kitDir } = {}) {
  const script = path.join(repo, 'scripts', 'build-kit-css.mts');
  if (!fs.existsSync(script)) {
    throw new Error(`VoiceRoom checkout not found at ${repo} (set VOICEROOM_REPO)`);
  }
  execFileSync(process.execPath, [script, outDir], { cwd: repo, stdio: 'inherit' });
  return outDir;
}

if (require.main === module) {
  syncUiKit();
}

module.exports = { syncUiKit, voiceRoomRepo };
