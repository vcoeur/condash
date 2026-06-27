/**
 * Shared chrome for every Settings section: the `<section>` wrapper, a head
 * with the title and a scope chip, and an optional hint. The scope chip is the
 * one device that makes ownership legible — it names the file a section writes
 * to, replacing the old inheritance-badge vocabulary.
 */
import { Show, type JSX } from 'solid-js';
import { SCOPE_FILE, SCOPE_LABEL, type Section, type SettingsScope } from './data';

/** Pill naming a section's home file. Accent (indigo) for Personal, project
 *  green for This conception; the colour is the legend the eye learns once. */
export function ScopeChip(props: { scope: SettingsScope }): JSX.Element {
  return (
    <span
      class="settings-scope-chip"
      classList={{
        'settings-scope-chip--global': props.scope === 'global',
        'settings-scope-chip--conception': props.scope === 'conception',
      }}
      title={`Saved in ${SCOPE_FILE[props.scope]}`}
    >
      <span class="settings-scope-chip-mark" aria-hidden="true">
        {props.scope === 'global' ? '●' : '◆'}
      </span>
      {SCOPE_LABEL[props.scope]}
    </span>
  );
}

/** Section wrapper: scoped left-edge accent, head (title + chip), optional
 *  hint, then the section's fields. */
export function SectionShell(props: {
  id: Section;
  title: string;
  scope: SettingsScope;
  hint?: JSX.Element;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section id={`settings-section-${props.id}`} class="settings-section" data-scope={props.scope}>
      <div class="settings-section-head">
        <h2>{props.title}</h2>
        <ScopeChip scope={props.scope} />
      </div>
      <Show when={props.hint}>{props.hint}</Show>
      {props.children}
    </section>
  );
}
