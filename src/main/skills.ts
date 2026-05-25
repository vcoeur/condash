import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { SkillNode, SkillScope, SkillTab } from '../shared/types';
import { toPosix } from '../shared/path';
import { parseHead } from './knowledge';
import { readFileHead } from './read-file-head';
import { buildShippedLookup, type ShippedLookup } from './skills-shipped';
import { userAgentConfigOutput, userAgentConfigRoot, userSkillsRoot } from './user-scope-paths';

const HIDDEN_PREFIX = /^\./;

/** Agent-config source files surfaced (read-only) on the Generic tab — the
 *  `condash.md` (shipped) + `conception.md` (user-owned) split sources and the
 *  per-model `<model>.md` inputs that `condash skills install` compiles into
 *  each agent's CLAUDE.md / AGENTS.md. `common.md` is the combined body —
 *  materialised from the split in a conception, hand-authored in the user
 *  scope (`~/.config/agents/agents/`). */
const GENERIC_AGENT_SOURCES = [
  'condash.md',
  'conception.md',
  'common.md',
  'claude.md',
  'kimi.md',
  'opencode.md',
] as const;

/**
 * Read the skills tree for a (scope, tab) pair.
 *
 * `local` reads the active conception; `global` reads the per-machine user
 * scope (`~/.config/agents/`, `~/.claude/`, `~/.kimi/`, `~/.config/opencode/`).
 * The tree is the recursive listing of the tab's skills directory — `.md`
 * only, except the Generic tab which also surfaces `.yaml` skillspecs — plus
 * an optional `shipped` stamp on files tracked by `.condash-skills.json`.
 * Symlink loops are deduped via realpath.
 *
 * Synthetic read-only agent-config entries are prepended at the root: the
 * compiled `CLAUDE.md` (Claude), `AGENTS.md` (Kimi / OpenCode), and the
 * `common.md` + `<model>.md` sources (Generic). Each
 * carries a `badge` so the renderer draws a callout instead of a skill card.
 */
export async function readSkillsTreeForTab(
  scope: SkillScope,
  conceptionPath: string,
  tab: SkillTab,
  skillsRelPath: string,
): Promise<SkillNode | null> {
  const root = skillsRootFor(scope, conceptionPath, tab, skillsRelPath);
  let tree: SkillNode | null = null;
  try {
    await fs.access(root);
    const shipped = await buildShippedLookup(root);
    tree = await walk(
      root,
      '',
      basename(root) || 'skills',
      new Set<string>(),
      shipped,
      root,
      /* acceptYaml */ tab === 'generic',
    );
  } catch {
    tree = null;
  }
  const configEntries = await readAgentConfigEntries(scope, conceptionPath, tab);
  if (tree) {
    if (configEntries.length > 0) {
      tree.children = [...configEntries, ...(tree.children ?? [])];
    }
    return tree;
  }
  // No skills directory on disk, but the agent-config files may still exist
  // (e.g. global Claude with `~/.claude/CLAUDE.md` but no `~/.claude/skills`).
  // Surface them under a synthetic root so the pane isn't empty.
  if (configEntries.length > 0) {
    return {
      relPath: '',
      path: toPosix(root),
      name: 'skills',
      title: 'skills',
      kind: 'directory',
      children: configEntries,
    };
  }
  return null;
}

/** Local-scope Claude tree at `<conceptionPath>/<skillsRelPath>`. Thin wrapper
 *  over the scope-aware reader; kept for the existing call sites + tests. */
export function readSkillsTree(
  conceptionPath: string,
  skillsRelPath: string,
): Promise<SkillNode | null> {
  return readSkillsTreeForTab('local', conceptionPath, 'claude', skillsRelPath);
}

/** Local-scope Generic tree at `<conceptionPath>/.agents/skills/`. */
export function readGenericSkillsTree(conceptionPath: string): Promise<SkillNode | null> {
  return readSkillsTreeForTab('local', conceptionPath, 'generic', '');
}

/** Local-scope Kimi tree at `<conceptionPath>/.kimi/skills/`. */
export function readKimiSkillsTree(conceptionPath: string): Promise<SkillNode | null> {
  return readSkillsTreeForTab('local', conceptionPath, 'kimi', '');
}

/** Local-scope OpenCode tree at `<conceptionPath>/.opencode/skills/`. */
export function readOpencodeSkillsTree(conceptionPath: string): Promise<SkillNode | null> {
  return readSkillsTreeForTab('local', conceptionPath, 'opencode', '');
}

/** Resolve the on-disk skills directory for a (scope, tab) pair. */
function skillsRootFor(
  scope: SkillScope,
  conceptionPath: string,
  tab: SkillTab,
  skillsRelPath: string,
): string {
  if (scope === 'global') return userSkillsRoot(tab);
  switch (tab) {
    case 'generic':
      return join(conceptionPath, '.agents', 'skills');
    case 'kimi':
      return join(conceptionPath, '.kimi', 'skills');
    case 'opencode':
      return join(conceptionPath, '.opencode', 'skills');
    case 'claude':
      return join(conceptionPath, skillsRelPath);
  }
}

