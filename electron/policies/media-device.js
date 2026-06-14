'use strict';

const AUDIO_DEVICE_KINDS = new Set(['audioinput', 'audiooutput']);

function getDefaultDeviceName(label) {
  const match = /^Default\s*-\s*(.+)$/i.exec(String(label || '').trim());
  return match ? match[1].trim() : '';
}

function isConcreteDuplicateOfDefault(defaultDevice, device) {
  if (device.kind !== defaultDevice.kind || device.deviceId === 'default') return false;

  if (defaultDevice.groupId && device.groupId && defaultDevice.groupId === device.groupId) {
    return true;
  }

  const defaultName = getDefaultDeviceName(defaultDevice.label);
  const deviceLabel = String(device.label || '').trim();
  return Boolean(defaultName && deviceLabel && defaultName === deviceLabel);
}

function findConcreteDuplicate(defaultDevice, devices) {
  return devices.find((device) => isConcreteDuplicateOfDefault(defaultDevice, device)) || null;
}

function buildDefaultToConcreteRemaps(devices) {
  const remaps = new Map();

  for (const device of devices) {
    if (!AUDIO_DEVICE_KINDS.has(device.kind) || device.deviceId !== 'default') continue;
    const concrete = findConcreteDuplicate(device, devices);
    if (!concrete) continue;
    remaps.set(`${device.kind}:${device.deviceId}`, concrete.deviceId);
  }

  return remaps;
}

function filterEnumeratedMediaDevices(devices) {
  if (!Array.isArray(devices) || devices.length === 0) return devices;

  return devices.filter((device) => {
    if (!AUDIO_DEVICE_KINDS.has(device.kind)) return true;
    if (device.deviceId !== 'default') return true;
    return !findConcreteDuplicate(device, devices);
  });
}

function remapAudioConstraint(constraint, remapDeviceId) {
  if (!constraint) return constraint;
  if (constraint === true) return constraint;
  if (typeof constraint !== 'object') return constraint;

  const next = { ...constraint };
  if (typeof next.deviceId === 'string') {
    next.deviceId = remapDeviceId(next.deviceId);
  } else if (next.deviceId && typeof next.deviceId === 'object') {
    next.deviceId = { ...next.deviceId };
    if (Array.isArray(next.deviceId.exact)) {
      next.deviceId.exact = next.deviceId.exact.map(remapDeviceId);
    } else if (typeof next.deviceId.exact === 'string') {
      next.deviceId.exact = remapDeviceId(next.deviceId.exact);
    }
    if (Array.isArray(next.deviceId.ideal)) {
      next.deviceId.ideal = next.deviceId.ideal.map(remapDeviceId);
    } else if (typeof next.deviceId.ideal === 'string') {
      next.deviceId.ideal = remapDeviceId(next.deviceId.ideal);
    }
  }

  return next;
}

function remapMediaStreamConstraints(constraints, remapDeviceId) {
  if (!constraints || typeof constraints !== 'object') return constraints;
  const next = { ...constraints };
  if ('audio' in next) next.audio = remapAudioConstraint(next.audio, remapDeviceId);
  return next;
}

function getInjectableMediaDeviceRuntime() {
  return [
    'const AUDIO_DEVICE_KINDS = new Set(["audioinput", "audiooutput"]);',
    getDefaultDeviceName.toString(),
    isConcreteDuplicateOfDefault.toString(),
    findConcreteDuplicate.toString(),
    buildDefaultToConcreteRemaps.toString(),
    filterEnumeratedMediaDevices.toString(),
    remapAudioConstraint.toString(),
    remapMediaStreamConstraints.toString()
  ].join('\n');
}

function getMediaDeviceFilterInjectScript() {
  return `(() => {
    if (window.__voiceRoomMediaDeviceFilterInstalled) return;
    window.__voiceRoomMediaDeviceFilterInstalled = true;
    if (!navigator.mediaDevices?.enumerateDevices) return;

    ${getInjectableMediaDeviceRuntime()}

    let deviceIdRemaps = new Map();
    const originalEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);

    const refreshDeviceIdRemaps = async () => {
      const devices = await originalEnumerateDevices();
      deviceIdRemaps = buildDefaultToConcreteRemaps(devices);
    };

    const remapDeviceId = (deviceId) => {
      if (typeof deviceId !== 'string' || !deviceId) return deviceId;
      for (const [fromKey, toId] of deviceIdRemaps.entries()) {
        const [, fromId] = fromKey.split(':');
        if (fromId === deviceId) return toId;
      }
      return deviceId;
    };
    navigator.mediaDevices.enumerateDevices = async function voiceRoomEnumerateDevices() {
      const devices = await originalEnumerateDevices();
      deviceIdRemaps = buildDefaultToConcreteRemaps(devices);
      return filterEnumeratedMediaDevices(devices);
    };

    if (navigator.mediaDevices.getUserMedia) {
      const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async function voiceRoomGetUserMedia(constraints) {
        await refreshDeviceIdRemaps();
        return originalGetUserMedia(
          remapMediaStreamConstraints(constraints, remapDeviceId)
        );
      };
    }

    if (typeof HTMLMediaElement !== 'undefined' && HTMLMediaElement.prototype.setSinkId) {
      const originalSetSinkId = HTMLMediaElement.prototype.setSinkId;
      HTMLMediaElement.prototype.setSinkId = function voiceRoomSetSinkId(deviceId) {
        return originalSetSinkId.call(this, remapDeviceId(deviceId));
      };
    }

    void refreshDeviceIdRemaps();
  })();`;
}

module.exports = {
  buildDefaultToConcreteRemaps,
  filterEnumeratedMediaDevices,
  getInjectableMediaDeviceRuntime,
  getMediaDeviceFilterInjectScript,
  remapMediaStreamConstraints
};