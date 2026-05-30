/**
 * The application registry — the single source of truth for app identity.
 *
 * Every app has one canonical `#handle`. Live apps are the `repositories[]`
 * entries in `condash.json`; defunct apps that closed projects still reference
 * live in `retired_apps`. Both may carry `aliases` — legacy spellings that
 * resolve to the handle so the cleanup rewriter and `validate` can map them.
 *
 * This module backs the `condash applications` CLI: `list`, `add`, `set`,
 * `rename`, `sync-docs` (regenerate the AGENTS.md Apps table), and `validate`
 * (every project README `apps:` value resolves to a known handle or an
 * existing path). The CLI is a thin wrapper; the logic and its tests live here.
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { appHandle } from '../shared/app-color';
import { parseHeader } from '../shared/header';
import { walkRepos, type ConfigShape, type RepoLookup } from './config-walk';
import { getEffectiveConceptionConfig, readConceptionConfigRaw } from './effective-config';
import { findProjectReadmes } from './walk';
import { pathExists } from './fs-helpers';

/** One row of the registry — a live repo or a retired handle. */
export interface AppRecord {
  handle: string;
  label?: string;
  /** Configured path (as written in condash.json) for live apps; undefined for retired. */
  path?: string;
  /** Resolved absolute cwd for live apps; undefined for retired. */
  cwd?: string;
  /** Directory name (basename) for live apps. */
  dirName?: string;
  aliases: string[];
  retired: boolean;
}

/** A `retired_apps` entry as parsed from the config. */
interface RawRetiredApp {
  handle: string;
  label?: string;
  aliases?: string[];
}

function retiredApps(config: ConfigShape & { retired_apps?: RawRetiredApp[] }): RawRetiredApp[] {
  return Array.isArray(config.retired_apps) ? config.retired_apps : [];
}

/**
 * List every registered application — live repos (top-level only; submodules
 * are not standalone apps) followed by retired handles, in declaration order.
 */
export async function listApplications(
  conceptionPath: string,
  settingsFile?: string,
): Promise<AppRecord[]> {
  const config = (await getEffectiveConceptionConfig(
    conceptionPath,
    settingsFile,
  )) as ConfigShape & {
    retired_apps?: RawRetiredApp[];
  };
  const records: AppRecord[] = [];
  const live: RepoLookup[] = [];
  walkRepos(config, (entry) => {
    if (!entry.parent) live.push(entry);
  });
  for (const entry of live) {
    records.push({
      handle: entry.handle,
      label: entry.label,
      path: pathAsConfigured(config, entry),
      cwd: entry.cwd,
      dirName: entry.name,
      aliases: entry.aliases ?? [],
      retired: false,
    });
  }
  for (const retired of retiredApps(config)) {
    records.push({
      handle: appHandle(retired.handle),
      label: retired.label,
      aliases: retired.aliases ?? [],
      retired: true,
    });
  }
  return records;
}

/** The path string as written in condash.json (relative when inside the
 *  workspace), for display — never the resolved absolute cwd. */
function pathAsConfigured(config: ConfigShape, entry: RepoLookup): string {
  const workspace = config.workspace_path;
  if (workspace && entry.cwd.startsWith(`${workspace}/`)) {
    return entry.cwd.slice(workspace.length + 1);
  }
  return entry.cwd;
}

/**
 * Index every alias and handle → its canonical handle. Both live and retired
 * apps contribute. Used to resolve a legacy reference to its current handle.
 */
export function aliasIndex(records: AppRecord[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const record of records) {
    index.set(record.handle, record.handle);
    for (const alias of record.aliases) index.set(appHandle(alias), record.handle);
  }
  return index;
}

/** Resolution of one `apps:` reference against the registry. */
export interface RefResolution {
  ref: string;
  /** `handle` — a registered (live or retired) handle; `path` — an existing
   *  absolute path to an unregistered repo; `alias` — a legacy spelling that
   *  maps to `canonical`; `unknown` — neither resolves. */
  kind: 'handle' | 'path' | 'alias' | 'unknown';
  /** The canonical handle, when known. */
  canonical?: string;
  retired?: boolean;
}

/**
 * Resolve one project-README `apps:` value. `#handle` / bare names go through
 * the registry (exact handle, then alias); a `/abs` or `~` path is accepted
 * when it exists on disk; anything else is `unknown`.
 */
