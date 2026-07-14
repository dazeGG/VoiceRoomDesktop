'use strict';

const CONFIGURE_CHANNEL = 'desktop-hotkeys:configure';
const SUSPEND_CHANNEL = 'desktop-hotkeys:set-suspended';
const ACTION_CHANNEL = 'desktop-hotkeys:action';
const STATUS_CHANNEL = 'desktop-hotkeys:status';
const ALL_ACTIONS = Object.freeze(['push-to-talk', 'mic-mute', 'output-mute']);
const GLOBAL_ACTIONS = Object.freeze(['mic-mute', 'output-mute']);

const NAMED_KEYS = Object.freeze({
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  Backquote: '`',
  Backslash: '\\',
  Backspace: 'Backspace',
  BracketLeft: '[',
  BracketRight: ']',
  CapsLock: 'Capslock',
  Comma: ',',
  Delete: 'Delete',
  End: 'End',
  Enter: 'Enter',
  Equal: '=',
  Escape: 'Escape',
  Home: 'Home',
  Insert: 'Insert',
  Minus: '-',
  NumpadAdd: 'numadd',
  NumpadDecimal: 'numdec',
  NumpadDivide: 'numdiv',
  NumpadMultiply: 'nummult',
  NumpadSubtract: 'numsub',
  NumLock: 'Numlock',
  PageDown: 'PageDown',
  PageUp: 'PageUp',
  Period: '.',
  PrintScreen: 'PrintScreen',
  Quote: '"',
  ScrollLock: 'Scrolllock',
  Semicolon: ';',
  Slash: '/',
  Space: 'Space',
  Tab: 'Tab'
});

function domCodeToAcceleratorKey(code) {
  if (typeof code !== 'string' || code.length > 32) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  return NAMED_KEYS[code] || null;
}

function bindingToAccelerator(binding) {
  if (!binding || typeof binding !== 'object') {
    return { accelerator: null, reason: 'unassigned' };
  }

  const key = domCodeToAcceleratorKey(binding.code);
  if (!key) return { accelerator: null, reason: 'unsupported-key' };

  const modifiers = [];
  if (binding.ctrlKey === true) modifiers.push('Control');
  if (binding.metaKey === true) modifiers.push('Super');
  if (binding.altKey === true) modifiers.push('Alt');
  if (binding.shiftKey === true) modifiers.push('Shift');

  const safeWithoutModifier = /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key)
    || key === 'PrintScreen';
  if (modifiers.length === 0 && !safeWithoutModifier) {
    return { accelerator: null, reason: 'modifier-required' };
  }

  return { accelerator: [...modifiers, key].join('+'), reason: null };
}

function bindingIdentity(binding) {
  if (!binding || typeof binding !== 'object' || typeof binding.code !== 'string' || !binding.code) return '';
  return [
    binding.code,
    binding.ctrlKey === true ? 'C' : '-',
    binding.altKey === true ? 'A' : '-',
    binding.shiftKey === true ? 'S' : '-',
    binding.metaKey === true ? 'M' : '-'
  ].join('|');
}

function createRegistrationResult(active, backend = 'none', configurationId = 0) {
  return {
    active,
    backend,
    configurationId,
    failed: [],
    registered: [],
    unsupported: []
  };
}

