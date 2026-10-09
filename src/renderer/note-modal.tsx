import {
  createEffect,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import { highlightCode, renderMarkdown, runMermaidIn } from './markdown';
import { routeMarkdownClick, scrollToAnchor } from './md-link-router';
import type { MountedEditor } from './editor';
import type { Deliverable, TreeEvent } from '@shared/types';
import { toPosix } from '@shared/path';
import type { ModalState } from './modal-types';
import { ConfirmModal } from './confirm-modal';
import { Button } from './actions';
import { IconClose, IconExternal } from './icons';
import { IconEdit, IconPdf, IconSave, IconView } from './note-modal-parts/icons';
import {
  clearFindHighlights,
  focusFindMatch,
  highlightFindMatches,
  FIND_HIGHLIGHT_CLASS,
  FIND_CURRENT_CLASS,
} from './note-modal-parts/find';
import { ConfigSummaryPanel } from './note-modal-parts/config-summary';
import { buildNotePdfHtml } from './note-modal-parts/export-pdf';
import './note-modal.css';
import './code-theme.css';

let editorModulePromise: Promise<typeof import('./editor')> | null = null;
function loadEditor(): Promise<typeof import('./editor')> {
  if (!editorModulePromise) editorModulePromise = import('./editor');
  return editorModulePromise;
}

type Mode = 'view' | 'edit';

function inferLanguage(path: string): 'markdown' | 'json' {
  return path.toLowerCase().endsWith('.json') ? 'json' : 'markdown';
}

function isMarkdown(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

function isConceptionConfig(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('/condash.json') || lower.endsWith('/configuration.json');
}

export function NoteModal(props: {
  conceptionPath?: string | null;
  treeEvents?: TreeEvent[];
  state: ModalState;
  onClose: () => void;
  onOpenInEditor: (path: string) => void;
  onOpenDeliverable: (deliverable: Deliverable) => void;
  onWikilink: (slug: string) => void;
  /** Open a markdown file referenced by a relative `[text](path.md)` link in
   * the rendered body — replaces the current note in the same modal. */
  onOpenMarkdown: (path: string) => void;
  /** Open a PDF referenced by a relative link in the rendered body. */
  onOpenPdf: (path: string) => void;
  onOpenMdx: (path: string) => void;
  /** Open a bundled help doc — used by the condash.json reference panel
   * to expand into the full doc. */
  onOpenHelp?: (doc: 'configuration' | 'welcome') => void;
  /** Pop one entry off the in-modal navigation history. When provided, the
   * back-button click routes here instead of straight to onClose, so the
   * user steps back through the chain instead of dismissing the whole stack. */
  onBack?: () => void;
  /** Notify the host whenever the editor's dirty flag flips. The host needs
   * this to gate global "are you sure you want to quit?" prompts on a real
   * unsaved-changes signal instead of guessing. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Resolved dark/light flag for the active app theme. Drives the
   *  CodeMirror theme compartment so the cursor/selection/gutter colours
   *  flip live when the user toggles theme without remounting the editor. */
  dark?: boolean;
}) {
  const [mode, setMode] = createSignal<Mode>(
    props.state?.readOnly ? 'view' : (props.state?.initialMode ?? 'view'),
  );

  // Key the mode-reset on the specific state fields that drive it. Without
  // `on`, this effect tracks every property read on `props.state` and
  // re-fires whenever the host hands us a reference-equal-but-new state
  // object (which it does freely on unrelated re-renders) — silently
  // clobbering the user's current view/edit choice.
  createEffect(
    on(
      [
        () => props.state?.readOnly ?? false,
        () => props.state?.initialMode,
        () => props.state?.path,
      ],
      ([readOnly, initialMode, path]) => {
        if (readOnly) {
          setMode('view');
          return;
        }
        if (initialMode) setMode(initialMode);
        else if (path && !isMarkdown(path)) setMode('edit');
      },
    ),
  );
  const [draft, setDraft] = createSignal('');
  const [dirty, setDirty] = createSignal(false);
  const [reloading, setReloading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [changedOnDisk, setChangedOnDisk] = createSignal(false);
  let disposed = false;
  let owner = 0;
  let requestGeneration = 0;
  let draftRevision = 0;
  let diskRevision = 0;
  let reseeding = false;
  let restorePreview: { owner: number; request: number; draft: number; scroll: number } | null =
    null;
  const [error, setError] = createSignal<string | null>(null);
  const [savedAt, setSavedAt] = createSignal<number | null>(null);
  const [findOpen, setFindOpen] = createSignal(false);
  const [findQuery, setFindQuery] = createSignal('');
  const [findMatch, setFindMatch] = createSignal<{ index: number; total: number } | null>(null);
  // Toggling out of edit mode tears down the CodeMirror instance, so any
  // unsaved draft is gone the moment we flip to view. Hold the request in this
  // signal until the user picks Save or Discard.
  const [pendingViewSwitch, setPendingViewSwitch] = createSignal(false);

  /** Pending dirty-discard prompt — set when the user attempts a navigation
   * (Esc-close, backdrop-click, back-button) on a dirty note. The
   * stacked ConfirmModal renders while this is non-null; on confirm, runs
   * the captured action; on cancel, clears. Replaces the three
   * window.confirm() sites that pass-9 deferred. */
  const [pendingDirtyAction, setPendingDirtyAction] = createSignal<{
    verb: 'close' | 'leave' | 'reload';
    run: () => void;
  } | null>(null);

  const guardDirty = (verb: 'close' | 'leave' | 'reload', run: () => void): void => {
    if (!dirty()) {
      run();
      return;
    }
    setPendingDirtyAction({ verb, run });
  };
  let savedAtTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSavedAtClear = (): void => {
    if (savedAtTimer !== null) clearTimeout(savedAtTimer);
    savedAtTimer = setTimeout(() => {
      setSavedAt((t) => (t && Date.now() - t > 1200 ? null : t));
      savedAtTimer = null;
    }, 1500);
  };
  onCleanup(() => {
    if (savedAtTimer !== null) clearTimeout(savedAtTimer);
  });

  // PDF export: busy flag (debounces the button) + a transient exported-✓
  // pill mirroring the saved-✓ one.
  const [exporting, setExporting] = createSignal(false);
  const [exportedAt, setExportedAt] = createSignal<number | null>(null);
  let exportedAtTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleExportedAtClear = (): void => {
    if (exportedAtTimer !== null) clearTimeout(exportedAtTimer);
    exportedAtTimer = setTimeout(() => {
      setExportedAt(null);
      exportedAtTimer = null;
    }, 1500);
  };
  onCleanup(() => {
    if (exportedAtTimer !== null) clearTimeout(exportedAtTimer);
  });

  // Mirror the dirty flag out to the host. createEffect, not a wrapped
  // setDirty: covers every flip including the resets fired below on path
  // change, so the host's "unsaved" view never lags the modal's.
  createEffect(() => {
    props.onDirtyChange?.(dirty());
  });
  // On unmount, force the host's mirror back to false. Without this, closing
  // a dirty modal via the × button or backdrop confirm leaves the host
  // believing an unsaved note still exists, producing a phantom
  // "Unsaved note edits will be lost" prompt at next Quit.
  onCleanup(() => {
    props.onDirtyChange?.(false);
  });

  // Switching to a different file (back/forward, in-modal navigation) must
  // reset the per-file local state — otherwise an unsaved-edit pill from the
  // previous file leaks onto the next, and the dirty diff compares against
  // the wrong base content. The path-keyed createResource above already
  // re-fetches `content`; we reset everything else explicitly here.
  let lastPath: string | null = null;
  let bodyRef: HTMLDivElement | undefined;
  let editorParent: HTMLDivElement | undefined;
  let findInput: HTMLInputElement | undefined;
  let editor: MountedEditor | null = null;
  const resetDocument = (): void => {
    const key = `${props.conceptionPath ?? ''}:${props.state?.readWith ?? 'note'}:${props.state?.path ?? ''}`;
    if (key === lastPath) return;
    lastPath = key;
    owner++;
    requestGeneration++;
    draftRevision++;
    diskRevision = 0;
    restorePreview = null;
    setChangedOnDisk(false);
    setReloading(false);
    setSaving(false);
    setPendingDirtyAction(null);
    setDraft('');
    setDirty(false);
    setError(null);
    setSavedAt(null);
    setExportedAt(null);
    setFindOpen(false);
    setFindQuery('');
    setFindMatch(null);
    setPendingViewSwitch(false);
    // Tear down any live CodeMirror instance so the mount effect re-seeds it
    // from the new file's content. Without this, navigating to another file
    // while staying in edit mode keeps the previous editor (and its text)
    // alive under the new path — one keystroke + Save then writes the old
    // file's content into the new one. Any unsaved edits were already
    // resolved by the dirty guard on the navigation that changed the path.
    if (editor) {
      editor.destroy();
      editor = null;
    }
  };

  const readContent = (path: string, kind?: string) =>
    kind === 'skill' ? window.condash.readSkillFile(path) : window.condash.readNote(path);
  const [content, { mutate: mutateContent }] = createResource(
    () => {
      resetDocument();
      return { path: props.state?.path, kind: props.state?.readWith, root: props.conceptionPath };
    },
    async ({ path, kind }) => {
      if (!path) return null;
      const readOwner = owner;
      const text = await readContent(path, kind);
      return !disposed && readOwner === owner ? text : null;
    },
  );

  // markdown-it + highlight.js are lazy-loaded (out of the boot chunk), so the
  // rendered HTML is a resource keyed on the loaded text rather than a memo.
  const [html] = createResource(content, async (text) => {
    if (text == null) return '';
    const path = props.state?.path ?? null;
    const baseDir = path ? path.replace(/\/[^/]*$/, '') : undefined;
    return renderMarkdown(text, { baseDir });
  });

  // Read view for a non-markdown file: syntax-highlight the source by extension.
  const [codeHtml] = createResource(content, async (text) =>
    text == null ? '' : highlightCode(text, props.state?.path ?? ''),
  );

  createEffect(
    on(
      () => props.treeEvents,
      (events) => {
        const path = props.state?.path;
        if (!path) return;
        const matching = events?.some((event) => {
          if (event.kind === 'project')
            return toPosix(event.changedPath ?? event.path) === toPosix(path);
          if (event.kind === 'knowledge' || event.kind === 'resources' || event.kind === 'skills')
            return toPosix(event.path) === toPosix(path);
          return false;
        });
        if (matching) {
          diskRevision++;
          setChangedOnDisk(true);
        }
      },
      { defer: true },
    ),
  );

  // Mount / unmount the CodeMirror editor when entering / leaving edit mode.
  // CodeMirror lives in a dynamically-imported chunk so the renderer's initial
  // load only pays for it once the user opens an editor.
  const [mounting, setMounting] = createSignal(false);
  createEffect(() => {
    const m = mode();
    const text = content();
    // `content()` keeps the previous file's value while a new path's read is
    // in flight, so gate on `content.loading` — otherwise a path change in
    // edit mode would seed the fresh editor with the *old* file's text.
    if (
      m === 'edit' &&
      editorParent &&
      text != null &&
      !content.loading &&
      !editor &&
      !mounting()
    ) {
      setMounting(true);
      const parent = editorParent;
      const initial = text;
      const pathAtMount = props.state?.path;
      const mountOwner = owner;
      const mountRequest = requestGeneration;
      const mountDraft = draftRevision;
      const language = props.state ? inferLanguage(props.state.path) : 'markdown';
      void loadEditor()
        .then(({ mountEditor }) => {
          // Bail if the user left edit mode or navigated to another file
          // while the chunk was loading.
          if (
            disposed ||
            mode() !== 'edit' ||
            props.state?.path !== pathAtMount ||
            owner !== mountOwner ||
            requestGeneration !== mountRequest ||
            draftRevision !== mountDraft
          ) {
            if (!disposed) setMounting(false);
            return;
          }
          editor = mountEditor({
            parent,
            initial,
            language,
            dark: props.dark,
            onSave: () => void save(),
            onChange: (next) => {
              if (reseeding || disposed || mountOwner !== owner) return;
              draftRevision++;
              setDraft(next);
              setDirty(next !== content());
            },
          });
          setDraft(initial);
          setDirty(false);
          setMounting(false);
        })
        .catch((err) => {
          if (!disposed && owner === mountOwner) {
            setError(`Failed to load editor: ${(err as Error).message}`);
            // Do not retry a failed import until the next explicit mode/path change.
          }
        });
    }
    if (m !== 'edit' && editor) {
      editor.destroy();
      editor = null;
    }
  });

  // Live theme flip without remount: reconfigure the per-mount theme
  // compartment when the host's `dark` prop changes.
  createEffect(() => {
    const dark = props.dark === true;
    if (editor) editor.setDark(dark);
  });

  // Re-render Mermaid blocks any time the rendered HTML changes (view mode only).
  createEffect(() => {
    void html();
    if (mode() === 'view' && bodyRef) {
      void runMermaidIn(bodyRef);
    }
  });

  const handleBodyClick = (e: MouseEvent) => {
    const currentPath = props.state?.path ?? null;
    routeMarkdownClick(e, currentPath ? { path: currentPath } : null, {
      onWikilink: (slug) => props.onWikilink(slug),
      onExternal: (url) => void window.condash.openExternal(url),
      onAnchor: (id) => {
        if (bodyRef) scrollToAnchor(bodyRef, id);
      },
      onMarkdown: (path) => props.onOpenMarkdown(path),
      onPdf: (path) => props.onOpenPdf(path),
      onMdx: (path) => props.onOpenMdx(path),
      onOtherFile: (path) => props.onOpenInEditor(path),
    });
  };

  // Re-run find whenever the view-mode HTML or the query changes. A
  // 100 ms debounce keeps `runFind` off the keystroke critical path: every
  // letter typed in the find bar would otherwise walk the DOM, splice text
  // nodes, and re-highlight in line with the typing.
  let findTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFindQuery = '';
  createEffect(() => {
    const query = findQuery();
    const navigate = query !== lastFindQuery;
    lastFindQuery = query;
    if (navigate) restorePreview = null;
    void findOpen();
    void html();
    void codeHtml();
    void html.loading;
    void codeHtml.loading;
    if (mode() !== 'view') return;
    if (findTimer !== null) clearTimeout(findTimer);
    findTimer = setTimeout(() => {
      findTimer = null;
      runFind(navigate);
      const restore = restorePreview;
      if (
        restore &&
        !disposed &&
        owner === restore.owner &&
        requestGeneration === restore.request &&
        draftRevision === restore.draft &&
        !html.loading &&
        !codeHtml.loading &&
        bodyRef
      ) {
        bodyRef.scrollTop = Math.min(
          restore.scroll,
          Math.max(0, bodyRef.scrollHeight - bodyRef.clientHeight),
        );
        restorePreview = null;
      }
    }, 100);
  });
  onCleanup(() => {
    if (findTimer !== null) clearTimeout(findTimer);
  });

  const runFind = (navigate = true) => {
    if (!bodyRef) return;
    clearFindHighlights(bodyRef);
    const query = findQuery();
    if (!findOpen() || query.length === 0) {
      setFindMatch(null);
      return;
    }
    const total = highlightFindMatches(bodyRef, query);
    const index = navigate ? 0 : Math.min(findMatch()?.index ?? 0, Math.max(0, total - 1));
    setFindMatch({ index, total });
    if (total > 0) {
      if (navigate) focusFindMatch(bodyRef, index);
      else
        bodyRef
          .querySelectorAll(`.${FIND_HIGHLIGHT_CLASS}`)
          .forEach((element, ordinal) =>
            element.classList.toggle(FIND_CURRENT_CLASS, ordinal === index),
          );
    }
  };

  const stepFind = (delta: number) => {
    if (!bodyRef) return;
    const m = findMatch();
    if (!m || m.total === 0) return;
    const next = (m.index + delta + m.total) % m.total;
    setFindMatch({ ...m, index: next });
    focusFindMatch(bodyRef, next);
  };

  const save = async (): Promise<boolean> => {
    if (
      !props.state ||
      disposed ||
      reloading() ||
      saving() ||
      content.loading ||
      content() == null ||
      (mode() === 'edit' && !editor)
    )
      return false;
    const saveOwner = owner;
    const saveRequest = ++requestGeneration;
    const saveDraft = draftRevision;
    const saveDisk = diskRevision;
    const path = props.state.path;
    const expected = content() ?? '';
    const next = draft();
    setError(null);

    if (props.state.path.toLowerCase().endsWith('.json')) {
      try {
        JSON.parse(next);
      } catch (err) {
        setError(`Invalid JSON: ${(err as Error).message}`);
        return false;
      }
    }

    try {
      setSaving(true);
      await window.condash.writeNote(path, expected, next);
      if (disposed || saveOwner !== owner || saveRequest !== requestGeneration) return false;
      mutateContent(next);
      const stillSubmitted = saveDraft === draftRevision && draft() === next;
      setDirty(!stillSubmitted);
      if (saveDisk === diskRevision) setChangedOnDisk(false);
      setSavedAt(Date.now());
      // Snap the saved-at flag back after a moment so the indicator is
      // transient. Track the timer ID and clear in onCleanup so a modal
      // closed mid-grace doesn't fire setSavedAt on a disposed scope.
      scheduleSavedAtClear();
      return stillSubmitted;
    } catch (err) {
      if (!disposed && owner === saveOwner && requestGeneration === saveRequest)
        setError((err as Error).message);
      return false;
    } finally {
      if (!disposed && owner === saveOwner && requestGeneration === saveRequest) setSaving(false);
    }
  };

  // Export the current note as a PDF: build the self-contained document
  // (fresh render + inline print CSS) and hand it to the main process, which
  // owns the save dialog and the hidden print window. A `null` result means
  // the user cancelled the dialog — only a real save shows the ✓ pill.
  const exportPdf = async (): Promise<void> => {
    const state = props.state;
    const text = content();
    if (!state || text == null || exporting()) return;
    setError(null);
    setExporting(true);
    try {
      const baseDir = state.path.replace(/\/[^/]*$/, '');
      const title = state.title ?? state.path.split('/').pop() ?? 'note';
      const doc = await buildNotePdfHtml(text, { baseDir, title });
      const saved = await window.condash.exportNotePdf(state.path, doc);
      if (saved) {
        setExportedAt(Date.now());
        scheduleExportedAtClear();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExporting(false);
    }
  };

  // Request a switch to view mode. If the editor is dirty, defer until the
  // user resolves the Save / Discard / Cancel dialog so edits aren't silently
  // lost when CodeMirror unmounts.
  const requestViewMode = () => {
    if (saving() || reloading()) return;
    if (mode() !== 'edit') {
      setMode('edit');
      return;
    }
    if (dirty()) {
      setPendingViewSwitch(true);
      return;
    }
    setMode('view');
    setFindOpen(false);
  };

  const confirmSaveAndSwitch = async () => {
    const ok = await save();
    if (!ok) return;
    setPendingViewSwitch(false);
    setMode('view');
    setFindOpen(false);
  };

  const confirmDiscardAndSwitch = () => {
    setDraft('');
    setDirty(false);
    setPendingViewSwitch(false);
    setMode('view');
    setFindOpen(false);
  };

  const cancelViewSwitch = () => {
    setPendingViewSwitch(false);
  };

  const reload = async () => {
    if (!props.state || disposed || reloading() || saving()) return;
    const reloadOwner = owner;
    const request = ++requestGeneration;
    const revision = draftRevision;
    const noticeRevision = diskRevision;
    const { path, readWith } = props.state;
    setError(null);
    setReloading(true);
    try {
      const text = await readContent(path, readWith);
      if (disposed || owner !== reloadOwner || requestGeneration !== request) return;
      if (draftRevision !== revision) {
        setChangedOnDisk(true);
        return;
      }
      const scroll = bodyRef?.scrollTop ?? 0;
      const view = editor?.view;
      const editorScroll = view?.scrollDOM.scrollTop ?? 0;
      const selection = view?.state.selection.main;
      reseeding = true;
      mutateContent(text);
      editor?.setValue(text);
      setDraft(text);
      draftRevision++;
      setDirty(false);
      reseeding = false;
      if (diskRevision === noticeRevision) setChangedOnDisk(false);
      if (view && selection) {
        view.dispatch({
          selection: {
            anchor: Math.min(selection.anchor, text.length),
            head: Math.min(selection.head, text.length),
          },
        });
        view.requestMeasure({
          read: () => editorScroll,
          write: () => {
            if (
              disposed ||
              owner !== reloadOwner ||
              requestGeneration !== request ||
              draftRevision !== revision + 1
            )
              return;
            view.scrollDOM.scrollTop = editorScroll;
            if (mode() === 'edit' && bodyRef) bodyRef.scrollTop = scroll;
          },
        });
      }
      restorePreview = { owner: reloadOwner, request, draft: draftRevision, scroll };
      if (bodyRef) bodyRef.scrollTop = scroll;
    } catch (error) {
      if (!disposed && owner === reloadOwner && requestGeneration === request)
        setError((error as Error).message);
    } finally {
      reseeding = false;
      if (!disposed && owner === reloadOwner && requestGeneration === request) setReloading(false);
    }
  };
  const requestReload = (): void => {
    if (reloading() || saving() || pendingDirtyAction()) return;
    const reloadOwner = owner;
    guardDirty('reload', () => {
      if (!disposed && owner === reloadOwner) void reload();
    });
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (!props.state) return;
    if (pendingDirtyAction()) return;

    if (e.key === 'Escape') {
      if (pendingViewSwitch()) {
        e.preventDefault();
        e.stopPropagation();
        cancelViewSwitch();
        return;
      }
      if (findOpen()) {
        e.preventDefault();
        e.stopPropagation();
        setFindOpen(false);
        setFindQuery('');
        // Restore focus to the note body so the user lands back where
        // they were searching, not stranded on the now-hidden find input.
        queueMicrotask(() => bodyRef?.focus());
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      guardDirty('close', () => props.onClose());
      return;
    }

    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      requestViewMode();
      return;
    }

    if (mod && e.key.toLowerCase() === 'f' && mode() === 'view') {
      e.preventDefault();
      setFindOpen(true);
      queueMicrotask(() => findInput?.focus());
      return;
    }

    if (mod && e.key.toLowerCase() === 's' && mode() === 'edit') {
      e.preventDefault();
      void save();
      return;
    }

    if (findOpen() && (e.key === 'Enter' || e.key === 'F3')) {
      e.preventDefault();
      stepFind(e.shiftKey ? -1 : 1);
    }
  };

  onMount(() => {
    document.addEventListener('keydown', handleKeydown, true);
    // Focus the body on open so Tab order starts inside the modal — without
    // this Tab walks back into whatever button triggered the modal.
    queueMicrotask(() => bodyRef?.focus());
  });

  onCleanup(() => {
    disposed = true;
    owner++;
    requestGeneration++;
    document.removeEventListener('keydown', handleKeydown, true);
    if (editor) editor.destroy();
  });

  const handleBackdropClose = () => {
    guardDirty('close', () => props.onClose());
  };

  const handleBackClick = () => {
    guardDirty('leave', () => {
      if (props.onBack) props.onBack();
      else props.onClose();
    });
  };

  return (
    <div
      class="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) handleBackdropClose();
      }}
    >
      <div
        class="modal note-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="modal-head">
          <Show when={props.state?.backLabel}>
            <button
              class="modal-back-button"
              onClick={handleBackClick}
              title="Back"
              aria-label={`Back to ${props.state?.backLabel}`}
            >
              <span class="modal-back-arrow" aria-hidden="true">
                ←
              </span>
              <span class="modal-back-label">Back to {props.state?.backLabel}</span>
            </button>
          </Show>
          <span class="modal-title">{props.state?.title ?? props.state?.path ?? ''}</span>
          <Show when={props.state?.readOnly}>
            <span class="modal-readonly-tag" title="Read-only — open in IDE to edit">
              read-only
            </span>
          </Show>
          <span class="modal-head-spacer" />
          <Show when={changedOnDisk()}>
            <span class="modal-banner--warn" role="status">
              Changed on disk
            </span>
          </Show>
          <Button
            variant="default"
            class="btn--modal-head"
            onClick={requestReload}
            disabled={reloading() || saving() || content.loading}
            aria-label="Reload"
            title="Reload from disk"
          >
            {reloading() ? 'Reloading…' : 'Reload'}
          </Button>
          <Show when={dirty()}>
            <span class="modal-dirty" title="Unsaved changes" aria-label="Unsaved changes">
              ●
            </span>
          </Show>
          <Show when={savedAt() !== null}>
            <span class="modal-saved" title="Saved" aria-label="Saved">
              ✓
            </span>
          </Show>
          <Show when={exportedAt() !== null}>
            <span class="modal-saved" title="PDF exported" aria-label="PDF exported">
              ✓
            </span>
          </Show>
          <Show when={!props.state?.readOnly}>
            <Button
              variant="default"
              class="btn--modal-head"
              classList={{ active: mode() === 'edit' }}
              onClick={requestViewMode}
              title={mode() === 'edit' ? 'View (Ctrl+E)' : 'Edit (Ctrl+E)'}
              aria-label={mode() === 'edit' ? 'Switch to view mode' : 'Switch to edit mode'}
            >
              {mode() === 'edit' ? <IconView /> : <IconEdit />}
            </Button>
          </Show>
          <Show when={mode() === 'edit' && !props.state?.readOnly}>
            <Button
              variant="default"
              class="btn--modal-head"
              onClick={() => void save()}
              disabled={!dirty() || reloading() || saving()}
              title="Save (Ctrl+S)"
              aria-label="Save"
            >
              <IconSave />
            </Button>
          </Show>
          <Show when={mode() === 'view' && props.state && isMarkdown(props.state.path)}>
            <Button
              variant="default"
              class="btn--modal-head"
              onClick={() => void exportPdf()}
              disabled={exporting()}
              title="Export as PDF"
              aria-label="Export as PDF"
            >
              <IconPdf />
            </Button>
          </Show>
          <Button
            variant="default"
            tone="open"
            class="btn--modal-head"
            onClick={() => props.state && props.onOpenInEditor(props.state.path)}
            title="Open in $EDITOR"
            aria-label="Open in external editor"
          >
            <IconExternal />
          </Button>
          <Button
            variant="default"
            class="btn--modal-head"
            onClick={handleBackdropClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            <IconClose />
          </Button>
        </header>

        <Show when={findOpen() && mode() === 'view'}>
          <div class="find-bar">
            <input
              ref={(el) => (findInput = el)}
              class="find-input"
              type="text"
              placeholder="Find in note…"
              value={findQuery()}
              onInput={(e) => setFindQuery(e.currentTarget.value)}
            />
            <Show when={findMatch()}>
              <span class="find-count">
                {findMatch()!.total === 0
                  ? '0 / 0'
                  : `${findMatch()!.index + 1} / ${findMatch()!.total}`}
              </span>
            </Show>
            <Button
              variant="default"
              class="btn--modal-head"
              onClick={() => stepFind(-1)}
              title="Previous (Shift+Enter)"
            >
              ↑
            </Button>
            <Button
              variant="default"
              class="btn--modal-head"
              onClick={() => stepFind(1)}
              title="Next (Enter)"
            >
              ↓
            </Button>
            <Button
              variant="default"
              class="btn--modal-head"
              onClick={() => {
                setFindOpen(false);
                setFindQuery('');
              }}
              title="Close (Esc)"
            >
              ×
            </Button>
          </div>
        </Show>

        <Show when={error()}>
          <div class="modal-error">{error()}</div>
        </Show>

        <Show when={props.state?.bannerKind === 'shipped'}>
          <div class="modal-banner modal-banner--info" role="status">
            Shipped by condash. The on-disk content matches the version installed by{' '}
            <code>condash skills install</code>.
          </div>
        </Show>
        <Show when={props.state?.bannerKind === 'shipped-diverged'}>
          <div class="modal-banner modal-banner--warn" role="status">
            Shipped by condash, but locally edited. Running <code>condash skills install</code> will
            flag this divergence.
          </div>
        </Show>

        <Show when={pendingViewSwitch()}>
          <div class="modal-confirm" role="alertdialog" aria-label="Unsaved changes">
            <span class="modal-confirm-message">Unsaved changes — switch to view mode?</span>
            <Button
              variant="default"
              onClick={() => void confirmSaveAndSwitch()}
              disabled={saving() || reloading()}
              title="Save and switch to view"
            >
              Save
            </Button>
            <Button
              variant="default"
              onClick={confirmDiscardAndSwitch}
              title="Discard changes and switch to view"
            >
              Discard
            </Button>
            <Button variant="default" onClick={cancelViewSwitch} title="Stay in edit mode">
              Cancel
            </Button>
          </div>
        </Show>

        <div
          class="modal-body"
          ref={(el) => (bodyRef = el)}
          tabIndex={-1}
          onClick={handleBodyClick}
          onScroll={(event) => {
            if (restorePreview) restorePreview.scroll = event.currentTarget.scrollTop;
          }}
        >
          <Show when={props.state && isConceptionConfig(props.state.path)}>
            <ConfigSummaryPanel onOpenFullDoc={() => props.onOpenHelp?.('configuration')} />
          </Show>
          <Show when={content.loading}>
            <div class="empty">Loading…</div>
          </Show>
          <Show when={content.error}>
            <div class="empty warn">
              Failed to read: {(content.error as Error).message}
              <Button variant="default" onClick={requestReload}>
                Reload
              </Button>
            </div>
          </Show>
          <Show
            when={
              !content.loading &&
              !content.error &&
              mode() === 'view' &&
              props.state &&
              isMarkdown(props.state.path)
            }
          >
            <Show when={(props.state?.deliverables?.length ?? 0) > 0}>
              <section class="deliverables-strip">
                <h3>Deliverables</h3>
                <ul>
                  <For each={props.state!.deliverables!}>
                    {(d) => (
                      <li>
                        <button
                          class="deliverable-link"
                          onClick={() => props.onOpenDeliverable(d)}
                          title={d.path}
                        >
                          ⬇ {d.label}
                        </button>
                        <Show when={d.description}>
                          <span class="deliverable-desc"> — {d.description}</span>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
            <article class="md-rendered" innerHTML={html() ?? ''} />
          </Show>
          <Show
            when={
              !content.loading &&
              !content.error &&
              mode() === 'view' &&
              props.state &&
              !isMarkdown(props.state.path)
            }
          >
            <div class="md-rendered raw-code" innerHTML={codeHtml() ?? ''} />
          </Show>
          <Show when={!content.loading && !content.error && mode() === 'edit'}>
            <div class="cm-host" ref={(el) => (editorParent = el)} />
          </Show>
        </div>
      </div>
      <Show when={pendingDirtyAction()}>
        {(action) => (
          <ConfirmModal
            title={
              action().verb === 'leave'
                ? 'Leave with unsaved changes?'
                : action().verb === 'reload'
                  ? 'Reload with unsaved changes?'
                  : 'Close with unsaved changes?'
            }
            body={
              action().verb === 'leave'
                ? 'You have unsaved edits. Leaving will discard them.'
                : action().verb === 'reload'
                  ? 'You have unsaved edits. Reloading will discard them.'
                  : 'You have unsaved edits. Closing will discard them.'
            }
            confirmLabel="Discard changes"
            destructive
            onCancel={() => setPendingDirtyAction(null)}
            onConfirm={() => {
              const a = action();
              setPendingDirtyAction(null);
              a.run();
            }}
          />
        )}
      </Show>
    </div>
  );
}
