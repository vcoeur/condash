import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from '../exec';
import { indexHumanContent, regenerateIndex } from '../index-tree';
import { projectsStrategy } from '../index-projects';
import { knowledgeStrategy } from '../index-knowledge';
import { classifyPath } from './group';
import { inProgressOperation, readChangedPaths, resolveGitDir } from './git';
import type { SyncCommitRecord } from './run';

interface Snapshot {
  head: string;
  upstream: string;
  branch: string;
}

async function git(cwd: string, args: string[], isolated = false): Promise<string> {
  const env = { ...process.env };
  if (isolated) {
    env.GIT_CONFIG_GLOBAL = '/dev/null';
    env.GIT_CONFIG_SYSTEM = '/dev/null';
    env.GIT_ATTR_NOSYSTEM = '1';
    for (const key of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_PARAMETERS',
    ])
      delete env[key];
  }
  return (await exec('git', args, { cwd, env })).stdout;
}

async function snapshot(cwd: string): Promise<Snapshot> {
  return {
    head: (await git(cwd, ['rev-parse', 'HEAD'])).trim(),
    upstream: (await git(cwd, ['rev-parse', '@{upstream}'])).trim(),
    branch: (await git(cwd, ['symbolic-ref', 'HEAD'])).trim(),
  };
}

async function requireClean(cwd: string): Promise<void> {
  if ((await readChangedPaths(cwd)).length > 0) {
    throw new Error(
      'safe merge waits for a clean working tree and index (including untracked files)',
    );
  }
  if (await inProgressOperation(await resolveGitDir(cwd))) {
    throw new Error('safe merge refused: a Git operation is in progress');
  }
  const entries = (await git(cwd, ['ls-files', '-v', '-z'])).split('\0');
  if (entries.some((entry) => entry && !entry.startsWith('H '))) {
    throw new Error('safe merge refuses hidden index state (assume-unchanged/skip-worktree)');
  }
}

function generatedIndex(path: string): boolean {
  if (classifyPath(path).kind !== 'index') return false;
  return !path
    .split('/')
    .some(
      (part) =>
        part.startsWith('.') ||
        ['local', 'notes', 'node_modules'].includes(part) ||
        /^\d{4}-\d{2}-\d{2}-/.test(part),
    );
}

/** Prepare a two-parent merge outside the checkout, then apply only a guarded fast-forward.
 * @param cwd clean conception checkout, after fetching
 * @returns the applied commit record; throws on unsupported Git, human conflicts, or invalidated preflight
 */