interface AgentConfigCandidate {
  /** Sentinel-prefixed synthetic relPath; can't collide with a real skill. */
  rel: string;
  abs: string;
  /** Short uppercase badge the renderer shows on the callout. */
  badge: string;
}

/** The agent-config files to inject at the root for a (scope, tab) pair. */
function agentConfigCandidates(
  scope: SkillScope,
  conceptionPath: string,
  tab: SkillTab,
): AgentConfigCandidate[] {
  if (tab === 'generic') {
    const dir =
      scope === 'global' ? userAgentConfigRoot() : join(conceptionPath, '.agents', 'agents');
    return GENERIC_AGENT_SOURCES.map((file) => ({
      rel: `__agents__/${file}`,
      abs: join(dir, file),
      badge: file.replace(/\.md$/, '').toUpperCase(),
    }));
  }
  if (scope === 'global') {
    const abs = userAgentConfigOutput(tab);
    const badge = tab === 'claude' ? 'CLAUDE' : tab === 'kimi' ? 'KIMI' : 'AGENTS';
    return [{ rel: `__${tab}__/${basename(abs)}`, abs, badge }];
  }
  switch (tab) {
    case 'claude':
      return [
        { rel: '__claude__/CLAUDE.md', abs: join(conceptionPath, 'CLAUDE.md'), badge: 'CLAUDE' },
        {
          rel: '__claude__/.claude/CLAUDE.md',
          abs: join(conceptionPath, '.claude', 'CLAUDE.md'),
          badge: 'CLAUDE',
        },
      ];
    case 'kimi':
      return [
        { rel: '__kimi__/AGENTS.md', abs: join(conceptionPath, 'AGENTS.md'), badge: 'AGENTS' },
        {
          rel: '__kimi__/.kimi/AGENTS.md',
          abs: join(conceptionPath, '.kimi', 'AGENTS.md'),
          badge: 'AGENTS',
        },
      ];
    case 'opencode':
      return [
        { rel: '__opencode__/AGENTS.md', abs: join(conceptionPath, 'AGENTS.md'), badge: 'AGENTS' },
        {
          rel: '__opencode__/.opencode/AGENTS.md',
          abs: join(conceptionPath, '.opencode', 'AGENTS.md'),
          badge: 'AGENTS',
        },
      ];
    default:
      return [];
  }
}

/** Probe each candidate and return a synthetic SkillNode for whichever exist,
 *  in declaration order. The `badge` field marks them read-only callouts. */
async function readAgentConfigEntries(
  scope: SkillScope,
  conceptionPath: string,
  tab: SkillTab,
): Promise<SkillNode[]> {
  const found: SkillNode[] = [];
  for (const { rel, abs, badge } of agentConfigCandidates(scope, conceptionPath, tab)) {
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    const name = basename(abs);
    const meta = await readMarkdownMeta(abs, name);
    found.push({
      relPath: rel,
      path: toPosix(abs),
      name,
      title: meta.title,
      kind: 'file',
      summary: meta.summary,
      badge,
    });
  }
  return found;
}

async function walk(
  absPath: string,
  relPath: string,
  name: string,
  visitedDirs: Set<string>,
  shipped: ShippedLookup,
  root: string,
  acceptYaml: boolean,
): Promise<SkillNode> {
  const stat = await fs.stat(absPath);
  if (stat.isFile()) {
    const meta = await readMarkdownMeta(absPath, name);
    const shippedInfo = await shipped.lookup(absPath, relPath);
    return {
      relPath,
      path: toPosix(absPath),
      name,
      title: meta.title,
      kind: 'file',
      summary: meta.summary,
      shipped: shippedInfo ?? undefined,
    };
  }

  let canonical = absPath;
  try {
    canonical = await fs.realpath(absPath);
  } catch {
    /* fall through with the lexical path */
  }
  if (visitedDirs.has(canonical)) {
    return {
      relPath,
      path: toPosix(absPath),
      name,
      title: relPath ? basename(absPath) : name,
      kind: 'directory',
      children: [],
    };
  }
  const nextVisited = new Set(visitedDirs);
  nextVisited.add(canonical);

  const entries = await fs.readdir(absPath, { withFileTypes: true });
  const accepted = entries.filter((e) => {
    if (HIDDEN_PREFIX.test(e.name)) return false;
    if (e.isDirectory()) return true;
    if (!e.isFile()) return false;
    const lower = e.name.toLowerCase();
    if (lower.endsWith('.md')) return true;
    if (acceptYaml && (lower.endsWith('.yaml') || lower.endsWith('.yml'))) return true;
    return false;
  });

  const children = await Promise.all(
    accepted.map(async (entry) => {
      const childAbs = join(absPath, entry.name);
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      return walk(childAbs, childRel, entry.name, nextVisited, shipped, root, acceptYaml);
    }),
  );

  children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    relPath,
    path: toPosix(absPath),
    name,
    title: relPath ? basename(absPath) : name,
    kind: 'directory',
    children,
  };
}

async function readMarkdownMeta(
  path: string,
  fallback: string,
): Promise<{ title: string; summary?: string }> {
  const head = await readFileHead(path);
  if (head === null) return { title: fallback };
  const meta = parseHead(head, fallback);
  return { title: meta.title, summary: meta.summary };
}
