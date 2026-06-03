import { join, relative } from 'node:path';
import type { SearchResults, SearchTerm } from '../../shared/types';
import { toPosix } from '../../shared/path';
import {
  collectKnowledgeFiles,
  collectLogFiles,
  collectProjectFiles,
  collectResourceFiles,
  collectSkillFiles,
} from './walk';
import { matchFile, type MatchOutput } from './match';
import { parseQuery } from './query';
import { runWithConcurrency } from './concurrency';
import { searchIndex } from './index-cache';
import { resolveConceptionPaths } from '../conception-paths';
import { condashLogsRoot } from '../condash-dir';

/** Maximum number of hits returned to the renderer. The renderer's grouping
 * pass collapses project-side hits afterwards, so this caps raw files, not
 * displayed groups. 100 is comfortably above the typical "what was I working
 * on" query and well under the point where the modal starts feeling slow. */
const RAW_HIT_CAP = 100;

/** Cap on concurrent `fs.readFile` calls in the on-disk scan (logs + the
 * pre-index fallback). 32 is comfortably above what node's default uv thread
 * pool can chew through and well below the typical ulimit -n. */
const READ_CONCURRENCY = 32;

/**
 * Run a query against the conception tree. Returns ordered hits + the parsed
 * terms (used by the renderer for multi-token highlighting) + truncation
 * metadata for the "Showing 100 of N" footer.
 *
 * Pipeline: parse → match → sort → cap. The four markdown sources are matched
 * against the **in-memory index** (`index-cache.ts`) — no per-query walk / read
 * / lowercase — falling back to an on-disk scan only while the index is still
 * building (boot window). Logs are never indexed (too large, rarely searched),
 * so they're disk-scanned, and only when in scope.
 */
export async function search(
  conceptionPath: string,
  query: string,
  scopes?: string[],
): Promise<SearchResults> {
  const terms = parseQuery(query);
  if (terms.length === 0) {
    return { hits: [], terms: [], totalBeforeCap: 0, truncated: false };
  }

  const wants = (source: string): boolean =>
    !scopes || scopes.length === 0 || scopes.includes(source);

  // Markdown sources from the in-memory index; on-disk fallback until it's built.
  let matched = searchIndex(conceptionPath, terms, wants);
  if (matched === null) {
    matched = await scanMarkdownFromDisk(conceptionPath, terms, wants);
  }

  // Logs: disk-scanned, never indexed, and only when 'logs' is in scope.
  if (wants('logs')) {
    const logFiles = await collectLogFiles(condashLogsRoot(conceptionPath));
    const settled = await runWithConcurrency(
      logFiles.map(
        (path) => () =>
          matchFile({
            path: toPosix(path),
            relPath: toPosix(relative(conceptionPath, path)),
            source: 'logs',
            terms,
          }),
      ),
      READ_CONCURRENCY,
    );
    for (const m of settled) if (m !== null) matched.push(m);
  }

  matched.sort((a, b) => {
    if (b.hit.score !== a.hit.score) return b.hit.score - a.hit.score;
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.hit.path.localeCompare(b.hit.path);
  });

  const totalBeforeCap = matched.length;
  const truncated = totalBeforeCap > RAW_HIT_CAP;
  const hits = matched.slice(0, RAW_HIT_CAP).map((m) => m.hit);

  return { hits, terms, totalBeforeCap, truncated };
}

/**
 * On-disk scan of the four markdown sources — the original brute-force path,
 * used only as a fallback while the in-memory index is still building. Honours
 * the scope filter so unselected sources aren't walked.
 */
async function scanMarkdownFromDisk(
  conceptionPath: string,
  terms: readonly SearchTerm[],
  wants: (source: string) => boolean,
): Promise<MatchOutput[]> {
  const { resources, skills } = resolveConceptionPaths();
  const [projectFiles, knowledgeFiles, resourceFiles, skillFiles] = await Promise.all([
    wants('projects') ? collectProjectFiles(join(conceptionPath, 'projects')) : Promise.resolve([]),
    wants('knowledge')
      ? collectKnowledgeFiles(join(conceptionPath, 'knowledge'))
      : Promise.resolve([]),
    wants('resources')
      ? collectResourceFiles(join(conceptionPath, resources))
      : Promise.resolve([]),
    wants('skills') ? collectSkillFiles(join(conceptionPath, skills)) : Promise.resolve([]),
  ]);

  const factories: Array<() => Promise<MatchOutput | null>> = [];
  for (const file of projectFiles) {
    factories.push(() =>
      matchFile({
        path: toPosix(file.path),
        relPath: toPosix(relative(conceptionPath, file.path)),
        source: 'project',
        projectPath: toPosix(file.projectPath),
        terms,
      }),
    );
  }
  for (const path of knowledgeFiles) {
    factories.push(() =>
      matchFile({
        path: toPosix(path),
        relPath: toPosix(relative(conceptionPath, path)),
        source: 'knowledge',
        terms,
      }),
    );
  }
  for (const path of resourceFiles) {
    factories.push(() =>
      matchFile({
        path: toPosix(path),
        relPath: toPosix(relative(conceptionPath, path)),
        source: 'resources',
        terms,
      }),
    );
  }
  for (const path of skillFiles) {
    factories.push(() =>
      matchFile({
        path: toPosix(path),
        relPath: toPosix(relative(conceptionPath, path)),
        source: 'skills',
        terms,
      }),
    );
  }

  const settled = await runWithConcurrency(factories, READ_CONCURRENCY);
  return settled.filter((m): m is MatchOutput => m !== null);
}
