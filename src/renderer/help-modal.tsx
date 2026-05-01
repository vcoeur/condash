import { createEffect, createResource, onCleanup, onMount, Show } from 'solid-js';
import { renderMarkdown, runMermaidIn } from './markdown';
import { routeMarkdownClick, scrollToAnchor } from './md-link-router';
import 'highlight.js/styles/github.css';

export type HelpDoc =
  | 'welcome'
  | 'getting-started'
  | 'install'
  | 'first-launch'
  | 'shortcuts'
  | 'configuration'
  | 'cli'
  | 'mutations'
  | 'architecture'
  | 'why-markdown'
  | 'values'
  | 'non-goals'
  | 'index';

const TITLE: Record<HelpDoc, string> = {
  welcome: 'Welcome to condash',
  index: 'Documentation index',
  'getting-started': 'Getting started',
  install: 'Install',
  'first-launch': 'First launch',
  shortcuts: 'Keyboard shortcuts',
  configuration: 'Configuration reference',
  cli: 'CLI reference',
  mutations: 'Mutation model',
  architecture: 'Architecture',
  'why-markdown': 'Why Markdown-first',
  values: 'Values',
  'non-goals': 'Non-goals',
};

/**
 * Read-only modal for the bundled docs/. Pulls the markdown from main via
 * helpReadDoc, renders it through the same pipeline as the note modal
 * (markdown-it + mermaid + highlight.js), and shows it in a centred dialog.
 *
 * Distinct from NoteModal because help docs are non-editable, never
 * deliverable-bearing, and shouldn't share the "open in editor" affordance —
 * the file lives inside the app bundle, not on disk.
 */
export function HelpModal(props: { doc: HelpDoc; onClose: () => void }) {
  let bodyRef: HTMLDivElement | undefined;

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  };
  onMount(() => document.addEventListener('keydown', handleKey, true));
  onCleanup(() => document.removeEventListener('keydown', handleKey, true));

  const [content] = createResource(
    () => props.doc,
    async (doc) => {
      try {
        return await window.condash.helpReadDoc(doc);
      } catch (err) {
        return `# Error\n\nCould not load \`${doc}.md\`: ${(err as Error).message}`;
      }
    },
  );

  const html = (): string => {
    const raw = content();
    if (raw === undefined) return '';
    return renderMarkdown(raw);
  };

  createEffect(() => {
    if (content() && bodyRef) {
      void runMermaidIn(bodyRef);
    }
  });

  // Help docs live in the app bundle, not on disk — relative-path resolution
  // would lie. We only act on http(s)/mailto and in-page anchors; everything
  // else is preventDefault-only so a stray link can't blank the renderer.
  const handleBodyClick = (e: MouseEvent) => {
    routeMarkdownClick(e, null, {
      onExternal: (url) => void window.condash.openExternal(url),
      onAnchor: (id) => {
        if (bodyRef) scrollToAnchor(bodyRef, id);
      },
    });
  };

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div
        class="modal note-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="modal-head">
          <span class="modal-title">{TITLE[props.doc]}</span>
          <span class="modal-path">condash docs/</span>
          <button class="modal-button" onClick={props.onClose} title="Close (Esc)">
            ×
          </button>
        </header>
        <Show when={content()} fallback={<div class="modal-body modal-empty">Loading…</div>}>
          <div
            class="modal-body markdown-body"
            ref={(el) => (bodyRef = el)}
            innerHTML={html()}
            onClick={handleBodyClick}
          />
        </Show>
      </div>
    </div>
  );
}
