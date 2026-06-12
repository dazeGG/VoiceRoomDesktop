'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const builderConfig = require('../electron-builder.config');

describe('electron-builder config', () => {
  it('packages native capture utility process modules', () => {
    assert.ok(builderConfig.files.includes('electron/native-capture.js'));
    assert.ok(builderConfig.files.includes('electron/native-capture-frames.js'));
    assert.ok(builderConfig.files.includes('electron/native-capture-relay.js'));
  });
});
