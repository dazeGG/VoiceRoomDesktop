'use strict';

const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const rawRef = process.env.GITHUB_REF_NAME || process.argv[2] || '';
const tag = rawRef.trim();

if (!tag) {
  console.error('Release version validation needs a tag name, for example v1.2.0.');
  process.exit(1);
}

if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error(`Release tag "${tag}" must look like v1.2.0.`);
  process.exit(1);
}

const tagVersion = tag.slice(1);
if (packageJson.version !== tagVersion) {
  console.error(`Release tag ${tag} does not match package.json version ${packageJson.version}.`);
  console.error(`Run: npm version ${tagVersion} --no-git-tag-version`);
  process.exit(1);
}

console.log(`Release version ${tagVersion} is valid.`);
