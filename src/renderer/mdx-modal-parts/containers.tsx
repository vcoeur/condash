import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import type {
  AnnotatedCodeData,
  ApiEndpointData,
  CalloutData,
  ChecklistData,
  CodeData,
  ColumnsData,
  CustomHtmlData,
  DataModelData,
  DiagramData,
  DiffData,
  FileTreeData,
  InvalidBlockData,
  JsonExplorerData,
  MermaidData,
  NestedBlockRef,
  OpenApiData,
  PlanBlock,
  QuestionFormData,
  RichTextData,
  SvgData,
  TableData,
  TabsData,
  WireframeData,
} from '@shared/plan-blocks/schemas';
import { MermaidBlock, RichTextBlock } from './prose';
import { AnnotatedCodeBlock, CodeBlock, DiffBlock } from './code-blocks';
import {
  CalloutBlock,
  ChecklistBlock,
  DataModelBlock,
  EndpointBlock,
  FileTreeBlock,
  InvalidBlock,
  JsonExplorerBlock,
  OpenApiBlock,
  QuestionFormBlock,
  TableBlock,
} from './data-blocks';
import {
  CustomHtmlBlockView,
  DiagramBlockView,
  SvgBlockView,
  WireframeBlockView,
} from './visual-blocks';

/** Container blocks + the type → component dispatch every level renders through. */

/** How a rendered question form reaches the viewer's shared answer state: the
 *  pending answers to show, and the edit callback. Threaded down through the
 *  container blocks so a form nested in `columns` is as editable as a top-level
 *  one, and every form's answers land in the same place. */
export interface AnswerBinding {
  pending: (block: PlanBlock) => Record<string, string | string[]> | undefined;
  onChange: (block: PlanBlock, answers: Record<string, string | string[]>) => void;
}

export function BlockView(props: {
  block: PlanBlock;
  baseDir: string;
  answers?: AnswerBinding;
}): JSX.Element {
  const data = <T,>(): T => props.block.data as unknown as T;
  switch (props.block.type) {
    case 'rich-text':
      return <RichTextBlock data={data<RichTextData>()} baseDir={props.baseDir} />;
    case 'callout':
      return <CalloutBlock data={data<CalloutData>()} baseDir={props.baseDir} />;
    case 'table':
      return <TableBlock data={data<TableData>()} />;
    case 'checklist':
      return <ChecklistBlock data={data<ChecklistData>()} />;
    case 'code':
      return <CodeBlock data={data<CodeData>()} />;
    case 'annotated-code':
      return <AnnotatedCodeBlock data={data<AnnotatedCodeData>()} />;
    case 'diff':
      return <DiffBlock data={data<DiffData>()} />;
    case 'file-tree':
      return <FileTreeBlock data={data<FileTreeData>()} />;
    case 'data-model':
      return <DataModelBlock data={data<DataModelData>()} />;
    case 'api-endpoint':
      return <EndpointBlock data={data<ApiEndpointData>()} baseDir={props.baseDir} />;
    case 'openapi-spec':
      return <OpenApiBlock data={data<OpenApiData>()} />;
    case 'json-explorer':
      return <JsonExplorerBlock data={data<JsonExplorerData>()} />;
    case 'mermaid':
      return <MermaidBlock data={data<MermaidData>()} />;
    case 'diagram':
      return <DiagramBlockView data={data<DiagramData>()} />;
    case 'svg':
      return <SvgBlockView data={data<SvgData>()} blockId={props.block.id} />;
    case 'wireframe':
      return <WireframeBlockView data={data<WireframeData>()} />;
    case 'columns':
      return (
        <ColumnsBlock data={data<ColumnsData>()} baseDir={props.baseDir} answers={props.answers} />
      );
    case 'tabs':
    case 'code-tabs':
      return <TabsBlock data={data<TabsData>()} baseDir={props.baseDir} />;
    case 'question-form':
    case 'visual-questions':
      return (
        <QuestionFormBlock
          data={data<QuestionFormData>()}
          pending={
            props.answers && props.block.type === 'question-form'
              ? props.answers.pending(props.block)
              : undefined
          }
          onChange={
            props.answers && props.block.type === 'question-form'
              ? (answers) => props.answers!.onChange(props.block, answers)
              : undefined
          }
        />
      );
    case 'custom-html':
      return <CustomHtmlBlockView data={data<CustomHtmlData>()} />;
    case 'invalid':
      return <InvalidBlock data={data<InvalidBlockData>()} />;
    default:
      return <InvalidBlock data={{ reason: `no renderer for block type "${props.block.type}"` }} />;
  }
}

export function BlockList(props: {
  blocks: readonly NestedBlockRef[];
  baseDir: string;
  answers?: AnswerBinding;
}) {
  return (
    <For each={props.blocks}>
      {(block) => (
        <BlockView block={block as PlanBlock} baseDir={props.baseDir} answers={props.answers} />
      )}
    </For>
  );
}

/** Wide surfaces (desktop/browser wireframes) crush when squeezed into half
 *  width, so a columns block holding one auto-stacks vertically — the same
 *  rule the upstream renderer applies. */
function columnsMustStack(data: ColumnsData): boolean {
  return data.columns.some((column) =>
    column.blocks.some((block) => {
      if (block.type !== 'wireframe') return false;
      const surface = (block.data as { surface?: string }).surface;
      return surface === 'desktop' || surface === 'browser';
    }),
  );
}

export function ColumnsBlock(props: {
  data: ColumnsData;
  baseDir: string;
  answers?: AnswerBinding;
}) {
  const stacked = createMemo(() => columnsMustStack(props.data));
  return (
    <div class="plan-block plan-columns" classList={{ 'plan-columns-stacked': stacked() }}>
      <For each={props.data.columns}>
        {(column) => (
          <div class="plan-column">
            <Show when={column.label}>
              <h4 class="plan-column-label">{column.label}</h4>
            </Show>
            <BlockList blocks={column.blocks} baseDir={props.baseDir} answers={props.answers} />
          </div>
        )}
      </For>
    </div>
  );
}

/** Tabs container; `code-tabs` (deprecated) normalizes each `{label, code}`
 *  tab into a nested `code` block on the fly. */
export function TabsBlock(props: { data: TabsData; baseDir: string }) {
  const tabs = createMemo(() =>
    props.data.tabs.map((tab, index) => {
      const legacy = tab as { code?: string; language?: string };
      const blocks: NestedBlockRef[] =
        tab.blocks ??
        (legacy.code !== undefined
          ? [
              {
                id: `${tab.id ?? index}-code`,
                type: 'code',
                data: { code: legacy.code, language: legacy.language },
              },
            ]
          : []);
      return { id: tab.id ?? `tab-${index}`, label: tab.label, blocks };
    }),
  );
  const [active, setActive] = createSignal(0);
  const vertical = (): boolean => props.data.orientation === 'vertical';
  return (
    <div class="plan-block plan-tabs" classList={{ 'plan-tabs-vertical': vertical() }}>
      <div class="plan-tab-strip" role="tablist">
        <For each={tabs()}>
          {(tab, index) => (
            <button
              type="button"
              role="tab"
              class="plan-tab"
              classList={{ active: active() === index() }}
              aria-selected={active() === index()}
              onClick={() => setActive(index())}
            >
              {tab.label}
            </button>
          )}
        </For>
      </div>
      <div class="plan-tab-body">
        <Show when={tabs()[active()]} keyed>
          {(tab) => <BlockList blocks={tab.blocks} baseDir={props.baseDir} />}
        </Show>
      </div>
    </div>
  );
}
