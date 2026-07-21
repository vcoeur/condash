/**
 * Memory containment (main process only): per-tab scopes + an app-scope backstop.
 *
 * A terminal tab runs an arbitrary program — often an agent harness that can
 * leak or legitimately balloon to many GB. Left uncontained, one tab's growth
 * pressures the whole machine into a global OOM whose kill can land on the
 * dashboard's own renderer, taking every tab down (incident 2026-07-05). The
 * fix is to spawn each tab's pty inside its own transient
 * `systemd-run --user --scope` carrying a memory ceiling, so a runaway tab trips
 * its **own** cgroup's OOM killer and dies alone.
 *
 * The per-tab scope only binds processes spawned through the tab path. A child
 * that skips it — a tab left uncapped by a probe edge case, a stale pre-cap
 * condash still running, or a non-tab helper — stays in condash's own
 * `app-gnome-condash-*.scope`, which carries no limit, and a runaway there again
 * escalates to a global OOM (the 2026-07-05 crash recurred this way). So we also
 * cap that app scope at startup (`capOwnAppScopeAsync`): a backstop that makes a
 * global OOM impossible regardless of how a child got spawned.
 *
 * This is Linux-only (needs a reachable systemd user manager + cgroup v2). On
 * any other host the wrapper is a no-op and the caller spawns the program
 * directly, exactly as before.
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { promisify } from 'node:util';
import type { TerminalMemoryPrefs } from '../shared/types';

const execFileAsync = promisify(execFile);

/** Defaults for the per-tab scope (systemd size strings). Sized to fit ordinary
 * interactive + agent use while capping a runaway well below a typical
 * workstation's RAM, so the leak trips its own cgroup OOM instead of a global
 * one. Overridable via `terminal.memory` in settings.json. */
const DEFAULT_MEMORY_HIGH = '6G';
const DEFAULT_MEMORY_MAX = '8G';
const DEFAULT_MEMORY_SWAP_MAX = '2G';

// Only a *confirmed available* result is cached (`true`). A probe failure is
// NOT cached: a transient failure (systemd-run momentarily unavailable under
// load, user manager restarting) must not disable containment for the whole
// session — that is precisely how a tab gets silently left uncapped. We re-probe
// on the next call instead, so a transient glitch self-heals. Definitive
// "unsupported" hosts short-circuit in `platformSupportsMemoryScope` before any
// probe, so re-probing only ever costs anything on a Linux+cgroup-v2 host.
let cachedAvailable = false;
// One-shot guard so a capable-host probe failure warns once, not per tab spawn.
let warnedUncapped = false;

/**
 * Whether per-tab memory scoping can work on this host, verified by actually
 * creating a throwaway `--user --scope` with a memory limit — the only reliable
 * check that covers systemd-run presence, user-manager reachability, and
 * memory-controller delegation together. A success is cached for the process
 * lifetime; a failure on a capable host is re-checked next call.
 *
 * @returns True when a memory-limited user scope can be created here.
 */
function memoryScopeAvailable(): boolean {
  if (cachedAvailable) return true;
  if (!platformSupportsMemoryScope()) return false;
  const ok = runScopeProbe();
  if (ok) cachedAvailable = true;
  return ok;
}

/**
 * Async twin of {@link memoryScopeAvailable}: same cache and platform
 * short-circuit, but the live probe runs off the event loop
 * ({@link runScopeProbeAsync}). Shares the `cachedAvailable` flag, so a success
 * here also spares the per-tab path a re-probe (and vice versa) — the app-scope
 * backstop priming the cache before the first tab spawn, exactly as it did when
 * the backstop ran on the pre-window path.
 *
 * @returns True when a memory-limited user scope can be created here.
 */
async function memoryScopeAvailableAsync(): Promise<boolean> {
  if (cachedAvailable) return true;
  if (!platformSupportsMemoryScope()) return false;
  const ok = await runScopeProbeAsync();
  if (ok) cachedAvailable = true;
  return ok;
}

