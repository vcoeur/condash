import { createSignal } from 'solid-js';
import type { JSX } from 'solid-js';

/** Serialise a keyboard event to the modifier-chained string format the
 *  rest of condash uses (`Ctrl+Shift+V`, `Cmd+Left`, etc.). Returns null
 *  for events that produced no key character (modifier-only press, IME). */
function serializeShortcut(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.metaKey) parts.push('Cmd');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const k = e.key;
  // Don't accept a bare modifier as the final key — the user is still
  // composing.
  if (k === 'Control' || k === 'Meta' || k === 'Alt' || k === 'Shift') return null;
  if (k.length === 1) {
    parts.push(k.toUpperCase());
  } else {
    // Named keys: pass-through, capitalising. e.g. 'ArrowLeft' → 'Left',
    // 'Backquote' is unlikely as e.key, but if so leave it. Browsers emit
    // 'ArrowLeft' on arrow keys — strip the 'Arrow' prefix for legibility.
    parts.push(k.replace(/^Arrow/, ''));
  }
  return parts.join('+');
}

/** Click-to-capture keyboard shortcut input. When idle, renders the stored
 *  shortcut as a chip-like button; when capturing, listens for the next
 *  full key combination and stores its serialisation. Esc aborts;
 *  Backspace clears. */
export function ShortcutCapture(props: {
  id: string;
  value: () => string | undefined;
  placeholder: string;
  onChange: (next: string) => void;
}): JSX.Element {
  const [capturing, setCapturing] = createSignal(false);
  const handleKey = (e: KeyboardEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setCapturing(false);
      return;
    }
    if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      props.onChange('');
      setCapturing(false);
      return;
    }
    const serial = serializeShortcut(e);
    if (!serial) return;
    props.onChange(serial);
    setCapturing(false);
  };
  return (
    <button
      type="button"
      class="settings-shortcut"
      classList={{ 'settings-shortcut--capturing': capturing() }}
      onClick={() => setCapturing((c) => !c)}
      onKeyDown={(e) => {
        if (!capturing()) return;
        handleKey(e);
      }}
      title={
        capturing()
          ? 'Press a key combination (Esc to cancel, Backspace to clear)'
          : 'Click to rebind'
      }
    >
      {capturing()
        ? 'Press a key combination…'
        : props.value() && props.value()!.trim().length > 0
          ? props.value()
          : props.placeholder}
    </button>
  );
}
