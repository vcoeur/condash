import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { BrowserWindow, type WebContents } from 'electron';
import * as pty from 'node-pty';
import type {
  TabInfo,
  TermDeath,
  TermSession,
  TermSide,
  TermSpawnRequest,
  TerminalPrefs,
} from '../shared/types';
import { EVENT_CHANNELS } from '../shared/ipc-channels';
import { shellCommandArgv, shellFamily } from '../shared/shell-quote';
import { findRepoEntry, type ConfigShape } from './config-walk';
import { getEffectiveConceptionConfig } from './effective-config';
import { readSettings, updateSettings } from './settings';
import { tokenise } from './launchers';
import {
  wrapWithMemoryScope,
  resolveScopeCgroup,
  readCgroupMemory,
  readCgroupMemoryEvents,
  type CgroupMemoryEvents,
} from './tab-scope';
import { deriveDeath, isAbnormal } from './term-death';
import { perfLog } from './perf-log';
import { spawnEnv, spawnPtyEnv } from './shell-env';
import { safeSend } from './safe-send';
import { SessionLogger } from './terminal-logger';
import { cleanTerminalText } from './dashboard/clean-text';
import { OscTranscriptExtractor } from './osc-transcript';
import { readFileTranscript, sidecarTranscriptPath } from './file-transcript';
import { TerminalFlow } from './terminal-flow';

interface Session {
  id: string;
  side: TermSide;
  /** Live pty handle. Set to null after the process exits — the session row
   * lingers (with `exited` populated) until the renderer explicitly closes it. */
  pty: pty.IPty | null;
  webContents: WebContents;
  /** Optional repo this session was spawned for (Run button). */
  repo?: string;
  /** Human command label for this session (repo `run:`, the free-form
   * command, or the shell). Surfaced in the `{TABS}` provided var so a task
   * can see what each tab is running. */
  cmd?: string;
  /** Cumulative bytes the pty has emitted. Monotonic (unlike `buffer`, which
   * is a capped rolling tail) so the scheduler can growth-gate: skip a run
   * when no tab has produced new output since the last run. */
  bytesSeen: number;
  /** Resolved cwd of the spawned pty. Surfaced in the broadcast snapshot
   * so the Code pane can match a session to the worktree it was started in. */
  cwd: string;
  /** Captured at spawn time so Stop doesn't need conceptionPath at kill time. */
  forceStop?: string;
  /** Rolling tail of stdout/stderr — replayed when a freshly-loaded renderer
   * re-attaches via termAttach. Readers expose only the last ≤ MAX_BUFFER
   * chars (`recentTail`); the stored string may overrun the cap by up to
   * BUFFER_SLACK between reslices (see `appendRecentTail`). */
  buffer: string;
  /** Process exit code; undefined while live. */
  exited?: number;
  /** True when this tab's pty was wrapped in a memory scope (systemd-run). Only
   * scoped tabs are memory-sampled — an unscoped pid resolves to condash's own
   * cgroup, which would misreport the whole dashboard as the tab's usage. */
  memScoped: boolean;
  /** Latest sampled cgroup memory usage (bytes) for a scoped tab; undefined
   * until the first sample (and always for unscoped tabs). **Quantized** — only
   * advances when the broadcast quantum is crossed, so it must not be used as a
   * rate baseline. */
  memBytes?: number;
  /** Unquantized reading from the last sample, paired with `memSampledAt`. The
   * growth rate diffs against this; using the quantized `memBytes` would divide
   * a multi-tick delta by one tick's elapsed time and inflate the rate. */
  memRawBytes?: number;
  /** Resolved hard cap (bytes) of this tab's scope, when numeric. */
  memMaxBytes?: number;
  /** This tab's cgroup path, resolved **once at spawn while the pid is alive**.
   * `/proc/<pid>` is gone by the time node-pty emits `exit` (it fires after
   * `waitpid` and the socket close), so every later read — including the
   * death-verdict one that matters most — goes by this path. Also avoids the
   * pid-reuse race a recycled pid would introduce. Unset for unscoped tabs and
   * on hosts without cgroup v2. */
  cgroupPath?: string;
  /** cgroup `memory.events` at the most recent periodic sample. */
  memEvents?: CgroupMemoryEvents;
  /** cgroup `memory.events` at the sample *before* `memEvents`. The counters are
   * cumulative for the cgroup's life, so a verdict needs two points; keeping the
   * previous one means a kill is still attributable when the exit-time read
   * loses its race with `systemd-run --collect` reaping the unit. */
  memEventsPrev?: CgroupMemoryEvents;
  /** Why the session ended; undefined while live. */
  death?: TermDeath;
  /** Wall-clock ms of the sample that produced `memBytes` — the other half of
   * the growth-rate calculation. */
  memSampledAt?: number;
  /** Bytes/second the tab's cgroup grew over the last sampling interval. The
   * existing meter is instantaneous, so a tab going 2G→8G inside one 2.5 s
   * window showed no warning at all before it died; a rate can warn on
   * trajectory instead of on a level. */
  memGrowthBytesPerSec?: number;
  /** True when the cgroup's `MemoryHigh` throttle count moved on the last
   * sample — i.e. the kernel is actively reclaiming against this tab. This is
   * the state tabs are actually dying in, and it was previously invisible: the
   * user saw an unexplained slowdown with nothing to attribute it to. */
  memThrottled?: boolean;
  /** Per-session 'destroyed' listener handle on `webContents` — kept on the
   * session so `stopSession` can remove it (otherwise long-lived renderers
   * accumulate one stale closure per spawned-and-closed session). */
  onWebContentsDestroyed?: () => void;
  /** Per-session disk logger — renders pty output to a plain-text
   * `.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.txt` (since v2.27.0; stdin is
   * deliberately not captured — the pty echoes it back through stdout).
   * Null when the spawn happened without an active conception (no place
   * to write). */
  logger: SessionLogger | null;
  /** Always-on in-band transcript capture (OSC 7373), independent of the disk
   * logger and of on-disk logging being enabled. An alternate-screen agent TUI
   * (claude / opencode) leaves its conversation only in this protocol, never in
   * the terminal grid — so the dashboard summarizer reads this when present
   * instead of the repaint-noise raw `buffer`. Stays empty for programs that
   * don't emit the protocol (plain shells, kimi). */
  transcript: OscTranscriptExtractor;
  /** Per-tab neutral sidecar transcript path (`.condash/transcripts/<sid>.ndjson`),
   * passed to the spawned program via `CONDASH_TRANSCRIPT_FILE`. A cooperating
   * program (the agedum claude hook / opencode plugin) appends neutral frames
   * here; the summarizer prefers it over the in-band OSC capture and the raw
   * buffer because a file reliably reaches condash where the program's
   * `/dev/tty` echo does not. Unset when spawned without an active conception
   * (no place to write). */
  transcriptFile?: string;
  /** Pty → renderer micro-batch + backpressure state (review findings T1/T2).
   * The raw `onData` chunk is still fed to the buffer / transcript / logger
   * synchronously; only the `termData` send is routed through here, so it
   * coalesces bursts and pauses the pty when the renderer falls behind. */
  flow: TerminalFlow;
}

