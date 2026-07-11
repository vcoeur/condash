import { For, Show } from 'solid-js';
import type { LeftView, WorkingSurface } from '@shared/types';
import {
  CodeIcon,
  DeliverablesIcon,
  KnowledgeIcon,
  LogsIcon,
  ProjectsIcon,
  ResourcesIcon,
  SkillsIcon,
  TasksIcon,
} from './icons';
import type { JSX } from 'solid-js';

interface RailItemDef {
  key: LeftView | WorkingSurface;
  label: string;
  shortcut: string;
  icon: () => JSX.Element;
  kind: 'left' | 'working';
}

const RAIL_ITEMS: RailItemDef[] = [
  { key: 'projects', label: 'Projects', shortcut: '', icon: ProjectsIcon, kind: 'left' },
  { key: 'tasks', label: 'Tasks', shortcut: '', icon: TasksIcon, kind: 'left' },
  {
    key: 'deliverables',
    label: 'Deliverables',
    shortcut: '',
    icon: DeliverablesIcon,
    kind: 'left',
  },
  { key: 'code', label: 'Code', shortcut: 'Ctrl+Shift+C', icon: CodeIcon, kind: 'working' },
  {
    key: 'knowledge',
    label: 'Knowledge',
    shortcut: 'Ctrl+Shift+K',
    icon: KnowledgeIcon,
    kind: 'working',
  },
  {
    key: 'resources',
    label: 'Resources',
    shortcut: 'Ctrl+R',
    icon: ResourcesIcon,
    kind: 'working',
  },
  { key: 'skills', label: 'Skills', shortcut: 'Ctrl+L', icon: SkillsIcon, kind: 'working' },
  { key: 'logs', label: 'Logs', shortcut: 'Ctrl+Shift+L', icon: LogsIcon, kind: 'working' },
];

export interface ActivityRailProps {
  leftView: LeftView;
  workingSurface: WorkingSurface;
  projectsVisible: boolean;
  disabled: boolean;
  onToggleLeftView: (view: LeftView) => void;
  onSelectWorking: (next: WorkingSurface) => void;
}

export function ActivityRail(props: ActivityRailProps) {
  const isActive = (item: RailItemDef): boolean => {
    if (item.kind === 'left') {
      return props.projectsVisible && props.leftView === item.key;
    }
    return props.workingSurface === item.key;
  };

  const handleClick = (item: RailItemDef): void => {
    if (item.kind === 'left') {
      props.onToggleLeftView(item.key as LeftView);
    } else {
      props.onSelectWorking(
        props.workingSurface === item.key ? null : (item.key as WorkingSurface),
      );
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
          const divider = item.kind === 'working' && index() === 3;
          return (
            <>
              <Show when={divider}>
                <div class="rail-divider" />
              </Show>
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