export async function resolveReference(
  ref: string,
  records: AppRecord[],
  index: Map<string, string>,
): Promise<RefResolution> {
  const trimmed = ref.trim();
  if (isAbsolute(trimmed) || trimmed.startsWith('~')) {
    const abs = trimmed.startsWith('~') ? resolve(homedir(), trimmed.slice(2)) : trimmed;
    return { ref, kind: (await pathExists(abs)) ? 'path' : 'unknown' };
  }
  const handle = appHandle(trimmed);
  const byHandle = records.find((r) => r.handle === handle);
  if (byHandle) return { ref, kind: 'handle', canonical: handle, retired: byHandle.retired };
  const canonical = index.get(handle);
  if (canonical) {
    const target = records.find((r) => r.handle === canonical);
    return { ref, kind: 'alias', canonical, retired: target?.retired };
  }
  return { ref, kind: 'unknown' };
}

/** One validation finding against a project README's `apps:` list. */
export interface AppValidationIssue {
  readme: string;
  ref: string;
  /** `unknown-handle` — no handle/alias/path matches; `alias` — resolves via a
   *  legacy spelling and should be rewritten to `#canonical`. */
  problem: 'unknown-handle' | 'alias';
  suggestion?: string;
}

/**
 * Validate every project README `apps:` value across the tree. An empty issue
 * list means every reference resolves to a live/retired handle or an existing
 * absolute path. Alias hits are reported (with a suggested `#handle`) so the
 * cleanup can rewrite them, but they are not hard errors on their own.
 */
export async function validateApplications(
  conceptionPath: string,
  settingsFile?: string,
): Promise<AppValidationIssue[]> {
  const records = await listApplications(conceptionPath, settingsFile);
  const index = aliasIndex(records);
  const readmes = await findProjectReadmes(conceptionPath);
  const issues: AppValidationIssue[] = [];
  for (const readme of readmes) {
    let raw: string;
    try {
      raw = await fs.readFile(readme, 'utf8');
    } catch {
      continue;
    }
    const header = parseHeader(raw);
    for (const app of header.apps) {
      const resolution = await resolveReference(app, records, index);
      if (resolution.kind === 'unknown') {
        issues.push({ readme, ref: app, problem: 'unknown-handle' });
      } else if (resolution.kind === 'alias') {
        issues.push({
          readme,
          ref: app,
          problem: 'alias',
          suggestion: `#${resolution.canonical}`,
        });
      }
    }
  }
  return issues;
}

/** Outcome of a {@link fixAppsReferences} run. */
export interface FixResult {
  readmesRewritten: string[];
  /** References left untouched because they resolve to nothing (no handle,
   *  alias, or existing path) — the caller must resolve these by hand. */
  unresolved: AppValidationIssue[];
}

/**
 * Canonicalise every project README `apps:` value to its `#handle`. A bare
 * handle (`condash`) and a legacy alias (`ClaudeConfig`) both become
 * `#canonical`; absolute paths are left verbatim; references that resolve to
 * nothing are left in place and reported under `unresolved` for a human. Live
 * and retired handles both count as resolved.
 */
export async function fixAppsReferences(
  conceptionPath: string,
  settingsFile?: string,
): Promise<FixResult> {
  const records = await listApplications(conceptionPath, settingsFile);
  const index = aliasIndex(records);
  const readmes = await findProjectReadmes(conceptionPath);
  const rewritten: string[] = [];
  const unresolved: AppValidationIssue[] = [];
  for (const readme of readmes) {
    let raw: string;
    try {
      raw = await fs.readFile(readme, 'utf8');
    } catch {
      continue;
    }
    // resolveReference touches the filesystem (path existence), so resolve
    // every app first, then drive the synchronous line rewriter off the map.
    const header = parseHeader(raw);
    const canonical = new Map<string, string>();
    for (const app of header.apps) {
      const resolution = await resolveReference(app, records, index);
      if (resolution.kind === 'handle' || resolution.kind === 'alias') {
        canonical.set(app.trim(), `#${resolution.canonical}`);
      } else if (resolution.kind === 'unknown') {
        unresolved.push({ readme, ref: app, problem: 'unknown-handle' });
      }
    }
    if (canonical.size === 0) continue;
    const next = rewriteAppsRefs(raw, (ref) => canonical.get(ref.trim()) ?? ref);
    if (next !== raw) {
      await fs.writeFile(readme, next, 'utf8');
      rewritten.push(readme);
    }
  }
  return { readmesRewritten: rewritten, unresolved };
}

const APPS_TABLE_START = '<!-- condash:apps:start -->';
const APPS_TABLE_END = '<!-- condash:apps:end -->';

/** Instruction-file candidates per app checkout, in fallback order. The first
 *  that exists wins; AGENTS.md is canonical, the CLAUDE.md forms are legacy. */
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md'];