const MAX_BUFFER = 64_000;
/** Reslice hysteresis: the rolling buffer is allowed to overrun MAX_BUFFER by
 *  up to this many chars before the hot append path trims it back to the last
 *  MAX_BUFFER. Without the slack, a high-throughput pty reallocated the whole
 *  (up-to-64 KB) string on every output chunk; with it the reslice happens at
 *  most once per BUFFER_SLACK chars. Readers still expose only the last
 *  ≤ MAX_BUFFER chars via `recentTail`, so observable output is unchanged. */
const BUFFER_SLACK = 16_000;
const sessions = new Map<string, Session>();

/**
 * Append `data` to a rolling-tail buffer, reslicing to the last MAX_BUFFER
 * chars only once the tail overruns MAX_BUFFER + BUFFER_SLACK. Pure (no session
 * state) so the cap behaviour is unit-testable without a live pty.
 *
 * @param tail The current rolling tail.
 * @param data The newly-emitted chunk to append.
 * @returns The new tail — at most MAX_BUFFER + BUFFER_SLACK chars long.
 */
export function appendRecentTail(tail: string, data: string): string {
  const next = tail + data;
  return next.length > MAX_BUFFER + BUFFER_SLACK ? next.slice(-MAX_BUFFER) : next;
}

/**
 * The last ≤ MAX_BUFFER chars of a rolling-tail buffer — what every reader
 * replays. Trims any hysteresis overrun left by `appendRecentTail`, so the
 * exposed tail is identical to the pre-hysteresis "always exactly capped"
 * buffer. Pure, for unit testing alongside `appendRecentTail`.
 *
 * @param tail The rolling tail (possibly overrun past MAX_BUFFER).
 * @returns The last MAX_BUFFER chars, or the whole tail when shorter.
 */
export function recentTail(tail: string): string {
  return tail.length > MAX_BUFFER ? tail.slice(-MAX_BUFFER) : tail;
}

function appendBuffer(session: Session, data: string): void {
  session.buffer = appendRecentTail(session.buffer, data);
}

function snapshot(): TermSession[] {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    side: s.side,
    repo: s.repo,
    cwd: s.cwd,
    exited: s.exited,
    death: s.death,
    memBytes: s.memBytes,
    memMaxBytes: s.memMaxBytes,
    memGrowthBytesPerSec: s.memGrowthBytesPerSec,
    memThrottled: s.memThrottled,
  }));
}

function broadcastSessions(): void {
  const snap = snapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    safeSend(win.webContents, EVENT_CHANNELS.termSessions, snap);
  }
}

export function listTerminalSessions(): TermSession[] {
  return snapshot();
}

let memoryInterval: ReturnType<typeof setInterval> | null = null;

/** Broadcast quantum for the per-tab memory meter (bytes). A scoped tab's cgroup
 *  `memory.current` drifts by a few hundred KB on nearly every 2.5s sample, but
 *  the tab-strip meter renders at ~0.1 GB steps (`formatMem` in
 *  terminal-pane/column.tsx) and flips its ≥80%-of-cap `.warn` at a GB-scale
 *  threshold — so a sub-quantum wiggle changes nothing on screen. Rebroadcasting
 *  the whole termSessions snapshot only when a tab moves at least this far from
 *  its last broadcast value collapses the steady-state churn (review finding T5)
 *  while keeping the meter and warn threshold accurate to well under one displayed
 *  digit: 8 MB is finer than both the 0.1 GB display step and the sub-100 MB
 *  MB-rounded display. */
export const MEM_BROADCAST_QUANTUM_BYTES = 8 * 1024 * 1024;

/** Whether a fresh memory sample warrants updating the stored value and
 *  rebroadcasting: the first reading, a transition to/from "no reading", or a
 *  move of at least MEM_BROADCAST_QUANTUM_BYTES from the last broadcast value.
 *  Pure so the quantization threshold is unit-testable; exported for tests. */
export function memSampleChanged(previous: number | undefined, next: number | undefined): boolean {
  if (previous === next) return false;
  if (previous === undefined || next === undefined) return true;
  return Math.abs(next - previous) >= MEM_BROADCAST_QUANTUM_BYTES;
}

/** Broadcast quantum for the per-tab growth rate (bytes/sec). The perf pane
 *  renders whole MB/s and hides anything under 1 MB/s as "—", so a sub-MB/s
 *  wobble is invisible. Without a quantum the rate is a fresh integer on every
 *  sample of a live process, which would rebroadcast the whole session snapshot
 *  every tick and re-introduce the T5 idle churn for every user with memory
 *  scoping on — the default — whether or not they ever open the pane. */
export const RATE_BROADCAST_QUANTUM_BYTES_PER_SEC = 1024 * 1024;

/** Whether a fresh growth-rate reading warrants a rebroadcast: the first
 *  reading, a transition to/from "no reading", or a move of at least one
 *  quantum. Pure so the threshold is unit-testable; exported for tests. */
