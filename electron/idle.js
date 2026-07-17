'use strict';

const CHANNEL = 'desktop-idle:get-system-idle-time';

function configureDesktopIdleIpc({ ipcMain, powerMonitor, isTrustedFrame }) {
  ipcMain.handle(CHANNEL, (event) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop idle time is only available for the configured Voice Room URL.');
    }

    const idleTime = powerMonitor.getSystemIdleTime();
    if (!Number.isSafeInteger(idleTime) || idleTime < 0) {
      throw new Error('System idle time is unavailable.');
    }

    return idleTime;
  });
}

module.exports = {
  CHANNEL,
  configureDesktopIdleIpc
};