/**
 * Definitive, cheap "could this host ever do memory scopes" check — no
 * subprocess. False here is permanent for the process (Windows/macOS, no
 * user-manager runtime dir, cgroup v1), so the caller can safely stay quiet
 * about an uncapped spawn. True means the host looks capable and only the live
 * probe can confirm.
 *
 * @returns True on a Linux cgroup-v2 host with a user-manager runtime dir.
 */
function platformSupportsMemoryScope(): boolean {
  if (process.platform !== 'linux') return false;
  // A user scope needs the per-user systemd manager, which needs a runtime dir.
  if (!process.env.XDG_RUNTIME_DIR) return false;
  // cgroup v2's unified hierarchy exposes this file; cgroup v1 does not, and
  // per-user memory delegation is a v2 feature.
  try {
    return existsSync('/sys/fs/cgroup/cgroup.controllers');
  } catch {
    return false;
  }
}

/**
 * The `systemd-run --user --scope` argv for the live probe: a throwaway
 * transient unit that sets the same property kinds we use at spawn time and
 * runs `true`. `--collect` reaps the unit, so the probe is side-effect free.
 * Pure and shared by both the sync and async probes so they exercise the
 * identical systemd surface.
 *
 * @returns The full argv for `systemd-run`.
 */
export function probeArgv(): string[] {
  return [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    '-p',
    'MemoryHigh=64M',
    '-p',
    'MemoryMax=128M',
    '-p',
    'MemorySwapMax=0',
    '--',
    'true',
  ];
}

/**
 * The live probe (synchronous): runs {@link probeArgv} and reports success. A
 * non-zero status (no systemd-run, no user manager, memory controller not
 * delegated) → containment is unavailable right now. Blocks the caller for up
 * to 5 s, so it is only used on the per-tab spawn path (already synchronous);
 * the app-scope backstop uses {@link runScopeProbeAsync} to stay off the event
 * loop.
 *
 * @returns True when the throwaway scope was created successfully.
 */
function runScopeProbe(): boolean {
  const result = spawnSync('systemd-run', probeArgv(), { stdio: 'ignore', timeout: 5000 });
  return result.status === 0;
}

/**
 * The live probe (asynchronous): same {@link probeArgv} run via `execFile` so it
 * never blocks the main event loop. `execFile` rejects on a non-zero exit or the
 * 5 s timeout — both mean "unavailable right now", so any rejection maps to
 * false.
 *
 * @returns True when the throwaway scope was created successfully.
 */
