/**
 * Agents section of the Settings modal.
 *
 * Agents are an inheritable top-level key, so this ships on BOTH tabs (Global
 * → settings.json, Conception → condash.json), parameterised on `target` and
 * rendered twice — same pattern as Appearance / Terminal. Each agent is a
 * `{ id, label, command }` terminal launcher; the section is a vertical list of
 * cards with add / remove / move-up-down. No drag-and-drop (HTML5 DnD is broken
 * under condash's Wayland Ozone backend) — order via the ↑/↓ buttons.
 */

import { For, Show, type JSX } from 'solid-js';
import type { Agent } from '@shared/types';
import { type BindTextFn, type RawConfig, type SettingsTab } from './data';
import { FieldBadgeRow, type InheritanceState } from './badges';

/** Inheritance-badge inputs — passed on the conception side, omitted on global. */
interface BadgeProps {
  stateOf?: () => InheritanceState;
  removeOverride?: () => void;
}

interface AgentsSectionProps {
  target: SettingsTab;
  /** Draft-aware config getter for this tab's file. */
  parsed: () => RawConfig;
  bindText: BindTextFn;
  /** Stage a mutation to this tab's tree draft. */
  patch: (mutator: (config: RawConfig) => void) => Promise<void>;
  badge?: BadgeProps;
}

export function AgentsSection(props: AgentsSectionProps): JSX.Element {
  const agents = (): Agent[] => props.parsed().agents ?? [];

  const updateAgents = (mutate: (entries: Agent[]) => Agent[]): Promise<void> =>
    props.patch((c) => {
      c.agents = mutate((c.agents ?? []).slice());
    });

  const addAgent = (): Promise<void> =>
    updateAgents((entries) => [...entries, { id: '', label: '', command: '' }]);

  const removeAgent = (index: number): Promise<void> =>
    updateAgents((entries) => entries.filter((_, i) => i !== index));

  const moveAgent = (index: number, delta: -1 | 1): Promise<void> =>
    updateAgents((entries) => {
      const target = index + delta;
      if (target < 0 || target >= entries.length) return entries;
      const next = entries.slice();
      const [removed] = next.splice(index, 1);
      next.splice(target, 0, removed);
      return next;
    });

  const updateField = (index: number, patch: Partial<Agent>): Promise<void> =>
    updateAgents((entries) => entries.map((a, i) => (i === index ? { ...a, ...patch } : a)));

  // A row with a label or command but no id can't be launched or referenced —
  // flag it like RepoRow flags a missing name. A wholly-blank row is just a
  // not-yet-filled placeholder and stays unmarked.
  const idMissing = (a: Agent): boolean =>
    Boolean(a.command.trim() || a.label.trim()) && !a.id.trim();

  return (
    <section id={`settings-section-agents:${props.target}`} class="settings-section">
      <div class="settings-section-head">
        <h2>Agents</h2>
        <Show when={props.badge}>
          {(b) => (
            <FieldBadgeRow
              state={b().stateOf?.() ?? 'inherits'}
              onRemove={() => b().removeOverride?.()}
            />
          )}
        </Show>
      </div>
      <p class="settings-hint">
        Terminal launchers listed in the tab-strip spawn dropdown. Each is a <code>label</code>{' '}
        shown in the menu plus a <code>command</code> run in a fresh tab; <code>id</code> is a
        stable identity referenced by tasks and project actions. Point <code>command</code> at a
        wrapper on your <code>PATH</code> (e.g. <code>claude-kimi</code>) or inline it (e.g.{' '}
        <code>claude</code>). The command inherits the terminal's environment — condash injects no
        provider env or tokens. Mark agents <em>Favourite</em> to show them directly in the new-tab
        menu; the rest move under a <code>More ▸</code> fly-out (with none marked, every agent is
        listed inline). Enable <em>Seed prompt via flags</em> when the command speaks agedum's{' '}
        <code>--run</code> / <code>--prompt</code> so tasks pass the prompt in argv instead of
        typing it into the live TUI.
      </p>
      <div class="settings-bucket">
        <For each={agents()}>
          {(entry, index) => (
            <div class="settings-open-with" data-invalid={idMissing(entry) ? 'true' : undefined}>
              <div class="settings-open-with-head">
                <span class="settings-field-label">
                  {entry.label.trim() || `Agent ${index() + 1}`}
                </span>
                <span class="settings-agent-row-actions">
                  <button
                    class="modal-button"
                    title="Move up"
                    disabled={index() === 0}
                    onClick={() => void moveAgent(index(), -1)}
                  >
                    ↑
                  </button>
                  <button
                    class="modal-button"
                    title="Move down"
                    disabled={index() === agents().length - 1}
                    onClick={() => void moveAgent(index(), 1)}
                  >
                    ↓
                  </button>
                  <button
                    class="modal-button"
                    title="Remove agent"
                    aria-label="Remove agent"
                    onClick={() => void removeAgent(index())}
                  >
                    ×
                  </button>
                </span>
              </div>
              <label>
                <span>Label</span>
                <input
                  type="text"
                  placeholder="Claude · Kimi"
                  {...props.bindText(
                    `${props.target}.agents[${index()}].label`,
                    () => entry.label,
                    (v) => updateField(index(), { label: v }),
                  )}
                />
              </label>
              <label>
                <span>Command</span>
                <input
                  type="text"
                  placeholder="claude-kimi"
                  {...props.bindText(
                    `${props.target}.agents[${index()}].command`,
                    () => entry.command,
                    (v) => updateField(index(), { command: v }),
                  )}
                />
              </label>
              <label>
                <span>Id</span>
                <input
                  type="text"
                  placeholder="claude-kimi"
                  classList={{ 'settings-input--invalid': idMissing(entry) }}
                  aria-invalid={idMissing(entry)}
                  {...props.bindText(
                    `${props.target}.agents[${index()}].id`,
                    () => entry.id,
                    (v) => updateField(index(), { id: v }),
                  )}
                />
              </label>
              <Show when={idMissing(entry)}>
                <p class="settings-repo-name-error">Id is required to launch this agent.</p>
              </Show>
              <label class="settings-checkbox">
                <input
                  type="checkbox"
                  checked={entry.favorite === true}
                  onChange={(e) =>
                    void updateField(index(), { favorite: e.currentTarget.checked || undefined })
                  }
                />
                <span>
                  Favourite — show directly in the new-tab menu (non-favourites move under{' '}
                  <code>More ▸</code>)
                </span>
              </label>
              <label class="settings-checkbox">
                <input
                  type="checkbox"
                  checked={entry.promptFlags === true}
                  onChange={(e) =>
                    void updateField(index(), { promptFlags: e.currentTarget.checked || undefined })
                  }
                />
                <span>
                  Seed prompt via <code>--run</code> / <code>--prompt</code> (command must accept
                  them, e.g. agedum)
                </span>
              </label>
            </div>
          )}
        </For>
        <div class="settings-list-actions">
          <button class="modal-button" onClick={() => void addAgent()}>
            + Add agent
          </button>
        </div>
      </div>
    </section>
  );
}
