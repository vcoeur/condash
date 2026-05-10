import { createEffect, createSignal, For, Show } from 'solid-js';
import type { DirtyDetails, Worktree } from '@shared/types';
import { createPositionedPopover } from '../../popover';
import { DirtyFileRow, UnpushedCommitRow } from './dirty-rows';

/**
 * Per-branch info badges + shared click-to-inspect popover. Renders up to
 * two badges side by side on a branch row:
 *
 *   - **Dirty badge** — shown when the worktree has uncommitted changes
 *     (`wt.dirty > 0`). Click opens the popover.
 *   - **Upstream badge** — shown when the branch has an upstream tracking
 *     ref (`wt.upstream != null`). Renders a count-bearing pill (`↑N`)
 *     when ahead of upstream, or a faint `↑` glyph when in sync. Only
 *     clickable when ahead > 0; the in-sync glyph is purely informational.
 *
 * Both badges share a single popover. The popover fetches a
 * `DirtyDetails` payload — which carries both the dirty-file list and the
 * unpushed-commit list — via one round-trip, then renders whichever
 * sections are non-empty. Clicking either badge anchors the popover to
 * that badge.
 *
 * The popover is a portaled `position: fixed` overlay so it always paints
 * above neighbouring cards (same recipe as the open_with menu).
 */
