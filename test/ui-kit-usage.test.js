'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..');
const electronDir = path.join(root, 'electron');
const uiDir = path.join(electronDir, 'ui');

// A literal that has to stay needs a reason. None of the shell pages have one:
// colours, radii and fonts come from the kit tokens.
const ALLOWLIST = [];

const COLOR_LITERAL = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\brgba?\(|\bhsla?\(|\boklch\(|\boklab\(|\bcolor\(/;
const RADIUS_PX = /border-radius\s*:[^;{}]*\d+px/i;
const FONT_FAMILY = /font-family\s*:/i;

function collectCss(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'kit') continue;
      collectCss(full, out);
      continue;
    }
    if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

function maskComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

describe('shell pages use the UI kit', () => {
  it('links the kit stylesheet from every shell page', () => {
    const pages = fs.readdirSync(uiDir).filter((name) => name.endsWith('.html'));
    assert.ok(pages.length > 0);

    for (const page of pages) {
      const html = fs.readFileSync(path.join(uiDir, page), 'utf8');
      assert.match(
        html,
        /href=["']\.\/kit\/voiceroom-kit\.css["']/,
        `${page} must link ./kit/voiceroom-kit.css`
      );
    }
  });

  it('keeps colour, radius and font literals out of shell stylesheets', () => {
    const violations = [];
    const matchedAllowlist = new Set();

    for (const file of collectCss(electronDir)) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      const lines = maskComments(fs.readFileSync(file, 'utf8')).split(/\r?\n/);
      lines.forEach((line, index) => {
        const lineNumber = index + 1;
        const problems = [];
        if (COLOR_LITERAL.test(line)) problems.push('colour literal');
        if (RADIUS_PX.test(line)) problems.push('border-radius in px');
        if (FONT_FAMILY.test(line)) problems.push('font-family');
        if (problems.length === 0) return;

        const allowed = ALLOWLIST.find((entry) => (
          entry.file === relative
          && entry.line === lineNumber
          && entry.reason
        ));
        if (allowed) {
          matchedAllowlist.add(allowed);
          return;
        }
        violations.push(`${relative}:${lineNumber} (${problems.join(', ')}): ${line.trim()}`);
      });
    }

    assert.deepEqual(violations, []);
    const stale = ALLOWLIST.filter((entry) => !matchedAllowlist.has(entry));
    assert.deepEqual(stale, [], 'allowlist entries must match a real literal and say why');
  });
});
