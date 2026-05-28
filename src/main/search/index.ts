import { join, relative } from 'node:path';
import type { SearchResults } from '../../shared/types';
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
import { resolveConceptionPaths } from '../conception-paths';
import { condashLogsRoot } from '../condash-dir';

/** Maximum number of hits returned to the renderer. The renderer's grouping
 * pass collapses project-side hits afterwards, so this caps raw files, not
 * displayed groups. 100 is comfortably above the typical "what was I working
 * on" query and well under the point where the modal starts feeling slow. */
const RAW_HIT_CAP = 100;

/** Cap on concurrent `fs.readFile` calls in matchFile. A conception tree can
 * carry several thousand markdown files (projects + knowledge + logs); a
 * naive `Promise.all` over the lot was opening file descriptors as fast as
 * the OS would allow, occasionally tripping EMFILE on dense trees. 32 is
 * comfortably above what node's default uv thread pool can chew through and
 * well below the typical ulimit -n. */
const READ_CONCURRENCY = 32;

async function runWithConcurrency<T>(
  factories: ReadonlyArray<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(factories.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= factories.length) return;
      results[i] = await factories[i]();
    }
  }
  const workers: Promise<void>[] = [];
  const n = Math.min(limit, factories.length);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * Run a query against the conception tree. Returns ordered hits + the parsed
 * terms (used by the renderer for multi-token highlighting) + truncation
 * metadata for the "Showing 100 of N" footer.
 *
 * Pipeline: parse → walk → match-per-file (scored) → sort → cap. Each step
 * lives in its own module for easy unit-testing and future replacement —
 * for example, swapping the brute-force `walk + match` for a pre-built index
 * would only touch one boundary.
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

  const { resources, skills } = resolveConceptionPaths();

  // Skills search covers the single agedum source tree at
  // `<conception>/.agents/skills/`; per-harness compiled outputs are no
  // longer searched (they're not authored content).
  const [projectFiles, knowledgeFiles, resourceFiles, skillFiles, logFiles] = await Promise.all([
    wants('projects') ? collectProjectFiles(join(conceptionPath, 'projects')) : Promise.resolve([]),
    wants('knowledge')
      ? collectKnowledgeFiles(join(conceptionPath, 'knowledge'))
      : Promise.resolve([]),
    wants('resources')
      ? collectResourceFiles(join(conceptionPath, resources))
      : Promise.resolve([]),
    wants('skills') ? collectSkillFiles(join(conceptionPath, skills)) : Promise.resolve([]),
    wants('logs') ? collectLogFiles(condashLogsRoot(conceptionPath)) : Promise.resolve([]),
  ]);

  const matchFactories: Array<() => Promise<MatchOutput | null>> = [];

  for (const file of projectFiles) {
    matchFactories.push(() =>
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
    matchFactories.push(() =>
      matchFile({
        path: toPosix(path),
        relPath: toPosix(relative(conceptionPath, path)),
        source: 'knowledge',
        terms,
      }),
    );
  }

  for (const path of resourceFiles) {
    matchFactories.push(() =>
      matchFile({
        path: toPosix(path),
        relPath: toPosix(relative(conceptionPath, path)),
        source: 'resources',
        terms,
      }),
    );
  }

  for (const path of skillFiles) {
    matchFactories.push(() =>
      matchFile({
        path: toPosix(path),
        relPath: toPosix(relative(conceptionPath, path)),
        source: 'skills',
        terms,
      }),
    );
  }

  for (const path of logFiles) {
    matchFactories.push(() =>
      matchFile({
        path: toPosix(path),
        relPath: toPosix(relative(conceptionPath, path)),
        source: 'logs',
        terms,
      }),
    );
  }

  const settled = await runWithConcurrency(matchFactories, READ_CONCURRENCY);
  const matched = settled.filter((m): m is MatchOutput => m !== null);

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