/**
 * Absolute path to an app's instruction file, resolving the
 * `AGENTS.md` → `CLAUDE.md` → `.claude/CLAUDE.md` fallback against its checkout.
 * Returns `''` when the checkout is unknown (retired) or carries none of them.
 */
async function instructionsFile(cwd: string | undefined): Promise<string> {
  if (!cwd) return '';
  for (const candidate of INSTRUCTION_FILES) {
    const abs = resolve(cwd, candidate);
    if (await pathExists(abs)) return abs;
  }
  return '';
}

/**
 * Render the Apps table markdown from the live registry. Columns: the
 * `#handle`, the repo path (as configured), the absolute path to the app's
 * instruction file (`AGENTS.md`, else the legacy `CLAUDE.md` forms — so an
 * agent can open it directly), and the conventional knowledge file
 * `knowledge/internal/<handle>.md`. Retired apps are omitted — the table
 * documents live apps only.
 */
export async function renderAppsTable(records: AppRecord[]): Promise<string> {
  const live = records.filter((r) => !r.retired);
  const lines = [
    '| App | Repo | AGENTS.md | Knowledge |',
    '|-----|------|-----------|-----------|',
  ];
  for (const record of live) {
    const repo = record.path ?? '';
    const agents = await instructionsFile(record.cwd);
    const agentsCell = agents ? `\`${agents}\`` : '';
    lines.push(
      `| \`#${record.handle}\` | \`${repo}\` | ${agentsCell} | \`knowledge/internal/${record.handle}.md\` |`,
    );
  }
  return lines.join('\n');
}

/** Outcome of a {@link syncAppsDocs} run. */
export interface SyncDocsResult {
  changed: boolean;
  /** Set when AGENTS.md lacks the `condash:apps` sentinels. */
  missingSentinels?: boolean;
  file: string;
}

/**
 * Regenerate the Apps table inside `AGENTS.md` between the
 * `condash:apps:start` / `:end` sentinels. AGENTS.md is the single source —
 * CLAUDE.md is compiled from it downstream and is never written here. Returns
 * `missingSentinels` when the markers are absent (the bootstrap must add them
 * once).
 */
export async function syncAppsDocs(conceptionPath: string): Promise<SyncDocsResult> {
  const file = resolve(conceptionPath, 'AGENTS.md');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return { changed: false, missingSentinels: true, file };
  }
  const startIdx = raw.indexOf(APPS_TABLE_START);
  const endIdx = raw.indexOf(APPS_TABLE_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { changed: false, missingSentinels: true, file };
  }
  const records = await listApplications(conceptionPath);
  const table = await renderAppsTable(records);
  const before = raw.slice(0, startIdx + APPS_TABLE_START.length);
  const after = raw.slice(endIdx);
  const next = `${before}\n\n${table}\n\n${after}`;
  if (next === raw) return { changed: false, file };
  await fs.writeFile(file, next, 'utf8');
  return { changed: true, file };
}

// --- config mutation (add / set / rename) -----------------------------------

interface MutableConfig extends Record<string, unknown> {
  repositories?: unknown[];
  retired_apps?: RawRetiredApp[];
}

/**
 * Read the raw conception config (whichever file holds it), apply `mutate`,
 * and write it back to the canonical path. Mirrors `config set`: when the
 * canonical file is empty but a legacy `condash.json` exists, the legacy
 * content is seeded first so no keys are dropped.
 */
