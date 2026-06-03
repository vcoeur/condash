// In-memory search index for the four markdown sources (projects, knowledge,
// resources, skills). Built at conception-open, queried in RAM, and kept fresh
// incrementally by the chokidar watcher — so a keystroke search never re-walks
// + re-reads + re-lowercases the tree (the dominant per-query cost; see the
// perf research project's measurement note).
//
// Logs are deliberately NOT indexed: they're ~9/10 of the corpus bytes and
// rarely searched, so caching them would cost ~100 MB+ resident for little gain.
// They stay on-disk-scanned, and only when 'logs' is in scope (search/index.ts).
import { join, relative } from 'node:path';
import { toPosix } from '../../shared/path';
import type { SearchTerm } from '../../shared/types';
import { resolveConceptionPaths } from '../conception-paths';
import { runWithConcurrency } from './concurrency';
import {
  matchPrepared,
  prepareFile,
  type FileRef,
  type MatchOutput,
  type PreparedFile,
} from './match';
import {
  collectKnowledgeFiles,
  collectProjectFiles,
  collectResourceFiles,
  collectSkillFiles,
} from './walk';

const PREPARE_CONCURRENCY = 32;
const RESOURCE_EXTS = new Set(['.md', '.markdown', '.txt']);
// Directory names the markdown walkers skip (walk.ts SKIP_DIR_NAMES, minus the
// dotfile rule which `segmentsClean` covers separately).
const SKIP_SEGMENTS = new Set(['node_modules', 'local']);

export type IndexedSource = 'project' | 'knowledge' | 'resources' | 'skills';

/** Scope-pill name (what the renderer forwards) for each indexed source. */
const SOURCE_TO_SCOPE: Record<IndexedSource, string> = {
  project: 'projects',
  knowledge: 'knowledge',
  resources: 'resources',
  skills: 'skills',
};

interface ConceptionIndex {
  conceptionPath: string;
  /** Keyed by posix absolute path. */
  byPath: Map<string, PreparedFile>;
}

let current: ConceptionIndex | null = null;
// Bumped on every (re)build / clear so a slow build that's been superseded by a
// conception switch discards its result instead of clobbering the new index.
let buildToken = 0;

/** Drop the index (conception teardown / switch). */
export function clearSearchIndex(): void {
  current = null;
  buildToken++;
}

function getIndex(conceptionPath: string): ConceptionIndex | null {
  return current && current.conceptionPath === conceptionPath ? current : null;
}

/**
 * Run a parsed query over the in-memory index, honouring the scope filter.
 * Returns `null` when no index is built for this conception yet — the caller
 * (search/index.ts) then falls back to the on-disk scan.
 */
export function searchIndex(
  conceptionPath: string,
  terms: readonly SearchTerm[],
  wants: (scope: string) => boolean,
): MatchOutput[] | null {
  const index = getIndex(conceptionPath);
  if (!index) return null;
  const out: MatchOutput[] = [];
  for (const file of index.byPath.values()) {
    if (!wants(SOURCE_TO_SCOPE[file.source as IndexedSource])) continue;
    const m = matchPrepared(file, terms);
    if (m) out.push(m);
  }
  return out;
}

/**
 * Build (or rebuild) the index for the four markdown sources. Fire-and-forget
 * from the watcher so it never blocks boot; queries fall back to the disk scan
 * until it resolves. Passing `null` just clears.
 */
export async function rebuildSearchIndex(conceptionPath: string | null): Promise<void> {
  clearSearchIndex();
  if (!conceptionPath) return;
  const token = buildToken;
  const { resources, skills } = resolveConceptionPaths();

  const [projectFiles, knowledgeFiles, resourceFiles, skillFiles] = await Promise.all([
    collectProjectFiles(join(conceptionPath, 'projects')),
    collectKnowledgeFiles(join(conceptionPath, 'knowledge')),
    collectResourceFiles(join(conceptionPath, resources)),
    collectSkillFiles(join(conceptionPath, skills)),
  ]);

  const refs: FileRef[] = [
    ...projectFiles.map((f) => toRef(conceptionPath, f.path, 'project', f.projectPath)),
    ...knowledgeFiles.map((p) => toRef(conceptionPath, p, 'knowledge')),
    ...resourceFiles.map((p) => toRef(conceptionPath, p, 'resources')),
    ...skillFiles.map((p) => toRef(conceptionPath, p, 'skills')),
  ];

  const byPath = new Map<string, PreparedFile>();
  await runWithConcurrency(
    refs.map((ref) => async () => {
      const prepared = await prepareFile(ref);
      if (prepared) byPath.set(ref.path, prepared);
    }),
    PREPARE_CONCURRENCY,
  );

  // A newer rebuild/clear (conception switch) superseded us — drop the result.
  if (token !== buildToken) return;
  current = { conceptionPath, byPath };
}

