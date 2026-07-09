import { EditorState, Compartment, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';

export type EditorLanguage = 'markdown' | 'json';

export interface MountOptions {
  parent: HTMLElement;
  initial: string;
  language: EditorLanguage;
  /** Initial dark/light hint for the CodeMirror theme. The host can flip
   *  this later via `setDark()` without remounting the editor. */
  dark?: boolean;
  onSave: () => void;
  onChange: (next: string) => void;
}

export interface MountedEditor {
  view: EditorView;
  destroy: () => void;
  setValue: (next: string) => void;
  setDark: (dark: boolean) => void;
}

function languageExtension(lang: EditorLanguage): Extension {
  return lang === 'json' ? json() : markdown();
}

/**
 * Mount a CodeMirror editor into the given parent — the public entry point of
 * this module.
 *
 * @public Lazily loaded by `note-modal.tsx` via
 *   `import('./editor').then(({ mountEditor }) => …)`; knip can't trace a
 *   destructured dynamic import, so mark it public to keep the deadcode gate
 *   honest rather than delete a live export.
 */
export function mountEditor(opts: MountOptions): MountedEditor {
  // Per-mount compartment: reconfigure() targets the View instance, so a
  // module-level singleton would have all open editors share one mutation
  // stream and an EditorView removed from the DOM would still receive
  // dispatches. Per-instance keeps the wiring local.
  const themeCompartment = new Compartment();
  const saveKey = {
    key: 'Mod-s',
    preventDefault: true,
    run: () => {
      opts.onSave();
      return true;
    },
  };

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      opts.onChange(update.state.doc.toString());
    }
  });

  const state = EditorState.create({
    doc: opts.initial,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      bracketMatching(),
      history(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([saveKey, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      languageExtension(opts.language),
      themeCompartment.of(EditorView.theme({}, { dark: opts.dark === true })),
      EditorView.lineWrapping,
      updateListener,
    ],
  });

  const view = new EditorView({
    state,
    parent: opts.parent,
  });

  return {
    view,
    destroy: () => view.destroy(),
    setValue: (next: string) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
      });
    },
    setDark: (dark: boolean) => {
      view.dispatch({
        effects: themeCompartment.reconfigure(EditorView.theme({}, { dark })),
      });
    },
  };
}
