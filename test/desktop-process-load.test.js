'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { CHANNEL, configureProcessLoadIpc, createProcessLoad } = require('../electron/process-load');

const metric = (pid, seconds) => ({ pid, type: 'Tab', cpu: { cumulativeCPUUsage: seconds, percentCPUUsage: 0 } });
const core = (busy, idle) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });

describe('process load', () => {
  it('sums the app processes and every core into running totals', () => {
    const load = createProcessLoad({
      getAppMetrics: () => [metric(1, 2.5), metric(2, 0.5), { pid: 3, cpu: {} }],
      cpus: () => [core(300, 700), core(100, 900)]
    });
    assert.deepEqual(load.read(), { appCpuMs: 3000, systemBusyMs: 400, systemTotalMs: 2000 });
  });

  it('keeps what an exited process used, also when its pid comes back as a new process', () => {
    let metrics = [metric(1, 10), metric(2, 4)];
    const load = createProcessLoad({ getAppMetrics: () => metrics, cpus: () => [] });
    assert.equal(load.read().appCpuMs, 14_000);

    // Renderer 2 is gone: its 4 s stay counted.
    metrics = [metric(1, 11)];
    assert.equal(load.read().appCpuMs, 15_000);

    // Pid 1 now belongs to a new process that has used 0.5 s.
    metrics = [metric(1, 0.5)];
    assert.equal(load.read().appCpuMs, 15_500);
  });

  it('answers only a trusted VoiceRoom frame', () => {
    const handlers = new Map();
    let trusted = true;
    configureProcessLoadIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      app: { getAppMetrics: () => [metric(7, 1)] },
      os: { cpus: () => [core(10, 90)] },
      isTrustedFrame: () => trusted
    });
    const handler = handlers.get(CHANNEL);
    const event = { senderFrame: { url: 'https://voiceroom.ru/r/abc' } };
    assert.deepEqual(handler(event), { appCpuMs: 1000, systemBusyMs: 10, systemTotalMs: 100 });
    trusted = false;
    assert.throws(() => handler(event), /only available/);
  });
});
