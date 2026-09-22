import { For } from 'solid-js';
import type { LeftView, WorkingSurface } from '@shared/types';
import { CodeIcon, ProjectsIcon } from './icons';
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
  { key: 'code', label: 'Code', shortcut: 'Ctrl+Shift+C', icon: CodeIcon, kind: 'working' },
];

/** Index of the first `working` item — where the rail's group separator goes.
 *  Derived from RAIL_ITEMS so reordering or inserting items keeps it correct. */
const FIRST_WORKING_INDEX = RAIL_ITEMS.findIndex((item) => item.kind === 'working');

export interface ActivityRailProps {
  leftView: LeftView;
  workingSurface: WorkingSurface;
  projectsVisible: boolean;
  disabled: boolean;
  onToggleLeftView: (view: LeftView) => void;
  onSelectWorking: (next: Exclude<WorkingSurface, null>) => void;
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
      props.onSelectWorking(item.key as Exclude<WorkingSurface, null>);
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
          const divider = item.kind === 'working' && index() === FIRST_WORKING_INDEX;
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
