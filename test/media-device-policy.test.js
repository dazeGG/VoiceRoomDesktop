'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  buildDefaultToConcreteRemaps,
  filterEnumeratedMediaDevices,
  getMediaDeviceFilterInjectScript,
  remapMediaStreamConstraints
} = require('../electron/media-device-policy');

const builtInDevices = [
  { deviceId: 'default', kind: 'audioinput', label: 'Default - MacBook Microphone', groupId: 'g1' },
  { deviceId: 'abc', kind: 'audioinput', label: 'MacBook Microphone', groupId: 'g1' },
  { deviceId: 'xyz', kind: 'audioinput', label: 'AirPods', groupId: 'g2' },
  { deviceId: 'default', kind: 'audiooutput', label: 'Default - MacBook Speakers', groupId: 'g3' },
  { deviceId: 'def', kind: 'audiooutput', label: 'MacBook Speakers', groupId: 'g3' }
];

describe('filterEnumeratedMediaDevices', () => {
  it('removes default pseudo-devices when a concrete duplicate exists', () => {
    assert.deepEqual(
      filterEnumeratedMediaDevices(builtInDevices),
      [
        { deviceId: 'abc', kind: 'audioinput', label: 'MacBook Microphone', groupId: 'g1' },
        { deviceId: 'xyz', kind: 'audioinput', label: 'AirPods', groupId: 'g2' },
        { deviceId: 'def', kind: 'audiooutput', label: 'MacBook Speakers', groupId: 'g3' }
      ]
    );
  });

  it('deduplicates by matching default label suffix when groupId is missing', () => {
    const devices = [
      { deviceId: 'default', kind: 'audioinput', label: 'Default - USB Mic' },
      { deviceId: 'abc', kind: 'audioinput', label: 'USB Mic' }
    ];

    assert.deepEqual(filterEnumeratedMediaDevices(devices), [devices[1]]);
  });

  it('keeps default when no concrete duplicate exists', () => {
    const devices = [
      { deviceId: 'default', kind: 'audioinput', label: 'Default - MacBook Microphone', groupId: 'g1' }
    ];

    assert.deepEqual(filterEnumeratedMediaDevices(devices), devices);
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

    assert.deepEqual(filterEnumeratedMediaDevices(devices), [devices[1], devices[2]]);
  });
});

describe('buildDefaultToConcreteRemaps', () => {
  it('maps default pseudo-devices to their concrete duplicates', () => {
    assert.deepEqual(
      [...buildDefaultToConcreteRemaps(builtInDevices).entries()],
      [
        ['audioinput:default', 'abc'],
        ['audiooutput:default', 'def']
      ]
    );
  });
});

describe('getMediaDeviceFilterInjectScript', () => {
  it('embeds audio device helpers instead of referencing module scope', () => {
    const script = getMediaDeviceFilterInjectScript();

    assert.match(script, /const AUDIO_DEVICE_KINDS = new Set\(\["audioinput", "audiooutput"\]\);/);
    assert.match(script, /function findConcreteDuplicate/);
    assert.match(script, /return filterEnumeratedMediaDevices\(devices\);/);
    assert.doesNotMatch(script, /const filter =/);
  });
});

describe('remapMediaStreamConstraints', () => {
  it('rewrites exact default device ids to concrete ids', () => {
    const remaps = buildDefaultToConcreteRemaps(builtInDevices);
    const remapDeviceId = (deviceId) => remaps.get(`audioinput:${deviceId}`) || deviceId;

    assert.deepEqual(
      remapMediaStreamConstraints({
        audio: { deviceId: { exact: 'default' } }
      }, remapDeviceId),
      {
        audio: { deviceId: { exact: 'abc' } }
      }
    );
  });
});