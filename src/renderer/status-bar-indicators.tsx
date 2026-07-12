/**
 * Status-bar sync indicators — the two live widgets that replaced the static
 * `auto-sync on` badge:
 *
 *   - **Auto-sync**: a state dot + label (synced / N to sync / syncing / failed
 *     / off), a "Sync now" button (one immediate sweep via `autoSyncNow`), and a
 *     click-to-open popover listing the conception's most recent commits.
 *   - **Shipped skills**: a state dot + label (synced / needs install), with an
 *     "Install" action that runs `condash skills install` in a fresh terminal
 *     tab when the shipped skills are missing or outdated.
 *
 * Both read read-only snapshots on a poll + on the `auto-sync-status` push, so
 * they stay live without owning any engine state.
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { AutoSyncStatus, SkillsSyncStatus, SyncStatusSnapshot } from '@shared/types';
import { createPositionedPopover } from './popover';
import { Button } from './actions';

/** How often to re-read the snapshots. Commit cadence is minutes; the push
 *  refreshes the sync side the instant a sweep lands, so 20 s is plenty. */
const POLL_MS = 20_000;
/** Command the Install button runs — matches the Skills-pane hint. */
const SKILLS_INSTALL_CMD = 'condash skills install';

type SyncState = 'off' | 'syncing' | 'error' | 'pending' | 'synced' | 'unknown';
type SkillsState = 'synced' | 'update' | 'install' | 'unknown';

