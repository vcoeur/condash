import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { Agent } from '@shared/types';
import { createDropdownMenu } from '../../dropdown-menu';

/** One row of the primary spawn menu: the plain shell, a launchable agent, or
 *  the `More ▸` toggle that owns the overflow submenu. */
interface SpawnRow {
  label: string;
  /** Agent id to launch, or null for the plain shell. Unused for the More row. */
  value: string | null;
  /** Marks the `More ▸` toggle row (opens the overflow submenu, never spawns). */
  isMore?: boolean;
  /** Render a leading ★ — only when the favourites split is active. */
  isFavorite?: boolean;
}

/** Dropdown button + menu for spawning tabs. Replaces the fixed `+` / μ / λ
 *  button row with a single control that lists configured launchers.
 *
 *  When at least one agent is marked `favorite`, the menu lists `New shell` +
 *  the favourites (starred) directly and tucks the rest behind a `More ▸`
 *  fly-out submenu. With no favourites it lists every agent inline (the
 *  pre-favourites behaviour).
 *
 *  The menu is rendered with `position: fixed` (the `.portal` class via
 *  `createDropdownMenu`) so it escapes the strip's `overflow: auto` —
 *  otherwise the menu's full height gets clipped down to the strip's 32px
 *  box and the user sees only fragments of the menu items. The submenu is a
 *  nested `<ul>` *inside* that portal'd menu (not a second portal) so a click
 *  on it counts as inside `menuEl` and createDropdownMenu's outside-click
 *  dismissal leaves it open.
 *
 *  The overflow submenu stays `position: absolute` relative to the `More ▸`
 *  row, opening to its right by default (so a hover-open never drops an item
 *  under the cursor). `positionSubmenu` below picks a CSS `column-count` so a
 *  long agent list wraps into side-by-side columns that fit the viewport band
 *  (with a scroll fallback), and flips the fly-out left or up only when the
 *  default placement would spill past a viewport edge.
 */
