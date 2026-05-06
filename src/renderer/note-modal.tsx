import { createEffect, createResource, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { renderMarkdown, runMermaidIn } from './markdown';
import { routeMarkdownClick, scrollToAnchor } from './md-link-router';
import type { MountedEditor } from './editor';
import './code-theme.css';

let editorModulePromise: Promise<typeof import('./editor')> | null = null;
function loadEditor(): Promise<typeof import('./editor')> {
  if (!editorModulePromise) editorModulePromise = import('./editor');
  return editorModulePromise;
}

export type ModalState = {
  path: string;
  title?: string;
  /** Force edit mode on open (used by the preferences modal). */
  initialMode?: 'view' | 'edit';
  /** Deliverables to surface as a section above the rendered body, when known. */
  deliverables?: { label: string; path: string; description?: string }[];
  /** When set, render a leading "← Back to <label>" button in the modal head.
   * Clicking it calls onClose, which the parent routes back to the originating
   * preview via the previewBackPath plumbing. */
  backLabel?: string;
  /** Open the modal in read-only mode — no save / edit toggle. Used by the
   * Resources pane for `.md` and `.txt` viewing. */
  readOnly?: boolean;
  /** Render an informational banner above the body. `'shipped'` flags a file
   * tracked by `.condash-skills.json` whose disk SHA matches the manifest;
   * `'shipped-diverged'` flags a local edit. */
  bannerKind?: 'shipped' | 'shipped-diverged';
} | null;

type Mode = 'view' | 'edit';

function IconEdit() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M11.5 2.5l2 2-7.5 7.5H4v-2z" />
      <path d="M10 4l2 2" />
    </svg>
  );
}

function IconView() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.6" />
    </svg>
  );
}

function IconSave() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 2.5h8.5L13.5 5v8.5h-11z" />
      <path d="M5 2.5v3h5v-3" />
      <rect x="4.5" y="9" width="7" height="4.5" />
    </svg>
  );
}

function IconExternal() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M5.5 3h-3v10h10v-3" />
      <path d="M9 2.5h4.5V7" />
      <path d="M7 9l6.5-6.5" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function inferLanguage(path: string): 'markdown' | 'json' {
  return path.toLowerCase().endsWith('.json') ? 'json' : 'markdown';
}

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith('.md');
}

function isConfigurationJson(path: string): boolean {
  return path.toLowerCase().endsWith('/configuration.json');
}

const CONFIG_SUMMARY: { key: string; purpose: string }[] = [
  { key: 'workspace_path', purpose: 'Base directory for non-absolute repo entries.' },
  { key: 'worktrees_path', purpose: 'Where new git worktrees are created (informational).' },
  {
    key: 'repositories.primary / .secondary',
    purpose:
      'Repos shown on the Code pane. Each entry: name, optional run / force_stop / submodules.',
  },
  {
    key: 'open_with',
    purpose:
      'IDE / terminal launchers (main_ide, secondary_ide, terminal). {path} substitutes the target.',
  },
  {
    key: 'terminal',
    purpose:
      'Pane preferences: shell, shortcut, screenshot_dir, screenshot_paste_shortcut, launcher_command.',
  },
];

