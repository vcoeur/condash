import { realpath } from 'node:fs/promises';
import { dirname, relative, sep } from 'node:path';
import { exec } from './exec';
import { requirePathUnder } from './path-bounds';

/** Build a directory URL for the two supported public forges. */
export function buildProjectForgeLink(
  remote: string,
  branch: string,
  directory: string,
): string | null {
  let origin: URL;
  try {
    origin = new URL(remote.replace(/^git@([^:]+):(.+)$/, 'ssh://git@$1/$2'));
  } catch {
    return null;
  }
  if (!['https:', 'ssh:'].includes(origin.protocol) || origin.port || origin.search || origin.hash)
    return null;
  const host = origin.hostname;
  if (host !== 'github.com' && host !== 'gitlab.com') return null;
  let namespace: string[];
  try {
    namespace = origin.pathname
      .replace(/^\//, '')
      .replace(/\/$/, '')
      .replace(/\.git$/, '')
      .split('/')
      .map(decodeURIComponent);
  } catch {
    return null;
  }
  if (
    namespace.length < 2 ||
    (host === 'github.com' && namespace.length !== 2) ||
    namespace.some((part) => !part || part === '.' || part === '..' || part.includes('/'))
  )
    return null;
  const segments = directory.split('/');
  if (!branch || segments.some((part) => !part || part === '.' || part === '..')) return null;
  const repository = namespace.map(encodeURIComponent).join('/');
  const tree = host === 'gitlab.com' ? '-/tree' : 'tree';
  return `https://${host}/${repository}/${tree}/${encodeURIComponent(branch)}/${segments.map(encodeURIComponent).join('/')}`;
}

/** Resolve an item link using only the owning conception checkout's local git state. */
export async function getProjectForgeLink(
  conceptionPath: string,
  readmePath: string,
): Promise<string | null> {
  const root = await realpath(conceptionPath);
  const readme = await requirePathUnder(readmePath, root);
  const directory = relative(root, dirname(readme)).split(sep).join('/');
  if (
    !/^projects\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(directory) ||
    !readme.endsWith(`${sep}README.md`)
  )
    return null;
  try {
    const git = async (...args: string[]) =>
      (await exec('git', ['-C', root, ...args], { timeout: 5000 })).stdout.trim();
    if ((await realpath(await git('rev-parse', '--show-toplevel'))) !== root) return null;
    const branchRef = await git('symbolic-ref', '--quiet', 'HEAD');
    if (!branchRef.startsWith('refs/heads/')) return null;
    const branch = branchRef.slice('refs/heads/'.length);
    const remote = await git('remote', 'get-url', 'origin');
    return buildProjectForgeLink(remote, branch, directory);
  } catch {
    return null;
  }
}
