import { type JSX, splitProps } from 'solid-js';

/**
 * The action framework's component layer. These thin wrappers render the
 * `.btn` / `.seg` / `.action-bar` classes from actions.css so call-sites name
 * intent (a primary commit, a destructive icon, a cancel) rather than copying
 * chrome. See actions.css for the visual contract.
 */

/** Button role. `primary` is the single committing action (filled accent);
 *  `default` is neutral/secondary/cancel; `ghost` is a chromeless text
 *  action; `danger` is a quiet destructive verb. */
export type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger';

/** Button density. `md` (default) is the standard footer/form size; `sm` is
 *  the dense toolbar/card-row size. */
export type ButtonSize = 'sm' | 'md';

/** Semantic verb tone. On an icon button it colours the hover cue; on a
 *  primary button it recolours the fill (`danger` → destructive commit). */
export type ActionTone = 'open' | 'work' | 'run' | 'add' | 'stop' | 'danger';

/** Join class fragments, dropping falsy ones. */
function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Role variant. Defaults to `default`. */
  variant?: ButtonVariant;
  /** Density. Defaults to `md`. */
  size?: ButtonSize;
  /** Semantic verb tone (e.g. `danger` on a `primary` for a destructive commit). */
  tone?: ActionTone;
}

/**
 * Text (or text+icon) action button. Renders `.btn .btn--<variant>` plus the
 * optional size/tone modifiers; forwards every native button attribute
 * (onClick, disabled, type, title, …).
 */
export function Button(props: ButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, ['variant', 'size', 'tone', 'class', 'children']);
  return (
    <button
      {...rest}
      class={cx(
        'btn',
        `btn--${local.variant ?? 'default'}`,
        local.size === 'sm' && 'btn--sm',
        local.class,
      )}
      data-tone={local.tone}
    >
      {local.children}
    </button>
  );
}

export interface ActionBarProps {
  /** Push a lone leading child (e.g. a Delete) to the far left, commit on the right. */
  split?: boolean;
  class?: string;
  children: JSX.Element;
}

/**
 * Footer commit/cancel row. Right-aligns its children by default (cancel
 * left, primary right); `split` spreads them to both edges.
 */
export function ActionBar(props: ActionBarProps): JSX.Element {
  return (
    <div class={cx('action-bar', props.split && 'action-bar--split', props.class)}>
      {props.children}
    </div>
  );
}
