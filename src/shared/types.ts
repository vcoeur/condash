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

export interface Project {
  slug: string;
  path: string;
  title: string;
  kind: ItemKind;
  status: KnownStatus | string;
  apps?: string;
}

export interface Settings {
  conceptionPath: string | null;
}
