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
  onSave: () => void;
  onChange: (next: string) => void;
}

export interface MountedEditor {
  view: EditorView;
  destroy: () => void;
  setValue: (next: string) => void;
}

const themeCompartment = new Compartment();

function languageExtension(lang: EditorLanguage): Extension {
  return lang === 'json' ? json() : markdown();
}

export function mountEditor(opts: MountOptions): MountedEditor {
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
      themeCompartment.of(EditorView.theme({}, { dark: false })),
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
  };
}