export async function safeMerge(cwd: string): Promise<SyncCommitRecord> {
  await requireClean(cwd);
  const initial = await snapshot(cwd);
  const version = /git version (\d+)\.(\d+)/.exec(await git(cwd, ['--version']));
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 29)) {
    throw new Error('safe merge requires Git 2.29 or newer');
  }
  let help = '';
  try {
    help = await git(cwd, ['merge', '-h']);
  } catch (error) {
    help = `${(error as { stdout?: string; stderr?: string }).stdout ?? ''}${(error as { stderr?: string }).stderr ?? ''}`;
  }
  if (
    !help.includes('overwrite-ignore') ||
    !help.includes('--ff-only') ||
    !help.includes('autostash')
  ) {
    throw new Error('safe merge requires Git with --no-overwrite-ignore and --ff-only support');
  }
  const scratch = await fs.mkdtemp(join(tmpdir(), 'condash-safe-merge-'));
  const repo = join(scratch, 'repo');
  try {
    await fs.mkdir(repo);
    await git(repo, ['init', '-q'], true);
    const identity = (await git(cwd, ['var', 'GIT_AUTHOR_IDENT'])).trim();
    const author = /^(.*) <([^<>]+)> \d+ [+-]\d+$/.exec(identity);
    if (!author) throw new Error('safe merge cannot resolve Git author identity');
    await git(repo, ['config', 'user.name', author[1]], true);
    await git(repo, ['config', 'user.email', author[2]], true);
    await git(repo, ['fetch', '--no-tags', cwd, initial.head, initial.upstream], true);
    const affectedTrees = new Set<'projects' | 'knowledge'>();
    // Never regenerate through a symlink or submodule supplied by either tip.
    for (const tip of [initial.head, initial.upstream]) {
      await git(repo, ['checkout', '--detach', tip], true);
      const allPaths = (await git(repo, ['ls-tree', '-r', '--name-only', '-z', tip], true))
        .split('\0')
        .filter(Boolean);
      for (let i = 0; i < allPaths.length; i += 100) {
        const attributes = (
          await git(repo, ['check-attr', '-z', 'merge', '--', ...allPaths.slice(i, i + 100)], true)
        ).split('\0');
        for (let j = 2; j < attributes.length; j += 3) {
          if (!['unspecified', 'set', 'text'].includes(attributes[j])) {
            throw new Error('safe merge refuses non-text merge attributes');
          }
        }
      }
      const entries = (
        await git(repo, ['ls-tree', '-r', '-z', tip, '--', 'projects', 'knowledge'], true)
      ).split('\0');
      if (
        entries.some(
          (entry) => entry && !entry.startsWith('100644 ') && !entry.startsWith('100755 '),
        )
      ) {
        throw new Error('safe merge refuses symlinks and unsupported tree modes');
      }
      if (
        entries.some(
          (entry) =>
            entry &&
            generatedIndex(entry.slice(entry.indexOf('\t') + 1)) &&
            !entry.startsWith('100644 '),
        )
      ) {
        throw new Error('safe merge refuses unsupported index modes');
      }
    }
    const base = (await git(repo, ['merge-base', initial.head, initial.upstream], true)).trim();
    for (const tip of [initial.head, initial.upstream]) {
      const records = (
        await git(repo, ['diff', '--name-status', '-z', '-M', base, tip], true)
      ).split('\0');
      for (let i = 0; i < records.length - 1; ) {
        const status = records[i++];
        const paths = [records[i++]];
        if (/^[RC]/.test(status)) paths.push(records[i++]);
        for (const path of paths) {
          if (path.startsWith('projects/')) affectedTrees.add('projects');
          if (path.startsWith('knowledge/')) affectedTrees.add('knowledge');
        }
        if (/^[DRT]/.test(status) && paths.some(generatedIndex)) {
          throw new Error('safe merge refuses deleted, renamed, or type-changed indexes');
        }
      }
    }
    await git(repo, ['checkout', '--detach', initial.head], true);
    try {
      await git(repo, ['merge', '--no-ff', '--no-commit', initial.upstream], true);
    } catch (error) {
      // Only a real content-conflict result is recoverable, never an arbitrary Git failure.
      if (
        (error as { code?: number }).code !== 1 ||
        !(await inProgressOperation(await resolveGitDir(repo)))
      )
        throw error;
    }
    const stages = (await git(repo, ['ls-files', '-u', '-z'], true)).split('\0').filter(Boolean);
    const conflicts = new Map<string, Map<number, string>>();
    for (const entry of stages) {
      const match = /^(\d+) ([a-f0-9]+) ([123])\t([\s\S]+)$/.exec(entry);
      if (!match || match[1] !== '100644' || !generatedIndex(match[4])) {
        throw new Error('safe merge refuses handwritten conflicts or unsupported index modes');
      }
      const versions = conflicts.get(match[4]) ?? new Map<number, string>();
      versions.set(Number(match[3]), match[2]);
      conflicts.set(match[4], versions);
    }
    for (const [path, versions] of conflicts) {
      if (versions.size !== 3)
        throw new Error(`safe merge refuses added/deleted index conflict: ${path}`);
      const files: string[] = [];
      for (const stage of [2, 1, 3]) {
        const file = join(scratch, `human-${stage}`);
        const raw = await git(repo, ['cat-file', 'blob', versions.get(stage)!], true);
        await fs.writeFile(file, indexHumanContent(raw));
        files.push(file);
      }
      let human: string;
      try {
        human = await git(repo, ['merge-file', '-p', ...files], true);
      } catch {
        throw new Error(`safe merge refuses prose or curated-row conflict: ${path}`);
      }
      await fs.writeFile(join(repo, path), human);
      await git(repo, ['add', '--', path], true);
    }
    const protectedContent = new Map<string, string[]>();
    const mergedEntries = (await git(repo, ['ls-files', '-z'], true))
      .split('\0')
      .filter(generatedIndex);
    for (const path of mergedEntries) {
      const raw = await fs.readFile(join(repo, path), 'utf8');
      protectedContent.set(
        path,
        indexHumanContent(raw)
          .split(/\r?\n/)
          .filter((line) => line.trim() !== ''),
      );
    }
    for (const strategy of [projectsStrategy, knowledgeStrategy]) {
      if (!affectedTrees.has(strategy.treeName)) continue;
      // Rebuild from the merged committed sources, not any live user files.
      const report = await regenerateIndex(repo, strategy);
      if (report.flaggedRenames.length)
        throw new Error('safe merge refuses ambiguous index renames');
    }
    for (const [path, before] of protectedContent) {
      const after = indexHumanContent(await fs.readFile(join(repo, path), 'utf8')).split(/\r?\n/);
      let cursor = 0;
      for (const line of before) {
        const found = after.indexOf(line, cursor);
        if (found < 0)
          throw new Error(`safe merge refuses regeneration that changes human content: ${path}`);
        cursor = found + 1;
      }
    }
    await git(repo, ['add', '-A'], true);
    const subject = 'Merge upstream: regenerate indexes';
    await git(repo, ['commit', '--message', subject], true);
    const merged = (await git(repo, ['rev-parse', 'HEAD'], true)).trim();
    const paths = (await git(repo, ['diff', '--name-only', '-z', initial.head, merged], true))
      .split('\0')
      .filter(Boolean)
      .sort();
    // Import only objects; neither FETCH_HEAD nor live refs/index are changed here.
    await git(cwd, ['fetch', '--no-tags', '--no-write-fetch-head', repo, merged]);
    await requireClean(cwd);
    const latest = await snapshot(cwd);
    if (
      Object.keys(initial).some(
        (key) => initial[key as keyof Snapshot] !== latest[key as keyof Snapshot],
      )
    ) {
      throw new Error('safe merge preflight invalidated: HEAD, branch, or upstream changed');
    }
    // Git itself refuses dirty/untracked obstructions, including ignored files.
    await git(cwd, ['merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', merged]);
    return { sha: merged, subject, paths };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
