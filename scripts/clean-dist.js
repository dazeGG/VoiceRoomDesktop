'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const packageJson = require('../package.json');
const version = packageJson.version;

// Keep in sync with artifactBase in electron-builder.config.js. The slug is a
// space-free "Voice-Room" (productName is "Voice Room"): a space in the filename
// breaks auto-update, so the artifacts — and therefore this filter — use hyphens.
const ARTIFACT_SLUG = 'Voice-Room';
const isDevBuild = (process.env.VOICE_ROOM_DEV_BUILD || '') === '1';
// Same directory electron-builder wrote to: dist, or dist/dev/<hash> for dev builds.
const distDir = path.join(__dirname, '..', (process.env.VOICE_ROOM_DIST_DIR || 'dist').trim());

function shouldKeepFile(name) {
  const isOurArtifact = name.startsWith(`${ARTIFACT_SLUG}-${version}-`);

  // Installers are always the deliverable.
  if (isOurArtifact && /\.(?:dmg|exe|zip)$/i.test(name)) return true;

  // Dev builds are lightweight — just the installers, no auto-update plumbing.
  if (isDevBuild) return false;

  // Stable builds also keep the auto-update feed + differential blockmaps.
  if (/^latest.*\.ya?ml$/i.test(name)) return true;
  if (isOurArtifact && /\.blockmap$/i.test(name)) return true;

  return false;
}

async function cleanDist() {
  let entries;
  try {
    entries = await fs.readdir(distDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (entry.isFile() && shouldKeepFile(entry.name)) return;
      await fs.rm(path.join(distDir, entry.name), { force: true, recursive: true });
    })
  );
}

cleanDist().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
