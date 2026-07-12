import { createResource, createSignal, For, Show } from 'solid-js';
import { highlightLines, highlightSnippet } from '../markdown';
import { Button } from '../actions';
import type {
  AnnotatedCodeData,
  CodeAnnotation,
  CodeData,
  DiffData,
} from '@shared/plan-blocks/schemas';
import {
  annotatedLines,
  computeSplitRows,
  computeUnifiedRows,
  parseLineRange,
  type SplitDiffRow,
  type UnifiedDiffRow,
} from './data';

/** Code-bearing blocks: snippet, annotated walkthrough, and before/after diff. */

export function CodeBlock(props: { data: CodeData }) {
  const [expanded, setExpanded] = createSignal(false);
  const [html] = createResource(
    () => [props.data.code, props.data.language] as const,
    ([code, language]) => highlightSnippet(code, language),
  );
  const lineCount = (): number => props.data.code.split('\n').length;
  const collapsed = (): boolean =>
    props.data.maxLines !== undefined && lineCount() > props.data.maxLines && !expanded();
  return (
    <figure class="plan-block plan-code">
      <Show when={props.data.filename}>
        <div class="plan-code-head">
          <span class="plan-code-filename">{props.data.filename}</span>
          <Show when={props.data.language}>
            <span class="plan-code-lang">{props.data.language}</span>
          </Show>
        </div>
      </Show>
      <pre
        class="hljs plan-code-body"
        classList={{ 'plan-code-collapsed': collapsed() }}
        style={collapsed() ? { 'max-height': `${props.data.maxLines! * 1.5}em` } : undefined}
      >
        <code innerHTML={html() ?? ''} />
      </pre>
      <Show when={collapsed()}>
        <Button variant="ghost" class="btn--sm plan-code-expand" onClick={() => setExpanded(true)}>
          Show all {lineCount()} lines
        </Button>
      </Show>
      <Show when={props.data.caption}>
        <figcaption class="plan-caption">{props.data.caption}</figcaption>
      </Show>
    </figure>
  );
}

