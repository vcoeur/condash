/**
 * `links` audit check — relative Markdown links and knowledge-transfer markers
 * whose targets or Markdown anchors no longer resolve.
 *
 * The scan covers Markdown under both `knowledge/` and `projects`: knowledge
 * articles commonly link to project evidence, while project notes carry
 * `**Transferred:**` markers that point back into knowledge — either into the
 * tree itself or, when the `knowledge` skill's promotion rules moved detail
 * into an app's doc tree, into a file inside the workspace or a configured
 * repository. A CommonMark AST supplies source positions and keeps code-shaped
 * examples out of the scan.
 */

import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import GithubSlugger from 'github-slugger';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import type {
  Definition,
  Heading,
  Html,
  InlineCode,
  Link,
  LinkReference,
  Paragraph,
  Root,
} from 'mdast';
import { pathExists } from '../fs-helpers';
import { collectFilesByExt, type AuditIssue } from './shared';

const EXTERNAL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const TRANSFERRED_PREFIX_RE = /^[ \t]+\d{4}-\d{2}-\d{2}[ \t]+→[ \t]*$/;

interface MarkdownLink {
  node: Link | LinkReference;
  target: string;
  line: number;
}

interface SplitTarget {
  path: string;
  anchor: string | null;
}

interface MdastNode {
  type: string;
  children?: MdastNode[];
}

/**
 * Fallback roots a transfer target may resolve against beyond the conception
 * tree. `runAudit` builds this from the effective config; tests pass it
 * explicitly so the check stays deterministic without a config on disk.
 */
export interface TransferContext {
  /** The conception's configured workspace root, when one is set. */
  workspacePath?: string;
  /** Every configured repository's directory name and resolved absolute cwd. */
  repoRoots: { name: string; cwd: string }[];
}

/** Scan Markdown in the durable tree for unresolved relative links and anchors. */
export async function checkLinks(
  conceptionPath: string,
  context: TransferContext = { repoRoots: [] },
): Promise<AuditIssue[]> {
  const files = await markdownFiles(conceptionPath);
  const anchorCache = new Map<string, Promise<Set<string>>>();
  const issues: AuditIssue[] = [];

  for (const filePath of files) {
    const source = await fs.readFile(filePath, 'utf8');
    const file = relative(conceptionPath, filePath);
    const document = fromMarkdown(source);
    const definitions = collectDefinitions(document);
    const links = collectLinks(document, definitions);
    const consumedTransferLinks = new Set<Link | LinkReference>();

    for (const paragraph of paragraphs(document)) {
      for (const transfer of transferredTargets(paragraph, definitions)) {
        for (const targetRef of transfer.targets) {
          if (targetRef.link) {
            consumedTransferLinks.add(targetRef.link.node);
            const issue = await transferredLinkIssue(
              conceptionPath,
              filePath,
              file,
              targetRef.link,
              anchorCache,
              context,
            );
            if (issue) issues.push(issue);
            continue;
          }

          const issue = await transferredIssue(
            conceptionPath,
            filePath,
            file,
            transfer.line,
            targetRef.target,
            context,
          );
          if (issue) issues.push(issue);
        }
      }
    }

    for (const link of links) {
      if (consumedTransferLinks.has(link.node)) continue;
      const issue = await linkIssue(conceptionPath, filePath, file, link, anchorCache);
      if (issue) issues.push(issue);
    }
  }
  return issues;
}

/** List every Markdown file that participates in durable knowledge references. */
async function markdownFiles(conceptionPath: string): Promise<string[]> {
  const roots = [join(conceptionPath, 'knowledge'), join(conceptionPath, 'projects')];
  const groups = await Promise.all(roots.map((root) => collectFilesByExt(root, ['.md'])));
  return groups.flat().sort();
}

/** Return one issue for a relative Markdown link, or null when it resolves. */
async function linkIssue(
  conceptionPath: string,
  sourcePath: string,
  sourceFile: string,
  link: MarkdownLink,
  anchorCache: Map<string, Promise<Set<string>>>,
): Promise<AuditIssue | null> {
  if (isExternal(link.target)) return null;
  const target = splitTarget(link.target);
  const targetPath = target.path ? resolve(dirname(sourcePath), target.path) : sourcePath;
  if (!(await pathExists(targetPath))) {
    return unresolvedIssue(
      sourceFile,
      link.line,
      `Link target does not exist: ${link.target}`,
      link.target,
    );
  }
  if (!target.anchor || !targetPath.toLowerCase().endsWith('.md')) return null;

  const anchors = cachedAnchors(targetPath, anchorCache);
  if ((await anchors).has(target.anchor)) return null;
  const targetFile = relative(conceptionPath, targetPath);
  return unresolvedIssue(
    sourceFile,
    link.line,
    `Anchor #${target.anchor} does not exist in ${targetFile}`,
    link.target,
  );
}