export function rateChanged(previous: number | undefined, next: number | undefined): boolean {
  if (previous === next) return false;
  if (previous === undefined || next === undefined) return true;
  return Math.abs(next - previous) >= RATE_BROADCAST_QUANTUM_BYTES_PER_SEC;
}

/** Sample every scoped tab's cgroup memory and rebroadcast the snapshot when a
 *  figure moved by a meaningful step, so the renderer's per-tab meter tracks
 *  usage. One small file read per live scoped pty. A tab is sampled only once
 *  `cgroupPath` is set, which `resolveScopeCgroup` does only after confirming
 *  the path ends in the tab's own unit name — never on a bare `/proc` read,
 *  which resolves to condash's own cgroup both for an unscoped tab and for a
 *  scoped one that has not finished migrating. An active
 *  process's memory.current moves on virtually every sample, so the change test
 *  is quantized (`memSampleChanged`) — an exact-byte compare would rebroadcast
 *  the whole snapshot continuously even when the rendered meter wouldn't change
 *  (T5). Broadcasts only on a quantized change, so idle tabs cost nothing
 *  downstream. */
function sampleMemory(): void {
  let changed = false;
  for (const s of sessions.values()) {
    if (!s.memScoped || s.exited !== undefined || s.cgroupPath === undefined) continue;
    const bytes = readCgroupMemory(s.cgroupPath);
    const at = Date.now();
    // Growth rate off the RAW previous sample (`memRawBytes`), not the quantized
    // display value: `memBytes` only advances when the 8 MB broadcast quantum is
    // crossed while the clock advances every tick, so diffing against it would
    // divide a multi-tick delta by a single tick and inflate the rate — a tab
    // growing 3 MB/tick would read 0, 0, then a false spike.
    if (bytes !== undefined && s.memRawBytes !== undefined && s.memSampledAt !== undefined) {
      const elapsedSec = (at - s.memSampledAt) / 1000;
      if (elapsedSec > 0) {
        const rate = Math.round((bytes - s.memRawBytes) / elapsedSec);
        // Quantize before comparing. An exact compare is true on virtually every
        // tick for a live process, which would rebroadcast the whole snapshot
        // every 2.5 s and undo the T5 idle-churn fix for every user running with
        // memory scoping (the default) — including those who never open this
        // pane. The pane renders whole MB/s, so a sub-MB/s wobble changes nothing
        // on screen.
        if (rateChanged(s.memGrowthBytesPerSec, rate)) {
          s.memGrowthBytesPerSec = rate;
          changed = true;
        }
      }
    }
    if (bytes !== undefined) {
      s.memRawBytes = bytes;
      s.memSampledAt = at;
    }
    if (memSampleChanged(s.memBytes, bytes)) {
      s.memBytes = bytes;
      changed = true;
    }
    // Refresh the death-evidence watermarks on the same tick — one extra small
    // read per scoped tab, riding the timer that already exists rather than
    // adding one. Two points are kept because the counters are cumulative and
    // the exit-time read can lose its race with `--collect`.
    const events = readCgroupMemoryEvents(s.cgroupPath);
    if (events) {
      // A move in the cumulative `high` counter means the kernel is reclaiming
      // against this tab right now. Unlike the raw counter (which stays
      // non-zero forever once tripped), the delta is a live state.
      const throttled = s.memEvents !== undefined && events.high > s.memEvents.high;
      if (throttled !== s.memThrottled) {
        s.memThrottled = throttled;
        changed = true;
      }
      s.memEventsPrev = s.memEvents;
      s.memEvents = events;
    }
  }
  if (changed) broadcastSessions();
  // Ride this tick rather than arming a second timer — the instrumentation must
  // not add periodic work to the very thread it is measuring. No-op while perf
  // recording is off, and best-effort when on (a write failure must never break
  // the thing it measures).
  void perfLog.flush();
}

/**
 * Apply the `terminal.perf` preference: open or close the recorder against the
 * active conception's `.condash/perf/` file. Called at boot and whenever the
 * conception or the preference changes.
 *
 * @param conceptionPath Active conception, or null (recording is then off — the
 *   records are per-conception and there is nowhere to put them).
 */
export async function syncPerfLogging(conceptionPath: string | null): Promise<void> {
  const prefs = await getTerminalPrefs();
  const wanted = prefs.perf?.enabled === true && conceptionPath !== null;
  perfLog.setEnabled(wanted, wanted ? conceptionPath : undefined);
}

/** Begin periodic per-tab memory sampling (idempotent). Called once at app
 *  start; the interval is unref'd so it never keeps the process alive on its
 *  own. */
export function startMemorySampling(intervalMs = 2500): void {
  if (memoryInterval) return;
  memoryInterval = setInterval(sampleMemory, intervalMs);
  memoryInterval.unref?.();
}

/** Minimal session shape the TabInfo mapper reads — a structural subset of the
 *  module-internal `Session` so `liveTabInfo` is callable (and unit-testable)
 *  with plain objects, no live pty. */
type TabInfoSource = Pick<Session, 'id' | 'cwd' | 'repo' | 'cmd' | 'side' | 'exited'>;

/**
 * Shape the still-live subset of `entries` into the `{sid, cwd, repo?, cmd?}`
 * provided-var rows. Exited sessions are always excluded. With `side` given,
 * restricts to that side; without it, every live session is included. Pure over
 * its input so the side/exit filtering is unit-testable without a live pty.
 *
 * @param entries Sessions to consider (typically the live `sessions` map).
 * @param side Optional side filter (`'my'` for the dashboard's terminal-tab roster).
 * @returns One TabInfo per matching live session.
 */
export function liveTabInfo(entries: Iterable<TabInfoSource>, side?: TermSide): TabInfo[] {
  return [...entries]
    .filter((s) => s.exited === undefined && (side === undefined || s.side === side))
    .map((s) => ({
      sid: s.id,
      cwd: s.cwd,
      ...(s.repo ? { repo: s.repo } : {}),
      ...(s.cmd ? { cmd: s.cmd } : {}),
    }));
}

/**
 * Build the `{TABS}` provided-var payload (capability 2): the open, still-live
 * tabs as `[{sid, cwd, repo, cmd}]`. Exited sessions are excluded — a task acts
 * only on tabs that actually exist; condash keeps no per-tab state for it.
 * Includes both sides; the dashboard's narrower roster is `dashboardRoster()`.
 */
