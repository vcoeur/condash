import type { DirtyFile, UnpushedCommit } from '@shared/types';
import { buildBar } from './data';

export function DirtyFileRow(props: { file: DirtyFile }) {
  const counts = (): string => {
    const f = props.file;
    if (f.binary) return '(bin)';
    if (f.added === null && f.deleted === null) return '(new)';
    const a = f.added ?? 0;
    const d = f.deleted ?? 0;
    if (a > 0 && d > 0) return `+${a} −${d}`;
    if (a > 0) return `+${a}`;
    if (d > 0) return `−${d}`;
    return '';
  };
  const bar = (): string => {
    const f = props.file;
    if (f.binary) return '';
    return buildBar(f.added ?? 0, f.deleted ?? 0);
  };
  return (
    <li class="branch-dirty-popover-row" data-status={props.file.code.trim() || 'mod'}>
      <span class="branch-dirty-popover-code">{props.file.code}</span>
      <span class="branch-dirty-popover-file" title={props.file.path}>
        {props.file.path}
      </span>
      <span class="branch-dirty-popover-counts">{counts()}</span>
      <span class="branch-dirty-popover-bar" aria-hidden="true">
        {bar()}
      </span>
    </li>
  );
}

/** One unpushed-commit row in the branch popover. SHA + subject, monospace. */
export function UnpushedCommitRow(props: { commit: UnpushedCommit }) {
  return (
    <li class="branch-popover-commit-row">
      <span class="branch-popover-commit-sha">{props.commit.sha}</span>
      <span class="branch-popover-commit-subject" title={props.commit.subject}>
        {props.commit.subject}
      </span>
    </li>
  );
}
