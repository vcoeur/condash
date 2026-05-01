import { join, relative } from 'node:path';
import type { SearchResults } from '../../shared/types';
import { toPosix } from '../../shared/path';
import { collectKnowledgeFiles, collectProjectFiles } from './walk';
import { matchFile, type MatchOutput } from './match';
import { parseQuery } from './query';

/** Maximum number of hits returned to the renderer. The renderer's grouping
 * pass collapses project-side hits afterwards, so this caps raw files, not
 * displayed groups. 100 is comfortably above the typical "what was I working
 * on" query and well under the point where the modal starts feeling slow. */
const RAW_HIT_CAP = 100;

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
export async function search(conceptionPath: string, query: string): Promise<SearchResults> {
  const terms = parseQuery(query);
  if (terms.length === 0) {
    return { hits: [], terms: [], totalBeforeCap: 0, truncated: false };
  }

  const projectFiles = await collectProjectFiles(join(conceptionPath, 'projects'));
  const knowledgeFiles = await collectKnowledgeFiles(join(conceptionPath, 'knowledge'));

  const matchPromises: Promise<MatchOutput | null>[] = [];

  for (const file of projectFiles) {
    matchPromises.push(
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
    matchPromises.push(
      matchFile({
        path: toPosix(path),
        relPath: toPosix(relative(conceptionPath, path)),
        source: 'knowledge',
        terms,
      }),
    );
  }

  const settled = await Promise.all(matchPromises);
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