export function tabsContext(): TabInfo[] {
  return liveTabInfo(sessions.values());
}

/**
 * The dashboard's open-tab roster: the user's live terminal tabs only
 * (`side: 'my'`). Code-pane Run sessions (`side: 'code'`) are long-running dev
 * servers (a Vite dev server, a backend HTTP server) rather than agent tabs —
 * counting them inflated the dashboard's "Open tabs · N" header and rendered them
 * as perpetually-idle cards with no corresponding terminal tab (issue #366).
 */
export function dashboardRoster(): TabInfo[] {
  return liveTabInfo(sessions.values(), 'my');
}

/** Per-sid cumulative bytes emitted, for every live session. The scheduler
 *  diffs this against the snapshot it captured at a task's last run to find the
 *  tabs that produced new output: a sid whose count is unchanged is stale, and
 *  a task whose every tab is stale is skipped (the per-tab growth gate). Drives
 *  the `{UPDATED_TABS}` provided var. Exited sessions are excluded, matching
 *  `tabsContext()`. */
export function tabsBytes(): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions.values()) {
    if (s.exited === undefined) out.set(s.id, s.bytesSeen);
  }
  return out;
}

/** Recent plain-text output for a live session, capped to the last `maxChars`
 *  characters. Empty string when the sid is unknown or exited. Drives the
 *  dashboard summarizer (capability: live tab summaries).
 *
 *  Prefers the faithful in-band transcript when the program emits one (claude /
 *  opencode over OSC 7373): an alternate-screen TUI repaints via cursor
 *  addressing, so the rolling raw buffer is just frame noise that reads as
 *  "only a control sequence". Falls back to the cleaned raw buffer (ANSI
 *  stripped, `\r` overwrites resolved) for plain shells and non-emitters.
 *  Both sources are in-memory, so this works whether or not on-disk terminal
 *  logging is enabled. */