export function SpawnDropdown(props: {
  agents: readonly Agent[];
  onSpawn: (agentId: string | null) => void;
}) {
  const menu = createDropdownMenu({ align: 'left' });
  const [highlighted, setHighlighted] = createSignal(0);
  const [submenuOpen, setSubmenuOpen] = createSignal(false);
  const [subHighlighted, setSubHighlighted] = createSignal(0);
  // The `More ▸` row and its fly-out, for viewport-aware placement.
  let moreRowEl: HTMLLIElement | undefined;
  let submenuEl: HTMLUListElement | undefined;

  const favorites = () => props.agents.filter((a) => a.favorite);
  const others = () => props.agents.filter((a) => !a.favorite);
  // No favourite designated → list every agent inline, no split (back-compat).
  const usesFavorites = () => favorites().length > 0;
  const primaryAgents = () => (usesFavorites() ? favorites() : props.agents);
  const hasMore = () => usesFavorites() && others().length > 0;

  const rows = (): SpawnRow[] => {
    const list: SpawnRow[] = [{ label: 'New shell', value: null }];
    for (const agent of primaryAgents()) {
      list.push({ label: agent.label, value: agent.id, isFavorite: usesFavorites() });
    }
    if (hasMore()) list.push({ label: 'More', value: null, isMore: true });
    return list;
  };

  // Reset transient menu state whenever the menu closes (select, outside click,
  // or the global Escape handler in createDropdownMenu) so a re-open starts at
  // the top with the submenu collapsed.
  createEffect(() => {
    if (!menu.isOpen()) {
      setSubmenuOpen(false);
      setHighlighted(0);
      setSubHighlighted(0);
    }
  });

  // Keep the overflow fly-out fully inside the viewport. The submenu is
  // `position: absolute` relative to the `More ▸` row, so its inline top/left
  // are offsets *from that row*. First we choose a `column-count` so a long
  // list wraps into side-by-side columns that each fit the viewport band; then
  // we cap max-height/-width and measure the default right-opening placement,
  // flipping only when it would spill past an edge (clearing the inline offset
  // to fall back to the CSS defaults when it already fits).
  const positionSubmenu = () => {
    const submenu = submenuEl;
    const moreRow = moreRowEl;
    if (!submenu || !moreRow) return;
    const margin = 8;
    const gap = 2;
    const availableHeight = window.innerHeight - margin * 2;
    // Reset to one column + no caps to measure the natural single-column list.
    submenu.style.columnCount = '';
    submenu.style.maxHeight = '';
    submenu.style.left = '';
    submenu.style.top = '';
    const itemCount = submenu.childElementCount;
    const naturalHeight = submenu.scrollHeight;
    // Wrap into as many columns as it takes to keep each within the band. CSS
    // multicol then balances the rows and sizes the box to fit every column.
    if (itemCount > 0 && naturalHeight > availableHeight) {
      const rowHeight = naturalHeight / itemCount;
      const perColumn = Math.max(1, Math.floor(availableHeight / rowHeight));
      submenu.style.columnCount = `${Math.ceil(itemCount / perColumn)}`;
    }
    submenu.style.maxHeight = `${availableHeight}px`;
    submenu.style.maxWidth = `${window.innerWidth - margin * 2}px`;
    // Reading back forces a synchronous layout reflecting the caps + columns.
    const moreRect = moreRow.getBoundingClientRect();
    let submenuRect = submenu.getBoundingClientRect();
    // Horizontal: keep opening right if it fits; else flip to the left of the
    // row; else (wider than either side) pin to the left viewport margin.
    if (submenuRect.right > window.innerWidth - margin) {
      if (moreRect.left - gap - submenuRect.width >= margin) {
        submenu.style.left = `${-(submenuRect.width + gap)}px`;
      } else {
        submenu.style.left = `${margin - moreRect.left}px`;
      }
      submenuRect = submenu.getBoundingClientRect();
    }
    // Vertical: flip up when the bottom would cross the viewport. The capped
    // height guarantees the flipped top still clears the top margin.
    if (submenuRect.bottom > window.innerHeight - margin) {
      const desiredTop = Math.max(margin, window.innerHeight - margin - submenuRect.height);
      submenu.style.top = `${desiredTop - moreRect.top}px`;
    }
  };

  // Re-place the fly-out whenever it opens, after the browser has laid out the
  // freshly-rendered <li> list (hence rAF).
  createEffect(() => {
    if (submenuOpen()) requestAnimationFrame(positionSubmenu);
  });

  // Keep it pinned to its row if the window resizes or the strip scrolls while
  // open (mirrors createDropdownMenu's primary-menu reflow).
  onMount(() => {
    const reflow = () => {
      if (submenuOpen()) positionSubmenu();
    };
    window.addEventListener('resize', reflow, true);
    window.addEventListener('scroll', reflow, true);
    onCleanup(() => {
      window.removeEventListener('resize', reflow, true);
      window.removeEventListener('scroll', reflow, true);
    });
  });

  const openSubmenu = () => {
    setSubHighlighted(0);
    setSubmenuOpen(true);
  };

  const select = (value: string | null) => {
    props.onSpawn(value);
    menu.close();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!menu.isOpen()) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setHighlighted(0);
        menu.open();
      }
      return;
    }
    // Submenu has keyboard focus: cycle the overflow agents; ArrowLeft returns
    // to the primary menu. (Escape closes everything via createDropdownMenu.)
    if (submenuOpen()) {
      const subCount = others().length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSubHighlighted((h) => (h + 1) % subCount);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSubHighlighted((h) => (h - 1 + subCount) % subCount);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        select(others()[subHighlighted()].id);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Right is a no-op here; Left collapses back to the primary menu.
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setSubmenuOpen(false);
        }
      }
      return;
    }
    const list = rows();
    const count = list.length;
    const current = list[highlighted()];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => (h + 1) % count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => (h - 1 + count) % count);
    } else if (e.key === 'ArrowRight' && current?.isMore) {
      e.preventDefault();
      openSubmenu();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (current?.isMore) openSubmenu();
      else select(current?.value ?? null);
    }
  };

  return (
    <>
      <button
        ref={menu.setTrigger}
        class="terminal-tab-dropdown"
        aria-haspopup="listbox"
        aria-expanded={menu.isOpen()}
        aria-label="Spawn new terminal"
        onClick={(e) => {
          setHighlighted(0);
          menu.toggle(e);
        }}
        onKeyDown={handleKeyDown}
      >
        <span>New shell</span>
        <span aria-hidden="true">▼</span>
      </button>
      <Show when={menu.isOpen() && menu.anchor()}>
        {/* Portal to document.body so the menu escapes `.terminal-pane`'s
         *  `contain: layout paint` — that containment makes
         *  `position: fixed` anchor to the pane instead of the viewport,
         *  which would render the menu hundreds of pixels off. */}
        <Portal>
          <ul
            ref={menu.setMenu}
            class="terminal-tab-dropdown-menu portal"
            role="listbox"
            aria-label="Terminal spawn options"
            style={{
              top: `${menu.anchor()!.top}px`,
              left: `${menu.anchor()!.left}px`,
            }}
          >
            <For each={rows()}>
              {(row, idx) => (
                <li
                  ref={(el) => {
                    if (row.isMore) moreRowEl = el;
                  }}
                  role="option"
                  class={row.isMore ? 'terminal-tab-dropdown-more' : undefined}
                  aria-haspopup={row.isMore ? 'true' : undefined}
                  aria-expanded={row.isMore ? submenuOpen() : undefined}
                  aria-selected={highlighted() === idx()}
                  classList={{ highlighted: highlighted() === idx() }}
                  onMouseEnter={() => {
                    setHighlighted(idx());
                    if (row.isMore) openSubmenu();
                    else setSubmenuOpen(false);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (row.isMore) {
                      // Idempotent open — hover already opens it, so a click
                      // (hover + press) must not toggle it back shut. Collapse
                      // via leaving the row, Escape, or ArrowLeft.
                      setHighlighted(idx());
                      openSubmenu();
                    } else {
                      select(row.value);
                    }
                  }}
                >
                  <Show
                    when={row.isMore}
                    fallback={
                      <>
                        <Show when={row.isFavorite}>
                          <span class="terminal-tab-dropdown-star" aria-hidden="true">
                            ★
                          </span>
                        </Show>
                        {row.label}
                      </>
                    }
                  >
                    <span>{row.label}</span>
                    <span aria-hidden="true">▸</span>
                    <Show when={submenuOpen()}>
                      <ul
                        ref={(el) => (submenuEl = el)}
                        class="terminal-tab-dropdown-submenu"
                        role="listbox"
                        aria-label="More agents"
                      >
                        <For each={others()}>
                          {(agent, subIdx) => (
                            <li
                              role="option"
                              aria-selected={subHighlighted() === subIdx()}
                              classList={{ highlighted: subHighlighted() === subIdx() }}
                              onMouseEnter={() => setSubHighlighted(subIdx())}
                              onClick={(e) => {
                                e.stopPropagation();
                                select(agent.id);
                              }}
                            >
                              {agent.label}
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Portal>
      </Show>
    </>
  );
}
