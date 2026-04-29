import type { SearchHit } from '@shared/types';

export interface ProjectGroup {
  projectPath: string;
  /** README hit if any — used to label the group header. */
  header?: SearchHit;
  /** Non-README hits (notes, deliverables stored as .md, …). */
  files: SearchHit[];
  /** Sum of the scores of every member hit — used for inter-group sort. */
  totalScore: number;
}

export interface GroupedResults {
  projects: ProjectGroup[];
  knowledge: SearchHit[];
  total: number;
}

/**
 * Group project-side hits by their owning project so a project's README +
 * notes/* matches collapse into a single card. Knowledge hits stay flat
 * (each file is its own subject; no enclosing group).
 *
 * Sort:
 * - Projects by aggregate `totalScore` desc.
 * - Files within a project: README first (when present, served as the
 *   header), then notes by relPath asc.
 * - Knowledge hits in their incoming order (already score-sorted by the
 *   backend).
 */
export function groupHits(hits: readonly SearchHit[]): GroupedResults {
  const groups = new Map<string, ProjectGroup>();
  const knowledge: SearchHit[] = [];

  for (const hit of hits) {
    if (hit.source === 'project' && hit.projectPath) {
      let group = groups.get(hit.projectPath);
      if (!group) {
        group = { projectPath: hit.projectPath, files: [], totalScore: 0 };
        groups.set(hit.projectPath, group);
      }
      const isReadme = hit.path.toLowerCase().endsWith('/readme.md');
      if (isReadme) {
        group.header = hit;
      } else {
        group.files.push(hit);
      }
      group.totalScore += hit.score;
    } else {
      knowledge.push(hit);
    }
  }

  const projects = [...groups.values()].sort((a, b) => b.totalScore - a.totalScore);
  for (const g of projects) {
    g.files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  return {
    projects,
    knowledge,
    total: projects.length + knowledge.length,
  };
}