export function BranchInfoBadges(props: { worktree: Worktree; subtreeScoped: boolean }) {
  const [details, setDetails] = createSignal<DirtyDetails | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let dirtyRef: HTMLButtonElement | undefined;
  let upstreamRef: HTMLButtonElement | undefined;
  let popoverRef: HTMLDivElement | undefined;

  const hasDirty = (): boolean => (props.worktree.dirty ?? 0) > 0;
  const upstream = (): Worktree['upstream'] => props.worktree.upstream ?? null;
  const ahead = (): number => upstream()?.ahead ?? 0;
  const upstreamShown = (): boolean => upstream() != null;
  const upstreamClickable = (): boolean => ahead() > 0;

  const popover = createPositionedPopover({
    popoverRef: () => popoverRef,
    triggerRefs: () => [dirtyRef, upstreamRef],
    onClose: () => {
      popover.setOpen(false);
      setError(null);
    },
  });

  // Re-anchor on async content arrival: the dirty-details fetch grows
  // the popover after the first paint, and the flip-above check needs
  // the real height to make the right call.
  createEffect(() => {
    details();
    error();
    if (popover.open() && popoverRef) requestAnimationFrame(popover.reposition);
  });

  const toggle = async (which: 'dirty' | 'upstream', e: MouseEvent): Promise<void> => {
    e.stopPropagation();
    popover.setActiveTrigger(which === 'dirty' ? (dirtyRef ?? null) : (upstreamRef ?? null));
    if (popover.open()) {
      popover.setOpen(false);
      setError(null);
      return;
    }
    popover.reposition();
    popover.setOpen(true);
    setError(null);
    try {
      const next = await window.condash.getDirtyDetails(props.worktree.path, {
        scopeToSubtree: props.subtreeScoped,
      });
      // The popover may have been dismissed (or this card unmounted)
      // while getDirtyDetails was in flight — drop the late result so
      // setDetails / setError don't write into a disposed scope.
      if (!popover.open()) return;
      setDetails(next);
      if (!next) setError('git status failed for this path');
    } catch (err) {
      if (!popover.open()) return;
      setError((err as Error).message);
    }
  };

  return (
    <>
      <Show when={hasDirty()}>
        <button
          ref={(el) => (dirtyRef = el)}
          type="button"
          class="branch-dirty"
          onClick={(e) => void toggle('dirty', e)}
          aria-haspopup="dialog"
          aria-expanded={popover.open()}
          title="Show dirty files"
        >
          {props.worktree.dirty} dirty
        </button>
      </Show>
      <Show when={upstreamShown()}>
        <Show
          when={upstreamClickable()}
          fallback={
            <span
              class="branch-upstream insync"
              title={`In sync with ${upstream()?.upstreamRef ?? 'upstream'}`}
              aria-label={`In sync with ${upstream()?.upstreamRef ?? 'upstream'}`}
            >
              ↑
            </span>
          }
        >
          <button
            ref={(el) => (upstreamRef = el)}
            type="button"
            class="branch-upstream ahead"
            onClick={(e) => void toggle('upstream', e)}
            aria-haspopup="dialog"
            aria-expanded={popover.open()}
            title={`${ahead()} commit${ahead() === 1 ? '' : 's'} not pushed to ${upstream()?.upstreamRef ?? 'upstream'}`}
          >
            ↑{ahead()}
          </button>
        </Show>
      </Show>
      <Show when={popover.open() && popover.anchor()}>
        <div
          ref={(el) => {
            popoverRef = el;
            if (el) requestAnimationFrame(popover.reposition);
          }}
          class="branch-dirty-popover"
          role="dialog"
          aria-label={`Branch info for ${props.worktree.branch ?? '(no branch)'}`}
          style={{
            top: `${popover.anchor()!.top}px`,
            left: `${popover.anchor()!.left}px`,
          }}
        >
          <header class="branch-dirty-popover-head">
            <span class="branch-dirty-popover-branch">
              {props.worktree.branch ?? '(no branch)'}
            </span>
            <span class="branch-dirty-popover-path" title={props.worktree.path}>
              {props.worktree.path}
            </span>
          </header>
          <Show when={error()}>
            <p class="branch-dirty-popover-error">{error()}</p>
          </Show>
          <Show when={details()}>
            {(d) => (
              <>
                <Show when={d().files.length > 0}>
                  <ul class="branch-dirty-popover-files">
                    <For each={d().files}>{(f) => <DirtyFileRow file={f} />}</For>
                    <Show when={d().truncated}>
                      <li class="branch-dirty-popover-truncated">
                        … +{d().totalCount - d().files.length} more
                      </li>
                    </Show>
                  </ul>
                  <Show when={d().totalAdded > 0 || d().totalDeleted > 0}>
                    <footer class="branch-dirty-popover-totals">
                      {`${d().totalCount} file${d().totalCount === 1 ? '' : 's'} changed`}
                      <Show when={d().totalAdded > 0}>
                        <span class="branch-dirty-popover-added">{`, +${d().totalAdded}`}</span>
                      </Show>
                      <Show when={d().totalDeleted > 0}>
                        <span class="branch-dirty-popover-deleted">{`, −${d().totalDeleted}`}</span>
                      </Show>
                    </footer>
                  </Show>
                </Show>
                <Show when={d().unpushedCommits.length > 0}>
                  <section class="branch-popover-section">
                    <h3 class="branch-popover-section-head">
                      Unpushed commits
                      <Show when={d().upstream}>
                        <span class="branch-popover-section-sub">
                          {' '}
                          → {d().upstream!.upstreamRef}
                        </span>
                      </Show>
                    </h3>
                    <ul class="branch-popover-commits">
                      <For each={d().unpushedCommits}>
                        {(c) => <UnpushedCommitRow commit={c} />}
                      </For>
                      <Show when={d().unpushedTruncated}>
                        <li class="branch-dirty-popover-truncated">
                          … +{(d().upstream?.ahead ?? 0) - d().unpushedCommits.length} more
                        </li>
                      </Show>
                    </ul>
                  </section>
                </Show>
                <Show when={d().files.length === 0 && d().unpushedCommits.length === 0}>
                  <p class="branch-dirty-popover-empty">
                    No dirty files{' '}
                    <Show when={d().upstream}>and in sync with {d().upstream!.upstreamRef}</Show>.
                  </p>
                </Show>
              </>
            )}
          </Show>
        </div>
      </Show>
    </>
  );
}
