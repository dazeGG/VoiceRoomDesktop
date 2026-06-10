'use strict';

document.querySelector('#recoveryReload')?.addEventListener('click', () => {
  window.voiceRoomRecovery?.reload?.().catch(() => {});
});