export function tabRecentText(sid: string, maxChars = 8000): string {
  const s = sessions.get(sid);
  if (!s || s.exited !== undefined) return '';
  // Precedence: the cooperating program's neutral sidecar file (reliable,
  // survives a hook running without condash's controlling terminal) → the
  // in-band OSC capture (same protocol, fragile transport) → the cleaned raw
  // buffer (plain shells and line-oriented commands; just repaint noise for an
  // alternate-screen TUI).
  const fileText = s.transcriptFile ? readFileTranscript(s.transcriptFile) : '';
  const text = fileText.trim()
    ? fileText
    : s.transcript.hasTranscript()
      ? // `renderTail` walks lines backwards for the tail only — no full
        // multi-MB re-join — and equals `render().slice(-maxChars)` here.
        s.transcript.renderTail(maxChars)
      : cleanTerminalText(recentTail(s.buffer));
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

export function attachTerminal(
  id: string,
  sender: WebContents,
): { output: string; exited?: number } | null {
  const s = sessions.get(id);
  if (!s) return null;
  // Reset flow control on EVERY re-attach: the previous page's JS context — and
  // with it its `termAck` listener — is gone, so it will never ack the bytes
  // still outstanding to it (which would pin the pty paused forever), and any
  // pending batch is already part of the buffer tail replayed below, so drop it
  // rather than double-write it into the reloaded terminal. This must run on the
  // same-WebContents path too: a plain renderer reload reuses the same
  // WebContents (stable `id`, no `'destroyed'` event), so the early return below
  // is the *common* re-attach, not a rare one.
  s.flow.reset();
  // The renderer that requested the attach may have been destroyed before the
  // IPC handler ran (fast window close / reload race). Do not reassign the
  // session's webContents or register a listener on a dead frame — return null
  // so the renderer does not mount a dead session.
  if (sender.isDestroyed()) {
    return null;
  }
  // Reassign the live data sink to the calling renderer so that subsequent
  // `termData` events from the still-running pty land in the freshly-loaded
  // window. Without this, after a renderer reload the session row is visible
  // but no live output arrives — `webContents.send` keeps targeting the
  // destroyed original WebContents and silently bails.
  if (!s.webContents.isDestroyed() && s.webContents.id === sender.id) {
    return { output: recentTail(s.buffer), exited: s.exited };
  }
  if (s.onWebContentsDestroyed) {
    try {
      s.webContents.removeListener('destroyed', s.onWebContentsDestroyed);
    } catch {
      /* old webContents already gone */
    }
  }
  s.webContents = sender;
  const onDestroyed = (): void => {
    void closeSession(id);
  };
  s.onWebContentsDestroyed = onDestroyed;
  sender.once('destroyed', onDestroyed);
  return { output: recentTail(s.buffer), exited: s.exited };
}

/** Reset flow control for EVERY session bound to `wc`. Wired to the window's
 * `did-start-loading` (a reload / crash-recovery re-navigation): the old page's
 * JS context — and its `termAck` listener — is gone, so bytes counted in-flight
 * to it can never be acked. `attachTerminal` covers only sessions the fresh
 * renderer re-attaches, which its reconcile does for `my`-side tabs alone; a
 * `code`-side session (a dev server run) is re-attached lazily on first row
 * expand, so a chatty one streaming through the reload gap would otherwise hit
 * the high watermark and pin its pty paused forever — shown "running", dev
 * server blocked on a full kernel pty buffer (L2). Resetting here is safe for
 * every session: pending bytes are already part of the rolling buffer tail the
 * renderer replays on (re-)attach. */
export function resetFlowsForWebContents(wc: WebContents): void {
  for (const s of sessions.values()) {
    if (s.webContents === wc) s.flow.reset();
  }
}

/** Sids of every tracked session — live ptys and exited-but-still-open rows,
 * whose `SessionLogger` stays open until `closeSession`. The orphan-log seal
 * skips these so a quiet live tab (or a lingering exited row mid-close) is
 * never stamped with a bogus recovery footer (E4). */
export function trackedSessionIds(): Set<string> {
  return new Set(sessions.keys());
}

/** Move a session between the "my" and "code" sides. Used by the Code pane's
 * pop-out button to surface a running dev server in the bottom pane. */
export function setSessionSide(id: string, side: TermSide): void {
  const s = sessions.get(id);
  if (!s || s.side === side) return;
  s.side = side;
  broadcastSessions();
}

/** Generate an opaque session id. The 8-hex-char random suffix is
 * filename-safe (used in the log writer's path) and unique across
 * restarts / windows — the previous monotonic counter collided with
 * filenames after a crash + restart in the same second. */
function makeId(): string {
  return `t-${randomBytes(4).toString('hex')}`;
}

/** Resolve the shell to spawn: the configured value when non-blank, else the
 *  platform default. SHELL is reliably set on POSIX; on Windows it is usually
 *  unset, so fall through to ComSpec, then cmd.exe. Exported so the headless
 *  task scheduler resolves the same shell as interactive spawns. */
export function defaultShell(configured?: string): string {
  if (configured && configured.trim()) return configured;
  if (process.platform !== 'win32' && process.env.SHELL) return process.env.SHELL;
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  return '/bin/bash';
}

/** Build the argv for running `command` through `shell`. Family detection +
 *  per-family argv shape (POSIX `-c` / cmd.exe `/d /s /c` / PowerShell
 *  `-NoLogo -NonInteractive -Command`) live in the shared
 *  `src/shared/shell-quote.ts` so the task scheduler and the renderer's prompt
 *  quoting agree with the spawn path. Detection is by shell-binary basename,
 *  so a user-configured `pwsh.exe` or `git-bash.exe` is routed correctly; the
 *  POSIX branch deliberately stays a non-login shell (rationale in the shared
 *  module — the login-shell PATH is injected via spawnEnv() instead). Exported
 *  for unit testing of the cross-OS family routing. */
export function wrapForShell(shell: string, command: string): string[] {
  return shellCommandArgv(shellFamily(shell, process.platform === 'win32'), command);
}

export async function spawnTerminal(
  conceptionPath: string | null,
  webContents: WebContents,
  request: TermSpawnRequest,
): Promise<{ id: string; cwd: string }> {
  const config = conceptionPath
    ? ((await getEffectiveConceptionConfig(conceptionPath)) as ConfigShape)
    : {};
  const settings = await readSettings();
  const shell = defaultShell(settings.terminal?.shell);

  let cwd = request.cwd ?? homedir();
  let argv: string[] = [];
  let program = shell;
  let forceStop: string | undefined;
  let commandLabel: string | undefined;

  if (request.repo && conceptionPath) {
    const entry = findRepoEntry(config, request.repo);
    if (!entry) throw new Error(`Repo '${request.repo}' not found in effective config`);
    // Honour an explicit request.cwd (worktree path from the Code-pane Run
    // button on a non-primary branch) over the entry's resolved primary
    // checkout. Without this, every Run lands on the primary checkout
    // regardless of which branch row the user clicked.
    if (!request.cwd && entry.cwd) cwd = entry.cwd;
    // Wrap the configured run: command for the active shell so user-supplied
    // shells like `make dev && tail -f log` keep their pipes / && / operators
    // on every OS (POSIX -lc / cmd.exe /d /s /c / pwsh -Command).
    if (entry.run) {
      program = shell;
      argv = wrapForShell(shell, entry.run);
      commandLabel = entry.run;
    }
    forceStop = entry.forceStop;
  } else if (request.command) {
    program = shell;
    argv = wrapForShell(shell, request.command);
    commandLabel = request.command;
  }

  // One run per repo: kill any prior code-side session for the same repo
  // before we spawn. Awaited so renderer reactions stay clean
  // (termSessions snapshot drops the old entry first, then we add the new
  // one), and so the dev port is freed before the new run binds.
  if (request.side === 'code' && request.repo) {
    const stale = [...sessions.values()].filter(
      (s) => s.side === 'code' && s.repo === request.repo,
    );
    await Promise.all(stale.map((s) => stopSession(s.id)));
  }

  const cols = request.cols ?? 80;
  const rows = request.rows ?? 24;

  // Base env from spawnPtyEnv(): a copy of process.env with PATH replaced by
  // the resolved login-shell PATH, so user-installed CLIs (opencode, ~/bin
  // wrappers) resolve even though GUI-launched condash never sourced
  // ~/.profile, plus the AppImage/nvm hygiene scrub.
  const childEnv = await spawnPtyEnv();

  // Generated before the spawn so the per-tab sidecar path can be handed to the
  // child via the environment. A cooperating program (the agedum claude hook /
  // opencode plugin) appends neutral transcript frames to this file; condash
  // reads them back for the dashboard summary. Keyed by `id`, so two tabs in the
  // same cwd never share a file. Only set with an active conception (a writable
  // place under `.condash/`); mkdir failures fall back to no sidecar rather than
  // pointing the child at a directory that doesn't exist.
  const id = makeId();
  let transcriptFile: string | undefined;
  if (conceptionPath) {
    const candidate = sidecarTranscriptPath(conceptionPath, id);
    try {
      mkdirSync(dirname(candidate), { recursive: true });
      childEnv.CONDASH_TRANSCRIPT_FILE = candidate;
      transcriptFile = candidate;
    } catch {
      /* no sidecar this run — summarizer falls back to OSC / buffer */
    }
  }

  // Contain the tab in its own memory-limited systemd scope (Linux + systemd +
  // cgroup v2) so a runaway agent is OOM-killed alone instead of pressuring the
  // whole machine into a global OOM. No-op elsewhere. Conception override wins
  // over the per-machine default; both may be unset (→ enabled defaults). The
  // logger keeps recording the *real* program/argv, not the wrapper.
  const memPrefs = config.terminal?.memory ?? settings.terminal?.memory;
  const spawnTarget = wrapWithMemoryScope(program, argv, memPrefs, { kind: 'term', sessionId: id });
  const ptyProcess = pty.spawn(spawnTarget.program, spawnTarget.argv, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: childEnv,
  });

  const logger = conceptionPath
    ? new SessionLogger(
        conceptionPath,
        {
          sid: id,
          side: request.side,
          repo: request.repo,
          cwd,
          spawn: { cmd: program, argv },
          taskContext: request.taskContext,
        },
        config.terminal?.logging,
      )
    : null;
  // `flow` closes over `session`, so declare the binding first and fill it in
  // once the object exists. The `send` / `getPty` closures read `session` live:
  // attachTerminal reassigns `webContents` on renderer reload and onExit nulls
  // `pty`, and both must be reflected on the next flush / pause.
  let session: Session;
  const flow = new TerminalFlow(
    // The epoch rides on every payload and is echoed back in the renderer's
    // termAck, so an ack minted before a flow.reset() can't debit the fresh
    // epoch's backlog (L4). safeSend's return tells the flow whether the bytes
    // actually reached a live frame.
    (data, epoch) => safeSend(session.webContents, EVENT_CHANNELS.termData, { id, data, epoch }),
    () => session.pty,
    {
      observer: {
        onBatch: (_bytes, inFlight) => perfLog.recordBatch(id, inFlight),
        onPause: () => perfLog.recordPause(id),
        onWatchdogResume: () => perfLog.recordWatchdog(id),
      },
    },
  );
  session = {
    id,
    side: request.side,
    pty: ptyProcess,
    webContents,
    repo: request.repo,
    cmd: commandLabel,
    bytesSeen: 0,
    cwd,
    forceStop,
    buffer: '',
    logger,
    transcript: new OscTranscriptExtractor(),
    transcriptFile,
    memScoped: spawnTarget.program === 'systemd-run',
    memMaxBytes: spawnTarget.scopeMaxBytes,
    flow,
  };
  // Guard against the window being destroyed during the async spawn window.
  // Adding a session with no 'destroyed' listener (the event already fired)
  // would leak the pty until app quit; safeSend would silently drop output.
  if (webContents.isDestroyed()) {
    try {
      ptyProcess.kill();
    } catch {
      /* pty may already be gone */
    }
    if (logger) {
      void logger.close();
    }
    throw new Error('Terminal spawn failed: target WebContents was destroyed');
  }
  sessions.set(id, session);
  logger?.spawn();

  // Resolve the cgroup path while the pid is alive, but only once the child has
  // actually MIGRATED into its scope. Both halves are load-bearing:
  //
  //  - Not later: `/proc/<pid>` is gone by the time node-pty emits `exit` (it
  //    fires after waitpid and the pty socket close), so a lookup at death time
  //    always fails — every OOM would classify as a bare SIGKILL — and a
  //    recycled pid would resolve to a foreign cgroup.
  //  - Not immediately: `systemd-run --scope` execs before it has asked the user
  //    manager to create the unit, so a read taken here returns condash's OWN
  //    app scope. Every tab then caches the same foreign path, reports the whole
  //    app's memory as its own, and derives its death verdict from the app's
  //    counters. `resolveScopeCgroup` waits for the named unit to appear.
  //
  // Seeding the first `memory.events` reading gives a tab that dies inside the
  // first sampling interval a baseline to diff against; a fast-allocating
  // runaway is plausibly in exactly that window. The await is deliberately not
  // blocking the spawn's return — output flows while migration completes.
  if (session.memScoped && spawnTarget.unitName !== undefined) {
    void resolveScopeCgroup(
      ptyProcess.pid,
      spawnTarget.unitName,
      () => sessions.get(id) === session && session.exited === undefined,
    ).then((path) => {
      // Re-check liveness: the tab may have exited during migration, and a
      // closed session must not acquire a path (and start sampling) afterwards.
      if (path === undefined || sessions.get(id) !== session || session.exited !== undefined) {
        return;
      }
      session.cgroupPath = path;
      session.memEvents = readCgroupMemoryEvents(path);
    });
  }

  // Read `session.webContents` (not the spawn-time parameter) inside the
  // handlers: attachTerminal reassigns it when a reloaded renderer
  // re-attaches, and a closure over the original WebContents would keep
  // sending live data to the destroyed one.
  ptyProcess.onData((data) => {
    session.bytesSeen += data.length;
    appendBuffer(session, data);
    // Time the OSC scan and the logger's parse SEPARATELY, not as one span:
    // they are the two competing candidates for what dominates the main thread,
    // and the whole point of measuring is to tell them apart. Both are gated on
    // recording being on, so a normal run pays one boolean check per chunk.
    const timing = perfLog.isEnabled();
    const started = timing ? process.hrtime.bigint() : 0n;
    // Capture any in-band transcript regardless of disk logging — the dashboard
    // reads it for a faithful summary. Scan the OSC out **once** here: when a
    // disk logger is present, hand it the stripped `clean` text and the decoded
    // `frames` so it need not re-scan the same bytes (it replays the frames into
    // its own transcript extractor). The raw `data` still drives the grid buffer
    // and the renderer. When there's no logger, the plain scan suffices.
    if (session.logger) {
      const { clean, frames } = session.transcript.feedCapturingFrames(data);
      const afterScan = timing ? process.hrtime.bigint() : 0n;
      session.logger.output(data, { clean, frames });
      if (timing) {
        perfLog.recordChunk(id, data.length, afterScan - started);
        perfLog.recordLogParse(id, process.hrtime.bigint() - afterScan);
      }
    } else {
      session.transcript.feed(data);
      if (timing) perfLog.recordChunk(id, data.length, process.hrtime.bigint() - started);
    }
    // Batch the renderer send only — the buffer / transcript / logger above
    // still see every raw chunk, so on-disk output stays byte-identical. The
    // flow controller coalesces and feeds the in-flight counter that gates
    // pty.pause()/resume().
    session.flow.enqueue(data);
  });
  ptyProcess.onExit(({ exitCode, signal }) => {
    // Read the cgroup counters by CACHED PATH, never by pid: node-pty emits this
    // only after waitpid has reaped the child and the pty socket has closed, so
    // `/proc/<pid>` is already gone (and a recycled pid would report a foreign
    // cgroup's counters — a spurious OOM verdict).
    //
    // Two-tier evidence, because this read still races `--collect` reaping the
    // unit: prefer the exit-time reading diffed against the last periodic
    // sample; if the cgroup is already gone, fall back to the last two periodic
    // samples, which still bracket a kill that happened between them.
    const exitEvents =
      session.cgroupPath !== undefined ? readCgroupMemoryEvents(session.cgroupPath) : undefined;
    const before = exitEvents ? session.memEvents : session.memEventsPrev;
    const after = exitEvents ?? session.memEvents;
    const death = deriveDeath({ exitCode, signal, before, after });
    session.exited = exitCode;
    session.death = death;
    session.pty = null;
    session.logger?.exit(exitCode, death);
    // Dispose the logger's headless xterm as soon as the pty is gone. An
    // abnormally-exited row is now kept on screen until the user dismisses it,
    // so without this each dead row would pin a full headless Terminal plus its
    // 5000-line scrollback for the app's lifetime — a crash-looping run or a
    // repeatedly-OOMing agent leaks one per death. `exit()` above has already
    // written the footer and `close()` is idempotent (it memoizes its pass), so
    // `stopSession` closing again later is a no-op.
    //
    // The rolling `buffer` is deliberately NOT cleared: it is capped at 64 KB,
    // and it is what a reloaded renderer replays into a dead row — clearing it
    // would blank the very output the row is being kept on screen to show.
    void session.logger?.close();
    // Deliver any batched-but-unsent output before the exit notification so the
    // renderer never sees termExit ahead of the tab's final bytes; this also
    // clears the coalescing timer so nothing fires after the pty is gone.
    session.flow.flush();
    safeSend(session.webContents, EVENT_CHANNELS.termExit, {
      id,
      code: exitCode,
      death,
      abnormal: isAbnormal(death),
    });
    // Keep the entry around (with `exited` set) so renderers that reload
    // can still see it via termList — closeSession removes it on demand.
    broadcastSessions();
  });

  const onDestroyed = (): void => {
    void closeSession(id);
  };
  session.onWebContentsDestroyed = onDestroyed;
  webContents.once('destroyed', onDestroyed);

  broadcastSessions();
  return { id, cwd };
}

