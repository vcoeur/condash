/**
 * Per-tab memory containment (main process only).
 *
 * A terminal tab runs an arbitrary program — often an agent harness that can
 * leak or legitimately balloon to many GB. Left uncontained, one tab's growth
 * pressures the whole machine into a global OOM whose kill can land on the
 * dashboard's own renderer, taking every tab down (incident 2026-07-05). The
 * fix is to spawn each tab's pty inside its own transient
 * `systemd-run --user --scope` carrying a memory ceiling, so a runaway tab trips
 * its **own** cgroup's OOM killer and dies alone.
 *
 * This is Linux-only (needs a reachable systemd user manager + cgroup v2). On
 * any other host the wrapper is a no-op and the caller spawns the program
 * directly, exactly as before.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { TerminalMemoryPrefs } from '../shared/types';

/** Defaults for the per-tab scope (systemd size strings). Sized to fit ordinary
 * interactive + agent use while capping a runaway well below a typical
 * workstation's RAM, so the leak trips its own cgroup OOM instead of a global
 * one. Overridable via `terminal.memory` in settings.json / condash.json. */
const DEFAULT_MEMORY_HIGH = '6G';
const DEFAULT_MEMORY_MAX = '8G';
const DEFAULT_MEMORY_SWAP_MAX = '2G';

let cachedAvailable: boolean | null = null;

/**
 * Whether per-tab memory scoping can work on this host. Verified once by
 * actually creating a throwaway `--user --scope` that sets a memory limit —
 * the only reliable check that covers systemd-run presence, user-manager
 * reachability, and memory-controller delegation together — then cached for the
 * process lifetime.
 *
 * @returns True when a memory-limited user scope can be created here.
 */
function memoryScopeAvailable(): boolean {
  if (cachedAvailable === null) cachedAvailable = probe();
  return cachedAvailable;
}

function probe(): boolean {
  if (process.platform !== 'linux') return false;
  // A user scope needs the per-user systemd manager, which needs a runtime dir.
  if (!process.env.XDG_RUNTIME_DIR) return false;
  // cgroup v2's unified hierarchy exposes this file; cgroup v1 does not, and
  // per-user memory delegation is a v2 feature.
  try {
    if (!existsSync('/sys/fs/cgroup/cgroup.controllers')) return false;
  } catch {
    return false;
  }
  // Representative probe: a transient user scope that sets the same properties
  // we use at spawn time, running `true`. --collect reaps the unit; the probe
  // is side-effect free. A non-zero status (no systemd-run, no user manager,
  // memory controller not delegated) → containment is unavailable here.
  const result = spawnSync(
    'systemd-run',
    [
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
    ],
    { stdio: 'ignore', timeout: 5000 },
  );
  return result.status === 0;
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
 * Current memory usage (bytes) of the cgroup a pid belongs to. For a
 * memory-scoped tab the pid is `systemd-run`, so this reports the whole
 * transient scope (the entire tab process tree). Reads cgroup v2's
 * `memory.current`. Returns undefined off cgroup v2, or when the process/file is
 * already gone (a just-exited pty).
 *
 * Only meaningful for a **scoped** pid — an unscoped pid resolves to condash's
 * own cgroup, so the caller must not sample unscoped tabs.
 *
 * @param pid The pty leader pid (the `systemd-run` process for a scoped tab).
 * @returns Bytes in use by the pid's cgroup, or undefined.
 */
export function sampleCgroupMemory(pid: number): number | undefined {
  try {
    // cgroup v2 is a single unified "0::<path>" line.
    const match = /^0::(.*)$/m.exec(readFileSync(`/proc/${pid}/cgroup`, 'utf8'));
    if (!match) return undefined;
    const rel = match[1] === '/' ? '' : match[1];
    const bytes = Number(readFileSync(`/sys/fs/cgroup${rel}/memory.current`, 'utf8').trim());
    return Number.isFinite(bytes) ? bytes : undefined;
  } catch {
    return undefined;
  }
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
  if (!memoryScopeAvailable()) return { program, argv };
  const max = prefs?.max ?? DEFAULT_MEMORY_MAX;
  return {
    program: 'systemd-run',
    argv: scopeArgv(program, argv, prefs),
    scopeMaxBytes: parseSize(max),
  };
}
