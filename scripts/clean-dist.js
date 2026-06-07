'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const distDir = path.join(__dirname, '..', 'dist');
const packageJson = require('../package.json');
const electronBuilderConfig = require('../electron-builder.config.js');
const productName = electronBuilderConfig.productName || packageJson.productName || packageJson.name;
const version = packageJson.version;
const keep = new Set([
  `${productName}-${version}-mac-arm64.dmg`,
  `${productName}-${version}-mac-x64.dmg`,
  `${productName}-${version}-win-x64.exe`
]);

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
      if (entry.isFile() && keep.has(entry.name)) return;
      await fs.rm(path.join(distDir, entry.name), { force: true, recursive: true });
    })
  );
}

cleanDist().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
