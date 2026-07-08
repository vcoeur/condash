import { clipboard, ipcMain } from 'electron';
import {
  ackTerminal,
  attachTerminal,
  closeSession,
  getTerminalPrefs,
  listTerminalSessions,
  resizeTerminal,
  setSessionSide,
  setTerminalPrefs,
  spawnTerminal,
  tabsContext,
  writeTerminal,
} from '../terminals';
import { latestScreenshot } from '../screenshot';
import { requireScreenshotDir } from '../path-bounds';
import { readSettings } from '../settings';
import type { TermSide, TermSpawnRequest } from '../../shared/types';
import {
  requireEnum,
  requireMainWindowSender,
  requireNonEmptyString,
  requireRecord,
} from './utils';

/** The two terminal sides a session can live on — the allow-set for the
 *  `termSetSide` enum decoder. */
const TERM_SIDES: ReadonlySet<TermSide> = new Set(['my', 'code']);

/** Wire every term.* IPC handler. Called once from main entry. */
export function registerTerminalIpc(): void {
  ipcMain.handle('termSpawn', async (event, request: unknown) => {
    requireMainWindowSender(event);
    const spawnRequest = requireRecord('termSpawn', request) as unknown as TermSpawnRequest;
    const { lastConceptionPath: conceptionPath } = await readSettings();
    return spawnTerminal(conceptionPath, event.sender, spawnRequest);
  });

  ipcMain.handle('termWrite', (event, id: unknown, data: string) => {
    requireMainWindowSender(event);
    writeTerminal(requireNonEmptyString('termWrite', id), data);
  });

  // Read the system clipboard from the main process. The renderer's
  // navigator.clipboard.readText() is permission-gated (no clipboard-read
  // permission handler is wired) and unreliable in Electron, so terminal
  // paste reads through here instead. See xterm-mount.ts's Ctrl+V handler.
  ipcMain.handle('clipboardReadText', (event) => {
    requireMainWindowSender(event);
    return clipboard.readText();
  });

  // Renderer → main flow-control credit: the preload `termData` forwarder acks
  // the bytes it delivered so main can release pty backpressure. High-frequency
  // and reply-less in spirit; a malformed `bytes` is ignored rather than thrown
  // so a stray ack never surfaces as a renderer error.
  ipcMain.handle('termAck', (event, id: unknown, bytes: unknown) => {
    requireMainWindowSender(event);
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return;
    ackTerminal(requireNonEmptyString('termAck', id), bytes);
  });

  ipcMain.handle('termResize', (event, id: unknown, cols: number, rows: number) => {
    requireMainWindowSender(event);
    resizeTerminal(requireNonEmptyString('termResize', id), cols, rows);
  });

  ipcMain.handle('termClose', (event, id: unknown) => {
    requireMainWindowSender(event);
    closeSession(requireNonEmptyString('termClose', id));
  });

  ipcMain.handle('termList', (event) => {
    requireMainWindowSender(event);
    return listTerminalSessions();
  });

  ipcMain.handle('termTabsContext', (event) => {
    requireMainWindowSender(event);
    return tabsContext();
  });

  ipcMain.handle('termAttach', (event, id: unknown) => {
    requireMainWindowSender(event);
    return attachTerminal(requireNonEmptyString('termAttach', id), event.sender);
  });

  ipcMain.handle('termSetSide', (event, id: unknown, side: unknown) => {
    requireMainWindowSender(event);
    return setSessionSide(
      requireNonEmptyString('termSetSide', id),
      requireEnum('termSetSide', side, TERM_SIDES),
    );
  });

  ipcMain.handle('termGetPrefs', async (event) => {
    requireMainWindowSender(event);
    return (await getTerminalPrefs()) ?? {};
  });

  ipcMain.handle('termSetPrefs', async (event, prefs: unknown) => {
    requireMainWindowSender(event);
    if (!prefs || typeof prefs !== 'object') {
      throw new Error('termSetPrefs: payload must be an object');
    }
    // Validate the whole nested patch through the config schema before it
    // is persisted — `terminal.shell` becomes the pty program on the next
    // spawn, so a malformed payload must be rejected at this boundary, not
    // discovered at spawn time. `config-schema` (≈45 ms of zod construction) is
    // dynamic-imported here so this write-path handler is the only thing that
    // pulls it — the pre-window boot graph stays zod-free. `terminal` is a
    // global (per-machine) key, so its shape comes from the global schema.
    const { globalSettingsSchema } = await import('../config-schema');
    const terminalPrefsSchema = globalSettingsSchema.shape.terminal;
    const parsed = terminalPrefsSchema.safeParse(prefs);
    if (!parsed.success) {
      throw new Error(`termSetPrefs: invalid terminal prefs — ${parsed.error.message}`);
    }
    await setTerminalPrefs(parsed.data ?? {});
  });

  ipcMain.handle('termLatestScreenshot', async (event, dir: string) => {
    requireMainWindowSender(event);
    // Bound the renderer-supplied directory to `terminal.screenshot_dir`
    // from settings — without this a compromised renderer could pass any
    // path through and have us stat it. `requireScreenshotDir` realpaths
    // both sides so a symlinked target outside the configured root is
    // rejected too.
    const canonical = await requireScreenshotDir(dir);
    return latestScreenshot(canonical);
  });
}
