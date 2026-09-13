'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  classifyForegroundApp,
  parseForegroundPayload,
  sanitizeAllowedExecutables
} = require('../electron/policies/overlay-games');

describe('overlay game classification', () => {
  it('treats Steam, Epic and Riot game installs as games and skips launchers and browsers', () => {
    assert.equal(classifyForegroundApp({
      exe: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\VALORANT\\live\\VALORANT.exe'
    }).game, true);
    assert.equal(classifyForegroundApp({
      exe: 'C:\\Program Files\\Epic Games\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe'
    }).reason, 'install-path');
    assert.equal(classifyForegroundApp({
      exe: 'C:\\Program Files\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe'
    }).game, false);
    assert.equal(classifyForegroundApp({
      exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    }).reason, 'blacklist');
    assert.equal(classifyForegroundApp({
      exe: 'C:\\Users\\me\\AppData\\Local\\Programs\\voice-room-desktop\\Voice Room.exe'
    }).game, false);
  });

  it('accepts a user allowlist for games outside known install folders', () => {
    const custom = { exe: 'D:\\Games\\WeirdTitle\\weirdtitle.exe' };
    assert.equal(classifyForegroundApp(custom).game, false);
    assert.equal(classifyForegroundApp(custom, { allowedExecutables: ['weirdtitle.exe'] }).game, true);
    assert.equal(classifyForegroundApp(custom, { allowedExecutables: ['D:/Games/WeirdTitle/weirdtitle.exe'] }).reason, 'allowlist');
  });
});

describe('overlay foreground payload', () => {
  it('parses helper JSON and drops junk', () => {
    assert.equal(parseForegroundPayload('nope'), null);
    assert.deepEqual(parseForegroundPayload('{"exe":"C:\\\\game\\\\g.exe","pid":3,"title":"G","bounds":{"x":1,"y":2,"width":800,"height":600}}'), {
      bounds: { height: 600, width: 800, x: 1, y: 2 },
      exe: 'C:\\game\\g.exe',
      pid: 3,
      title: 'G'
    });
    assert.deepEqual(sanitizeAllowedExecutables(['CS2.EXE', 'cs2.exe', '', 1]).length, 1);
  });
});