async function runScopeProbeAsync(): Promise<boolean> {
  try {
    await execFileAsync('systemd-run', probeArgv(), { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the `systemd-run --user --scope` argv that runs `program`/`argv` inside
 * a memory-limited transient unit. Pure (no host probing) so the argv shape and
 * default/override resolution are unit-testable without systemd.
 *
 * @param program The program to run inside the scope.
 * @param argv Its arguments.
 * @param prefs Effective memory prefs; missing sizes fall back to the defaults.
 * @returns The full argv for `systemd-run` (program + args after the `--`).
 */
export function scopeArgv(
  program: string,
  argv: string[],
  prefs: TerminalMemoryPrefs | undefined,
): string[] {
  const high = prefs?.high ?? DEFAULT_MEMORY_HIGH;
  const max = prefs?.max ?? DEFAULT_MEMORY_MAX;
  const swapMax = prefs?.swapMax ?? DEFAULT_MEMORY_SWAP_MAX;
  return [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    '-p',
    `MemoryHigh=${high}`,
    '-p',
    `MemoryMax=${max}`,
    '-p',
    `MemorySwapMax=${swapMax}`,
    '--',
    program,
    ...argv,
  ];
}

/**
 * Parse a systemd size string ("6G", "512M", "1024") to bytes, base 1024.
 * Returns undefined for "infinity" or anything unparseable — the caller then
 * has no numeric ceiling for the meter (usage still shows; no warning fraction).
 *
 * @param size A systemd size string.
 * @returns The size in bytes, or undefined.
 */
export function parseSize(size: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT])?$/i.exec(size.trim());
  if (!match) return undefined;
  const value = parseFloat(match[1]);
  const unit = (match[2] ?? '').toUpperCase();
  const mult =
    unit === 'K'
      ? 1024
      : unit === 'M'
        ? 1024 ** 2
        : unit === 'G'
          ? 1024 ** 3
          : unit === 'T'
            ? 1024 ** 4
            : 1;
  return Math.round(value * mult);
}

/**
 * Resolve a pid's cgroup v2 path, relative to the `/sys/fs/cgroup` mount.
 *
 * Exported so a caller can resolve **once while the pid is alive** and keep the
 * path: `/proc/<pid>` disappears the moment the process is reaped, and node-pty
 * only emits `exit` *after* `waitpid` has returned and the pty socket has closed
 * — so a pid-based read at exit time always fails, and worse, a recycled pid
 * would resolve to a foreign cgroup. Reading by cached path has neither problem.
 *
 * @param pid A live pid.
 * @returns The path relative to the cgroup mount, or undefined off cgroup v2 /
 *   when the process is already gone.
 */
export function cgroupPathFor(pid: number): string | undefined {
  try {
    // cgroup v2 is a single unified "0::<path>" line.
    const match = /^0::(.*)$/m.exec(readFileSync(`/proc/${pid}/cgroup`, 'utf8'));
    if (!match) return undefined;
    return match[1] === '/' ? '' : match[1];
  } catch {
    return undefined;
  }
}

/**
 * Current memory usage (bytes) for an already-resolved cgroup path.
 *
 * @param cgroupPath Path relative to the cgroup mount, from `cgroupPathFor`.
 * @returns Bytes in use, or undefined once the cgroup is gone.
 */
export function readCgroupMemory(cgroupPath: string): number | undefined {
  try {
    const bytes = Number(readFileSync(`/sys/fs/cgroup${cgroupPath}/memory.current`, 'utf8').trim());
    return Number.isFinite(bytes) ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** Cumulative memory-pressure counters for a cgroup, from cgroup v2's
 *  `memory.events`. **Every field counts events since the cgroup was created**,
 *  never "right now" — a consumer must compare two samples, not test against
 *  zero. See `term-death.ts` for why that distinction is load-bearing. */
export interface CgroupMemoryEvents {
  /** Times the cgroup's own OOM killer fired — i.e. it hit `MemoryMax`. */
  oomKill: number;
  /** Times usage reached `MemoryMax`. */
  max: number;
  /** Times usage exceeded `MemoryHigh` and the kernel throttled + reclaimed.
   *  Sustained growth here is what generates the PSI pressure an external OOM
   *  killer (systemd-oomd) reacts to. */
  high: number;
}

/**
 * Read cgroup v2 `memory.events` for an already-resolved cgroup path.
 *
 * Takes a **path, not a pid**, deliberately. The verdict this feeds is needed
 * exactly at process exit, and by then the pid is reaped and `/proc/<pid>` is
 * gone (node-pty emits `exit` only after `waitpid` returns and the pty socket
 * closes). Resolve the path once at spawn with `cgroupPathFor` and read by path
 * thereafter; that also sidesteps the pid-reuse race, where a recycled pid would
 * silently report a foreign cgroup's counters and could manufacture a spurious
 * OOM verdict.
 *
 * The read still races `systemd-run --collect` reaping the unit after exit, so
 * callers must keep the last periodic sample as a fallback rather than relying
 * on the exit-time read succeeding.
 *
 * @param cgroupPath Path relative to the cgroup mount, from `cgroupPathFor`.
 * @returns The cumulative counters, or undefined once the cgroup is gone.
 */
export function readCgroupMemoryEvents(cgroupPath: string): CgroupMemoryEvents | undefined {
  try {
    const text = readFileSync(`/sys/fs/cgroup${cgroupPath}/memory.events`, 'utf8');
    return parseCgroupMemoryEvents(text);
  } catch {
    return undefined;
  }
}

/** Parse the `key value` lines of a cgroup v2 `memory.events` file. Absent keys
 *  read as 0 — the file only lists counters the kernel tracks for that cgroup.
 *  Pure and exported so the format handling is unit-testable without a cgroup. */
export function parseCgroupMemoryEvents(text: string): CgroupMemoryEvents {
  const read = (key: string): number => {
    const match = new RegExp(`^${key}\\s+(\\d+)$`, 'm').exec(text);
    return match ? Number(match[1]) : 0;
  };
  return { oomKill: read('oom_kill'), max: read('max'), high: read('high') };
}

/** A program + argv pair ready to hand to `pty.spawn`. */
export interface WrappedSpawn {
  program: string;
  argv: string[];
  /** When the spawn was wrapped in a memory scope, the resolved hard cap
   *  (`MemoryMax`) in bytes — drives the renderer meter's warning fraction.
   *  Undefined when not wrapped, or when the cap is non-numeric ("infinity"). */
  scopeMaxBytes?: number;
}

/**
 * Wrap a program + argv so it runs inside a memory-limited transient systemd
 * user scope, when containment is enabled and the host supports it. Returns the
 * inputs unchanged when disabled (`memory.enabled === false`) or unsupported, so
 * the caller's `pty.spawn` stays a plain spawn.
 *
 * `--scope` (not `--service`) keeps the program a direct child in the caller's
 * session, so it inherits the node-pty pty, cwd, and environment — verified
 * needed for interactive TUIs. `--collect` reaps the unit after an OOM kill.
 *
 * @param program The program to run (shell, agedum, …).
 * @param argv Its arguments.
 * @param prefs The effective `terminal.memory` prefs (may be undefined).
 * @returns The program + argv to spawn — wrapped, or verbatim.
 */
export function wrapWithMemoryScope(
  program: string,
  argv: string[],
  prefs: TerminalMemoryPrefs | undefined,
): WrappedSpawn {
  // Enabled unless explicitly turned off — robustness by default on capable
  // hosts.
  if (prefs?.enabled === false) return { program, argv };
  if (!memoryScopeAvailable()) {
    // On a host that looks capable (Linux + cgroup v2) but where the live probe
    // failed, the tab is spawned UNCAPPED — the silent hole behind the
    // 2026-07-05 crash. Warn once so it's diagnosable; the app-scope backstop
    // still contains it. Genuinely unsupported hosts (Windows/macOS) stay quiet.
    if (!warnedUncapped && platformSupportsMemoryScope()) {
      warnedUncapped = true;
      process.stderr.write(
        'condash: per-tab memory scope unavailable on a capable host — tabs spawned uncapped ' +
          '(app-scope backstop still applies)\n',
      );
    }
    return { program, argv };
  }
  const max = prefs?.max ?? DEFAULT_MEMORY_MAX;
  return {
    program: 'systemd-run',
    argv: scopeArgv(program, argv, prefs),
    scopeMaxBytes: parseSize(max),
  };
}

// --- App-scope backstop -----------------------------------------------------

/** RAM left for the rest of the session by the default app-scope cap, so
 * condash's cgroup trips its own OOM before the system's global one. */
const APP_SCOPE_RESERVE_BYTES = 3 * 1024 ** 3;
/** Default app-scope swap ceiling — the lever that stops a runaway from
 * thrashing all of system swap into a global OOM (the 2026-07-05 escalation). */
const DEFAULT_APP_SCOPE_SWAP_MAX = '2G';

/**
 * Default hard cap for condash's own app scope: physical RAM minus a reserve,
 * floored at half RAM so a small-memory host still gets a usable ceiling.
 * Deliberately below total RAM so the cgroup OOM fires before the system's.
 *
 * @param totalBytes Physical RAM in bytes (os.totalmem()).
 * @returns A systemd size string ("…M") for MemoryMax.
 */
export function defaultAppScopeMax(totalBytes: number): string {
  const floor = Math.floor(totalBytes * 0.5);
  const capped = Math.max(totalBytes - APP_SCOPE_RESERVE_BYTES, floor);
  return `${Math.floor(capped / 1024 ** 2)}M`;
}

/**
 * The systemd scope unit condash should self-cap, parsed from a
 * `/proc/<pid>/cgroup` body. Returns condash's own desktop-launched app scope
 * (`app-…condash….scope`) and nothing else — never a shared session scope, a
 * dev-from-terminal launch, or a cgroup-v1 host — so the backstop can only ever
 * cap condash's own scope. Pure → unit-testable without systemd.
 *
 * @param cgroupContent The text of /proc/<pid>/cgroup.
 * @returns The scope unit name, or undefined when it isn't condash's app scope.
 */
export function ownAppScopeUnit(cgroupContent: string): string | undefined {
  // cgroup v2 is a single unified "0::<path>" line; v1 has no such line.
  const match = /^0::(.*)$/m.exec(cgroupContent);
  if (!match) return undefined;
  const leaf = match[1].split('/').pop() ?? '';
  if (leaf.startsWith('app-') && /condash/i.test(leaf) && leaf.endsWith('.scope')) return leaf;
  return undefined;
}

/**
 * Build the `systemctl --user set-property` argv that caps a scope unit's
 * memory at runtime. `--runtime` keeps it to the unit's lifetime (re-applied on
 * every launch); pure, so the argv shape is unit-testable without systemd.
 *
 * @param unit The `.scope` unit name.
 * @param max MemoryMax size string.
 * @param swapMax MemorySwapMax size string.
 * @returns The full argv for `systemctl`.
 */
export function appScopeSetPropertyArgv(unit: string, max: string, swapMax: string): string[] {
  return [
    '--user',
    'set-property',
    '--runtime',
    unit,
    `MemoryMax=${max}`,
    `MemorySwapMax=${swapMax}`,
  ];
}

/** Outcome of the app-scope backstop attempt — the caller logs it. */
export interface AppScopeCapResult {
  applied: boolean;
  /** Why the cap was not applied. */
  skipped?: 'disabled' | 'unsupported' | 'no-scope' | 'set-property-failed';
  unit?: string;
  max?: string;
  swapMax?: string;
}

/**
 * Cap condash's own app scope so a child that escapes per-tab scoping can't
 * pressure the machine into a global OOM — it trips condash's cgroup OOM
 * instead. Idempotent (meant to run once per launch); a clean no-op when
 * disabled, off a memory-scope-capable host, or when condash isn't in its own
 * app scope. Reads the main process's cgroup, derives the scope unit, and
 * applies the limits via `systemctl --user set-property`.
 *
 * Fully asynchronous: every step that can stall — the availability probe and the
 * `set-property` call — runs off the event loop via `execFile`, and
 * `/proc/self/cgroup` is read with async fs, so a hung or slow systemd user
 * manager can never freeze the main process. (The former blocking `spawnSync`
 * could stall the main process for up to 5 s if the user manager hung, blocking
 * every pending IPC.) Shares the pure argv/parse helpers with the synchronous
 * per-tab spawn path.
 *
 * @param prefs Effective `terminal.memory` prefs; the `appScope` sub-object is read.
 * @returns What was applied, or why not.
 */
export async function capOwnAppScopeAsync(
  prefs: TerminalMemoryPrefs | undefined,
): Promise<AppScopeCapResult> {
  const appPrefs = prefs?.appScope;
  if (appPrefs?.enabled === false) return { applied: false, skipped: 'disabled' };
  if (!(await memoryScopeAvailableAsync())) return { applied: false, skipped: 'unsupported' };
  let unit: string | undefined;
  try {
    unit = ownAppScopeUnit(await readFile('/proc/self/cgroup', 'utf8'));
  } catch {
    unit = undefined;
  }
  if (!unit) return { applied: false, skipped: 'no-scope' };
  const max = appPrefs?.max ?? defaultAppScopeMax(totalmem());
  const swapMax = appPrefs?.swapMax ?? DEFAULT_APP_SCOPE_SWAP_MAX;
  try {
    await execFileAsync('systemctl', appScopeSetPropertyArgv(unit, max, swapMax), {
      timeout: 5000,
    });
  } catch {
    // Non-zero exit or the 5 s timeout — the cap did not take.
    return { applied: false, skipped: 'set-property-failed', unit, max, swapMax };
  }
  return { applied: true, unit, max, swapMax };
}
