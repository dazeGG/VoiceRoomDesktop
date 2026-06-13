#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const checklistPath = path.join(__dirname, '..', 'docs', 'testing', 'windows-tray-smoke.md');

if (!fs.existsSync(checklistPath)) {
  console.error(`Missing Windows tray smoke checklist: ${checklistPath}`);
  process.exit(1);
}

const checklist = fs.readFileSync(checklistPath, 'utf8');
const requiredChecks = [
  'Click the titlebar **X**',
  'Click the tray icon',
  'Открыть Voice Room',
  'Alt+F4',
  'Выход',
  'VOICE_ROOM_PICKER_PREVIEW=1'
];
const missingChecks = requiredChecks.filter((check) => !checklist.includes(check));

if (missingChecks.length > 0) {
  console.error(`Windows tray smoke checklist is missing required checks: ${missingChecks.join(', ')}`);
  process.exit(1);
}

console.log(`Windows tray smoke checklist: ${checklistPath}`);
if (process.platform !== 'win32') {
  console.log('Manual execution requires a packaged Windows build. Checklist integrity verified.');
}
