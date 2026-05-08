import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { isoToday } from '../shared/iso-today';
import { CliError, ExitCodes, validation } from '../cli/output';
import { touchDirtyMarker } from './dirty';
import { pathExists } from './fs-helpers';

/**
 * Lay down a new item (project / incident / document) under
 * `projects/<YYYY-MM>/<YYYY-MM-DD>-<slug>/`. Validates input, writes the
 * README from the canonical template, mkdir's `notes/`, touches the dirty
 * marker, and reports what was created.
 *
 * Shared between `condash-cli projects create` (the CLI verb) and the Electron
 * main process's `createProject` IPC so the GUI's "+ New project" button
 * writes byte-identical files to the CLI. The previous home was
 * `src/cli/commands/projects.ts`, but main was importing it — inverted
 * layering. Pass-10 moves it to `src/main/create-project.ts` so main owns
 * its own file-touching helper and `cli/commands/projects.ts` imports
 * from main like every other write path.
 */

export const ITEM_KINDS = ['project', 'incident', 'document'] as const;
export const SEVERITIES = ['low', 'medium', 'high'] as const;
export const ENVIRONMENTS = ['PROD', 'STAGING', 'DEV'] as const;
export const SLUG_TAIL_RE = /^[a-z0-9-]+$/;

export interface CreateProjectInput {
  kind: string;
  slug: string;
  title: string;
  apps: string[];
  branch: string | null;
  base: string | null;
  /** ISO YYYY-MM-DD; defaults to today. */
  date?: string;
  severity: string | null;
  severityImpact: string | null;
  environment: string | null;
}

export interface CreateProjectResult {
  slug: string;
  path: string;
  relPath: string;
  readme: string;
  kind: string;
  title: string;
  date: string;
  apps: string[];
  branch: string | null;
  base: string | null;
}

export async function createProjectCore(
  conceptionPath: string,
  input: CreateProjectInput,
): Promise<CreateProjectResult> {
  const kind = input.kind;
  if (!ITEM_KINDS.includes(kind as (typeof ITEM_KINDS)[number])) {
    validation(`--kind must be one of {${ITEM_KINDS.join(', ')}}; got '${kind || '(missing)'}'`);
  }
  const slug = input.slug;
  if (!slug || !SLUG_TAIL_RE.test(slug)) {
    validation(`--slug must match ^[a-z0-9-]+$; got '${slug}'`);
  }
  const title = input.title;
  if (!title) validation(`--title is required`);
  // Apps may be empty here — the GUI's quick-create form intentionally
  // omits Apps so the form stays minimal. The CLI's `create` verb still
  // requires `--apps` (validated in createCommand before this call).
  const apps = input.apps;

  const branch = input.branch;
  const base = input.base;
  const date = input.date && input.date.length > 0 ? input.date : isoToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    validation(`--date must be YYYY-MM-DD; got '${date}'`);
  }
  const month = date.slice(0, 7);

  let severity: string | null = null;
  let severityImpact: string | null = null;
  let environment: string | null = null;
  if (kind === 'incident') {
    severity = (input.severity ?? '').toLowerCase();
    if (!SEVERITIES.includes(severity as (typeof SEVERITIES)[number])) {
      validation(
        `--severity must be one of {${SEVERITIES.join(', ')}} for incidents; got '${severity || '(missing)'}'`,
      );
    }
    severityImpact = input.severityImpact?.trim() || null;
    environment = input.environment ?? null;
    if (environment && !ENVIRONMENTS.includes(environment as (typeof ENVIRONMENTS)[number])) {
      validation(`--environment must be one of {${ENVIRONMENTS.join(', ')}}; got '${environment}'`);
    }
  }

  const folderName = `${date}-${slug}`;
  const itemDir = join(conceptionPath, 'projects', month, folderName);
  if (await pathExists(itemDir)) {
    throw new CliError(
      ExitCodes.VALIDATION,
      `Item already exists at projects/${month}/${folderName}`,
    );
  }

  const readmeBody = renderTemplate({
    kind: kind as (typeof ITEM_KINDS)[number],
    title,
    date,
    apps,
    branch,
    base,
    severity,
    severityImpact,
    environment,
  });

  await fs.mkdir(join(itemDir, 'notes'), { recursive: true });
  const readmePath = join(itemDir, 'README.md');
  // `wx` flag (write-exclusive) closes the check-then-act race on the
  // pre-flight `pathExists` above: if two concurrent creates pass that
  // check, the second writeFile fails with EEXIST instead of clobbering
  // the first one's content.
  try {
    await fs.writeFile(readmePath, readmeBody, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CliError(
        ExitCodes.VALIDATION,
        `Item already exists at projects/${month}/${folderName}`,
      );
    }
    throw err;
  }

  await touchDirtyMarker(conceptionPath, 'projects');

  return {
    slug: folderName,
    path: itemDir,
    relPath: relative(conceptionPath, itemDir),
    readme: readmePath,
    kind,
    title,
    date,
    apps,
    branch,
    base,
  };
}