/** Return a transfer-marker finding when its target resolves nowhere it could live. */
async function transferredIssue(
  conceptionPath: string,
  sourcePath: string,
  file: string,
  line: number,
  target: string,
  context: TransferContext,
): Promise<AuditIssue | null> {
  for (const candidate of transferCandidates(conceptionPath, sourcePath, target, context)) {
    if (await pathExists(candidate)) return null;
  }
  const unverifiable = await unverifiableTransferTarget(target, context);
  if (unverifiable) {
    return { ...unresolvedIssue(file, line, unverifiable, target), severity: 'info' };
  }
  return unresolvedIssue(file, line, `Transferred marker target does not exist: ${target}`, target);
}

/** Resolve a linked transfer target through the fallback chain, then its anchors. */
async function transferredLinkIssue(
  conceptionPath: string,
  sourcePath: string,
  sourceFile: string,
  link: MarkdownLink,
  anchorCache: Map<string, Promise<Set<string>>>,
  context: TransferContext,
): Promise<AuditIssue | null> {
  const target = splitTarget(link.target);
  for (const candidate of transferCandidates(conceptionPath, sourcePath, link.target, context)) {
    if (!(await pathExists(candidate))) continue;
    if (!target.anchor || !candidate.toLowerCase().endsWith('.md')) return null;
    const anchors = await cachedAnchors(candidate, anchorCache);
    if (anchors.has(target.anchor)) return null;
    return unresolvedIssue(
      sourceFile,
      link.line,
      `Anchor #${target.anchor} does not exist in ${relative(conceptionPath, candidate)}`,
      link.target,
    );
  }
  const unverifiable = await unverifiableTransferTarget(link.target, context);
  if (unverifiable) {
    return {
      ...unresolvedIssue(sourceFile, link.line, unverifiable, link.target),
      severity: 'info',
    };
  }
  return unresolvedIssue(
    sourceFile,
    link.line,
    `Transferred marker target does not exist: ${link.target}`,
    link.target,
  );
}

/**
 * Absolute paths a transfer target may resolve against, in priority order: the
 * conception root, the containing file's directory, the workspace root, and
 * each configured repository whose directory name the target's first segment
 * names — resolved against that repository's own cwd with the segment stripped,
 * so a sub-path entry (cwd deeper than its directory name) still matches.
 */
function transferCandidates(
  conceptionPath: string,
  sourcePath: string,
  target: string,
  context: TransferContext,
): string[] {
  const rel = splitTarget(target).path;
  if (!rel || isExternal(rel)) return [];
  const candidates = new Set<string>([resolve(conceptionPath, rel)]);
  if (!isAbsolute(rel)) candidates.add(resolve(dirname(sourcePath), rel));
  if (context.workspacePath) candidates.add(resolve(context.workspacePath, rel));
  const first = rel.split('/')[0];
  for (const root of context.repoRoots) {
    if (root.name === first && rel.length > first.length) {
      candidates.add(join(root.cwd, rel.slice(first.length + 1)));
    }
  }
  return [...candidates];
}

/**
 * Explain when a miss cannot prove a dangler: without a configured workspace,
 * or when the named repository is not cloned on this machine, the check cannot
 * tell a missing file from a missing checkout — an info, not an error.
 */
async function unverifiableTransferTarget(
  target: string,
  context: TransferContext,
): Promise<string | null> {
  const rel = splitTarget(target).path;
  if (!rel || isExternal(rel)) return null;
  if (!context.workspacePath) {
    return `Transferred marker target could not be verified: workspace_path is not configured (${target})`;
  }
  const first = rel.split('/')[0];
  const repo = context.repoRoots.find((root) => root.name === first);
  if (repo && rel.length > first.length && !(await pathExists(repo.cwd))) {
    return `Transferred marker target could not be verified: ${repo.name} is not cloned (${target})`;
  }
  return null;
}

/** Build the standard non-auto-fixable issue shape for a broken reference. */
function unresolvedIssue(file: string, line: number, message: string, target: string): AuditIssue {
  return {
    check: 'links',
    severity: 'error',
    file,
    line,
    message,
    fix: { action: 'flag_for_user_review', autoFix: false, target },
  };
}

/** Separate a URI path from its query and fragment, decoding each component. */
function splitTarget(raw: string): SplitTarget {
  const hash = raw.indexOf('#');
  const beforeFragment = hash === -1 ? raw : raw.slice(0, hash);
  const query = beforeFragment.indexOf('?');
  return {
    path: decodeUriComponent(beforeFragment.slice(0, query === -1 ? undefined : query)),
    anchor: hash === -1 ? null : decodeUriComponent(raw.slice(hash + 1)),
  };
}

/** Decode a URI component without allowing a malformed link to crash the audit. */
function decodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Schemed and protocol-relative targets are external, not filesystem references. */
function isExternal(target: string): boolean {
  return EXTERNAL_SCHEME_RE.test(target) || target.startsWith('//');
}

