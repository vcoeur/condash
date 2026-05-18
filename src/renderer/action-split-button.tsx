import { For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { createDropdownMenu } from './dropdown-menu';
import { TerminalIcon, ChevronDownIcon } from './icons';

export interface SplitActionItem {
  label: string;
  submit?: boolean;
}

interface ActionSplitButtonProps {
  /** Content of the left (primary) button. */
  primary: JSX.Element;
  /** Tooltip / aria-label for the primary button. */
  primaryTitle: string;
  /** Click handler for the primary button. */
  onPrimary: () => void;
  /** Label shown in the menu's first "default" row. */
  defaultLabel: string;
  /** Whether the default row should show the submit glyph. */
  defaultSubmit?: boolean;
  /** Configured items — rendered below the divider. */
  items: SplitActionItem[];
  /** Called when a menu item (or the default row) is picked.
   *  `index` is `-1` for the default row, otherwise the item index. */
  onItem: (index: number) => void;
  /** Optional extra class on the outer wrapper. */
  class?: string;
  /** Icon rendered left of the default-label in the menu. */
  defaultIcon?: JSX.Element;
}

/** Split button: primary action on the left, caret dropdown on the right.
 *  When `items` is empty the caret is hidden and the button behaves like a
 *  regular single button. */
export function ActionSplitButton(props: ActionSplitButtonProps): JSX.Element {
  const menu = createDropdownMenu({ align: 'right' });
  const hasItems = (): boolean => props.items.length > 0;

  return (
    <>
      <div
        class={`action-split-button ${props.class ?? ''}`}
        classList={{ 'has-menu': hasItems() }}
      >
        <button
          type="button"
          class="action-split-primary"
          title={props.primaryTitle}
          aria-label={props.primaryTitle}
          onClick={() => props.onPrimary()}
        >
          {props.primary}
        </button>
        <Show when={hasItems()}>
          <button
            type="button"
            class="action-split-caret"
            title="More actions"
            aria-label="More actions"
            aria-expanded={menu.isOpen()}
            ref={menu.setTrigger}
            onClick={(e) => menu.toggle(e)}
          >
            <ChevronDownIcon />
          </button>
        </Show>
      </div>

      <Show when={menu.isOpen() && menu.anchor()}>
        {(() => {
          const anchor = menu.anchor()!;
          return (
            <div
              ref={menu.setMenu}
              class="action-split-menu portal"
              style={{
                position: 'fixed',
                top: `${anchor.top}px`,
                left: `${anchor.left}px`,
                transform: 'translateX(-100%)',
                'z-index': '1000',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                class="action-split-menu-item action-split-menu-default"
                onClick={() => {
                  menu.close();
                  props.onItem(-1);
                }}
              >
                <span class="action-split-menu-icon">{props.defaultIcon ?? <TerminalIcon />}</span>
                <span class="action-split-menu-label">{props.defaultLabel}</span>
                <Show when={props.defaultSubmit}>
                  <span class="action-split-menu-submit" aria-hidden="true">
                    ⏎
                  </span>
                </Show>
                <span class="action-split-menu-badge">default</span>
              </button>
              <Show when={props.items.length > 0}>
                <div class="action-split-menu-divider" />
              </Show>
              <For each={props.items}>
                {(item, idx) => (
                  <button
                    type="button"
                    class="action-split-menu-item"
                    onClick={() => {
                      menu.close();
                      props.onItem(idx());
                    }}
                  >
                    <span class="action-split-menu-bullet" aria-hidden="true">
                      ▸
                    </span>
                    <span class="action-split-menu-label">{item.label}</span>
                    <Show when={item.submit}>
                      <span class="action-split-menu-submit" aria-hidden="true">
                        ⏎
                      </span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          );
        })()}
      </Show>
    </>
  );
}