interface StatusBarIndicatorsProps {
  /** Active conception path — a change re-reads both snapshots. */
  conceptionPath: () => string | null;
  /** Run `condash skills install` (in a terminal tab); wired to the bridge. */
  onInstallSkills: () => void;
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export function StatusBarIndicators(props: StatusBarIndicatorsProps) {
  const [sync, setSync] = createSignal<SyncStatusSnapshot | null>(null);
  const [auto, setAuto] = createSignal<AutoSyncStatus | null>(null);
  const [skills, setSkills] = createSignal<SkillsSyncStatus | null>(null);
  const [busy, setBusy] = createSignal(false);

  const refreshSync = async (): Promise<void> => {
    try {
      setSync(await window.condash.syncStatusSnapshot());
    } catch {
      /* keep the last snapshot — a transient read must not blank the bar */
    }
  };
  const refreshSkills = async (): Promise<void> => {
    try {
      setSkills(await window.condash.skillsSyncStatus());
    } catch {
      /* keep the last snapshot */
    }
  };

  // Seed + subscribe to the engine push. A completed sweep changes the pending
  // count and the commit list, so refresh the snapshot when the push lands.
  onMount(() => {
    void window.condash.autoSyncGetStatus().then(setAuto);
    const unsubscribe = window.condash.onAutoSyncStatus((status) => {
      setAuto(status);
      void refreshSync();
    });
    onCleanup(unsubscribe);
  });

  // Re-read both snapshots on mount and whenever the conception switches.
  createEffect(() => {
    props.conceptionPath();
    void refreshSync();
    void refreshSkills();
  });

  onMount(() => {
    const timer = setInterval(() => {
      void refreshSync();
      void refreshSkills();
    }, POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  const syncState = (): SyncState => {
    const a = auto();
    const s = sync();
    if (busy() || a?.phase === 'syncing') return 'syncing';
    if (a?.phase === 'error') return 'error';
    if (s && (s.pendingCount > 0 || s.ahead > 0)) return 'pending';
    if (a && !a.enabled) return 'off';
    if (!s && !a) return 'unknown';
    return 'synced';
  };

  const syncLabel = (): string => {
    const s = sync();
    switch (syncState()) {
      case 'syncing':
        return 'Syncing…';
      case 'error':
        return 'Sync failed';
      case 'off':
        return 'Auto-sync off';
      case 'pending': {
        const pending = s?.pendingCount ?? 0;
        if (pending > 0) return `${pending} to sync`;
        return `${s?.ahead ?? 0} to push`;
      }
      case 'synced':
        return 'Synced';
      default:
        return 'Sync';
    }
  };

  const syncTitle = (): string => {
    const s = sync();
    const a = auto();
    const parts: string[] = [];
    if (s) {
      parts.push(`${s.pendingCount} uncommitted`);
      if (s.hasUpstream) parts.push(`${s.ahead} unpushed`);
    }
    parts.push(a?.enabled ? 'auto-sync on' : 'auto-sync off');
    return `${parts.join(' · ')} — click for recent commits`;
  };

  const skillsState = (): SkillsState => {
    const k = skills();
    if (!k) return 'unknown';
    if (!k.installed) return 'install';
    if (k.needsInstall > 0) return 'update';
    return 'synced';
  };

  const skillsLabel = (): string => {
    switch (skillsState()) {
      case 'install':
        return 'Skills: install';
      case 'update':
        return 'Skills: update';
      default:
        return 'Skills';
    }
  };

  const skillsTitle = (): string => {
    const k = skills();
    if (!k) return 'Shipped skills';
    if (!k.installed) return 'condash skills not installed here';
    if (k.needsInstall > 0) {
      return `${k.needsInstall} shipped skill file${k.needsInstall === 1 ? '' : 's'} missing or outdated`;
    }
    const edited = k.edited > 0 ? ` (${k.edited} locally edited)` : '';
    return `Shipped skills up to date${edited}`;
  };

  const showInstall = (): boolean => skillsState() === 'install' || skillsState() === 'update';

  const syncNow = async (): Promise<void> => {
    setBusy(true);
    try {
      setAuto(await window.condash.autoSyncNow());
      await refreshSync();
    } catch (err) {
      props.flashToast(`Sync failed: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const installSkills = (): void => {
    props.onInstallSkills();
    // The command runs asynchronously in its terminal tab; nudge the indicator
    // a couple of times after it likely finished (the poll covers the rest).
    setTimeout(() => void refreshSkills(), 4_000);
    setTimeout(() => void refreshSkills(), 12_000);
  };

  // Commits popover.
  let pillRef: HTMLButtonElement | undefined;
  let popRef: HTMLDivElement | undefined;
  const popover = createPositionedPopover({
    popoverRef: () => popRef,
    triggerRefs: () => [pillRef],
    onClose: () => popover.setOpen(false),
  });
  const toggleCommits = (): void => {
    if (popover.open()) {
      popover.setOpen(false);
      return;
    }
    popover.setActiveTrigger(pillRef ?? null);
    popover.setOpen(true);
    void refreshSync();
    queueMicrotask(() => popover.reposition());
  };

  const recentCommits = createMemo(() => sync()?.recentCommits ?? []);

  return (
    <>
      <span class="status-group">
        <button
          type="button"
          ref={pillRef}
          class="status-pill"
          classList={{ 'status-pill--open': popover.open() }}
          onClick={toggleCommits}
          title={syncTitle()}
          aria-label={syncTitle()}
        >
          <span class={`status-dot status-dot--${syncState()}`} />
          <span class="status-pill-label">{syncLabel()}</span>
        </button>
        <button
          type="button"
          class="status-bar-action"
          onClick={() => void syncNow()}
          disabled={busy()}
          title="Commit & push settled changes now"
        >
          {busy() ? 'Syncing…' : 'Sync now'}
        </button>
      </span>

      <span class="status-group">
        <span
          class="status-pill status-pill--static"
          title={skillsTitle()}
          aria-label={skillsTitle()}
        >
          <span class={`status-dot status-dot--skills-${skillsState()}`} />
          <span class="status-pill-label">{skillsLabel()}</span>
        </span>
        <Show when={showInstall()}>
          <button
            type="button"
            class="status-bar-action"
            onClick={installSkills}
            title={`Run \`${SKILLS_INSTALL_CMD}\``}
          >
            Install
          </button>
        </Show>
      </span>

      <Show when={popover.open()}>
        <div
          ref={popRef}
          class="status-commits"
          style={{
            top: `${popover.anchor()?.top ?? 0}px`,
            left: `${popover.anchor()?.left ?? 0}px`,
          }}
          role="dialog"
          aria-label="Recent commits"
        >
          <div class="status-commits-head">
            <span>Recent commits</span>
            <Button
              type="button"
              variant="default"
              disabled={busy()}
              onClick={() => void syncNow()}
            >
              {busy() ? 'Syncing…' : 'Sync now'}
            </Button>
          </div>
          <Show
            when={recentCommits().length > 0}
            fallback={<div class="status-commits-empty">No commits yet.</div>}
          >
            <ul class="status-commits-list">
              <For each={recentCommits()}>
                {(commit) => (
                  <li
                    class="status-commit"
                    classList={{ 'status-commit--unpushed': !commit.pushed }}
                  >
                    <code class="status-commit-sha">{commit.sha}</code>
                    <span class="status-commit-subject" title={commit.subject}>
                      {commit.subject}
                    </span>
                    <span class="status-commit-meta">
                      <Show when={!commit.pushed}>
                        <span class="status-commit-tag">unpushed</span>
                      </Show>
                      {commit.relativeTime}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
    </>
  );
}
