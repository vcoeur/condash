import { createEffect, createResource, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { renderMarkdown, runMermaidIn } from './markdown';
import { mountEditor, type MountedEditor } from './editor';
import 'highlight.js/styles/github.css';

export type ModalState = {
  path: string;
  title?: string;
  /** Force edit mode on open (used by the preferences modal). */
  initialMode?: 'view' | 'edit';
  /** Deliverables to surface as a section above the rendered body, when known. */
  deliverables?: { label: string; path: string; description?: string }[];
} | null;

type Mode = 'view' | 'edit';

function inferLanguage(path: string): 'markdown' | 'json' {
  return path.toLowerCase().endsWith('.json') ? 'json' : 'markdown';
}

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith('.md');
}

export function NoteModal(props: {
  state: ModalState;
  onClose: () => void;
  onOpenInEditor: (path: string) => void;
  onWikilink: (slug: string) => void;
}) {
  const [mode, setMode] = createSignal<Mode>(props.state?.initialMode ?? 'view');

  createEffect(() => {
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

  const [content, { mutate: mutateContent, refetch: refetchContent }] = createResource(
    () => props.state?.path,
    async (path) => (path ? await window.condash.readNote(path) : null),
  );

  const html = (): string => {
    const text = content();
    if (text == null) return '';
    return renderMarkdown(text);
  };

  let bodyRef: HTMLDivElement | undefined;
  let editorParent: HTMLDivElement | undefined;
  let findInput: HTMLInputElement | undefined;
  let editor: MountedEditor | null = null;

  // Mount / unmount the CodeMirror editor when entering / leaving edit mode.
  createEffect(() => {
    const m = mode();
    const text = content();
    if (m === 'edit' && editorParent && text != null && !editor) {
      editor = mountEditor({
        parent: editorParent,
        initial: text,
        language: props.state ? inferLanguage(props.state.path) : 'markdown',
        onSave: () => void save(),
        onChange: (next) => {
          setDraft(next);
          setDirty(next !== content());
        },
      });
      setDraft(text);
      setDirty(false);
    }
    if (m !== 'edit' && editor) {
      editor.destroy();
      editor = null;
    }
  });

  // Re-render Mermaid blocks any time the rendered HTML changes (view mode only).
  createEffect(() => {
    void html();
    if (mode() === 'view' && bodyRef) {
      void runMermaidIn(bodyRef);
    }
  });

  const handleBodyClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const link = target?.closest('a.wikilink');
    if (link) {
      e.preventDefault();
      const slug = link.getAttribute('data-slug');
      if (slug) props.onWikilink(slug);
    }
  };

  // Re-run find whenever the view-mode HTML or the query changes.
  createEffect(() => {
    if (mode() === 'view') {
      runFind();
    }
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

  const save = async () => {
    if (!props.state) return;
    const expected = content() ?? '';
    const next = draft();
    setError(null);

    if (props.state.path.toLowerCase().endsWith('.json')) {
      try {
        JSON.parse(next);
      } catch (err) {
        setError(`Invalid JSON: ${(err as Error).message}`);
        return;
      }
    }

    try {
      await window.condash.writeNote(props.state.path, expected, next);
      mutateContent(next);
      setDirty(false);
      setSavedAt(Date.now());
      // Snap the saved-at flag back after a moment so the indicator is transient.
      setTimeout(() => setSavedAt((t) => (t && Date.now() - t > 1200 ? null : t)), 1500);
    } catch (err) {
      setError((err as Error).message);
    }
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
      if (findOpen()) {
        e.preventDefault();
        setFindOpen(false);
        setFindQuery('');
        return;
      }
      if (dirty()) {
        if (!window.confirm('Unsaved changes — close anyway?')) {
          e.preventDefault();
          return;
        }
      }
      e.preventDefault();
      props.onClose();
      return;
    }

    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      setMode((m) => (m === 'edit' ? 'view' : 'edit'));
      setFindOpen(false);
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

  return (
    <div class="modal-backdrop" onClick={handleBackdropClose}>
      <div
        class="modal note-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="modal-head">
          <span class="modal-title">{props.state?.title ?? props.state?.path ?? ''}</span>
          <span class="modal-path">{props.state?.path ?? ''}</span>
          <Show when={dirty()}>
            <span class="modal-dirty" title="Unsaved changes">
              ●
            </span>
          </Show>
          <Show when={savedAt() !== null}>
            <span class="modal-saved" title="Saved">
              ✓
            </span>
          </Show>
          <button
            class="modal-button"
            classList={{ active: mode() === 'edit' }}
            onClick={() => setMode((m) => (m === 'edit' ? 'view' : 'edit'))}
            title={mode() === 'edit' ? 'View (Ctrl+E)' : 'Edit (Ctrl+E)'}
          >
            {mode() === 'edit' ? '⤺' : '✎'}
          </button>
          <Show when={mode() === 'edit'}>
            <button
              class="modal-button"
              onClick={() => void save()}
              disabled={!dirty()}
              title="Save (Ctrl+S)"
            >
              💾
            </button>
          </Show>
          <button
            class="modal-button"
            onClick={() => props.state && props.onOpenInEditor(props.state.path)}
            title="Open in $EDITOR"
          >
            ↗
          </button>
          <button class="modal-button" onClick={handleBackdropClose} title="Close (Esc)">
            ×
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

        <div class="modal-body" ref={(el) => (bodyRef = el)} onClick={handleBodyClick}>
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
                        onClick={() => void window.condash.openInEditor(d.path)}
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
      if (parent.closest('script, style, .find-bar')) return NodeFilter.FILTER_REJECT;
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
