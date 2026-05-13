import { For, Show } from 'solid-js';
import type { RawRepo, RawSubmoduleRepo } from '../../main/config-schema';
import { type BindTextFn, moveItem } from './data';

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
}) {
  const obj = (): RepoRowObject =>
    typeof props.entry === 'string' ? { name: props.entry } : props.entry;

  const patchObj = (patch: Partial<RepoRowObject>): Promise<void> =>
    props.onPatch({ ...obj(), ...patch });

  const submodules = (): RawSubmoduleRepo[] => obj().submodules ?? [];

  const updateSubmodules = (
    mutate: (subs: RawSubmoduleRepo[]) => RawSubmoduleRepo[],
  ): Promise<void> => patchObj({ submodules: mutate(submodules()) });

  return (
    <div class="settings-repo-row">
      <div class="settings-repo-row-head">
        <input
          type="text"
          class="settings-repo-name"
          placeholder="repo-name"
          {...props.bindText(
            `${props.idPrefix}.name`,
            () => obj().name,
            (v) => patchObj({ name: v }),
          )}
        />
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
      <div class="settings-repo-row-detail">
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
    </div>
  );
}