export function writeTerminal(id: string, data: string): void {
  const session = sessions.get(id);
  if (!session?.pty) return;
  session.logger?.input(data);
  session.pty.write(data);
}

/** Credit `bytes` the renderer reports having consumed for session `id`, so the
 *  flow controller can release pty backpressure once the backlog drains. Fed by
 *  the preload `termAck` forwarder (one ack per delivered `termData` payload,
 *  echoing that payload's flow `epoch` — a stale epoch is ignored, L4).
 *  A no-op for an unknown / already-closed session. */
export function ackTerminal(id: string, bytes: number, epoch?: number): void {
  sessions.get(id)?.flow.ack(bytes, epoch);
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (!session?.pty) return;
  try {
    session.pty.resize(Math.max(1, cols), Math.max(1, rows));
  } catch {
    /* the pty may have just exited */
  }
}

/** Send SIGTERM to the pty's process group. node-pty allocates a session
 * leader (setsid), so the negative pid form reaches the wrapping shell AND
 * everything it spawned (e.g. `make dev` → `vite` → child workers). The
 * unix-only sentinel `-pid` form is portable across linux/macOS; on Windows,
 * node-pty manages termination via a different code path inside `pty.kill()`,
 * so we fall back to that there. */
function killTree(p: pty.IPty | null, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (!p) return;
  if (process.platform === 'win32') {
    try {
      p.kill();
    } catch {
      /* gone */
    }
    return;
  }
  try {
    process.kill(-p.pid, signal);
  } catch {
    /* gone */
  }
}

