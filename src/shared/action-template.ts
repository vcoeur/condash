/** Context bag for project-scoped template substitution. */
export interface ProjectActionContext {
  [key: string]: string;
  slug: string;
  shortSlug: string;
  title: string;
  branch: string;
  base: string;
  kind: string;
  status: string;
  date: string;
  apps: string;
  firstApp: string;
  path: string;
  relPath: string;
}

/** Context bag for global template substitution. */
export interface GlobalActionContext {
  [key: string]: string;
  today: string;
  conception: string;
  conceptionPath: string;
}

/** Minimal Project shape accepted by `projectContext`. */
export interface ProjectLike {
  slug: string;
  title: string;
  kind: string;
  status: string;
  apps: string[];
  path: string;
  branch: string | null;
  base: string | null;
}

/** Build a project context from the shared `Project` shape. */
export function projectContext(
  project: ProjectLike,
  conceptionPath?: string,
): ProjectActionContext {
  const shortSlug = project.slug.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  let relPath = project.path;
  if (conceptionPath && project.path.startsWith(conceptionPath)) {
    relPath = project.path.slice(conceptionPath.length + 1);
  }
  return {
    slug: project.slug,
    shortSlug,
    title: project.title,
    branch: project.branch ?? '',
    base: project.base ?? '',
    kind: project.kind,
    status: project.status,
    date: project.slug.slice(0, 10),
    apps: project.apps.join(', '),
    firstApp: project.apps[0] ?? '',
    path: project.path,
    relPath,
  };
}

/** Build a global context from runtime values. */
export function globalContext(today: string, conceptionPath: string): GlobalActionContext {
  return {
    today,
    conception: conceptionPath.split('/').pop() ?? '',
    conceptionPath,
  };
}

/** Single-pass template substitution. Known `{name}` tokens are replaced;
 *  anything else is left verbatim so typos remain visible. */
export function substitute(template: string, ctx: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name) => {
    if (name in ctx) return ctx[name];
    return `{${name}}`;
  });
}
