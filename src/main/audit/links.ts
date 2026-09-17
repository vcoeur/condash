/**
 * `links` audit check — relative Markdown links and knowledge-transfer markers
 * whose targets or Markdown anchors no longer resolve.
 *
 * The scan covers Markdown under both `knowledge/` and `projects/`: knowledge
 * articles commonly link to project evidence, while project notes carry the
 * `**Transferred:**` markers that point back into knowledge. Markdown-it
 * tokenises inline code and fenced blocks for us, so examples remain prose,
 * rather than becoming false dangling-link findings.
 */

import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import MarkdownIt from 'markdown-it';
import { iterUnfencedLines } from '../../shared/header';
import { pathExists } from '../fs-helpers';
import { collectFilesByExt, type AuditIssue } from './shared';

const markdown = new MarkdownIt({ html: true, linkify: false });
const EXTERNAL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const TRANSFERRED_MARKER_RE = /^\*\*Transferred:\*\*\s+\d{4}-\d{2}-\d{2}\s+→\s*(.+?)\s*$/;

interface LinkReference {
  target: string;
  line: number;
}

interface SplitTarget {
  path: string;
  anchor: string | null;
}

/** Scan Markdown in the durable tree for unresolved relative links and anchors. */
export async function checkLinks(conceptionPath: string): Promise<AuditIssue[]> {
  const files = await markdownFiles(conceptionPath);
  const anchorCache = new Map<string, Promise<Set<string>>>();
  const issues: AuditIssue[] = [];

  for (const filePath of files) {
    const source = await fs.readFile(filePath, 'utf8');
    const file = relative(conceptionPath, filePath);
    const lines = source.split(/\r?\n/);
    const transferredLinks = new Map<string, number>();
    for (const { index, line } of iterUnfencedLines(lines)) {
      const transferTarget = transferredTarget(line);
      if (!transferTarget) continue;
      const transferIssue = await transferredIssue(
        conceptionPath,
        file,
        filePath,
        index + 1,
        transferTarget,
      );
      if (transferIssue) issues.push(transferIssue);
      if (transferTarget.isMarkdownLink) {
        const key = linkKey({ line: index + 1, target: transferTarget.target });
        transferredLinks.set(key, (transferredLinks.get(key) ?? 0) + 1);
      }
    }
    for (const link of markdownLinks(source)) {
      if (consumeTransferredLink(link, transferredLinks)) continue;
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

/** Extract Markdown link destinations from a complete source document. */
function markdownLinks(source: string): LinkReference[] {
  const tokens = markdown.parse(source, {});
  const links: LinkReference[] = [];
  for (const token of tokens) {
    if (token.type !== 'inline') continue;
    const firstLine = (token.map?.[0] ?? 0) + 1;
    let searchStart = 0;
    for (const child of token.children ?? []) {
      if (child.type !== 'link_open') continue;
      const target = child.attrGet('href');
      if (!target) continue;
      const location = inlineLinkLocation(token.content, target, searchStart);
      if (location) searchStart = location.offset + 1;
      links.push({
        target,
        line: firstLine + (location?.prefix.match(/\n/g)?.length ?? 0),
      });
    }
  }
  return links;
}

/** Locate a direct link destination in an inline token to preserve its source line. */
function inlineLinkLocation(
  source: string,
  target: string,
  searchStart: number,
): { offset: number; prefix: string } | null {
  const offset = source.indexOf(`](${target}`, searchStart);
  if (offset === -1) return null;
  const linkStart = source.lastIndexOf('[', offset);
  return { offset, prefix: source.slice(0, linkStart === -1 ? offset : linkStart) };
}

/** Build a key for the single Markdown link represented by a transfer marker. */
function linkKey(link: LinkReference): string {
  return `${link.line}\u0000${link.target}`;
}

/** Skip one link already handled as a Transferred-marker target. */
function consumeTransferredLink(
  link: LinkReference,
  transferredLinks: Map<string, number>,
): boolean {
  const key = linkKey(link);
  const count = transferredLinks.get(key) ?? 0;
  if (count === 0) return false;
  if (count === 1) transferredLinks.delete(key);
  else transferredLinks.set(key, count - 1);
  return true;
}

/** Return one issue for a relative Markdown link, or null when it resolves. */
async function linkIssue(
  conceptionPath: string,
  sourcePath: string,
  sourceFile: string,
  link: LinkReference,
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

/** Return a transfer-marker finding when its root-relative target is absent. */
async function transferredIssue(
  conceptionPath: string,
  file: string,
  sourcePath: string,
  line: number,
  transfer: { target: string; isMarkdownLink: boolean },
): Promise<AuditIssue | null> {
  if (isExternal(transfer.target)) return null;
  const targetPath = transfer.isMarkdownLink
    ? resolve(dirname(sourcePath), splitTarget(transfer.target).path)
    : resolve(conceptionPath, splitTarget(transfer.target).path);
  if (await pathExists(targetPath)) return null;
  return unresolvedIssue(
    file,
    line,
    `Transferred marker target does not exist: ${transfer.target}`,
    transfer.target,
  );
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
  const duplicateCounts = new Map<string, number>();

  const tokens = markdown.parse(source, {});
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'heading_open') continue;
    const inline = tokens[index + 1];
    if (inline?.type !== 'inline') continue;
    const visibleText = (inline.children ?? [])
      .filter((child) => child.type === 'text' || child.type === 'code_inline')
      .map((child) => child.content)
      .join('');
    const base = githubHeadingSlug(visibleText);
    const duplicate = duplicateCounts.get(base) ?? 0;
    duplicateCounts.set(base, duplicate + 1);
    anchors.add(duplicate === 0 ? base : `${base}-${duplicate}`);
  }

  for (const { line } of iterUnfencedLines(source.split(/\r?\n/))) {
    for (const anchor of htmlAnchors(withoutInlineCode(line))) anchors.add(anchor);
  }
  return anchors;
}

/** Generate the GitHub-style fragment for ordinary Markdown headings. */
function githubHeadingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

/** Extract `id` and legacy `name` values from explicit HTML anchor tags. */
function htmlAnchors(line: string): string[] {
  const anchors: string[] = [];
  const tagRe = /<a\b[^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(line))) {
    const attribute = /(?:^|\s)(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(
      tag[0],
    );
    const value = attribute?.[1] ?? attribute?.[2] ?? attribute?.[3];
    if (value) anchors.push(value);
  }
  return anchors;
}

/** Remove balanced inline-code spans before looking for literal HTML anchors. */
function withoutInlineCode(line: string): string {
  let result = '';
  let position = 0;
  while (position < line.length) {
    if (line[position] !== '`') {
      result += line[position++];
      continue;
    }
    const start = position;
    while (line[position] === '`') position += 1;
    const delimiter = line.slice(start, position);
    const closing = line.indexOf(delimiter, position);
    if (closing === -1) {
      result += delimiter;
      continue;
    }
    result += ' '.repeat(closing + delimiter.length - start);
    position = closing + delimiter.length;
  }
  return result;
}

/** Parse either supported transfer-marker target form without treating `[...](...)` as a path. */
function transferredTarget(line: string): { target: string; isMarkdownLink: boolean } | null {
  const match = TRANSFERRED_MARKER_RE.exec(line);
  if (!match) return null;
  const tail = match[1];
  const [inline] = markdown.parseInline(tail, {});
  const link = inline?.children?.find((token) => token.type === 'link_open');
  if (link) {
    const target = link.attrGet('href');
    if (target) return { target, isMarkdownLink: true };
  }
  const backticked = /^`([^`]+)`$/.exec(tail);
  return backticked ? { target: backticked[1], isMarkdownLink: false } : null;
}