function createDesktopHotkeyController({ globalShortcut, isTrustedFrame, nativeHotkeys = null, log = console }) {
  let ipcMain = null;
  let owner = null;
  let ownerLifecycleListeners = [];
  let powerMonitor = null;
  let powerMonitorListeners = [];
  let rendererSuspended = false;
  let fallbackSuspended = false;
  let generation = 0;
  let configurationId = 0;
  let voiceActive = false;
  let currentBindings = {};
  let pushToTalkPressed = false;
  const fallbackRegistrations = new Map();
  const nativeRegistrations = new Set();
  const systemSuspensionReasons = new Set();

  function isSuspended() {
    return rendererSuspended || systemSuspensionReasons.size > 0;
  }

  function registeredActions() {
    return new Set([...fallbackRegistrations.keys(), ...nativeRegistrations]);
  }

  function sendToOwner(channel, payload, { deactivateOnFailure = true } = {}) {
    if (!owner || owner.isDestroyed?.()) return false;
    try {
      owner.send(channel, payload);
      return true;
    } catch (error) {
      log.warn?.('Desktop hotkey renderer delivery failed:', error);
      if (deactivateOnFailure) deactivate({ notifyPushToTalkRelease: false });
      return false;
    }
  }

  function sendAction(action, phase = 'pressed') {
    if (!registeredActions().has(action)) return false;
    if (action === 'push-to-talk') pushToTalkPressed = phase === 'pressed';
    return sendToOwner(ACTION_CHANNEL, { action, configurationId, phase });
  }

  function releasePushToTalk() {
    if (!pushToTalkPressed) return;
    pushToTalkPressed = false;
    sendToOwner(ACTION_CHANNEL, {
      action: 'push-to-talk',
      configurationId,
      phase: 'released'
    }, {
      deactivateOnFailure: false
    });
  }

  function setFallbackSuspended(nextSuspended) {
    const next = Boolean(nextSuspended);
    if (next && fallbackRegistrations.size === 0) return;
    if (fallbackSuspended === next) return;
    fallbackSuspended = next;
    globalShortcut.setSuspended?.(next);
  }

  function clearRendererSuspension() {
    if (!rendererSuspended) return;
    rendererSuspended = false;
    const nextSuspended = isSuspended();
    nativeHotkeys?.setSuspended?.(nextSuspended);
    setFallbackSuspended(nextSuspended);
  }

  function unregisterOwnedShortcuts({ notifyPushToTalkRelease = true } = {}) {
    if (notifyPushToTalkRelease) releasePushToTalk();
    nativeHotkeys?.stop?.();
    nativeRegistrations.clear();
    for (const accelerator of fallbackRegistrations.values()) {
      globalShortcut.unregister(accelerator);
    }
    fallbackRegistrations.clear();
  }

  function detachOwner() {
    if (owner) {
      for (const [eventName, listener] of ownerLifecycleListeners) {
        owner.removeListener?.(eventName, listener);
      }
    }
    owner = null;
    ownerLifecycleListeners = [];
  }

  function deactivate(options = {}) {
    generation += 1;
    voiceActive = false;
    currentBindings = {};
    unregisterOwnedShortcuts(options);
    clearRendererSuspension();
    detachOwner();
  }

  function attachOwner(sender) {
    if (owner === sender) return;
    detachOwner();
    owner = sender;
    const onRendererUnavailable = () => deactivate();
    // `did-navigate` is emitted only after a real main-document navigation.
    // Same-document history changes and navigations cancelled by will-navigate
    // must keep the active voice hotkeys registered.
    const onMainDocumentNavigated = () => deactivate();
    ownerLifecycleListeners = [
      ['destroyed', onRendererUnavailable],
      ['render-process-gone', onRendererUnavailable],
      ['did-navigate', onMainDocumentNavigated]
    ];
    owner.once?.('destroyed', onRendererUnavailable);
    owner.once?.('render-process-gone', onRendererUnavailable);
    owner.on?.('did-navigate', onMainDocumentNavigated);
  }

  function prepareBindings(bindings, result) {
    const claimed = new Set();
    const prepared = {};
    for (const action of ALL_ACTIONS) {
      const binding = bindings[action];
      if (!binding) continue;
      const identity = bindingIdentity(binding);
      if (!identity) {
        result.failed.push({ action, reason: 'unsupported-key' });
        continue;
      }
      if (claimed.has(identity)) {
        result.failed.push({ action, reason: 'duplicate-binding' });
        continue;
      }
      claimed.add(identity);
      prepared[action] = binding;
    }
    return prepared;
  }

  function registerFallback(bindings, result) {
    const restoreSuspension = isSuspended();
    if (restoreSuspension) setFallbackSuspended(false);
    const claimedAccelerators = new Set();
    try {
      for (const action of GLOBAL_ACTIONS) {
        const binding = bindings[action];
        if (!binding) continue;
        if (fallbackRegistrations.has(action)) {
          result.registered.push(action);
          continue;
        }
        const { accelerator, reason } = bindingToAccelerator(binding);
        if (!accelerator) {
          if (reason !== 'unassigned') result.failed.push({ action, reason });
          continue;
        }
        if (claimedAccelerators.has(accelerator)) {
          result.failed.push({ action, reason: 'duplicate-binding' });
          continue;
        }
        claimedAccelerators.add(accelerator);

        let registered = false;
        try {
          registered = globalShortcut.register(accelerator, () => {
            if (!isSuspended()) sendAction(action, 'pressed');
          });
        } catch (error) {
          log.warn?.('Global hotkey registration failed:', action, accelerator, error);
        }
        if (!registered) {
          result.failed.push({ action, reason: 'registration-failed' });
          continue;
        }

        fallbackRegistrations.set(action, accelerator);
        result.registered.push(action);
      }
    } finally {
      if (restoreSuspension) setFallbackSuspended(true);
    }
  }

  function handleNativeUnavailable(expectedGeneration, nativeFailure) {
    if (
      !voiceActive
      || expectedGeneration !== generation
      || !owner
      || systemSuspensionReasons.size > 0
    ) return;
    releasePushToTalk();
    nativeRegistrations.clear();

    const result = createRegistrationResult(true, 'electron-fallback', configurationId);
    if (currentBindings['push-to-talk']) {
      result.unsupported.push('push-to-talk');
      const failure = nativeFailure?.failed?.find?.(({ action }) => action === 'push-to-talk');
      result.failed.push({ action: 'push-to-talk', reason: failure?.reason || 'helper-exited' });
    }
    registerFallback(currentBindings, result);
    if (isSuspended()) setFallbackSuspended(true);
    sendToOwner(STATUS_CHANNEL, result);
  }

  async function registerPreparedBindings(nextGeneration, result, expectedOwner) {
    if (Object.keys(currentBindings).length === 0 || systemSuspensionReasons.size > 0) {
      return result;
    }

    if (nativeHotkeys?.start) {
      nativeHotkeys.setSuspended?.(isSuspended());
      const nativeResult = await nativeHotkeys.start(currentBindings, {
        onAction: ({ action, phase }) => {
          if (
            nextGeneration !== generation
            || !voiceActive
            || isSuspended()
            || !currentBindings[action]
          ) return;
          // A press can arrive in the same stdout chunk as the helper's ready
          // message, before the configure promise continuation copies the set.
          nativeRegistrations.add(action);
          sendAction(action, phase);
        },
        onUnavailable: (failure) => handleNativeUnavailable(nextGeneration, failure)
      });
      if (
        nextGeneration !== generation
        || owner !== expectedOwner
        || systemSuspensionReasons.size > 0
      ) return result;

      if (nativeResult.available) {
        const nativeRegistered = new Set(nativeResult.registered);
        for (const action of nativeRegistered) nativeRegistrations.add(action);
        result.registered.push(...nativeRegistered);

        const fallbackBindings = Object.fromEntries(
          GLOBAL_ACTIONS
            .filter((action) => currentBindings[action] && !nativeRegistered.has(action))
            .map((action) => [action, currentBindings[action]])
        );
        const fallbackResult = createRegistrationResult(true, 'electron-fallback', configurationId);
        registerFallback(fallbackBindings, fallbackResult);
        result.registered.push(...fallbackResult.registered);

        const fallbackRegistered = new Set(fallbackResult.registered);
        const nativeFailureActions = new Set(nativeResult.failed.map(({ action }) => action));
        result.failed.push(
          ...nativeResult.failed.filter(({ action }) => !fallbackRegistered.has(action)),
          ...fallbackResult.failed.filter(({ action }) => !nativeFailureActions.has(action))
        );

        if (currentBindings['push-to-talk'] && !nativeRegistered.has('push-to-talk')) {
          result.unsupported.push('push-to-talk');
        }
        result.backend = nativeRegistered.size > 0 ? 'native' : 'electron-fallback';
        if (isSuspended()) setFallbackSuspended(true);
        return result;
      }

      result.backend = 'electron-fallback';
      if (currentBindings['push-to-talk']) {
        result.unsupported.push('push-to-talk');
        const nativePushToTalkFailure = nativeResult.failed.find(({ action }) => action === 'push-to-talk');
        result.failed.push(nativePushToTalkFailure || {
          action: 'push-to-talk',
          reason: nativeResult.reason || 'helper-missing'
        });
      }
    } else {
      result.backend = 'electron-fallback';
      if (currentBindings['push-to-talk']) {
        result.unsupported.push('push-to-talk');
        result.failed.push({ action: 'push-to-talk', reason: 'helper-missing' });
      }
    }

    registerFallback(currentBindings, result);
    if (isSuspended()) setFallbackSuspended(true);
    return result;
  }

  async function configure(event, payload = {}) {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop hotkeys are only available for the configured Voice Room URL.');
    }

    const nextGeneration = ++generation;
    const nextConfigurationId = Number.isSafeInteger(payload?.configurationId)
      && payload.configurationId >= 0
      ? payload.configurationId
      : nextGeneration;
    setFallbackSuspended(false);
    unregisterOwnedShortcuts();
    attachOwner(event.sender);
    configurationId = nextConfigurationId;

    const active = payload?.active === true;
    voiceActive = active;
    const result = createRegistrationResult(active, 'none', configurationId);
    if (!active) {
      currentBindings = {};
      clearRendererSuspension();
      detachOwner();
      return result;
    }

    const bindings = payload?.bindings && typeof payload.bindings === 'object'
      ? payload.bindings
      : {};
    currentBindings = prepareBindings(bindings, result);
    return registerPreparedBindings(nextGeneration, result, event.sender);
  }

  function setSuspended(event, nextSuspended) {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop hotkeys are only available for the configured Voice Room URL.');
    }
    if (event.sender !== owner || !voiceActive) return false;
    rendererSuspended = Boolean(nextSuspended);
    const nextState = isSuspended();
    if (nextState) releasePushToTalk();
    nativeHotkeys?.setSuspended?.(nextState);
    setFallbackSuspended(nextState);
    return rendererSuspended;
  }

  function setSystemSuspended(reason, nextSuspended) {
    if (typeof reason !== 'string' || !reason) return systemSuspensionReasons.size > 0;
    const wasSystemSuspended = systemSuspensionReasons.size > 0;
    if (nextSuspended) systemSuspensionReasons.add(reason);
    else systemSuspensionReasons.delete(reason);
    const systemSuspended = systemSuspensionReasons.size > 0;
    if (systemSuspended === wasSystemSuspended) return systemSuspended;

    if (systemSuspended) {
      generation += 1;
      nativeHotkeys?.setSuspended?.(true);
      setFallbackSuspended(true);
      // unregisterOwnedShortcuts emits a balanced release before resetting the
      // helper, so a key-up lost to lock/sleep can never leave PTT open.
      unregisterOwnedShortcuts();
      return true;
    }

    const nextState = isSuspended();
    nativeHotkeys?.setSuspended?.(nextState);
    setFallbackSuspended(nextState);
    if (!voiceActive || !owner) return false;

    const nextGeneration = ++generation;
    const expectedOwner = owner;
    const result = createRegistrationResult(true, 'none', configurationId);
    void registerPreparedBindings(nextGeneration, result, expectedOwner).then((registration) => {
      if (
        nextGeneration === generation
        && voiceActive
        && owner === expectedOwner
        && systemSuspensionReasons.size === 0
      ) sendToOwner(STATUS_CHANNEL, registration);
    }).catch((error) => {
      log.warn?.('Desktop hotkeys failed to resume after system suspension:', error);
    });
    return false;
  }

  function installPowerMonitor(nextPowerMonitor) {
    if (powerMonitor || !nextPowerMonitor?.on) return;
    powerMonitor = nextPowerMonitor;
    powerMonitorListeners = [
      ['lock-screen', () => setSystemSuspended('screen-lock', true)],
      ['unlock-screen', () => setSystemSuspended('screen-lock', false)],
      ['suspend', () => setSystemSuspended('system-suspend', true)],
      ['resume', () => setSystemSuspended('system-suspend', false)]
    ];
    for (const [eventName, listener] of powerMonitorListeners) {
      powerMonitor.on(eventName, listener);
    }
  }

  function uninstallPowerMonitor() {
    if (powerMonitor) {
      for (const [eventName, listener] of powerMonitorListeners) {
        powerMonitor.removeListener?.(eventName, listener);
      }
    }
    powerMonitor = null;
    powerMonitorListeners = [];
    systemSuspensionReasons.clear();
  }

  function install(nextIpcMain) {
    if (ipcMain) return;
    ipcMain = nextIpcMain;
    ipcMain.handle(CONFIGURE_CHANNEL, configure);
    ipcMain.handle(SUSPEND_CHANNEL, setSuspended);
  }

  function dispose() {
    deactivate();
    uninstallPowerMonitor();
    if (!ipcMain) return;
    ipcMain.removeHandler?.(CONFIGURE_CHANNEL);
    ipcMain.removeHandler?.(SUSPEND_CHANNEL);
    ipcMain = null;
  }

  return {
    configure,
    deactivate,
    dispose,
    install,
    installPowerMonitor,
    setSuspended,
    setSystemSuspended
  };
}

module.exports = {
  ACTION_CHANNEL,
  ALL_ACTIONS,
  CONFIGURE_CHANNEL,
  GLOBAL_ACTIONS,
  STATUS_CHANNEL,
  SUSPEND_CHANNEL,
  bindingIdentity,
  bindingToAccelerator,
  createDesktopHotkeyController,
  domCodeToAcceleratorKey
};
