import { For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { JSX } from 'solid-js';
import { createDropdownMenu } from './dropdown-menu';
import { TerminalIcon, ChevronDownIcon } from './icons';

export interface DropdownActionItem {
  label: string;
  submit?: boolean;
  /** When set, the menu item renders an inline `→ <launcher>` hint so the
   *  user can see at a glance which launcher this entry will spawn into,
   *  matching the per-row Launcher dropdown in Settings. */
  launcher?: string;
}

interface ActionDropdownButtonProps {
  /** Content of the trigger button (icon + label as the user sees it). */
  trigger: JSX.Element;
  /** Tooltip / aria-label for the trigger button. */
  triggerTitle: string;
  /** Label shown in the menu's first row (the built-in default action). */
  defaultLabel: string;
  /** Whether the default row should show the submit glyph. */
  defaultSubmit?: boolean;
  /** Configured items rendered below the default row. */
  items: DropdownActionItem[];
  /** Called when a menu row is picked.
   *  `index` is `-1` for the default row, otherwise the item index. */
  onItem: (index: number) => void;
  /** Optional extra class on the outer trigger button. */
  class?: string;
  /** Icon rendered left of the default-label in the menu. */
  defaultIcon?: JSX.Element;
}

/** Single-button dropdown trigger. The whole trigger opens the menu — there
 *  is no separate "primary" hit zone. Row 1 of the menu is the built-in
 *  default action; rows 2+ are user-configured items. */
export function ActionDropdownButton(props: ActionDropdownButtonProps): JSX.Element {
  const menu = createDropdownMenu({ align: 'right' });

  return (
    <>
      <button
        type="button"
        class={`action-dropdown-button ${props.class ?? ''}`}
        title={props.triggerTitle}
        aria-label={props.triggerTitle}
        aria-haspopup="menu"
        aria-expanded={menu.isOpen()}
        ref={menu.setTrigger}
        onClick={(e) => menu.toggle(e)}
      >
        <span class="action-dropdown-trigger-content">{props.trigger}</span>
        <span class="action-dropdown-caret" aria-hidden="true">
          <ChevronDownIcon />
        </span>
      </button>

      <Show when={menu.isOpen() && menu.anchor()}>
        <Portal>
          <div
            ref={menu.setMenu}
            class="action-dropdown-menu portal"
            style={{
              position: 'fixed',
              top: `${menu.anchor()!.top}px`,
              left: `${menu.anchor()!.left}px`,
              transform: 'translateX(-100%)',
              'z-index': '1000',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              class="action-dropdown-menu-item action-dropdown-menu-default"
              onClick={() => {
                menu.close();
                props.onItem(-1);
              }}
            >
              <span class="action-dropdown-menu-icon">{props.defaultIcon ?? <TerminalIcon />}</span>
              <span class="action-dropdown-menu-label">{props.defaultLabel}</span>
              <Show when={props.defaultSubmit}>
                <span class="action-dropdown-menu-submit" aria-hidden="true">
                  ⏎
                </span>
              </Show>
              <span class="action-dropdown-menu-badge">default</span>
            </button>
            <Show when={props.items.length > 0}>
              <div class="action-dropdown-menu-divider" />
            </Show>
            <For each={props.items}>
              {(item, idx) => (
                <button
                  type="button"
                  class="action-dropdown-menu-item"
                  onClick={() => {
                    menu.close();
                    props.onItem(idx());
                  }}
                >
                  <span class="action-dropdown-menu-bullet" aria-hidden="true">
                    ▸
                  </span>
                  <span class="action-dropdown-menu-label">{item.label}</span>
                  <Show when={item.launcher}>
                    <span
                      class="action-dropdown-menu-launcher"
                      title={`Spawns a fresh ${item.launcher} tab`}
                    >
                      → {item.launcher}
                    </span>
                  </Show>
                  <Show when={item.submit}>
                    <span class="action-dropdown-menu-submit" aria-hidden="true">
                      ⏎
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </>
  );
}
