'use strict';

// How much of the computer VoiceRoom itself uses, apart from everything else
// running (a game). The page reads two running totals and takes its own
// differences, so nothing here keeps a measuring interval of its own:
// - appCpuMs: CPU time of the app's Chromium processes (main, renderers, GPU,
//   utilities) from app.getAppMetrics() cumulativeCPUUsage; a process that has
//   exited keeps its last reading in the total, so the total never goes back.
//   The native helpers are separate executables and are not counted;
// - systemBusyMs / systemTotalMs: every core's busy and total time from
//   os.cpus(), the same counters the system's own CPU figure comes from.
// The app's share of the whole computer is ΔappCpuMs / ΔsystemTotalMs.

const CHANNEL = 'desktop-load:get';

function createProcessLoad({ getAppMetrics, cpus }) {
  const lastByPid = new Map();
  let exitedMs = 0;

  function appCpuMs() {
    const list = getAppMetrics();
    const metrics = Array.isArray(list) ? list : [];
    const seen = new Map();
    for (const metric of metrics) {
      const pid = metric?.pid;
      const seconds = Number(metric?.cpu?.cumulativeCPUUsage);
      if (!Number.isSafeInteger(pid) || !Number.isFinite(seconds) || seconds < 0) continue;
      seen.set(pid, seconds * 1000);
    }
    // A process gone, or its pid reused by a new one (its total starts again), keeps what it used.
    for (const [pid, ms] of lastByPid) {
      const now = seen.get(pid);
      if (now === undefined || now < ms) exitedMs += ms;
    }
    lastByPid.clear();
    let running = 0;
    for (const [pid, ms] of seen) {
      lastByPid.set(pid, ms);
      running += ms;
    }
    return exitedMs + running;
  }

  function systemTimes() {
    let busy = 0;
    let total = 0;
    for (const cpu of cpus()) {
      const { user = 0, nice = 0, sys = 0, idle = 0, irq = 0 } = cpu?.times || {};
      busy += user + nice + sys + irq;
      total += user + nice + sys + idle + irq;
    }
    return { busy, total };
  }

  function read() {
    const system = systemTimes();
    return {
      appCpuMs: Math.round(appCpuMs()),
      systemBusyMs: Math.round(system.busy),
      systemTotalMs: Math.round(system.total)
    };
  }

  return { read };
}

function configureProcessLoadIpc({ ipcMain, app, os, isTrustedFrame }) {
  const load = createProcessLoad({
    getAppMetrics: () => app.getAppMetrics(),
    cpus: () => os.cpus()
  });
  ipcMain.handle(CHANNEL, (event) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Process load is only available for the configured VoiceRoom URL.');
    }
    return load.read();
  });
}

module.exports = {
  CHANNEL,
  configureProcessLoadIpc,
  createProcessLoad
};