/** Annotation cards listed under a code/diff body, anchored by line range. */
function AnnotationList(props: { annotations: readonly CodeAnnotation[] | undefined }) {
  return (
    <Show when={(props.annotations ?? []).length > 0}>
      <ul class="plan-annotations">
        <For each={props.annotations}>
          {(annotation) => (
            <li>
              <span class="plan-annotation-lines">
                L{annotation.lines}
                {annotation.side === 'before' ? ' (before)' : ''}
              </span>
              <Show when={annotation.label}>
                <strong class="plan-annotation-label">{annotation.label}</strong>
              </Show>
              <span class="plan-annotation-note">{annotation.note}</span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

export function AnnotatedCodeBlock(props: { data: AnnotatedCodeData }) {
  const [lines] = createResource(
    () => [props.data.code, props.data.language] as const,
    ([code, language]) => highlightLines(code.split('\n'), language),
  );
  const marked = (): Set<number> => {
    const out = new Set<number>();
    for (const annotation of props.data.annotations ?? []) {
      const range = parseLineRange(annotation.lines);
      if (!range) continue;
      for (let line = range.start; line <= range.end; line += 1) out.add(line);
    }
    return out;
  };
  return (
    <figure class="plan-block plan-code">
      <Show when={props.data.filename}>
        <div class="plan-code-head">
          <span class="plan-code-filename">{props.data.filename}</span>
        </div>
      </Show>
      <div class="plan-lines hljs">
        <For each={lines() ?? []}>
          {(lineHtml, index) => (
            <div class="plan-line" classList={{ 'plan-line-marked': marked().has(index() + 1) }}>
              <span class="plan-line-num">{index() + 1}</span>
              <span class="plan-line-text" innerHTML={lineHtml || '&nbsp;'} />
            </div>
          )}
        </For>
      </div>
      <AnnotationList annotations={props.data.annotations} />
    </figure>
  );
}

export function DiffBlock(props: { data: DiffData }) {
  const [mode, setMode] = createSignal<'split' | 'unified'>(props.data.mode ?? 'split');
  // jsdiff + both sides' highlighting resolve together off one resource.
  const [rows] = createResource(
    () => [props.data.before, props.data.after, props.data.language] as const,
    async ([before, after, language]) => {
      const { diffLines } = await import('diff');
      const changes = diffLines(before, after);
      const split = computeSplitRows(changes);
      const unified = computeUnifiedRows(changes);
      const highlightCell = async (text: string): Promise<string> =>
        (await highlightLines([text], language))[0];
      const splitHtml = await Promise.all(
        split.map(async (row) => ({
          ...row,
          leftHtml: row.left ? await highlightCell(row.left.text) : '',
          rightHtml: row.right ? await highlightCell(row.right.text) : '',
        })),
      );
      const unifiedHtml = await Promise.all(
        unified.map(async (row) => ({ ...row, html: await highlightCell(row.text) })),
      );
      return { splitHtml, unifiedHtml };
    },
  );
  const beforeMarks = (): Set<number> => annotatedLines(props.data.annotations, 'before');
  const afterMarks = (): Set<number> => annotatedLines(props.data.annotations, 'after');

  const cellClass = (kind: string | undefined, marked: boolean): Record<string, boolean> => ({
    [`plan-diff-${kind ?? 'empty'}`]: true,
    'plan-line-marked': marked,
  });

  return (
    <figure class="plan-block plan-diff">
      <div class="plan-code-head">
        <span class="plan-code-filename">{props.data.filename ?? 'diff'}</span>
        <div class="modal-seg" role="tablist" aria-label="Diff view mode">
          <Button
            variant="default"
            class="btn--sm"
            classList={{ active: mode() === 'split' }}
            onClick={() => setMode('split')}
          >
            Split
          </Button>
          <Button
            variant="default"
            class="btn--sm"
            classList={{ active: mode() === 'unified' }}
            onClick={() => setMode('unified')}
          >
            Unified
          </Button>
        </div>
      </div>
      <Show when={rows()}>
        {(resolved) => (
          <Show
            when={mode() === 'split'}
            fallback={
              <div class="plan-lines hljs">
                <For each={resolved().unifiedHtml}>
                  {(row: UnifiedDiffRow & { html: string }) => (
                    <div
                      class="plan-line"
                      classList={cellClass(
                        row.kind,
                        (row.numAfter !== undefined && afterMarks().has(row.numAfter)) ||
                          (row.numBefore !== undefined && beforeMarks().has(row.numBefore)),
                      )}
                    >
                      <span class="plan-line-num">{row.numBefore ?? ''}</span>
                      <span class="plan-line-num">{row.numAfter ?? ''}</span>
                      <span class="plan-line-text" innerHTML={row.html || '&nbsp;'} />
                    </div>
                  )}
                </For>
              </div>
            }
          >
            <div class="plan-diff-split hljs">
              <For each={resolved().splitHtml}>
                {(row: SplitDiffRow & { leftHtml: string; rightHtml: string }) => (
                  <div class="plan-diff-row">
                    <div
                      class="plan-line"
                      classList={cellClass(
                        row.left?.kind,
                        row.left !== undefined && beforeMarks().has(row.left.num),
                      )}
                    >
                      <span class="plan-line-num">{row.left?.num ?? ''}</span>
                      <span class="plan-line-text" innerHTML={row.leftHtml || '&nbsp;'} />
                    </div>
                    <div
                      class="plan-line"
                      classList={cellClass(
                        row.right?.kind,
                        row.right !== undefined && afterMarks().has(row.right.num),
                      )}
                    >
                      <span class="plan-line-num">{row.right?.num ?? ''}</span>
                      <span class="plan-line-text" innerHTML={row.rightHtml || '&nbsp;'} />
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        )}
      </Show>
      <AnnotationList annotations={props.data.annotations} />
    </figure>
  );
}
