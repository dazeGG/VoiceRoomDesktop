'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { filterEnumeratedMediaDevices } = require('../electron/media-device-policy');

describe('filterEnumeratedMediaDevices', () => {
  it('removes built-in audio duplicates when a default entry exists', () => {
    const devices = [
      { deviceId: 'default', kind: 'audioinput', label: 'Default - MacBook Microphone', groupId: 'g1' },
      { deviceId: 'abc', kind: 'audioinput', label: 'MacBook Microphone', groupId: 'g1' },
      { deviceId: 'xyz', kind: 'audioinput', label: 'AirPods', groupId: 'g2' },
      { deviceId: 'default', kind: 'audiooutput', label: 'Default - MacBook Speakers', groupId: 'g3' },
      { deviceId: 'def', kind: 'audiooutput', label: 'MacBook Speakers', groupId: 'g3' }
    ];

    assert.deepEqual(
      filterEnumeratedMediaDevices(devices),
      [
        { deviceId: 'default', kind: 'audioinput', label: 'Default - MacBook Microphone', groupId: 'g1' },
        { deviceId: 'xyz', kind: 'audioinput', label: 'AirPods', groupId: 'g2' },
        { deviceId: 'default', kind: 'audiooutput', label: 'Default - MacBook Speakers', groupId: 'g3' }
      ]
    );
  });

  it('deduplicates by matching default label suffix when groupId is missing', () => {
    const devices = [
      { deviceId: 'default', kind: 'audioinput', label: 'Default - USB Mic' },
      { deviceId: 'abc', kind: 'audioinput', label: 'USB Mic' }
    ];

    assert.deepEqual(filterEnumeratedMediaDevices(devices), [devices[0]]);
  });

  it('keeps all devices when no default entry exists', () => {
    const devices = [
      { deviceId: 'abc', kind: 'audioinput', label: 'MacBook Microphone', groupId: 'g1' },
      { deviceId: 'xyz', kind: 'audiooutput', label: 'MacBook Speakers', groupId: 'g2' }
    ];

    assert.deepEqual(filterEnumeratedMediaDevices(devices), devices);
  });

  it('does not filter non-audio devices', () => {
    const devices = [
      { deviceId: 'default', kind: 'audioinput', label: 'Default - MacBook Microphone', groupId: 'g1' },
      { deviceId: 'abc', kind: 'audioinput', label: 'MacBook Microphone', groupId: 'g1' },
      { deviceId: 'cam', kind: 'videoinput', label: 'FaceTime HD Camera', groupId: 'g4' }
    ];

    assert.deepEqual(filterEnumeratedMediaDevices(devices), [devices[0], devices[2]]);
  });
});