function isAlive(p: pty.IPty | null): boolean {
  if (!p) return false;
  if (process.platform === 'win32') return true;
  try {
    process.kill(-p.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Cap for how long stopSession will wait for force_stop to settle before
 * moving on to the SIGKILL grace period. The detached child is unref'd at
 * spawn time so the main process exit isn't blocked; this timeout just
 * unblocks the awaiter so a slow / hung force_stop script can't stall the
 * tab-close path. */
const FORCE_STOP_TIMEOUT_MS = 3000;

async function runForceStop(command: string): Promise<void> {
  // Tokenise + shell:false to mirror launchers.runForceStopRepo. Routing
  // the user-configured force_stop: string through the shell costs us
  // shell-metacharacter surprises (stray `&`, unintended globs) and ${VAR}
  // interpolation against the main-process env — the argv shape avoids
  // both. Pass-9 closes the parity gap with launchers.ts.
  const env = await spawnEnv();
  return new Promise<void>((resolve) => {
    const argv = tokenise(command, '');
    if (argv.length === 0) {
      resolve();
      return;
    }
    const [program, ...args] = argv;
    const child = spawn(program, args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
      env,
    });
    // Detach the child from the main process event loop so a script that
    // outlives the kill path (intentional or hung) doesn't hold the awaiter
    // open beyond the timeout.
    child.unref();
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(finish, FORCE_STOP_TIMEOUT_MS);
    child.on('error', finish);
    child.on('exit', finish);
  });
}

interface StopOpts {
  /** Run the configured force_stop: command after SIGTERM. Default true. */
  runForceStop?: boolean;
  /** Remove the session entry from the map and broadcast. Default true. The
   * killAll path passes false so it can clear the map in one shot. */
  removeEntry?: boolean;
}

/** Terminate a session's process tree via the parity-batch-7 pipeline:
 * SIGTERM the process group → run force_stop: → SIGKILL fallback after a
 * 500 ms grace if the leader is still alive. Resolves once the kill is
 * issued — does not wait for the pty's onExit callback. */
async function stopSession(id: string, opts: StopOpts = {}): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  const runFs = opts.runForceStop !== false;
  const removeEntry = opts.removeEntry !== false;

  const p = session.pty;
  killTree(p, 'SIGTERM');

  if (runFs && session.forceStop) {
    try {
      await runForceStop(session.forceStop);
    } catch {
      /* surfaced via toast at the renderer; don't block the kill */
    }
  }

  if (isAlive(p)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    // Re-check session state before SIGKILL: if the original pty exited
    // during the 500 ms grace and the OS recycled its PID for another
    // process, killTree(p, 'SIGKILL') would target the foreign group.
    // Bail out unless the same pty handle is still tracked.
    const stillSamePty = session.pty?.pid === p?.pid && session.exited === undefined;
    if (stillSamePty && isAlive(p)) killTree(p, 'SIGKILL');
  }

  if (removeEntry) {
    // Deliver any batched-but-unsent output and clear the coalescing timer so
    // nothing fires after the entry is dropped. onExit usually already flushed;
    // this covers a Stop while the pty was still emitting.
    session.flow.flush();
    if (session.onWebContentsDestroyed && !session.webContents.isDestroyed()) {
      try {
        session.webContents.removeListener('destroyed', session.onWebContentsDestroyed);
      } catch {
        /* webContents already torn down */
      }
    }
    // Flush + close the log file. close() is idempotent, so a logger that
    // killAll already closed in its own sweep doesn't double-close here.
    if (session.logger) {
      void session.logger.close();
    }
    // Drop the per-tab sidecar transcript — it's only useful while the tab is
    // live. Best-effort; a leftover is harmless (gitignored) if this fails.
    if (session.transcriptFile) {
      try {
        rmSync(session.transcriptFile, { force: true });
      } catch {
        /* leftover sidecar is harmless */
      }
    }
    sessions.delete(id);
    broadcastSessions();
  }
}

export function closeSession(id: string): Promise<void> {
  return stopSession(id);
}

/**
 * Relaunch an exited session with the same command, cwd, and side, then drop the
 * dead row. The counterpart to keeping an abnormally-exited tab on screen: the
 * user reads why it died, then restarts it without re-deriving what it was.
 *
 * Only a session whose pty has actually exited can be restarted — restarting a
 * live tab would silently orphan its running process.
 *
 * Re-entrant calls for the same id are rejected rather than queued: the Restart
 * button has no busy state, and a double-click would otherwise pass the
 * still-exited check twice and spawn two terminals from one dead row.
 *
 * @param conceptionPath Active conception, for repo resolution (as `spawnTerminal`).
 * @param id The exited session to relaunch.
 * @returns The new session's id and cwd.
 * @throws When the id is unknown, its pty is still live, or a restart is already
 *   in flight for it.
 */
export async function restartSession(
  conceptionPath: string | null,
  id: string,
): Promise<{ id: string; cwd: string }> {
  const session = sessions.get(id);
  if (!session) throw new Error(`No terminal session '${id}'`);
  if (session.exited === undefined) throw new Error(`Session '${id}' is still running`);
  if (restarting.has(id)) throw new Error(`Session '${id}' is already restarting`);
  restarting.add(id);
  try {
    const spawned = await spawnTerminal(conceptionPath, session.webContents, {
      side: session.side,
      // `cmd` is the resolved command label the original spawn ran; a session
      // spawned as a plain shell has none, and re-spawns as a plain shell.
      command: session.cmd,
      repo: session.repo,
      cwd: session.cwd,
    });
    // Retire the dead row only once the replacement exists, so a failed respawn
    // leaves the evidence on screen rather than silently swallowing the tab.
    // Caveat for a code-side repo session: spawnTerminal's one-run-per-repo
    // sweep has already stopped this row by the time we get here, so the
    // evidence-preserving property holds only for `my`-side tabs.
    await stopSession(id);
    return spawned;
  } finally {
    restarting.delete(id);
  }
}

/** Ids with a restart in flight — see `restartSession`. */
const restarting = new Set<string>();

/** Read terminal prefs. The `terminal` key is global-only (`settings.json`);
 * `condash.json` / `configuration.json` are legacy read fallbacks for
 * conception-owned keys, not an override layer for `terminal`. The one-shot
 * migration that promoted terminal from configuration.json into settings.json
 * (2026-05-01) still runs at boot. */
export async function getTerminalPrefs(): Promise<TerminalPrefs> {
  const settings = await readSettings();
  return settings.terminal ?? {};
}

/** Replace the persisted terminal prefs in settings.json. The patch is a
 * full replacement; pass `{}` to clear back to defaults. Always writes to
 * the per-machine settings.json — per-conception overrides are written
 * via the Settings modal's `patchConfig` flow. */
export async function setTerminalPrefs(patch: TerminalPrefs): Promise<void> {
  await updateSettings((cur) => ({ ...cur, terminal: patch }));
}

/** Await `work`, but give up after `ms` so the quit path stays bounded. */
async function bounded(work: Promise<unknown>, ms: number): Promise<void> {
  let safetyTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    safetyTimer = setTimeout(resolve, ms);
  });
  await Promise.race([work, timeout]).finally(() => clearTimeout(safetyTimer));
}