async function mutateConfig(
  conceptionPath: string,
  mutate: (config: MutableConfig) => void,
): Promise<void> {
  const { atomicWrite } = await import('./atomic-write');
  const { conceptionConfigWritePath } = await import('./effective-config');
  const writePath = conceptionConfigWritePath(conceptionPath);
  const existing = (await readConceptionConfigRaw(conceptionPath)) as MutableConfig;
  let current: MutableConfig = {};
  try {
    const rawWrite = await fs.readFile(writePath, 'utf8');
    const parsed = JSON.parse(rawWrite);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (Object.keys(current).length === 0) current = existing;
  mutate(current);
  const { dirname } = await import('node:path');
  await fs.mkdir(dirname(writePath), { recursive: true });
  await atomicWrite(writePath, JSON.stringify(current, null, 2) + '\n');
}

/** Register a new live application. Fails if the handle already resolves. */
export async function addApplication(
  conceptionPath: string,
  input: { handle: string; path: string; label?: string },
): Promise<void> {
  const handle = appHandle(input.handle);
  const records = await listApplications(conceptionPath);
  if (aliasIndex(records).has(handle)) {
    throw new Error(`handle #${handle} already exists`);
  }
  await mutateConfig(conceptionPath, (config) => {
    const repos = (config.repositories ??= []);
    const entry: Record<string, unknown> = { handle, path: input.path };
    if (input.label) entry.label = input.label;
    repos.push(entry);
  });
}

/** Update a live application's label or path, keyed by handle. */
export async function setApplication(
  conceptionPath: string,
  handle: string,
  patch: { label?: string; path?: string },
): Promise<void> {
  const target = appHandle(handle);
  await mutateConfig(conceptionPath, (config) => {
    const repos = config.repositories ?? [];
    const entry = repos.find((r) => isRepoWithHandle(r, target));
    if (!entry || typeof entry !== 'object') throw new Error(`no live app #${target}`);
    const obj = entry as Record<string, unknown>;
    if (patch.label !== undefined) obj.label = patch.label || undefined;
    if (patch.path !== undefined) obj.path = patch.path;
  });
}

/** True when a raw repositories[] entry resolves to `handle`. */
function isRepoWithHandle(raw: unknown, handle: string): boolean {
  if (typeof raw === 'string') return appHandle(raw) === handle;
  if (!raw || typeof raw !== 'object' || 'section' in raw) return false;
  const obj = raw as { handle?: string; name?: string; path?: string };
  const own = obj.handle ? appHandle(obj.handle) : appHandle(obj.name ?? basenameOf(obj.path));
  return own === handle;
}

function basenameOf(p?: string): string {
  if (!p) return '';
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? '';
}

/** Outcome of a {@link renameApplication} run. */
export interface RenameResult {
  oldHandle: string;
  newHandle: string;
  readmesRewritten: string[];
}

/**
 * Rename an app's handle. Cascades: updates the registry entry, records the
 * old handle as an alias, and rewrites every project README `apps:` reference
 * that resolved to the old handle. Returns the list of rewritten READMEs.
 */
export async function renameApplication(
  conceptionPath: string,
  from: string,
  to: string,
): Promise<RenameResult> {
  const oldHandle = appHandle(from);
  const newHandle = appHandle(to);
  if (!oldHandle || !newHandle) throw new Error('both handles must be non-empty');
  if (oldHandle === newHandle) throw new Error('old and new handle are identical');

  await mutateConfig(conceptionPath, (config) => {
    const repos = config.repositories ?? [];
    const entry = repos.find((r) => isRepoWithHandle(r, oldHandle));
    if (!entry) throw new Error(`no live app #${oldHandle}`);
    if (typeof entry === 'string') {
      const idx = repos.indexOf(entry);
      repos[idx] = { handle: newHandle, name: entry, aliases: [entry] };
    } else if (typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const aliases = new Set<string>(Array.isArray(obj.aliases) ? (obj.aliases as string[]) : []);
      aliases.add(oldHandle);
      obj.handle = newHandle;
      obj.aliases = Array.from(aliases);
    }
  });

  const readmes = await findProjectReadmes(conceptionPath);
  const rewritten: string[] = [];
  for (const readme of readmes) {
    let raw: string;
    try {
      raw = await fs.readFile(readme, 'utf8');
    } catch {
      continue;
    }
    const next = rewriteAppsRefs(raw, (ref) =>
      appHandle(ref) === oldHandle && !ref.includes('/') ? `#${newHandle}` : ref,
    );
    if (next !== raw) {
      await fs.writeFile(readme, next, 'utf8');
      rewritten.push(readme);
    }
  }
  return { oldHandle, newHandle, readmesRewritten: rewritten };
}

/**
 * Rewrite each `- <value>` line inside a YAML `apps:` block through `mapper`,
 * preserving the rest of the README byte-for-byte. Handles both quoted and
 * bare list items.
 */
export function rewriteAppsRefs(raw: string, mapper: (ref: string) => string): string {
  const lines = raw.split('\n');
  let inApps = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^apps:\s*$/.test(line)) {
      inApps = true;
      continue;
    }
    if (inApps) {
      const item = line.match(/^(\s*-\s*)(.*)$/);
      if (item) {
        const rawValue = item[2].trim();
        const unquoted = rawValue.replace(/^["']|["']$/g, '');
        const mapped = mapper(unquoted);
        if (mapped !== unquoted) {
          // A leading `#` is a YAML comment and `@`/`~` are reserved
          // indicators — any of these must be quoted or the value is dropped.
          const needsQuote = /[#@~/]/.test(mapped) || mapped.includes(' ');
          lines[i] = `${item[1]}${needsQuote ? `"${mapped}"` : mapped}`;
        }
        continue;
      }
      // A non-list, non-blank line ends the apps block.
      if (line.trim() !== '' && !/^\s/.test(line)) inApps = false;
      if (/^\S/.test(line)) inApps = false;
    }
  }
  return lines.join('\n');
}
