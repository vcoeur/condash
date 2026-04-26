export type ItemKind = 'project' | 'incident' | 'document' | 'unknown';

export type KnownStatus = 'now' | 'soon' | 'later' | 'backlog' | 'review' | 'done';

export const KNOWN_STATUSES: readonly KnownStatus[] = [
  'now',
  'soon',
  'later',
  'backlog',
  'review',
  'done',
];

export interface StepCounts {
  todo: number;
  doing: number;
  done: number;
  dropped: number;
}

export type StepMarker = ' ' | '~' | 'x' | '-';

export const STEP_MARKERS: readonly StepMarker[] = [' ', '~', 'x', '-'];

export interface Step {
  lineIndex: number;
  marker: StepMarker;
  text: string;
  section: string;
}

export interface Project {
  slug: string;
  path: string;
  title: string;
  kind: ItemKind;
  status: KnownStatus | string;
  apps?: string;
  summary?: string;
  steps: Step[];
  stepCounts: StepCounts;
  deliverableCount: number;
}

export type Theme = 'light' | 'dark' | 'system';

export interface Settings {
  conceptionPath: string | null;
  theme: Theme;
}
