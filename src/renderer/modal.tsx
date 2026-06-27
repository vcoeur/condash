import { type JSX, Show } from 'solid-js';
import { createBackdropClose, useModalEscHandler } from './modal-helpers';
import { Button } from './actions';
import { IconClose } from './icons';

export interface ModalProps {
  /** Per-modal class appended to `.modal` — carries the width tier and any
   *  modal-specific layout (e.g. `confirm-modal`, `pdf-modal`). */
  class: string;
  /** ARIA role for the panel. Defaults to `dialog`; confirmation dialogs
   *  pass `alertdialog`. */
  role?: 'dialog' | 'alertdialog';
  /** Accessible label for the panel (maps to `aria-label`). */
  ariaLabel?: string;
  /** Extra class on the backdrop (e.g. `search-modal-backdrop`). */
  backdropClass?: string;
  /** Extra class on the `.modal-head` bar (e.g. `logs-modal-head` for its
   *  tighter gap). */
  headClass?: string;
  /** Close handler — invoked by the close button, Esc, and a genuine
   *  backdrop click (drag-out clicks are rejected). */
  onClose: () => void;
  /** Head title text. Omit (and pass `headLeading`) for a fully custom head
   *  lead, e.g. the search modal's in-head input. */
  title?: string;
  /** Monospace path shown next to the title (viewers). */
  path?: string;
  /** Replaces the default `<span class="modal-title">` lead — for heads that
   *  put something other than a title first (e.g. a search input). When set,
   *  `title` / `path` are ignored. */
  headLeading?: JSX.Element;
  /** Head action buttons rendered between the lead and the close button. */
  headExtra?: JSX.Element;
  /** Tooltip on the close button. Defaults to "Close (Esc)". */
  closeTitle?: string;
  /** aria-label on the close button. Defaults to "Close". */
  closeLabel?: string;
  /** Modal body. */
  children: JSX.Element;
}

/**
 * Shared centered-modal shell. Owns the backdrop, the centered panel, the
 * `.modal-head` bar (title / path / extra actions / close button) and the
 * dialog ARIA wiring, and internally installs the two modal behaviours that
 * were previously opt-in per file: `useModalEscHandler` (Esc → close) and
 * `createBackdropClose` (close on backdrop click, ignoring drag-out clicks).
 *
 * Every simple centered modal renders through this so the backdrop/header/
 * close scaffold exists in exactly one place and the two modal bug classes
 * (stray-Esc, drag-out dismiss) can't regress per-modal. Bespoke surfaces
 * with a richer head or Esc contract (note, settings) keep their own layout.
 */
export function Modal(props: ModalProps): JSX.Element {
  useModalEscHandler(() => props.onClose());
  const backdrop = createBackdropClose(() => props.onClose());

  return (
    <div
      class="modal-backdrop"
      classList={props.backdropClass ? { [props.backdropClass]: true } : {}}
      onMouseDown={backdrop.onMouseDown}
      onClick={backdrop.onClick}
    >
      <div
        class={`modal ${props.class}`}
        role={props.role ?? 'dialog'}
        aria-modal="true"
        aria-label={props.ariaLabel}
      >
        <header class="modal-head" classList={props.headClass ? { [props.headClass]: true } : {}}>
          <Show
            when={props.headLeading}
            fallback={<ModalHead title={props.title} path={props.path} />}
          >
            {props.headLeading}
          </Show>
          {props.headExtra}
          <Button
            variant="default"
            tone="stop"
            class="btn--modal-head"
            onClick={() => props.onClose()}
            title={props.closeTitle ?? 'Close (Esc)'}
            aria-label={props.closeLabel ?? 'Close'}
          >
            <IconClose />
          </Button>
        </header>
        {props.children}
      </div>
    </div>
  );
}

/**
 * Default head lead: a title and, when given, a monospace path. When there is
 * no path a flex spacer pushes the close button (and any `headExtra`) to the
 * right edge; when a path is present it carries `flex:1` itself, so the spacer
 * is omitted to keep the same layout the hand-rolled heads had. Pulled out so
 * a modal can also compose it directly inside a custom `headLeading`.
 */
export function ModalHead(props: { title?: string; path?: string }): JSX.Element {
  return (
    <>
      <span class="modal-title">{props.title}</span>
      <Show when={props.path} fallback={<span class="modal-head-spacer" />}>
        <span class="modal-path">{props.path}</span>
      </Show>
    </>
  );
}
