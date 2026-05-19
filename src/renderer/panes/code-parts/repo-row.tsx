import { createMemo, For, Show } from 'solid-js';
import type { OpenWithSlotKey, OpenWithSlots, RepoEntry, Worktree } from '@shared/types';
import { BranchActions } from './branch-actions';
import { BranchInfoBadges } from './branch-badges';
import { filterWorktrees, orderedWorktrees, type RepoStatus } from './data';
import { RepoCardMenu } from './repo-menu';

export function RepoRow(props: {
  repo: RepoEntry;
  slots: OpenWithSlots;
  /** True when at least one terminal session is currently running for this repo. */
  live?: boolean;
  /** Branch name of the live session, when known — surfaced on the card face
   * so the user can see what's running at a glance. */
  liveBranch?: string | null;
  /** Branch names pinned by the Code-pane top-of-pane filter. The primary
   *  worktree row is always rendered regardless of this set; non-primary
   *  rows render only when their branch name is in here. An empty set
   *  collapses every card to its primary row alone. */
  selectedBranches: ReadonlySet<string>;
  /** When true, `selectedBranches` is shadowed and every worktree shows
   *  (the "All (sticky)" mode from issue #169). */
  stickyAllBranches: boolean;
  onOpen: (path: string) => void;
  onLaunch: (slot: OpenWithSlotKey, path: string) => void;
  onForceStop: (repo: RepoEntry) => void;
  onStop: (repo: RepoEntry) => void;
  onRun: (repo: RepoEntry, worktree?: Worktree) => void;
  onOpenInTerm: (repo: RepoEntry, worktree: Worktree) => void;
}) {
  const displayName = (): string => {
    if (props.repo.parent && props.repo.name.startsWith(`${props.repo.parent}/`)) {
      return props.repo.name.slice(props.repo.parent.length + 1);
    }
    return props.repo.name;
  };

  /** Card title — prefers `label` from `condash.json` when set, falls
   * back to the directory name. */
  const cardTitle = (): string => props.repo.label ?? displayName();

  /** Secondary directory-name pill: only when a label is set AND it actually
   * differs from the directory name (otherwise the pill would just repeat the
   * title). */
  const secondaryName = (): string | null => {
    if (!props.repo.label) return null;
    const name = displayName();
    return props.repo.label === name ? null : name;
  };

  const isPlainDirectory = (): boolean => !props.repo.missing && props.repo.isGit === false;

  const branchStatus = (wt: Worktree): RepoStatus => {
    if (props.repo.missing) return 'missing';
    if (wt.dirty == null) return 'unknown';
    return wt.dirty === 0 ? 'clean' : 'dirty';
  };

  const visibleWorktrees = createMemo(() =>
    filterWorktrees(orderedWorktrees(props.repo), props.selectedBranches, props.stickyAllBranches),
  );

  const hasRun = (): boolean => !props.repo.missing && !!props.repo.hasRun;

  const liveBranchLabel = (): string | null => {
    if (!props.live) return null;
    if (props.liveBranch) return props.liveBranch;
    // No branch known — fall back to a generic running marker so the card
    // still surfaces the live state on the face.
    return '(running)';
  };

  const branchLabel = (wt: Worktree): string => {
    if (isPlainDirectory()) return 'Directory';
    return wt.branch ?? '(no branch)';
  };

  const branchTitle = (wt: Worktree): string => {
    if (isPlainDirectory()) return 'Plain directory';
    return wt.branch ? wt.branch : 'Detached HEAD — git is on a specific commit, not a branch';
  };

  return (
    <article
      class="repo-row"
      classList={{
        missing: props.repo.missing,
      }}
    >
      <header class="repo-head">
        <span style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}>
          <span class="repo-name">{cardTitle()}</span>
          <Show when={secondaryName()}>
            <span class="repo-dirname" title={`Directory: ${displayName()}`}>
              {secondaryName()}
            </span>
          </Show>
          <Show when={liveBranchLabel()}>
            <span
              class="repo-live-branch"
              title={`Running: ${liveBranchLabel()}`}
              aria-label={`Running on ${liveBranchLabel()}`}
            >
              <span class="repo-live-dot-inline" aria-hidden="true" />
              <span class="repo-live-branch-label">{liveBranchLabel()}</span>
            </span>
          </Show>
        </span>
        <span class="spacer" />
        <Show when={props.repo.parent}>
          <span class="repo-kind-tag" title="Submodule, configured under repositories">
            submodule
          </span>
        </Show>
        <RepoCardMenu repo={props.repo} onForceStop={props.onForceStop} />
      </header>
      <ul class="branches">
        <For each={visibleWorktrees()}>
          {(wt) => (
            <li
              class="branch-row"
              data-status={branchStatus(wt)}
              data-primary={wt.primary ? 'true' : undefined}
            >
              <span class="branch-dot" aria-hidden="true" />
              <span class="branch-name" title={branchTitle(wt)}>
                {branchLabel(wt)}
              </span>
              <Show when={!isPlainDirectory()}>
                <BranchInfoBadges worktree={wt} subtreeScoped={!!props.repo.parent} />
              </Show>
              <Show when={props.live && (props.liveBranch ?? null) === (wt.branch ?? null)}>
                <span class="branch-live-dot" title="Running" aria-label="Running" />
              </Show>
              <span class="spacer" />
              <BranchActions
                repo={props.repo}
                worktree={wt}
                slots={props.slots}
                hasRun={hasRun()}
                running={!!props.live && (props.liveBranch ?? null) === (wt.branch ?? null)}
                onLaunch={props.onLaunch}
                onRun={props.onRun}
                onStop={props.onStop}
                onOpenInTerm={props.onOpenInTerm}
                onOpen={props.onOpen}
              />
            </li>
          )}
        </For>
      </ul>
    </article>
  );
}
