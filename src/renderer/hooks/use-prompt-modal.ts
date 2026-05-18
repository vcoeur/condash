import { createSignal } from 'solid-js';
import type { PromptModalState } from '../prompt-modal';

export interface UsePromptModal {
  promptState: () => PromptModalState | null;
  setPromptState: (next: PromptModalState | null) => void;
  openPrompt: (init: Omit<PromptModalState, 'resolve'>) => Promise<string | null>;
}

/** Imperative prompt modal — the resolve handle on the state object is
 *  invoked by the modal itself when the user confirms or cancels. */
export function usePromptModal(): UsePromptModal {
  const [promptState, setPromptState] = createSignal<PromptModalState | null>(null);
  const openPrompt = (init: Omit<PromptModalState, 'resolve'>): Promise<string | null> =>
    new Promise<string | null>((resolve) => {
      setPromptState({ ...init, resolve });
    });
  return { promptState, setPromptState, openPrompt };
}
