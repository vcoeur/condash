import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import { Modal } from './modal';
import { Button } from './actions';
import { IconSave } from './note-modal-parts/icons';
import { highlightCode } from './markdown';
import { routeMarkdownClick, scrollToAnchor } from './md-link-router';
import type { PlanDocument, QuestionFormData } from '@shared/plan-blocks/schemas';
import { BlockView, type AnswerBinding } from './mdx-modal-parts/containers';
import {
  answersEqual,
  applyAllAnswers,
  collectQuestionForms,
  seedAnswers,
  type PendingFormAnswers,
} from './mdx-modal-parts/data';
import './mdx-modal.css';
import './mdx-modal-parts/plan-blocks.css';

type MdxMode = 'rendered' | 'source';

/** Answers the reader has typed but not yet written, keyed by block id. */
type AnswerDrafts = Record<string, Record<string, string | string[]>>;

/**
 * In-app viewer for visual-note MDX documents (`.mdx` in a project's notes).
 * Rendered mode parses the file with the shared plan-block parser — the same
 * schemas `condash mdx check` validates — and renders each typed block
 * natively; parse/validation issues surface in a banner and invalid blocks
 * render as labeled placeholders instead of blanking the document. Source
 * mode shows the highlighted MDX, and is the automatic fallback when the
 * document has a syntax error. The parser module is heavy (micromark + zod)
 * and loads lazily with the first opened document.
 *
 * Question-form answers are owned here, not by the individual form blocks: the
 * document saves as a whole through the head Save button or Ctrl+S, so
 * answering questions in several forms and saving once keeps every answer.
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

  const [source, { mutate: mutateSource }] = createResource(
    () => props.path,
    (path) => window.condash.readNote(path),
  );
  const [doc] = createResource(source, async (text): Promise<PlanDocument | null> => {
    if (text == null) return null;
    const { parsePlanMdx } = await import('@shared/plan-blocks/parse-mdx');
    return parsePlanMdx(text);
  });

  const [drafts, setDrafts] = createSignal<AnswerDrafts>({});
  const [saving, setSaving] = createSignal(false);
  const [savedAt, setSavedAt] = createSignal<number | null>(null);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  // Opening a different note in the same modal must not carry the previous
  // document's pending answers over — their block ids would collide.
  createEffect((previousPath: string | undefined) => {
    if (previousPath !== undefined && previousPath !== props.path) {
      setDrafts({});
      setSavedAt(null);
      setSaveError(null);
    }
    return props.path;
  });

  const questionForms = createMemo(() => collectQuestionForms(doc()?.blocks));
  /** Forms whose pending answers differ from what the note already holds. A
   *  draft is kept after its save lands (the re-parse makes it match the seed),
   *  so dirtiness is a comparison, never a flag the save has to clear. */
  const pendingSaves = createMemo((): PendingFormAnswers[] => {
    const draftsNow = drafts();
    const out: PendingFormAnswers[] = [];
    for (const { block, ordinal } of questionForms()) {
      const draft = draftsNow[block.id];
      if (draft === undefined) continue;
      const data = block.data as unknown as QuestionFormData;
      if (answersEqual(draft, seedAnswers(data.questions))) continue;
      out.push({
        blockId: block.id,
        questions: data.questions,
        submitLabel: data.submitLabel,
        answers: draft,
        // Locate each form by its document-order position, so notes with
        // several id-less <QuestionForm> blocks each save into the right one.
        ordinal,
      });
    }
    return out;
  });
  const dirty = (): boolean => pendingSaves().length > 0;

  const answerBinding: AnswerBinding = {
    pending: (block) => drafts()[block.id],
    onChange: (block, answers) => {
      setDrafts({ ...drafts(), [block.id]: answers });
      setSavedAt(null);
      setSaveError(null);
    },
  };

  // Snap the saved-✓ back after a moment, the same transient the note modal
  // shows. Cleared on unmount so a modal closed mid-grace never fires into a
  // disposed scope.
  let savedAtTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSavedAtClear = (): void => {
    if (savedAtTimer !== null) clearTimeout(savedAtTimer);
    savedAtTimer = setTimeout(() => {
      setSavedAt(null);
      savedAtTimer = null;
    }, 1500);
  };
  onCleanup(() => {
    if (savedAtTimer !== null) clearTimeout(savedAtTimer);
  });

  /** Write every pending form's answers into the note in one pass, then update
   *  the in-memory source so the rendered document reflects what was saved.
   *  Resolves false when nothing was written, so the close gate can hold. */
  const saveAll = async (): Promise<boolean> => {
    const current = source();
    const pending = pendingSaves();
    if (current == null || pending.length === 0) return true;
    const applied = applyAllAnswers(current, pending);
    if (!applied.ok) {
      setSaveError(`Could not locate the question-form "${applied.blockId}" in the note.`);
      return false;
    }
    if (applied.source === current) return true;
    setSaving(true);
    setSaveError(null);
    try {
      await window.condash.writeNote(props.path, current, applied.source);
    } catch (err) {
      console.error('failed to save question-form answers', err);
      setSaveError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
    mutateSource(applied.source);
    setSavedAt(Date.now());
    scheduleSavedAtClear();
    return true;
  };

  /** Pending close request, held while the unsaved-answers gate is up. */
  const [pendingClose, setPendingClose] = createSignal(false);
  const requestClose = (): void => {
    if (!dirty()) {
      props.onClose();
      return;
    }
    setPendingClose(true);
  };
  const saveAndClose = async (): Promise<void> => {
    if (await saveAll()) {
      setPendingClose(false);
      props.onClose();
    } else {
      // The write failed — keep the document open with its answers intact so
      // the error banner is readable and the reader can retry.
      setPendingClose(false);
    }
  };
  const discardAndClose = (): void => {
    setDrafts({});
    setPendingClose(false);
    props.onClose();
  };

  const handleKeydown = (event: KeyboardEvent): void => {
    if (pendingClose() && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setPendingClose(false);
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
    if (event.shiftKey || event.altKey) return;
    if (!dirty() || saving()) return;
    event.preventDefault();
    event.stopPropagation();
    void saveAll();
  };
  onMount(() => document.addEventListener('keydown', handleKeydown, true));
  onCleanup(() => document.removeEventListener('keydown', handleKeydown, true));

  const title = (): string => {
    const fromDoc = doc()?.frontmatter.title;
    return typeof fromDoc === 'string' && fromDoc !== '' ? fromDoc : filename();
  };
  const kind = (): string => {
    const value = doc()?.frontmatter.kind;
    // Show the literal posture (design/plan/review/note, or an off-list value);
    // `note` is the neutral default. The pill CSS colors the known postures and
    // falls back to a muted style for anything else.
    return typeof value === 'string' && value !== '' ? value : 'note';
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
      onClose={requestClose}
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
          <Show when={dirty()}>
            <span class="modal-dirty" title="Unsaved answers" aria-label="Unsaved answers">
              ●
            </span>
          </Show>
          <Show when={savedAt() !== null}>
            <span class="modal-saved" title="Saved" aria-label="Saved">
              ✓
            </span>
          </Show>
          {/* One save for the whole document: every form's answers go in a
              single write. Shown only for notes that actually have a form. */}
          <Show when={questionForms().length > 0}>
            <Button
              variant="default"
              class="btn--modal-head"
              onClick={() => void saveAll()}
              disabled={!dirty() || saving()}
              title="Save answers (Ctrl+S)"
              aria-label="Save answers"
            >
              <IconSave />
            </Button>
          </Show>
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
      <Show when={pendingClose()}>
        <div class="modal-confirm" role="alertdialog" aria-label="Unsaved answers">
          <span class="modal-confirm-message">
            {pendingSaves().length === 1
              ? '1 form has answers you have not saved to the note.'
              : `${pendingSaves().length} forms have answers you have not saved to the note.`}
          </span>
          <Button variant="default" onClick={() => void saveAndClose()} title="Save and close">
            Save
          </Button>
          <Button variant="default" onClick={discardAndClose} title="Discard the answers and close">
            Discard
          </Button>
          <Button
            variant="default"
            onClick={() => setPendingClose(false)}
            title="Stay in the document"
          >
            Cancel
          </Button>
        </div>
      </Show>
      <Show when={saveError()}>
        <div class="modal-error" role="alert">
          Could not save the answers — {saveError()}
        </div>
      </Show>
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
              {(block) => <BlockView block={block} baseDir={baseDir()} answers={answerBinding} />}
            </For>
          </div>
        </Show>
      </div>
    </Modal>
  );
}
