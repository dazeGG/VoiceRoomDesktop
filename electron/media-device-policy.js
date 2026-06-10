'use strict';

const AUDIO_DEVICE_KINDS = new Set(['audioinput', 'audiooutput']);

function getDefaultDeviceName(label) {
  const match = /^Default\s*-\s*(.+)$/i.exec(String(label || '').trim());
  return match ? match[1].trim() : '';
}

function isDuplicateOfDefaultDevice(device, defaultsByKind) {
  const defaults = defaultsByKind.get(device.kind) || [];
  if (!defaults.length) return false;

  for (const defaultDevice of defaults) {
    if (defaultDevice.groupId && device.groupId && defaultDevice.groupId === device.groupId) {
      return true;
    }

    const defaultName = getDefaultDeviceName(defaultDevice.label);
    const deviceLabel = String(device.label || '').trim();
    if (defaultName && deviceLabel && defaultName === deviceLabel) {
      return true;
    }
  }

  return false;
}

function filterEnumeratedMediaDevices(devices) {
  if (!Array.isArray(devices) || devices.length === 0) return devices;

  const defaultsByKind = new Map();
  for (const device of devices) {
    if (!AUDIO_DEVICE_KINDS.has(device.kind) || device.deviceId !== 'default') continue;
    const list = defaultsByKind.get(device.kind) || [];
    list.push(device);
    defaultsByKind.set(device.kind, list);
  }

  if (defaultsByKind.size === 0) return devices;

  return devices.filter((device) => {
    if (!AUDIO_DEVICE_KINDS.has(device.kind)) return true;
    if (device.deviceId === 'default') return true;
    return !isDuplicateOfDefaultDevice(device, defaultsByKind);
  });
}

function getMediaDeviceFilterInjectScript() {
  return `(() => {
    if (window.__voiceRoomMediaDeviceFilterInstalled) return;
    window.__voiceRoomMediaDeviceFilterInstalled = true;
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const filter = ${filterEnumeratedMediaDevices.toString()};
    const original = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async function voiceRoomEnumerateDevices() {
      return filter(await original());
    };
  })();`;
}

module.exports = {
  filterEnumeratedMediaDevices,
  getMediaDeviceFilterInjectScript
};