/** Kill every session (or every session attached to `forWebContents`) via the
 * full Stop pipeline — process-group SIGTERM, force_stop if configured,
 * SIGKILL fallback — then close every session's logger. The returned promise
 * resolves once the loggers have flushed and closed, so a quit handler that
 * awaits killAll gets the final debounce window's output (and the exit
 * footer, when onExit landed during the stop pipeline) on disk. Each phase is
 * time-bounded so the window can still close if a force_stop or a filesystem
 * write hangs. */
export async function killAll(forWebContents?: WebContents): Promise<void> {
  const targets = [...sessions.entries()].filter(
    ([, s]) => !forWebContents || s.webContents === forWebContents,
  );
  if (targets.length === 0) return;

  const stops = targets.map(([id]) => stopSession(id, { removeEntry: false }));
  await bounded(Promise.allSettled(stops), 1000);

  // stopSession({ removeEntry: false }) deliberately skips the logger, so the
  // sweep here is the only close on this path. close() is idempotent — a
  // session that separately goes through closeSession doesn't double-close.
  const closes = targets.map(([, s]) => s.logger?.close() ?? Promise.resolve());
  await bounded(Promise.allSettled(closes), 1500);

  // Flush + clear each session's batch timer before dropping the entry so no
  // coalescing timer outlives the map (it would later fire on a dead session).
  for (const [, s] of targets) s.flow.flush();
  for (const [id] of targets) sessions.delete(id);
  broadcastSessions();
}
