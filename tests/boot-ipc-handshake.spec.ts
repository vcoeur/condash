import { test, expect } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { bootApp } from './fixtures/electron-app';
import { holdFirstCalls, type IpcGate } from './fixtures/ipc-hold';

test('boot handshake stages every gate before app readiness and holds real initial reads across restart', async () => {
  let projects!: IpcGate;
  let sync!: IpcGate;
  let skills!: IpcGate;
  let handshakes = 0;
  const booted = await bootApp({
    beforeFirstWindow: async (app) => {
      expect(app.context().pages()).toHaveLength(0);
      const certified = await app.evaluateHandle(({ app, BrowserWindow, ipcMain }) => {
        const host = globalThis as any;
        if (!host.__condashBootHandshake.held || app.isReady()) throw new Error('boot escaped');
        if (BrowserWindow.getAllWindows().length) throw new Error('window escaped');
        if ((ipcMain as any)._invokeHandlers.size) throw new Error('registration escaped');
        host.__bootHandshakeProof = { pid: process.pid };
      });
      await certified.dispose();

      // Deliberately stage out of registration order, including immediate boot
      // reads, so sequential wrappers cannot accidentally discard a pending gate.
      sync = await holdFirstCalls(app, 'syncStatusSnapshot', 1);
      projects = await holdFirstCalls(app, 'listProjects', 1);
      skills = await holdFirstCalls(app, 'skillsSyncStatus', 1);
      const staged = await app.evaluateHandle(({ BrowserWindow }) => {
        const host = globalThis as any;
        if (BrowserWindow.getAllWindows().length) throw new Error('window escaped gate install');
        for (const channel of ['listProjects', 'syncStatusSnapshot', 'skillsSyncStatus']) {
          const gate = host.__condashIpcGates.get(channel);
          if (!gate || gate.seen !== 0 || gate.original) throw new Error('gate not staged');
          if (!host.__condashBootHandshake.pending.has(channel)) throw new Error('gate missing');
        }
      });
      await staged.dispose();
      handshakes += 1;
    },
  });
  try {
    for (let boot = 0; boot < 2; boot += 1) {
      const running = boot === 0 ? booted : await booted.restart();
      await expect.poll(projects.count).toBe(1);
      await expect.poll(sync.count).toBe(1);
      await expect.poll(skills.count).toBe(1);
      expect(
        await running.app.evaluate(({ app, BrowserWindow }) => {
          const host = globalThis as any;
          return {
            contextValid: host.__bootHandshakeProof.pid === process.pid,
            ready: app.isReady(),
            windows: BrowserWindow.getAllWindows().length,
            registeredBeforeWindow: host.__condashBootHandshake.registeredBeforeWindow,
            pending: host.__condashBootHandshake.pending.size,
            held: ['listProjects', 'syncStatusSnapshot', 'skillsSyncStatus'].map((channel) => {
              const gate = host.__condashIpcGates.get(channel);
              return { channel, seen: gate.seen, parked: gate.held.length };
            }),
          };
        }),
      ).toEqual({
        contextValid: true,
        ready: true,
        windows: 1,
        registeredBeforeWindow: true,
        pending: 0,
        held: [
          { channel: 'listProjects', seen: 1, parked: 1 },
          { channel: 'syncStatusSnapshot', seen: 1, parked: 1 },
          { channel: 'skillsSyncStatus', seen: 1, parked: 1 },
        ],
      });
      await expect(running.window.getByText('Sample project', { exact: true })).toHaveCount(0);
      await projects.releaseWithOriginal(0);
      await sync.releaseWithOriginal(0);
      await skills.releaseWithOriginal(0);
      await expect(running.window.getByText('Sample project', { exact: true })).toBeVisible();
      await expect(
        running.window.locator('.status-bar').getByText('Skills: install'),
      ).toBeVisible();
      expect(await projects.count()).toBe(1);
      expect(await sync.count()).toBe(1);
      expect(await skills.count()).toBe(1);
      await projects.uninstall();
      await sync.uninstall();
      await skills.uninstall();
    }
    expect(handshakes).toBe(2);
  } finally {
    await booted.cleanup();
  }
});

test('boot handshake fails closed when a staged IPC handler is never registered', async () => {
  let child!: ChildProcess;
  await expect(
    bootApp({
      beforeFirstWindow: async (app) => {
        child = app.process();
        await holdFirstCalls(app, 'fixture-handler-that-does-not-exist', 1);
      },
    }),
  ).rejects.toThrow('Unregistered boot IPC gates: fixture-handler-that-does-not-exist');
  expect(child.exitCode).toBe(0);
});

test('boot handshake rejects registration after first-window construction even if ready by load', async () => {
  let child!: ChildProcess;
  await expect(
    bootApp({
      beforeFirstWindow: async (app) => {
        child = app.process();
        await holdFirstCalls(app, 'fixture-late-handler', 1);
        const delayed = await app.evaluateHandle(({ app, ipcMain }) => {
          app.once('browser-window-created', () => {
            ipcMain.handle('fixture-late-handler', async () => null);
          });
        });
        await delayed.dispose();
      },
    }),
  ).rejects.toThrow('IPC gates registered after first window');
  expect(child.exitCode).toBe(0);
});
