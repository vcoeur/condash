import { For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { ActionTemplate } from '@shared/types';
import { Subgroup } from './primitives';

export function ActionTemplateSection(props: {
  title: string;
  hint: string;
  idPrefix: string;
  /** Stable subgroup id (e.g. "global.terminal.project-actions"). When
   *  set, the section renders inside a collapsible Subgroup that also
   *  participates in search. */
  subgroupId?: string;
  /** Extra search keywords (e.g. "project action template launcher"). */
  keywords?: string;
  bindText: (
    id: string,
    persisted: () => string | undefined,
    save: (value: string) => Promise<void>,
  ) => {
    value: string;
    onInput: (e: InputEvent & { currentTarget: HTMLInputElement }) => void;
    onChange: (e: Event & { currentTarget: HTMLInputElement }) => void;
  };
  items: () => ActionTemplate[];
  patch: (index: number, patch: Partial<ActionTemplate>) => Promise<void>;
  add: () => Promise<void>;
  remove: (index: number) => Promise<void>;
  move: (index: number, delta: -1 | 1) => Promise<void>;
}): JSX.Element {
  const body = (): JSX.Element => (
    <>
      <p class="settings-field-hint">{props.hint}</p>
      <For each={props.items()}>
        {(action, idx) => (
          <div class="settings-launcher-row">
            <label>
              <span>Label</span>
              <input
                type="text"
                placeholder="Claude review"
                {...props.bindText(
                  `${props.idPrefix}.${idx()}.label`,
                  () => action.label || undefined,
                  (v) => props.patch(idx(), { label: v }),
                )}
              />
            </label>
            <label>
              <span>Template</span>
              <input
                type="text"
                placeholder='claude "review project {shortSlug}"'
                {...props.bindText(
                  `${props.idPrefix}.${idx()}.template`,
                  () => action.template || undefined,
                  (v) => props.patch(idx(), { template: v }),
                )}
              />
            </label>
            <label>
              <span>Agent</span>
              <input
                type="text"
                placeholder="claude-deepseek-v4-pro (blank = focused tab)"
                {...props.bindText(
                  `${props.idPrefix}.${idx()}.agent`,
                  () => action.agent || undefined,
                  (v) => props.patch(idx(), { agent: v || undefined }),
                )}
              />
            </label>
            <label class="settings-checkbox">
              <input
                type="checkbox"
                checked={action.submit === true}
                onChange={(e) => void props.patch(idx(), { submit: e.currentTarget.checked })}
              />
              <span>Submit (press Enter after pasting)</span>
            </label>
            <div class="settings-launcher-actions">
              <button type="button" title="Remove" onClick={() => props.remove(idx())}>
                ×
              </button>
              <button
                type="button"
                title="Move up"
                disabled={idx() === 0}
                onClick={() => props.move(idx(), -1)}
              >
                ↑
              </button>
              <button
                type="button"
                title="Move down"
                disabled={idx() === props.items().length - 1}
                onClick={() => props.move(idx(), 1)}
              >
                ↓
              </button>
            </div>
          </div>
        )}
      </For>
      <button type="button" class="settings-add-launcher" onClick={() => props.add()}>
        + Add action
      </button>
    </>
  );
  return (
    <Show
      when={props.subgroupId}
      fallback={
        <>
          <h3>{props.title}</h3>
          {body()}
        </>
      }
    >
      <Subgroup
        id={props.subgroupId!}
        title={props.title}
        keywords={`${props.hint} ${props.keywords ?? ''}`}
      >
        {body()}
      </Subgroup>
    </Show>
  );
}