/**
 * Apply one chokidar FS event to the index (called from the watcher). Keeps the
 * index incrementally fresh without a full rebuild: re-prepare a changed/added
 * markdown file, drop a removed one. No-op when the path isn't an indexed
 * markdown file (logs, dotfiles, `local/`, non-markdown) or when no index is
 * built for this conception.
 */
export async function applyIndexFsEvent(
  conceptionPath: string,
  eventName: string,
  absPath: string,
): Promise<void> {
  if (!getIndex(conceptionPath)) return;
  const key = toPosix(absPath);

  if (eventName === 'unlink') {
    getIndex(conceptionPath)?.byPath.delete(key);
    return;
  }
  if (eventName === 'unlinkDir') {
    const index = getIndex(conceptionPath);
    if (!index) return;
    const prefix = `${key}/`;
    for (const k of index.byPath.keys()) {
      if (k.startsWith(prefix)) index.byPath.delete(k);
    }
    return;
  }
  if (eventName !== 'add' && eventName !== 'change') return;

  const classified = classifyIndexedPath(conceptionPath, key);
  if (!classified) return;
  const prepared = await prepareFile({
    path: key,
    relPath: toPosix(relative(conceptionPath, absPath)),
    source: classified.source,
    projectPath: classified.projectPath,
  });
  // Re-fetch: a conception switch could have landed while we read the file.
  const live = getIndex(conceptionPath);
  if (!live) return;
  if (prepared) live.byPath.set(key, prepared);
  else live.byPath.delete(key); // vanished between the event and the read
}

function toRef(
  conceptionPath: string,
  absPath: string,
  source: IndexedSource,
  projectPath?: string,
): FileRef {
  return {
    path: toPosix(absPath),
    relPath: toPosix(relative(conceptionPath, absPath)),
    source,
    projectPath: projectPath ? toPosix(projectPath) : undefined,
  };
}

/**
 * Map a posix absolute path to its indexed source (or null), mirroring the
 * walk.ts collectors' membership: correct extension, and no dot-prefixed /
 * `node_modules` / `local` segment below the source root.
 */
function classifyIndexedPath(
  conceptionPath: string,
  posixPath: string,
): { source: IndexedSource; projectPath?: string } | null {
  const cp = toPosix(conceptionPath);
  const lower = posixPath.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  const { resources, skills } = resolveConceptionPaths();

  const projRoot = `${cp}/projects`;
  if (posixPath.startsWith(`${projRoot}/`) && ext === '.md') {
    const rel = posixPath.slice(projRoot.length + 1).split('/');
    if (rel.length < 2 || !segmentsClean(rel)) return null;
    return { source: 'project', projectPath: `${projRoot}/${rel[0]}/${rel[1]}` };
  }

  const knowRoot = `${cp}/knowledge`;
  if (posixPath.startsWith(`${knowRoot}/`) && ext === '.md') {
    if (!segmentsClean(posixPath.slice(knowRoot.length + 1).split('/'))) return null;
    return { source: 'knowledge' };
  }

  const resRoot = toPosix(join(cp, resources));
  if (posixPath.startsWith(`${resRoot}/`) && RESOURCE_EXTS.has(ext)) {
    if (!segmentsClean(posixPath.slice(resRoot.length + 1).split('/'))) return null;
    return { source: 'resources' };
  }

  const skillRoot = toPosix(join(cp, skills));
  if (posixPath.startsWith(`${skillRoot}/`) && ext === '.md') {
    if (!segmentsClean(posixPath.slice(skillRoot.length + 1).split('/'))) return null;
    return { source: 'skills' };
  }

  return null;
}

function segmentsClean(segments: string[]): boolean {
  return segments.every((s) => s.length > 0 && !s.startsWith('.') && !SKIP_SEGMENTS.has(s));
}
