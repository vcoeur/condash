import { createMemo, createSignal, For, Show } from 'solid-js';
import type {
  ApiEndpointData,
  CalloutData,
  ChangeFlag,
  ChecklistData,
  DataModelData,
  FileTreeData,
  InvalidBlockData,
  JsonExplorerData,
  OpenApiData,
  QuestionFormData,
  TableData,
} from '@shared/plan-blocks/schemas';
import { buildFileTree, tryParseJson, type FileTreeNode } from './data';
import { RichTextBlock } from './prose';

/** Structured data blocks: callout, table, checklist, JSON explorer,
 *  data-model, API endpoint, OpenAPI, file-tree, question-form, invalid. */

export function CalloutBlock(props: { data: CalloutData; baseDir: string }) {
  return (
    <aside class="plan-block plan-callout" data-tone={props.data.tone ?? 'info'}>
      <span class="plan-callout-tone">{props.data.tone ?? 'info'}</span>
      <RichTextBlock data={{ markdown: props.data.body }} baseDir={props.baseDir} />
    </aside>
  );
}

export function TableBlock(props: { data: TableData }) {
  return (
    <div class="plan-block plan-table" data-density={props.data.density ?? 'normal'}>
      <table>
        <thead>
          <tr>
            <For each={props.data.columns}>{(column) => <th>{column}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <For each={props.data.rows}>
            {(row) => (
              <tr>
                <For each={row}>{(cell) => <td>{cell}</td>}</For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

export function ChecklistBlock(props: { data: ChecklistData }) {
  return (
    <ul class="plan-block plan-checklist">
      <For each={props.data.items}>
        {(item) => (
          <li>
            {/* Read-only surface: the file is the state, edits happen in the note. */}
            <input type="checkbox" checked={item.checked === true} disabled />
            <div>
              <span>{item.label}</span>
              <Show when={item.note}>
                <small class="plan-muted">{item.note}</small>
              </Show>
            </div>
          </li>
        )}
      </For>
    </ul>
  );
}

function JsonNode(props: { name?: string; value: unknown; depth: number; collapsedDepth: number }) {
  const isObject = (): boolean => typeof props.value === 'object' && props.value !== null;
  const entries = (): [string, unknown][] =>
    Array.isArray(props.value)
      ? props.value.map((v, i) => [String(i), v] as [string, unknown])
      : Object.entries(props.value as Record<string, unknown>);
  const [open, setOpen] = createSignal(props.depth < props.collapsedDepth);
  const summary = (): string =>
    Array.isArray(props.value) ? `[${props.value.length}]` : `{${entries().length}}`;
  return (
    <div class="plan-json-node" style={{ 'padding-left': props.depth === 0 ? '0' : '14px' }}>
      <Show
        when={isObject()}
        fallback={
          <div>
            <Show when={props.name !== undefined}>
              <span class="plan-json-key">{props.name}: </span>
            </Show>
            <span class={`plan-json-${props.value === null ? 'null' : typeof props.value}`}>
              {JSON.stringify(props.value)}
            </span>
          </div>
        }
      >
        <button type="button" class="plan-json-toggle" onClick={() => setOpen(!open())}>
          <span class="plan-json-arrow">{open() ? '▾' : '▸'}</span>
          <Show when={props.name !== undefined}>
            <span class="plan-json-key">{props.name}: </span>
          </Show>
          <span class="plan-muted">{summary()}</span>
        </button>
        <Show when={open()}>
          <For each={entries()}>
            {([key, value]) => (
              <JsonNode
                name={key}
                value={value}
                depth={props.depth + 1}
                collapsedDepth={props.collapsedDepth}
              />
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}

export function JsonExplorerBlock(props: { data: JsonExplorerData }) {
  const parsed = createMemo(() => tryParseJson(props.data.json));
  return (
    <div class="plan-block plan-json">
      <Show when={props.data.title}>
        <div class="plan-block-title">{props.data.title}</div>
      </Show>
      <Show
        when={parsed().error === undefined}
        fallback={
          <div>
            <div class="plan-issue-warning">not parseable as JSON — shown raw</div>
            <pre class="hljs">{props.data.json}</pre>
          </div>
        }
      >
        <JsonNode
          value={parsed().value}
          depth={0}
          collapsedDepth={props.data.collapsedDepth ?? 2}
        />
      </Show>
    </div>
  );
}

function ChangeBadge(props: { change?: ChangeFlag; was?: string }) {
  return (
    <Show when={props.change}>
      <span class="plan-change" data-change={props.change}>
        {props.change}
        <Show when={props.was}> (was {props.was})</Show>
      </span>
    </Show>
  );
}

export function DataModelBlock(props: { data: DataModelData }) {
  return (
    <div class="plan-block plan-data-model">
      <div class="plan-entities">
        <For each={props.data.entities}>
          {(entity) => (
            <div class="plan-entity" data-change={entity.change}>
              <div class="plan-entity-name">
                {entity.name}
                <ChangeBadge change={entity.change} />
              </div>
              <For each={entity.fields}>
                {(field) => (
                  <div class="plan-field" data-change={field.change}>
                    <span class="plan-field-name">
                      <Show when={field.pk}>
                        <span class="plan-field-pk">PK</span>
                      </Show>
                      {field.name}
                      {field.nullable ? '?' : ''}
                    </span>
                    <span class="plan-field-type">{field.type ?? ''}</span>
                    <Show when={field.fk}>
                      <span class="plan-field-fk">→ {field.fk}</span>
                    </Show>
                    <ChangeBadge change={field.change} was={field.was} />
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
      <Show when={(props.data.relations ?? []).length > 0}>
        <ul class="plan-relations">
          <For each={props.data.relations}>
            {(relation) => (
              <li>
                {relation.from} → {relation.to}
                <Show when={relation.kind}>
                  <span class="plan-muted"> ({relation.kind})</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

function JsonExample(props: { label: string; example?: string }) {
  return (
    <Show when={props.example}>
      <div class="plan-endpoint-example">
        <div class="plan-block-title">{props.label}</div>
        <JsonExplorerBlock data={{ json: props.example! }} />
      </div>
    </Show>
  );
}

export function EndpointBlock(props: { data: ApiEndpointData; baseDir: string }) {
  return (
    <details class="plan-block plan-endpoint" data-change={props.data.change}>
      <summary>
        <span class="plan-method" data-method={props.data.method.toUpperCase()}>
          {props.data.method.toUpperCase()}
        </span>
        <code class="plan-endpoint-path">{props.data.path}</code>
        <Show when={props.data.deprecated}>
          <span class="plan-change" data-change="removed">
            deprecated
          </span>
        </Show>
        <ChangeBadge change={props.data.change} />
        <Show when={props.data.summary}>
          <span class="plan-muted">{props.data.summary}</span>
        </Show>
      </summary>
      <div class="plan-endpoint-body">
        <Show when={props.data.auth}>
          <div class="plan-muted">Auth: {props.data.auth}</div>
        </Show>
        <Show when={props.data.description}>
          <RichTextBlock data={{ markdown: props.data.description! }} baseDir={props.baseDir} />
        </Show>
        <Show when={(props.data.params ?? []).length > 0}>
          <table class="plan-endpoint-params">
            <thead>
              <tr>
                <th>param</th>
                <th>in</th>
                <th>type</th>
                <th>description</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.data.params}>
                {(param) => (
                  <tr data-change={param.change}>
                    <td>
                      {param.name}
                      {param.required ? ' *' : ''}
                    </td>
                    <td>{param.in ?? ''}</td>
                    <td>
                      {param.type ?? ''}
                      <Show when={param.was}>
                        <span class="plan-muted"> (was {param.was})</span>
                      </Show>
                    </td>
                    <td>{param.description ?? ''}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
        <JsonExample
          label={`Request${props.data.request?.contentType ? ` (${props.data.request.contentType})` : ''}`}
          example={props.data.request?.example}
        />
        <For each={props.data.responses ?? []}>
          {(response) => (
            <div class="plan-endpoint-response">
              <span class="plan-status" data-status-class={response.status[0]}>
                {response.status}
              </span>
              <span class="plan-muted">{response.description ?? ''}</span>
              <JsonExample label={response.label ?? 'Body'} example={response.example} />
            </div>
          )}
        </For>
      </div>
    </details>
  );
}

/** Whole-spec reference: header + per-path method list + raw spec explorer.
 *  Deliberately compact — a full Swagger-UI clone is out of scope for a
 *  read-only note viewer. */
export function OpenApiBlock(props: { data: OpenApiData }) {
  const spec = createMemo((): Record<string, unknown> | null => {
    if (typeof props.data.spec !== 'string') return props.data.spec;
    const parsed = tryParseJson(props.data.spec);
    return parsed.error ? null : (parsed.value as Record<string, unknown>);
  });
  const info = (): { title?: string; version?: string } =>
    (spec()?.info as { title?: string; version?: string }) ?? {};
  const paths = (): [string, Record<string, unknown>][] =>
    Object.entries((spec()?.paths as Record<string, Record<string, unknown>>) ?? {});
  const specJson = (): string =>
    typeof props.data.spec === 'string'
      ? props.data.spec
      : JSON.stringify(props.data.spec, null, 2);
  return (
    <div class="plan-block plan-openapi">
      <div class="plan-block-title">
        {props.data.title ?? info().title ?? 'API specification'}
        <Show when={info().version}>
          <span class="plan-muted"> v{info().version}</span>
        </Show>
      </div>
      <Show
        when={spec()}
        fallback={<div class="plan-issue-warning">spec is not parseable JSON</div>}
      >
        <For each={paths()}>
          {([path, operations]) => (
            <div class="plan-openapi-path">
              <code>{path}</code>
              <For each={Object.entries(operations)}>
                {([method, operation]) => (
                  <span class="plan-method" data-method={method.toUpperCase()}>
                    {method.toUpperCase()}
                    <Show when={(operation as { summary?: string }).summary}>
                      <span class="plan-muted"> {(operation as { summary?: string }).summary}</span>
                    </Show>
                  </span>
                )}
              </For>
            </div>
          )}
        </For>
        <details>
          <summary>Raw spec</summary>
          <JsonExplorerBlock data={{ json: specJson(), collapsedDepth: 1 }} />
        </details>
      </Show>
    </div>
  );
}

function FileTreeNodeView(props: { node: FileTreeNode; depth: number }) {
  return (
    <>
      <div class="plan-file" style={{ 'padding-left': `${props.depth * 16}px` }}>
        <span class="plan-file-name" data-dir={props.node.children.length > 0 ? '' : undefined}>
          {props.node.name}
        </span>
        <ChangeBadge change={props.node.entry?.change} />
        <Show when={props.node.entry?.note}>
          <span class="plan-muted">{props.node.entry!.note}</span>
        </Show>
      </div>
      <Show when={props.node.entry?.snippet}>
        <pre class="hljs plan-file-snippet" style={{ 'margin-left': `${props.depth * 16 + 16}px` }}>
          {props.node.entry!.snippet}
        </pre>
      </Show>
      <For each={props.node.children}>
        {(child) => <FileTreeNodeView node={child} depth={props.depth + 1} />}
      </For>
    </>
  );
}

export function FileTreeBlock(props: { data: FileTreeData }) {
  const tree = createMemo(() => buildFileTree(props.data.entries));
  return (
    <div class="plan-block plan-file-tree">
      <Show when={props.data.title}>
        <div class="plan-block-title">{props.data.title}</div>
      </Show>
      <For each={tree()}>{(node) => <FileTreeNodeView node={node} depth={0} />}</For>
    </div>
  );
}

/** Interactive question form: the reader picks answers (radio / checkbox /
 *  free text) and Save writes them back into the same `.mdx` via `onSave`.
 *  With no `onSave` it renders read-only, still reflecting any saved answers. */
export function QuestionFormBlock(props: {
  data: QuestionFormData;
  onSave?: (answers: Record<string, string | string[]>) => Promise<void>;
}) {
  const seed = (): Record<string, string | string[]> => {
    const out: Record<string, string | string[]> = {};
    for (const question of props.data.questions) {
      if (question.answer !== undefined) out[question.id] = question.answer;
    }
    return out;
  };
  const [answers, setAnswers] = createSignal<Record<string, string | string[]>>(seed());
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);

  const isChosen = (questionId: string, optionId: string): boolean => {
    const value = answers()[questionId];
    return Array.isArray(value) ? value.includes(optionId) : value === optionId;
  };
  const chooseSingle = (questionId: string, optionId: string): void => {
    setAnswers({ ...answers(), [questionId]: optionId });
    setSaved(false);
  };
  const toggleMulti = (questionId: string, optionId: string): void => {
    const current = answers()[questionId];
    const list = Array.isArray(current) ? current : [];
    const next = list.includes(optionId)
      ? list.filter((id) => id !== optionId)
      : [...list, optionId];
    setAnswers({ ...answers(), [questionId]: next });
    setSaved(false);
  };
  const setText = (questionId: string, text: string): void => {
    setAnswers({ ...answers(), [questionId]: text });
    setSaved(false);
  };
  const textValue = (questionId: string): string => {
    const value = answers()[questionId];
    return typeof value === 'string' ? value : '';
  };
  const save = async (): Promise<void> => {
    const handler = props.onSave;
    if (!handler) return;
    setSaving(true);
    try {
      await handler(answers());
      setSaved(true);
    } catch {
      setSaved(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="plan-block plan-questions">
      <For each={props.data.questions}>
        {(question) => (
          <div class="plan-question">
            <div class="plan-question-title">
              {question.title}
              {question.required ? ' *' : ''}
              <span class="plan-muted"> ({question.mode})</span>
            </div>
            <Show when={question.subtitle}>
              <div class="plan-muted">{question.subtitle}</div>
            </Show>
            <Show when={question.mode !== 'freeform'}>
              <For each={question.options ?? []}>
                {(option) => (
                  <label
                    class="plan-option"
                    data-recommended={option.recommended ? '' : undefined}
                    data-chosen={isChosen(question.id, option.id) ? '' : undefined}
                  >
                    <input
                      class="plan-option-input"
                      type={question.mode === 'multi' ? 'checkbox' : 'radio'}
                      name={`q-${question.id}`}
                      checked={isChosen(question.id, option.id)}
                      disabled={!props.onSave}
                      onChange={() =>
                        question.mode === 'multi'
                          ? toggleMulti(question.id, option.id)
                          : chooseSingle(question.id, option.id)
                      }
                    />
                    <span class="plan-option-body">
                      <span class="plan-option-label">
                        {option.label}
                        <Show when={option.recommended}>
                          <span class="plan-change" data-change="added">
                            recommended
                          </span>
                        </Show>
                      </span>
                      <Show when={option.detail}>
                        <small class="plan-muted">{option.detail}</small>
                      </Show>
                    </span>
                  </label>
                )}
              </For>
            </Show>
            <Show when={question.mode === 'freeform'}>
              <textarea
                class="plan-answer-text"
                rows={2}
                placeholder={question.placeholder ?? 'Free-text answer'}
                disabled={!props.onSave}
                value={textValue(question.id)}
                onInput={(event) => setText(question.id, event.currentTarget.value)}
              />
            </Show>
          </div>
        )}
      </For>
      <Show when={props.onSave}>
        <div class="plan-questions-actions">
          <button
            type="button"
            class="plan-answer-save"
            disabled={saving()}
            onClick={() => void save()}
          >
            {saving() ? 'Saving…' : (props.data.submitLabel ?? 'Save answers')}
          </button>
          <Show when={saved()}>
            <span class="plan-muted">Saved ✓</span>
          </Show>
        </div>
      </Show>
    </div>
  );
}

export function InvalidBlock(props: { data: InvalidBlockData }) {
  return (
    <div class="plan-block plan-invalid">
      <div class="plan-block-title">
        Invalid block
        <Show when={props.data.tag}>
          <code> &lt;{props.data.tag}&gt;</code>
        </Show>
      </div>
      <div class="plan-issue-error">{props.data.reason}</div>
      <Show when={props.data.source}>
        <details>
          <summary>Source</summary>
          <pre class="hljs">{props.data.source}</pre>
        </details>
      </Show>
    </div>
  );
}
