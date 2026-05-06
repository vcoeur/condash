import { createMemo, For, Show } from 'solid-js';
import type { KnowledgeNode } from '@shared/types';
import { BookIcon } from '../icons';
import { formatSectionLabel } from './pane-utils';
import './knowledge-pane.css';

/* Knowledge pane — flat card list grouped one section per directory. The
 * chrome (section header capsule, card silhouette, hover-brighten) mirrors
 * the Code and Projects panes so the three panes feel like one app. The
 * directory's `index.md` (when present) is surfaced as an [INDEX] badge
 * on the section header — clicking it opens the index file. */

type BucketId = 'general' | 'internal' | 'topics' | 'external';

interface KnowledgeFile {
  node: KnowledgeNode;
  bucket: BucketId;
}

interface KnowledgeSection {
  id: string;
  label: string;
  bucket: BucketId;
  index?: KnowledgeNode;
  files: KnowledgeFile[];
}

const BUCKET_ORDER: readonly BucketId[] = ['general', 'internal', 'topics', 'external'];

function bucketOf(relPath: string): BucketId {
  if (relPath.startsWith('internal')) return 'internal';
  if (relPath.startsWith('external')) return 'external';
  if (relPath.startsWith('topics')) return 'topics';
  return 'general';
}

function buildSections(root: KnowledgeNode | null): KnowledgeSection[] {
  if (!root) return [];

  const sectionsByDir = new Map<string, KnowledgeSection>();
  const general: KnowledgeFile[] = [];

  const visit = (node: KnowledgeNode, dirRel: string): void => {
    if (node.kind === 'file') return;
    const isRoot = dirRel === '';
    const childDirs: KnowledgeNode[] = [];
    const childFiles: KnowledgeNode[] = [];
    for (const child of node.children ?? []) {
      if (child.kind === 'directory') childDirs.push(child);
      else childFiles.push(child);
    }
    let indexNode: KnowledgeNode | undefined;
    const contentNodes: KnowledgeNode[] = [];
    for (const f of childFiles) {
      if (f.name.toLowerCase() === 'index.md') indexNode = f;
      else contentNodes.push(f);
    }

    if (isRoot) {
      for (const f of contentNodes) general.push({ node: f, bucket: 'general' });
    } else if (contentNodes.length > 0 || indexNode) {
      const bucket = bucketOf(dirRel);
      const label = formatSectionLabel(dirRel);
      const files: KnowledgeFile[] = contentNodes
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((n) => ({ node: n, bucket }));
      sectionsByDir.set(dirRel, { id: dirRel, label, bucket, index: indexNode, files });
    }

    for (const sub of childDirs) {
      const childRel = dirRel ? `${dirRel}/${sub.name}` : sub.name;
      visit(sub, childRel);
    }
  };
  visit(root, '');

  const out: KnowledgeSection[] = [];
  if (general.length > 0) {
    out.push({
      id: 'general',
      label: 'GENERAL',
      bucket: 'general',
      files: general.sort((a, b) => a.node.title.localeCompare(b.node.title)),
    });
  }
  const rest = Array.from(sectionsByDir.values());
  rest.sort((a, b) => {
    const ai = BUCKET_ORDER.indexOf(a.bucket);
    const bi = BUCKET_ORDER.indexOf(b.bucket);
    if (ai !== bi) return ai - bi;
    return a.id.localeCompare(b.id);
  });
  return out.concat(rest);
}

function freshnessOf(verifiedAt: string | undefined, todayISO: string): string {
  if (!verifiedAt) return 'none';
  const t = Date.parse(`${todayISO}T00:00:00Z`);
  const v = Date.parse(`${verifiedAt}T00:00:00Z`);
  if (Number.isNaN(t) || Number.isNaN(v)) return 'none';
  const days = Math.floor((t - v) / 86_400_000);
  if (days < 90) return 'fresh';
  if (days < 365) return 'stale';
  return 'old';
}

export function KnowledgeView(props: {
  root: KnowledgeNode;
  onOpen: (path: string, title?: string) => void;
}) {
  const todayISO = new Date().toISOString().slice(0, 10);
  const sections = createMemo<KnowledgeSection[]>(() => buildSections(props.root));

  return (
    <div class="knowledge-pane">
      <DirectoryView sections={sections()} todayISO={todayISO} onOpen={props.onOpen} />
    </div>
  );
}

function DirectoryView(props: {
  sections: KnowledgeSection[];
  todayISO: string;
  onOpen: (path: string, title?: string) => void;
}) {
  return (
    <For each={props.sections}>
      {(section) => (
        <section class="knowledge-group" data-bucket={section.bucket}>
          <h2 class="knowledge-section-header">
            <span class="name">{section.label}</span>
            <Show when={section.files.length > 0}>
              <span class="count">{section.files.length}</span>
            </Show>
            <Show when={section.index}>
              {(idx) => (
                <button
                  type="button"
                  class="knowledge-section-index"
                  onClick={() => props.onOpen(idx().path, idx().title)}
                  title={`Open ${section.label.toLowerCase()} index`}
                >
                  INDEX
                </button>
              )}
            </Show>
            <span class="rule" />
          </h2>
          <div class="knowledge-grid">
            <For each={section.files}>
              {(file) => (
                <KnowledgeCard
                  file={file}
                  todayISO={props.todayISO}
                  onOpen={() => props.onOpen(file.node.path, file.node.title)}
                />
              )}
            </For>
          </div>
        </section>
      )}
    </For>
  );
}

function KnowledgeCard(props: { file: KnowledgeFile; todayISO: string; onOpen: () => void }) {
  const fresh = (): string => freshnessOf(props.file.node.verifiedAt, props.todayISO);
  return (
    <article
      class="knowledge-card"
      data-bucket={props.file.bucket}
      title={props.file.node.path}
      onClick={() => props.onOpen()}
    >
      <header class="knowledge-card-head">
        <span class="knowledge-card-glyph" aria-hidden="true">
          <BookIcon />
        </span>
        <h3 class="knowledge-card-title">{props.file.node.title}</h3>
        <Show when={props.file.node.verifiedAt}>
          <span
            class="knowledge-card-verified"
            data-fresh={fresh()}
            title={`Verified ${props.file.node.verifiedAt}`}
          >
            <span class="knowledge-card-verified-label">Verified</span>{' '}
            <span class="knowledge-card-verified-date">{props.file.node.verifiedAt}</span>
          </span>
        </Show>
      </header>
      <Show when={props.file.node.summary}>
        <p class="knowledge-card-summary">{props.file.node.summary}</p>
      </Show>
    </article>
  );
}