/** Memoise target-anchor collection because several inbound links share one target. */
function cachedAnchors(
  targetPath: string,
  cache: Map<string, Promise<Set<string>>>,
): Promise<Set<string>> {
  let anchors = cache.get(targetPath);
  if (!anchors) {
    anchors = collectAnchors(targetPath);
    cache.set(targetPath, anchors);
  }
  return anchors;
}

/** Collect GitHub-style heading slugs plus explicit HTML `id` / `name` anchors. */
async function collectAnchors(filePath: string): Promise<Set<string>> {
  if (!filePath.toLowerCase().endsWith('.md')) return new Set();
  const source = await fs.readFile(filePath, 'utf8');
  const anchors = new Set<string>();
  const slugger = new GithubSlugger();

  walk(fromMarkdown(source), (node) => {
    if (node.type === 'heading') anchors.add(slugger.slug(toString(node as Heading)));
    if (node.type === 'html') {
      for (const anchor of htmlAnchors((node as Html).value)) anchors.add(anchor);
    }
  });
  return anchors;
}

/** Return normalised definition destinations from one Markdown document. */
function collectDefinitions(document: Root): Map<string, string> {
  const definitions = new Map<string, string>();
  walk(document, (node) => {
    if (node.type === 'definition') {
      const definition = node as Definition;
      if (!definitions.has(definition.identifier)) {
        definitions.set(definition.identifier, definition.url);
      }
    }
  });
  return definitions;
}

/** Return direct and resolved reference links with their AST source lines. */
function collectLinks(document: Root, definitions: Map<string, string>): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  walk(document, (node) => {
    if (node.type === 'link') {
      const link = node as Link;
      links.push({ node: link, target: link.url, line: nodeLine(link) });
    }
    if (node.type === 'linkReference') {
      const link = node as LinkReference;
      const target = definitions.get(link.identifier);
      if (target) links.push({ node: link, target, line: nodeLine(link) });
    }
  });
  return links;
}

/** Return paragraphs so transfer metadata remains constrained to Markdown prose. */
function* paragraphs(document: Root): Generator<Paragraph> {
  const found: Paragraph[] = [];
  walk(document, (node) => {
    if (node.type === 'paragraph') found.push(node as Paragraph);
  });
  yield* found;
}

/**
 * Identify each Transferred marker shape from a paragraph's AST children and
 * yield every target it names. A marker matches anywhere in a paragraph —
 * timeline entries and list items start one mid-line — and after the first
 * target further backticked nodes are additional targets (`… → `a.md` `b.md``)
 * until an `on` word appears: `… on `repo`/`branch`` names the landing branch,
 * not a target, so everything after it is left uncollected.
 */
function* transferredTargets(
  paragraph: Paragraph,
  definitions: Map<string, string>,
): Generator<{ line: number; targets: { target: string; link?: MarkdownLink }[] }> {
  for (let index = 0; index < paragraph.children.length - 2; index += 1) {
    const marker = paragraph.children[index];
    const prefix = paragraph.children[index + 1];
    const target = paragraph.children[index + 2];
    if (marker?.type !== 'strong' || toString(marker) !== 'Transferred:') continue;
    if (prefix?.type !== 'text' || !TRANSFERRED_PREFIX_RE.test(prefix.value)) continue;

    const refs: { target: string; link?: MarkdownLink }[] = [];
    if (target?.type === 'inlineCode') {
      refs.push({ target: (target as InlineCode).value });
    } else if (target?.type === 'link') {
      const link = target as Link;
      refs.push({
        target: link.url,
        link: { node: link, target: link.url, line: nodeLine(link) },
      });
    } else if (target?.type === 'linkReference') {
      const link = target as LinkReference;
      const destination = definitions.get(link.identifier);
      if (!destination) continue;
      refs.push({
        target: destination,
        link: { node: link, target: destination, line: nodeLine(link) },
      });
    } else {
      continue;
    }

    for (let scan = index + 3; scan < paragraph.children.length; scan += 1) {
      const next = paragraph.children[scan];
      if (next?.type === 'inlineCode') {
        refs.push({ target: (next as InlineCode).value });
        continue;
      }
      if (next?.type === 'text' && /^\s*$/.test(next.value)) continue;
      break;
    }
    yield { line: nodeLine(marker), targets: refs };
  }
}

/** Traverse mdast nodes without a second tree-walking dependency. */
function walk(node: MdastNode, visit: (node: MdastNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/** Return the parser-provided line, keeping audit findings navigable. */
function nodeLine(node: { position?: { start?: { line?: number } } }): number {
  return node.position?.start?.line ?? 1;
}

/** Extract `id` and legacy `name` values from explicit HTML anchor tags. */
function htmlAnchors(html: string): string[] {
  const anchors: string[] = [];
  const tagRe = /<[a-z][^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(html))) {
    const attribute = /(?:^|\s)(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(
      tag[0],
    );
    const value = attribute?.[1] ?? attribute?.[2] ?? attribute?.[3];
    if (value) anchors.push(value);
  }
  return anchors;
}