export function NoteModal(props: {
  state: ModalState;
  onClose: () => void;
  onOpenInEditor: (path: string) => void;
  onOpenDeliverable: (path: string) => void;
  onWikilink: (slug: string) => void;
  /** Open a markdown file referenced by a relative `[text](path.md)` link in
   * the rendered body — replaces the current note in the same modal. */
  onOpenMarkdown: (path: string) => void;
  /** Open a PDF referenced by a relative link in the rendered body. */
  onOpenPdf: (path: string) => void;
  /** Open a bundled help doc — used by the configuration.json reference panel
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

  createEffect(() => {
    if (props.state?.readOnly) {
      setMode('view');
      return;
    }
    if (props.state?.initialMode) setMode(props.state.initialMode);
    else if (props.state && !isMarkdown(props.state.path)) setMode('edit');
  });
  const [draft, setDraft] = createSignal('');
  const [dirty, setDirty] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [savedAt, setSavedAt] = createSignal<number | null>(null);
  const [findOpen, setFindOpen] = createSignal(false);
  const [findQuery, setFindQuery] = createSignal('');
  const [findMatch, setFindMatch] = createSignal<{ index: number; total: number } | null>(null);
  // Toggling out of edit mode tears down the CodeMirror instance, so any
  // unsaved draft is gone the moment we flip to view. Hold the request in this
  // signal until the user picks Save or Discard.
  const [pendingViewSwitch, setPendingViewSwitch] = createSignal(false);
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
  createEffect(() => {
    const path = props.state?.path ?? null;
    if (path === lastPath) return;
    lastPath = path;
    setDraft('');
    setDirty(false);
    setError(null);
    setSavedAt(null);
    setFindOpen(false);
    setFindQuery('');
    setFindMatch(null);
    setPendingViewSwitch(false);
  });

  const [content, { mutate: mutateContent, refetch: refetchContent }] = createResource(
    () => props.state?.path,
    async (path) => (path ? await window.condash.readNote(path) : null),
  );

  const html = (): string => {
    const text = content();
    if (text == null) return '';
    const path = props.state?.path ?? null;
    const baseDir = path ? path.replace(/\/[^/]*$/, '') : undefined;
    return renderMarkdown(text, { baseDir });
  };

  let bodyRef: HTMLDivElement | undefined;
  let editorParent: HTMLDivElement | undefined;
  let findInput: HTMLInputElement | undefined;
  let editor: MountedEditor | null = null;

  // Mount / unmount the CodeMirror editor when entering / leaving edit mode.
  // CodeMirror lives in a dynamically-imported chunk so the renderer's initial
  // load only pays for it once the user opens an editor.
  let mounting = false;
  createEffect(() => {
    const m = mode();
    const text = content();
    if (m === 'edit' && editorParent && text != null && !editor && !mounting) {
      mounting = true;
      const parent = editorParent;
      const initial = text;
      const language = props.state ? inferLanguage(props.state.path) : 'markdown';
      void loadEditor()
        .then(({ mountEditor }) => {
          // Bail if the user left edit mode while the chunk was loading.
          if (mode() !== 'edit') {
            mounting = false;
            return;
          }
          editor = mountEditor({
            parent,
            initial,
            language,
            dark: props.dark,
            onSave: () => void save(),
            onChange: (next) => {
              setDraft(next);
              setDirty(next !== content());
            },
          });
          setDraft(initial);
          setDirty(false);
          mounting = false;
        })
        .catch((err) => {
          mounting = false;
          setError(`Failed to load editor: ${(err as Error).message}`);
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
      onOtherFile: (path) => props.onOpenInEditor(path),
    });
  };

  // Re-run find whenever the view-mode HTML or the query changes. A
  // 100 ms debounce keeps `runFind` off the keystroke critical path: every
  // letter typed in the find bar would otherwise walk the DOM, splice text
  // nodes, and re-highlight in line with the typing.
  let findTimer: ReturnType<typeof setTimeout> | null = null;
  createEffect(() => {
    void findQuery();
    void findOpen();
    void html();
    if (mode() !== 'view') return;
    if (findTimer !== null) clearTimeout(findTimer);
    findTimer = setTimeout(() => {
      findTimer = null;
      runFind();
    }, 100);
  });
  onCleanup(() => {
    if (findTimer !== null) clearTimeout(findTimer);
  });

  const runFind = () => {
    if (!bodyRef) return;
    clearFindHighlights(bodyRef);
    const query = findQuery();
    if (!findOpen() || query.length === 0) {
      setFindMatch(null);
      return;
    }
    const total = highlightFindMatches(bodyRef, query);
    setFindMatch(total > 0 ? { index: 0, total } : { index: 0, total: 0 });
    if (total > 0) focusFindMatch(bodyRef, 0);
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
    if (!props.state) return false;
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
      await window.condash.writeNote(props.state.path, expected, next);
      mutateContent(next);
      setDirty(false);
      setSavedAt(Date.now());
      // Snap the saved-at flag back after a moment so the indicator is
      // transient. Track the timer ID and clear in onCleanup so a modal
      // closed mid-grace doesn't fire setSavedAt on a disposed scope.
      scheduleSavedAtClear();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  // Request a switch to view mode. If the editor is dirty, defer until the
  // user resolves the Save / Discard / Cancel dialog so edits aren't silently
  // lost when CodeMirror unmounts.
  const requestViewMode = () => {
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
    setError(null);
    setDirty(false);
    setDraft('');
    if (editor) {
      editor.destroy();
      editor = null;
    }
    await refetchContent();
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (!props.state) return;

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
      if (dirty()) {
        if (!window.confirm('Unsaved changes — close anyway?')) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
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
  });

  onCleanup(() => {
    document.removeEventListener('keydown', handleKeydown, true);
    if (editor) editor.destroy();
  });

  const handleBackdropClose = () => {
    if (dirty() && !window.confirm('Unsaved changes — close anyway?')) return;
    props.onClose();
  };

  const handleBackClick = () => {
    if (dirty() && !window.confirm('Unsaved changes — leave anyway?')) return;
    if (props.onBack) props.onBack();
    else props.onClose();
  };

  return (
    <div class="modal-backdrop" onClick={handleBackdropClose}>
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
          <Show when={!props.state?.readOnly}>
            <button
              class="modal-button"
              classList={{ active: mode() === 'edit' }}
              onClick={requestViewMode}
              title={mode() === 'edit' ? 'View (Ctrl+E)' : 'Edit (Ctrl+E)'}
              aria-label={mode() === 'edit' ? 'Switch to view mode' : 'Switch to edit mode'}
            >
              {mode() === 'edit' ? <IconView /> : <IconEdit />}
            </button>
          </Show>
          <Show when={mode() === 'edit' && !props.state?.readOnly}>
            <button
              class="modal-button"
              onClick={() => void save()}
              disabled={!dirty()}
              title="Save (Ctrl+S)"
              aria-label="Save"
            >
              <IconSave />
            </button>
          </Show>
          <button
            class="modal-button"
            onClick={() => props.state && props.onOpenInEditor(props.state.path)}
            title="Open in $EDITOR"
            aria-label="Open in external editor"
          >
            <IconExternal />
          </button>
          <button
            class="modal-button"
            onClick={handleBackdropClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            <IconClose />
          </button>
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
            <button
              class="modal-button"
              onClick={() => stepFind(-1)}
              title="Previous (Shift+Enter)"
            >
              ↑
            </button>
            <button class="modal-button" onClick={() => stepFind(1)} title="Next (Enter)">
              ↓
            </button>
            <button
              class="modal-button"
              onClick={() => {
                setFindOpen(false);
                setFindQuery('');
              }}
              title="Close (Esc)"
            >
              ×
            </button>
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
            <button
              class="modal-button"
              onClick={() => void confirmSaveAndSwitch()}
              title="Save and switch to view"
            >
              Save
            </button>
            <button
              class="modal-button"
              onClick={confirmDiscardAndSwitch}
              title="Discard changes and switch to view"
            >
              Discard
            </button>
            <button class="modal-button" onClick={cancelViewSwitch} title="Stay in edit mode">
              Cancel
            </button>
          </div>
        </Show>

        <div
          class="modal-body"
          ref={(el) => (bodyRef = el)}
          tabIndex={-1}
          onClick={handleBodyClick}
        >
          <Show when={props.state && isConfigurationJson(props.state.path)}>
            <ConfigSummaryPanel onOpenFullDoc={() => props.onOpenHelp?.('configuration')} />
          </Show>
          <Show when={content.loading}>
            <div class="empty">Loading…</div>
          </Show>
          <Show when={content.error}>
            <div class="empty warn">
              Failed to read: {(content.error as Error).message}
              <button class="modal-button" onClick={() => void reload()}>
                Reload
              </button>
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
                  {props.state!.deliverables!.map((d) => (
                    <li>
                      <button
                        class="deliverable-link"
                        onClick={() => props.onOpenDeliverable(d.path)}
                        title={d.path}
                      >
                        ⬇ {d.label}
                      </button>
                      <Show when={d.description}>
                        <span class="deliverable-desc"> — {d.description}</span>
                      </Show>
                    </li>
                  ))}
                </ul>
              </section>
            </Show>
            <article class="md-rendered" innerHTML={html()} />
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
            <pre class="md-rendered raw-text">{content() ?? ''}</pre>
          </Show>
          <Show when={!content.loading && !content.error && mode() === 'edit'}>
            <div class="cm-host" ref={(el) => (editorParent = el)} />
          </Show>
        </div>
      </div>
    </div>
  );
}

const FIND_HIGHLIGHT_CLASS = 'find-hit';
const FIND_CURRENT_CLASS = 'find-current';

function clearFindHighlights(container: HTMLElement): void {
  for (const el of Array.from(
    container.querySelectorAll<HTMLElement>(`.${FIND_HIGHLIGHT_CLASS}`),
  )) {
    const parent = el.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(el.textContent ?? ''), el);
    parent.normalize();
  }
}

function highlightFindMatches(container: HTMLElement, query: string): number {
  const lower = query.toLowerCase();
  if (lower.length === 0) return 0;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // Skip script/style/find-bar (UI noise) and SVG subtrees (mermaid
      // diagrams render text as <text> nodes inside <svg>; replacing them
      // with split <span> wrappers blows up the diagram's layout).
      if (parent.closest('script, style, svg, .find-bar')) return NodeFilter.FILTER_REJECT;
      return node.nodeValue && node.nodeValue.toLowerCase().includes(lower)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const targets: Text[] = [];
  let cur: Node | null = walker.nextNode();
  while (cur) {
    targets.push(cur as Text);
    cur = walker.nextNode();
  }

  let count = 0;
  for (const node of targets) {
    const text = node.nodeValue ?? '';
    const fragment = document.createDocumentFragment();
    const lowerText = text.toLowerCase();
    let cursor = 0;
    let next = lowerText.indexOf(lower, cursor);
    while (next !== -1) {
      if (next > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, next)));
      const span = document.createElement('span');
      span.className = FIND_HIGHLIGHT_CLASS;
      span.textContent = text.slice(next, next + query.length);
      fragment.appendChild(span);
      count++;
      cursor = next + query.length;
      next = lowerText.indexOf(lower, cursor);
    }
    if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
    node.parentNode?.replaceChild(fragment, node);
  }
  return count;
}

function focusFindMatch(container: HTMLElement, index: number): void {
  const hits = container.querySelectorAll<HTMLElement>(`.${FIND_HIGHLIGHT_CLASS}`);
  for (const hit of Array.from(hits)) hit.classList.remove(FIND_CURRENT_CLASS);
  const target = hits[index];
  if (!target) return;
  target.classList.add(FIND_CURRENT_CLASS);
  target.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
}

function ConfigSummaryPanel(props: { onOpenFullDoc: () => void }) {
  const [open, setOpen] = createSignal(true);
  return (
    <details
      class="config-summary-panel"
      open={open()}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        Reference — top-level keys
        <button
          class="modal-button config-summary-link"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            props.onOpenFullDoc();
          }}
          title="Open the full configuration reference"
        >
          Full reference →
        </button>
      </summary>
      <ul class="config-summary-list">
        {CONFIG_SUMMARY.map((row) => (
          <li>
            <code>{row.key}</code>
            <span> — {row.purpose}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
