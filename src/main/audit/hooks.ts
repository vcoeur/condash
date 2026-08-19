/**
 * `hooks` audit check — a hook script sitting in the conception that no
 * settings file registers.
 *
 * A dead hook is indistinguishable from a live one from the outside: the file
 * is present, executable, and reads as active to anyone opening the tree,
 * while nothing ever runs it. Skills that describe such a hook as a "backstop"
 * are then promising something the tree does not deliver, so the drift is
 * worth a line of output rather than silence.
 */

import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { toPosix } from '../../shared/path';
import { pathExists } from '../fs-helpers';
import type { AuditIssue } from './shared';

/** Where condash-managed hooks live, relative to the conception root. */
const HOOKS_DIR = '.claude/hooks';

/** Settings files that can register a hook, in the order a reader would check. */
const SETTINGS_CANDIDATES = ['.claude/settings.json', '.claude/settings.local.json'];

export async function checkHooks(conceptionPath: string): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const hooksDir = join(conceptionPath, HOOKS_DIR);
  if (!(await pathExists(hooksDir))) return issues;

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(hooksDir, { withFileTypes: true });
  } catch {
    return issues;
  }
  const scripts = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  if (scripts.length === 0) return issues;

  const registered = await registeredCommands(conceptionPath);

  for (const script of scripts) {
    if (registered.some((command) => command.includes(script))) continue;
    const rel = toPosix(relative(conceptionPath, join(hooksDir, script)));
    issues.push({
      check: 'hooks',
      severity: 'warn',
      file: rel,
      line: null,
      message:
        registered.length === 0
          ? `${rel} is registered by no settings file — it never runs (no hooks are registered at all)`
          : `${rel} is registered by no settings file — it never runs`,
      fix: {
        action: 'register_hook_or_remove',
        autoFix: false,
        path: rel,
        settingsCandidates: SETTINGS_CANDIDATES,
      },
    });
  }
  return issues;
}

/**
 * Every string a settings file carries, which is where a hook command hides
 * whatever shape the harness's schema currently has. Falls back to the raw
 * file text when the JSON does not parse, so a settings file with a trailing
 * comma cannot turn a live hook into a reported one.
 */
async function registeredCommands(conceptionPath: string): Promise<string[]> {
  const out: string[] = [];
  for (const candidate of SETTINGS_CANDIDATES) {
    let raw: string;
    try {
      raw = await fs.readFile(join(conceptionPath, candidate), 'utf8');
    } catch {
      continue;
    }
    try {
      collectStrings(JSON.parse(raw), out);
    } catch {
      out.push(raw);
    }
  }
  return out;
}

/** Push every string value in a parsed JSON value onto `out`, at any depth. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}
