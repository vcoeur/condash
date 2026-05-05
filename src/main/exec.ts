import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** `promisify(execFile)` was duplicated four times across `main/audit.ts`,
 *  `main/worktrees.ts`, `main/worktree-ops.ts`, and `cli/commands/projects.ts`.
 *  Centralised here so the import site is grep-friendly and the buffer / shell
 *  defaults (no shell, default 10 MB maxBuffer) stay aligned. */
export const exec = promisify(execFile);
