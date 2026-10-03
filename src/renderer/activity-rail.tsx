import { For } from 'solid-js';
import type { WorkingSurface } from '@shared/types';
import {
  CodeIcon,
  KnowledgeIcon,
  ProjectsIcon,
  ResourcesIcon,
  SkillsIcon,
  TerminalIcon,
} from './icons';
import type { JSX } from 'solid-js';

interface RailItemDef {
  key: 'projects' | 'terminal' | WorkingSurface;
  label: string;
  shortcut: string;
  icon: () => JSX.Element;
}

/** Three independent rail groups: Projects, working panes, and Terminal. */
const RAIL_ITEMS: RailItemDef[] = [
  { key: 'projects', label: 'Projects', shortcut: '', icon: ProjectsIcon },
  { key: 'code', label: 'Code', shortcut: 'Ctrl+Shift+C', icon: CodeIcon },
  { key: 'knowledge', label: 'Knowledge', shortcut: '', icon: KnowledgeIcon },
  { key: 'resources', label: 'Resources', shortcut: '', icon: ResourcesIcon },
  { key: 'skills', label: 'Skills', shortcut: '', icon: SkillsIcon },
  { key: 'terminal', label: 'Terminal', shortcut: '', icon: TerminalIcon },
];

/** Index of the first right-pane item — where the rail's group separator goes.
 *  Derived from RAIL_ITEMS so reordering or inserting items keeps it correct. */
const FIRST_WORKING_INDEX = RAIL_ITEMS.findIndex((item) => item.key !== 'projects');

export interface ActivityRailProps {
  /** The surface currently filling the right pane. */
  workingSurface: WorkingSurface | 'none';
  projectsOpen: boolean;
  terminalOpen: boolean;
  disabled: boolean;
  onToggleProjects: () => void;
  onToggleWorking: (next: WorkingSurface) => void;
  onToggleTerminal: () => void;
}

export function ActivityRail(props: ActivityRailProps) {
  const isActive = (item: RailItemDef): boolean => {
    if (item.key === 'projects') return props.projectsOpen;
    if (item.key === 'terminal') return props.terminalOpen;
    return props.workingSurface === item.key;
  };

  const handleClick = (item: RailItemDef): void => {
    if (item.key === 'projects') {
      props.onToggleProjects();
    } else if (item.key === 'terminal') {
      props.onToggleTerminal();
    } else {
      props.onToggleWorking(item.key);
    }
  };

  const tooltipText = (item: RailItemDef): string => {
    if (item.shortcut) return `${item.label} (${item.shortcut})`;
    return item.label;
  };

  return (
    <aside class="rail" aria-label="Activity rail">
      <For each={RAIL_ITEMS}>
        {(item, index) => {
          const divider = index() === FIRST_WORKING_INDEX || item.key === 'terminal';
          return (
            <>
              {divider && <div class="rail-divider" />}
              <button
                type="button"
                class="rail-item"
                classList={{ active: isActive(item) }}
                aria-pressed={isActive(item)}
                disabled={props.disabled}
                title={tooltipText(item)}
                onClick={() => handleClick(item)}
              >
                <item.icon />
                <span class="rail-tooltip">{tooltipText(item)}</span>
              </button>
            </>
          );
        }}
      </For>
    </aside>
  );
}
