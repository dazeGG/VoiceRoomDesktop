'use strict';

const button = document.querySelector('#recoveryReload');

button?.addEventListener('click', () => {
  button.disabled = true;
  Promise.resolve(window.voiceRoomRecovery?.reload?.())
    .catch(() => {})
    .finally(() => {
      button.disabled = false;
    });
});