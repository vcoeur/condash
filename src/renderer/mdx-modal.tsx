import { createResource, createSignal, For, Show } from 'solid-js';
import { Modal } from './modal';
import { Button } from './actions';
import { highlightCode } from './markdown';
import { routeMarkdownClick, scrollToAnchor } from './md-link-router';
import type { PlanDocument } from '@shared/plan-blocks/schemas';
import { BlockView } from './mdx-modal-parts/containers';
import './mdx-modal.css';
import './mdx-modal-parts/plan-blocks.css';

type MdxMode = 'rendered' | 'source';

/**
 * In-app viewer for plan/review MDX documents (`.mdx` in a project's notes).
 * Rendered mode parses the file with the shared plan-block parser — the same
 * schemas `condash mdx check` validates — and renders each typed block
 * natively; parse/validation issues surface in a banner and invalid blocks
 * render as labeled placeholders instead of blanking the document. Source
 * mode shows the highlighted MDX, and is the automatic fallback when the
 * document has a syntax error. The parser module is heavy (micromark + zod)
 * and loads lazily with the first opened document.
 */
export function MdxModal(props: {
  path: string;
  onClose: () => void;
  onOpenInEditor: (path: string) => void;
  onReveal: (path: string) => void;
  onWikilink: (slug: string) => void;
  onOpenMarkdown: (path: string) => void;
  onOpenPdf: (path: string) => void;
  onOpenMdx: (path: string) => void;
}) {
  const [mode, setMode] = createSignal<MdxMode>('rendered');
  const [issuesOpen, setIssuesOpen] = createSignal(false);
  let bodyRef: HTMLDivElement | undefined;

  const filename = (): string => props.path.split('/').pop() ?? props.path;
  const baseDir = (): string => props.path.replace(/\/[^/]*$/, '');

  const [source] = createResource(
    () => props.path,
    (path) => window.condash.readNote(path),
  );
  const [doc] = createResource(source, async (text): Promise<PlanDocument | null> => {
    if (text == null) return null;
    const { parsePlanMdx } = await import('@shared/plan-blocks/parse-mdx');
    return parsePlanMdx(text);
  });
  const title = (): string => {
    const fromDoc = doc()?.frontmatter.title;
    return typeof fromDoc === 'string' && fromDoc !== '' ? fromDoc : filename();
  };
  const kind = (): string => {
    const value = doc()?.frontmatter.kind;
    return value === 'review' ? 'review' : 'plan';
  };
  const errors = () => (doc()?.issues ?? []).filter((i) => i.severity === 'error');
  const warnings = () => (doc()?.issues ?? []).filter((i) => i.severity === 'warning');
  // A document-level syntax error yields zero blocks — reading the raw
  // source is then strictly more useful than an empty render.
  const brokenDocument = (): boolean =>
    doc() !== undefined && doc() !== null && doc()!.blocks.length === 0 && errors().length > 0;

  const [sourceHtml] = createResource(
    // Also loaded when a syntax error forces the source fallback below.
    () => (mode() === 'source' || brokenDocument() ? source() : null),
    (text) => (text == null ? '' : highlightCode(text, props.path)),
  );

  const handleBodyClick = (e: MouseEvent) => {
    routeMarkdownClick(
      e,
      { path: props.path },
      {
        onWikilink: (slug) => props.onWikilink(slug),
        onExternal: (url) => void window.condash.openExternal(url),
        onAnchor: (id) => {
          if (bodyRef) scrollToAnchor(bodyRef, id);
        },
        onMarkdown: (path) => props.onOpenMarkdown(path),
        onPdf: (path) => props.onOpenPdf(path),
        onMdx: (path) => props.onOpenMdx(path),
        onOtherFile: (path) => props.onOpenInEditor(path),
      },
    );
  };

  return (
    <Modal
      class="mdx-modal"
      ariaLabel={`${kind()}: ${title()}`}
      title={title()}
      path={props.path}
      onClose={props.onClose}
      headExtra={
        <>
          <span class="plan-kind-pill" data-kind={kind()}>
            {kind()}
          </span>
          <div class="modal-seg" role="tablist" aria-label="MDX view mode">
            <Button
              type="button"
              role="tab"
              variant="default"
              classList={{ active: mode() === 'rendered' }}
              aria-selected={mode() === 'rendered'}
              onClick={() => setMode('rendered')}
            >
              Rendered
            </Button>
            <Button
              type="button"
              role="tab"
              variant="default"
              classList={{ active: mode() === 'source' }}
              aria-selected={mode() === 'source'}
              onClick={() => setMode('source')}
            >
              Source
            </Button>
          </div>
          <Button
            variant="default"
            class="btn--modal-head"
            onClick={() => props.onReveal(props.path)}
            title="Reveal in file manager"
          >
            ⤷
          </Button>
          <Button
            variant="default"
            class="btn--modal-head"
            onClick={() => props.onOpenInEditor(props.path)}
            title="Open in editor"
          >
            ↗
          </Button>
        </>
      }
    >
      <div class="mdx-body" ref={bodyRef} onClick={handleBodyClick}>
        <Show when={doc()?.issues.length}>
          <div class="plan-issues" data-severity={errors().length > 0 ? 'error' : 'warning'}>
            <button
              type="button"
              class="plan-issues-head"
              onClick={() => setIssuesOpen(!issuesOpen())}
            >
              {errors().length > 0 ? `${errors().length} error(s)` : ''}
              {errors().length > 0 && warnings().length > 0 ? ' · ' : ''}
              {warnings().length > 0 ? `${warnings().length} warning(s)` : ''}
              <span class="plan-muted"> — condash mdx check</span>
            </button>
            <Show when={issuesOpen()}>
              <ul>
                <For each={doc()!.issues}>
                  {(issue) => (
                    <li class={`plan-issue-${issue.severity}`}>
                      <Show when={issue.line !== undefined}>
                        <span class="plan-issue-line">L{issue.line}</span>
                      </Show>
                      {issue.message}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </Show>
        <Show
          when={mode() === 'rendered' && !brokenDocument()}
          fallback={<div class="mdx-source md-rendered raw-code" innerHTML={sourceHtml() ?? ''} />}
        >
          <div class="plan-doc">
            <For each={doc()?.blocks ?? []}>
              {(block) => <BlockView block={block} baseDir={baseDir()} />}
            </For>
          </div>
        </Show>
      </div>
    </Modal>
  );
}
