import { createSignal, For, Show } from 'solid-js';
import type { RawRepo, RawSubmoduleRepo } from '../../main/config-schema';
import { type BindTextFn, type DndHandlers, moveItem } from './data';

const REPO_ROW_OPEN_KEY = 'condash:settings-modal:repo-row-open';

function readRepoOpen(id: string, defaultOpen: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(REPO_ROW_OPEN_KEY);
    if (!raw) return defaultOpen;
    const map = JSON.parse(raw) as Record<string, boolean>;
    return typeof map[id] === 'boolean' ? map[id] : defaultOpen;
  } catch {
    return defaultOpen;
  }
}

function writeRepoOpen(id: string, open: boolean): void {
  try {
    const raw = window.localStorage.getItem(REPO_ROW_OPEN_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    map[id] = open;
    window.localStorage.setItem(REPO_ROW_OPEN_KEY, JSON.stringify(map));
  } catch {
    // Same private-mode fallback as Subgroup — collapse state simply
    // doesn't persist across reloads.
  }
}

/**
 * One row in a repositories list. Always shows the full editable surface
 * (name, label, run, force_stop, sub repos) regardless of how the entry
 * is currently serialized — string-form entries are coerced to object on
 * render. The recursive `submodules` UI lets a parent repo carry its own
 * nested list with the same shape. Section markers (`{ section: … }`) are
 * rendered by `<SectionRow>` and never reach this component — the parent
 * uses an `isSectionMarker` guard.
 */
type RepoRowEntry = Exclude<RawRepo, { section: string }>;
type RepoRowObject = Exclude<RepoRowEntry, string>;

export function RepoRow(props: {
  entry: RepoRowEntry;
  idPrefix: string;
  index: number;
  total: number;
  bindText: BindTextFn;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onPatch: (next: RawRepo) => Promise<void>;
  /** Optional drag-and-drop callbacks. Submodule rows pass `undefined` —
   *  DnD only happens at the top level for now. */
  dnd?: DndHandlers;
}) {
  const obj = (): RepoRowObject =>
    typeof props.entry === 'string' ? { name: props.entry } : props.entry;

  const patchObj = (patch: Partial<RepoRowObject>): Promise<void> =>
    props.onPatch({ ...obj(), ...patch });

  const submodules = (): RawSubmoduleRepo[] => obj().submodules ?? [];

  /** True when the row has anything *other than* its locator filled in. A
   *  blank row may omit name + path (a not-yet-saved placeholder); a row with
   *  a label / run / etc. but neither name nor path is the "required" error
   *  condition the asterisk + red border flag — an entry needs at least one
   *  locator (`name` or `path`). */
  const hasContent = (): boolean => {
    const o = obj();
    return Boolean(
      o.label || o.run || o.force_stop || o.install || o.pinned_branch || o.env?.length,
    );
  };
  const nameMissing = (): boolean => hasContent() && !obj().name?.trim() && !obj().path?.trim();

  // Collapse state per row, keyed by the row's idPrefix (which is stable
  // for the lifetime of the conception's repository list — adding/
  // removing entries shifts indices, but each row's open state is
  // visually scoped enough that drift is acceptable).
  const [open, setOpen] = createSignal(readRepoOpen(props.idPrefix, false));
  // Force-open when the row is invalid so the user sees the affected fields
  // without an extra click; same for actively-dragging rows so the drag
  // image is the summary header (not the expanded form).
  const effectiveOpen = (): boolean => open() && !nameMissing();
  const toggleOpen = (): void => {
    const next = !open();
    setOpen(next);
    writeRepoOpen(props.idPrefix, next);
  };

  const summary = (): string => {
    const o = obj();
    const parts: string[] = [];
    if (o.name) parts.push(o.name);
    else parts.push('(unnamed)');
    if (o.path && o.path !== o.name) parts.push(`· ${o.path}`);
    if (o.run) parts.push(`· ${o.run}`);
    return parts.join(' ');
  };

  const updateSubmodules = (
    mutate: (subs: RawSubmoduleRepo[]) => RawSubmoduleRepo[],
  ): Promise<void> => patchObj({ submodules: mutate(submodules()) });

  return (
    <div
      class="settings-repo-row"
      classList={{
        'settings-repo-row--dragging': props.dnd?.isDragging(props.index) ?? false,
        'settings-repo-row--drop-target': props.dnd?.isDropTarget(props.index) ?? false,
        'settings-repo-row--collapsed': !effectiveOpen(),
      }}
      data-invalid={nameMissing() ? 'true' : undefined}
      draggable={props.dnd ? true : undefined}
      onDragStart={(e) => {
        if (!props.dnd) return;
        e.dataTransfer?.setData('text/plain', String(props.index));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        props.dnd.onDragStart(props.index);
      }}
      onDragOver={(e) => {
        if (!props.dnd) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        props.dnd.onDragOver(props.index);
      }}
      onDrop={(e) => {
        if (!props.dnd) return;
        e.preventDefault();
        props.dnd.onDrop(props.index);
      }}
      onDragEnd={() => props.dnd?.onDragEnd()}
    >
      <div class="settings-repo-row-head">
        <Show when={props.dnd}>
          <span class="settings-repo-drag-handle" title="Drag to reorder" aria-hidden="true">
            ⋮⋮
          </span>
        </Show>
        <button
          type="button"
          class="settings-repo-toggle"
          aria-expanded={effectiveOpen()}
          aria-label={effectiveOpen() ? 'Collapse repository' : 'Expand repository'}
          onClick={toggleOpen}
        >
          <span class="settings-repo-toggle-chevron" aria-hidden="true">
            ▸
          </span>
        </button>
        <input
          type="text"
          class="settings-repo-name"
          classList={{ 'settings-input--invalid': nameMissing() }}
          placeholder="repo-name *"
          aria-invalid={nameMissing()}
          aria-label="Repository name (required)"
          {...props.bindText(
            `${props.idPrefix}.name`,
            () => obj().name,
            (v) => patchObj({ name: v }),
          )}
        />
        <Show when={!effectiveOpen()}>
          <span class="settings-repo-summary" onClick={toggleOpen}>
            {summary()}
          </span>
        </Show>
        <button
          class="modal-button"
          title="Move up"
          disabled={props.index === 0}
          onClick={() => props.onMove(-1)}
        >
          ↑
        </button>
        <button
          class="modal-button"
          title="Move down"
          disabled={props.index === props.total - 1}
          onClick={() => props.onMove(1)}
        >
          ↓
        </button>
        <button class="modal-button" title="Remove" onClick={() => props.onRemove()}>
          ×
        </button>
      </div>
      <Show when={nameMissing()}>
        <p class="settings-repo-name-error">
          A name or path is required when the row has other fields.
        </p>
      </Show>
      <Show when={effectiveOpen()}>
        <div class="settings-repo-row-detail">
          <label>
            <span>Path</span>
            <input
              type="text"
              placeholder="defaults to name"
              {...props.bindText(
                `${props.idPrefix}.path`,
                () => obj().path,
                (v) => patchObj({ path: v || undefined }),
              )}
            />
          </label>
          <label>
            <span>Handle</span>
            <input
              type="text"
              placeholder="defaults to name (e.g. kasten)"
              {...props.bindText(
                `${props.idPrefix}.handle`,
                () => obj().handle,
                (v) => patchObj({ handle: v || undefined }),
              )}
            />
          </label>
          <label>
            <span>Label</span>
            <input
              type="text"
              placeholder="Friendly subtitle"
              {...props.bindText(
                `${props.idPrefix}.label`,
                () => obj().label,
                (v) => patchObj({ label: v || undefined }),
              )}
            />
          </label>
          <label>
            <span>Run command</span>
            <input
              type="text"
              placeholder="make dev"
              {...props.bindText(
                `${props.idPrefix}.run`,
                () => obj().run,
                (v) => patchObj({ run: v || undefined }),
              )}
            />
          </label>
          <label>
            <span>Force stop</span>
            <input
              type="text"
              placeholder="fuser -k 5600/tcp"
              {...props.bindText(
                `${props.idPrefix}.force_stop`,
                () => obj().force_stop,
                (v) => patchObj({ force_stop: v || undefined }),
              )}
            />
          </label>
          <label>
            <span>Install command</span>
            <input
              type="text"
              placeholder="npm install"
              {...props.bindText(
                `${props.idPrefix}.install`,
                () => obj().install,
                (v) => patchObj({ install: v || undefined }),
              )}
            />
          </label>
          <label>
            <span>Pinned branch</span>
            <input
              type="text"
              placeholder="main"
              {...props.bindText(
                `${props.idPrefix}.pinned_branch`,
                () => obj().pinned_branch,
                (v) => patchObj({ pinned_branch: v || undefined }),
              )}
            />
          </label>
          <label>
            <span>Env files (comma-separated)</span>
            <input
              type="text"
              placeholder=".env, .env.local"
              {...props.bindText(
                `${props.idPrefix}.env`,
                () => (obj().env ?? []).join(', '),
                async (v) => {
                  const list = v
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                  await patchObj({ env: list.length > 0 ? list : undefined });
                },
              )}
            />
          </label>
        </div>
        <Show when={submodules().length > 0}>
          <div class="settings-repo-submodules">
            <span class="settings-field-label">Sub repos</span>
            <For each={submodules()}>
              {(sub, idx) => (
                <RepoRow
                  entry={sub}
                  idPrefix={`${props.idPrefix}.sub[${idx()}]`}
                  index={idx()}
                  total={submodules().length}
                  bindText={props.bindText}
                  onMove={(delta) => void updateSubmodules((all) => moveItem(all, idx(), delta))}
                  onRemove={() => void updateSubmodules((all) => all.filter((_, i) => i !== idx()))}
                  onPatch={(next) =>
                    updateSubmodules((all) =>
                      all.map((e, i) => (i === idx() ? (next as RawSubmoduleRepo) : e)),
                    )
                  }
                />
              )}
            </For>
          </div>
        </Show>
        <div class="settings-list-actions">
          <button
            class="modal-button"
            onClick={() => void updateSubmodules((all) => [...all, { name: '' }])}
          >
            + Add sub repo
          </button>
        </div>
      </Show>
    </div>
  );
}