interface TemplateInputs {
  kind: (typeof ITEM_KINDS)[number];
  title: string;
  date: string;
  apps: string[];
  branch: string | null;
  base: string | null;
  severity: string | null;
  severityImpact: string | null;
  environment: string | null;
}

function renderTemplate(input: TemplateInputs): string {
  const fmLines: string[] = ['---'];
  fmLines.push(`date: ${input.date}`);
  fmLines.push(`kind: ${input.kind}`);
  fmLines.push(`status: now`);
  if (input.apps.length === 0) {
    fmLines.push('apps: []');
  } else {
    fmLines.push('apps:');
    for (const app of input.apps) fmLines.push(`  - ${yamlScalar(app)}`);
  }
  if (input.branch) fmLines.push(`branch: ${yamlScalar(input.branch)}`);
  if (input.base) fmLines.push(`base: ${yamlScalar(input.base)}`);
  if (input.kind === 'incident') {
    if (input.environment) fmLines.push(`environment: ${yamlScalar(input.environment)}`);
    if (input.severity) fmLines.push(`severity: ${yamlScalar(input.severity)}`);
    if (input.severityImpact) {
      fmLines.push(`severity_impact: ${yamlScalar(input.severityImpact)}`);
    }
  }
  fmLines.push('---');
  const header = `${fmLines.join('\n')}\n\n# ${input.title}`;

  let body: string;
  if (input.kind === 'project') {
    body = `## Goal

<What this project aims to achieve — the user-facing outcome.>

## Scope

<What is in scope and what is explicitly out of scope.>

## Steps

- [ ] <first task>

## Timeline

- ${input.date} — Project created.

## Notes
`;
  } else if (input.kind === 'incident') {
    body = `## Description

<What happened — observable symptoms, scope, when it started.>

## Symptoms

<Bullet list of error messages, user-facing effects, log patterns.>

## Analysis

<Investigation findings, hypotheses, references to \`notes/\`.>

## Root cause

_Not yet identified._

## Steps

- [ ] <action items>

## Timeline

- ${input.date} — Incident created.

## Notes
`;
  } else {
    body = `## Goal

<Purpose — what this document aims to achieve or answer.>

## Steps

- [ ] Step 1

## Timeline

- ${input.date} — Created.

## Notes
`;
  }
  return `${header}\n\n${body}`;
}

/**
 * Quote a YAML scalar only when the value would otherwise change meaning —
 * leading dash, leading punctuation that introduces a YAML node, embedded
 * colon-space (a flow mapping), or a non-ASCII character that the YAML 1.1
 * boolean rule (`yes`/`no`/`on`/`off`) might catch. The values we serialise
 * here are slug-shaped strings (apps, branches, ISO dates, enums) plus the
 * incident `severity_impact` free text — quoting is only needed for the
 * latter and even then rarely.
 */
function yamlScalar(value: string): string {
  if (value === '') return '""';
  // Reserved words / booleans under YAML 1.1 — quote to be safe even though
  // the `yaml` package defaults to YAML 1.2 (where these are plain strings).
  if (/^(?:true|false|null|yes|no|on|off|y|n)$/i.test(value)) return JSON.stringify(value);
  // Anything alphanumeric + a small punctuation set is safe unquoted.
  if (/^[A-Za-z0-9][\w. /+-]*$/.test(value) && !/^-/.test(value)) return value;
  return JSON.stringify(value);
}
