import { z } from 'zod';

/**
 * Data schemas for every plan block type, plus the TypeScript shapes the
 * viewer components consume. The parser validates each block's `data` against
 * the matching schema and replaces a failing block with an `invalid`
 * placeholder (per-block salvage) — one bad block never blanks a document.
 *
 * Container blocks (`columns`, `tabs`, `code-tabs`) validate their nested
 * block lists SHALLOWLY here ({ id, type, data } only); the normalizer in
 * `parse-mdx.ts` recurses into them so salvage works at every depth.
 */

/** Per-field/entity/endpoint change flag used by diff-aware blocks. */
export const changeFlagSchema = z.enum(['added', 'modified', 'removed', 'renamed']);
export type ChangeFlag = z.infer<typeof changeFlagSchema>;

const frameSchema = z.enum(['auto', 'show', 'hide']);

/** Shallow nested-block reference inside a container's data payload. */
export interface NestedBlockRef {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

const nestedBlockSchema: z.ZodType<NestedBlockRef> = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});

// --- Leaf block data ---

export interface RichTextData {
  markdown: string;
}

export interface CalloutData {
  tone?: 'info' | 'decision' | 'risk' | 'warning' | 'success';
  body: string;
}

export interface TableData {
  columns: string[];
  rows: string[][];
  density?: 'compact' | 'normal';
}

export interface ChecklistItem {
  id: string;
  label: string;
  checked?: boolean;
  note?: string;
}

export interface ChecklistData {
  items: ChecklistItem[];
}

export interface CodeData {
  code: string;
  language?: string;
  filename?: string;
  caption?: string;
  maxLines?: number;
}

export interface CodeAnnotation {
  lines: string;
  label?: string;
  note: string;
  /** diff only: which side the line numbers anchor to (default after). */
  side?: 'before' | 'after';
}

export interface AnnotatedCodeData {
  code: string;
  filename?: string;
  language?: string;
  annotations?: CodeAnnotation[];
}

export interface DiffData {
  before: string;
  after: string;
  filename?: string;
  language?: string;
  mode?: 'split' | 'unified';
  annotations?: CodeAnnotation[];
}

export interface FileTreeEntry {
  path: string;
  change?: ChangeFlag;
  note?: string;
  snippet?: string;
}

export interface FileTreeData {
  title?: string;
  entries: FileTreeEntry[];
}

export interface DataModelField {
  name: string;
  type?: string;
  pk?: boolean;
  fk?: string;
  nullable?: boolean;
  change?: ChangeFlag;
  /** Prior value for a `modified`/`renamed` field (e.g. the old column type). */
  was?: string;
}

export interface DataModelEntity {
  id: string;
  name: string;
  fields: DataModelField[];
  change?: ChangeFlag;
}

export interface DataModelRelation {
  from: string;
  to: string;
  kind?: string;
}

export interface DataModelData {
  entities: DataModelEntity[];
  relations?: DataModelRelation[];
}

export interface EndpointParam {
  name: string;
  in?: 'path' | 'query' | 'header' | 'body';
  type?: string;
  required?: boolean;
  description?: string;
  change?: ChangeFlag;
  was?: string;
}

export interface EndpointBody {
  contentType?: string;
  /** A single parseable JSON value, kept as a string for the JSON explorer. */
  example?: string;
  label?: string;
}

export interface EndpointResponse {
  status: string;
  description?: string;
  example?: string;
  label?: string;
}

export interface ApiEndpointData {
  method: string;
  path: string;
  summary?: string;
  /** Prose description normalized from the MDX children. */
  description?: string;
  auth?: string;
  deprecated?: boolean;
  change?: ChangeFlag;
  params?: EndpointParam[];
  request?: EndpointBody;
  responses?: EndpointResponse[];
}

export interface OpenApiData {
  /** Complete OpenAPI 3 / Swagger 2 spec as a JSON string or inline object. */
  spec: string | Record<string, unknown>;
  title?: string;
}

export interface JsonExplorerData {
  json: string;
  title?: string;
  collapsedDepth?: number;
}

export interface MermaidData {
  source: string;
  caption?: string;
}

export interface DiagramData {
  html?: string;
  css?: string;
  caption?: string;
  frame?: 'auto' | 'show' | 'hide';
}

/** Legacy kit-tree node preserved for best-effort rendering of old screens. */
export interface KitNode {
  el: string;
  props: Record<string, unknown>;
  children: KitNode[];
}

export interface WireframeData {
  surface: 'browser' | 'desktop' | 'mobile' | 'popover' | 'panel';
  html?: string;
  css?: string;
  caption?: string;
  frame?: 'auto' | 'show' | 'hide';
  skeleton?: boolean;
  /** Legacy kit-tree children of `<Screen>` (old plans); `html` is canonical. */
  kit?: KitNode[];
}

export interface ColumnData {
  id?: string;
  label?: string;
  blocks: NestedBlockRef[];
}

export interface ColumnsData {
  columns: ColumnData[];
}

export interface TabData {
  id: string;
  label: string;
  blocks: NestedBlockRef[];
}

export interface TabsData {
  tabs: TabData[];
  orientation?: 'horizontal' | 'vertical';
}

export interface QuestionOption {
  id: string;
  label: string;
  detail?: string;
  recommended?: boolean;
}

export interface Question {
  id: string;
  title: string;
  subtitle?: string;
  mode: 'single' | 'multi' | 'freeform';
  options?: QuestionOption[];
  required?: boolean;
  placeholder?: string;
  allowOther?: boolean;
  /** The reader's answer, written back by the viewer: an option id (single),
   *  option ids (multi), or free text (freeform). */
  answer?: string | string[];
}

export interface QuestionFormData {
  questions: Question[];
  submitLabel?: string;
}

export interface CustomHtmlData {
  html: string;
  css?: string;
  caption?: string;
}

/** Parser-emitted placeholder for a block that failed tag or schema validation. */
export interface InvalidBlockData {
  reason: string;
  tag?: string;
  source?: string;
}

const annotationSchema: z.ZodType<CodeAnnotation> = z.object({
  lines: z.string().min(1),
  label: z.string().optional(),
  note: z.string(),
  side: z.enum(['before', 'after']).optional(),
});

const kitNodeSchema: z.ZodType<KitNode> = z.lazy(() =>
  z.object({
    el: z.string(),
    props: z.record(z.string(), z.unknown()),
    children: z.array(kitNodeSchema),
  }),
);

/**
 * `data` schema per block type. Keys are the registry `type` ids; the parser
 * resolves the schema through this map after tag resolution. `.strict()` is
 * deliberately NOT used: unknown extra fields pass through so documents from
 * newer dialect revisions degrade gracefully instead of failing whole blocks.
 */
export const DATA_SCHEMAS: Record<string, z.ZodType<unknown>> = {
  'rich-text': z.object({ markdown: z.string() }) satisfies z.ZodType<RichTextData>,
  callout: z.object({
    tone: z.enum(['info', 'decision', 'risk', 'warning', 'success']).optional(),
    body: z.string(),
  }) satisfies z.ZodType<CalloutData>,
  table: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    density: z.enum(['compact', 'normal']).optional(),
  }) satisfies z.ZodType<TableData>,
  checklist: z.object({
    items: z.array(
      z.object({
        id: z.string().min(1),
        label: z.string(),
        checked: z.boolean().optional(),
        note: z.string().optional(),
      }),
    ),
  }) satisfies z.ZodType<ChecklistData>,
  code: z.object({
    code: z.string(),
    language: z.string().optional(),
    filename: z.string().optional(),
    caption: z.string().optional(),
    maxLines: z.number().int().positive().optional(),
  }) satisfies z.ZodType<CodeData>,
  'annotated-code': z.object({
    code: z.string(),
    filename: z.string().optional(),
    language: z.string().optional(),
    annotations: z.array(annotationSchema).optional(),
  }) satisfies z.ZodType<AnnotatedCodeData>,
  diff: z.object({
    before: z.string(),
    after: z.string(),
    filename: z.string().optional(),
    language: z.string().optional(),
    mode: z.enum(['split', 'unified']).optional(),
    annotations: z.array(annotationSchema).optional(),
  }) satisfies z.ZodType<DiffData>,
  'file-tree': z.object({
    title: z.string().optional(),
    entries: z.array(
      z.object({
        path: z.string().min(1),
        change: changeFlagSchema.optional(),
        note: z.string().optional(),
        snippet: z.string().optional(),
      }),
    ),
  }) satisfies z.ZodType<FileTreeData>,
  'data-model': z.object({
    entities: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        fields: z.array(
          z.object({
            name: z.string(),
            type: z.string().optional(),
            pk: z.boolean().optional(),
            fk: z.string().optional(),
            nullable: z.boolean().optional(),
            change: changeFlagSchema.optional(),
            was: z.string().optional(),
          }),
        ),
        change: changeFlagSchema.optional(),
      }),
    ),
    relations: z
      .array(z.object({ from: z.string(), to: z.string(), kind: z.string().optional() }))
      .optional(),
  }) satisfies z.ZodType<DataModelData>,
  'api-endpoint': z.object({
    method: z.string().min(1),
    path: z.string().min(1),
    summary: z.string().optional(),
    description: z.string().optional(),
    auth: z.string().optional(),
    deprecated: z.boolean().optional(),
    change: changeFlagSchema.optional(),
    params: z
      .array(
        z.object({
          name: z.string(),
          in: z.enum(['path', 'query', 'header', 'body']).optional(),
          type: z.string().optional(),
          required: z.boolean().optional(),
          description: z.string().optional(),
          change: changeFlagSchema.optional(),
          was: z.string().optional(),
        }),
      )
      .optional(),
    request: z
      .object({
        contentType: z.string().optional(),
        example: z.string().optional(),
        label: z.string().optional(),
      })
      .optional(),
    responses: z
      .array(
        z.object({
          status: z.string(),
          description: z.string().optional(),
          example: z.string().optional(),
          label: z.string().optional(),
        }),
      )
      .optional(),
  }) satisfies z.ZodType<ApiEndpointData>,
  'openapi-spec': z.object({
    spec: z.union([z.string(), z.record(z.string(), z.unknown())]),
    title: z.string().optional(),
  }) satisfies z.ZodType<OpenApiData>,
  'json-explorer': z.object({
    json: z.string(),
    title: z.string().optional(),
    collapsedDepth: z.number().int().nonnegative().optional(),
  }) satisfies z.ZodType<JsonExplorerData>,
  mermaid: z.object({
    source: z.string().min(1),
    caption: z.string().optional(),
  }) satisfies z.ZodType<MermaidData>,
  diagram: z.object({
    html: z.string().optional(),
    css: z.string().optional(),
    caption: z.string().optional(),
    frame: frameSchema.optional(),
  }) satisfies z.ZodType<DiagramData>,
  wireframe: z.object({
    surface: z.enum(['browser', 'desktop', 'mobile', 'popover', 'panel']),
    html: z.string().optional(),
    css: z.string().optional(),
    caption: z.string().optional(),
    frame: frameSchema.optional(),
    skeleton: z.boolean().optional(),
    kit: z.array(kitNodeSchema).optional(),
  }) satisfies z.ZodType<WireframeData>,
  columns: z.object({
    columns: z.array(
      z.object({
        id: z.string().optional(),
        label: z.string().optional(),
        blocks: z.array(nestedBlockSchema),
      }),
    ),
  }) satisfies z.ZodType<ColumnsData>,
  tabs: z.object({
    tabs: z.array(
      z.object({
        id: z.string().min(1),
        label: z.string(),
        blocks: z.array(nestedBlockSchema),
      }),
    ),
    orientation: z.enum(['horizontal', 'vertical']).optional(),
  }) satisfies z.ZodType<TabsData>,
  'question-form': z.object({
    questions: z.array(
      z.object({
        id: z.string().min(1),
        title: z.string(),
        subtitle: z.string().optional(),
        mode: z.enum(['single', 'multi', 'freeform']),
        options: z
          .array(
            z.object({
              id: z.string().min(1),
              label: z.string(),
              detail: z.string().optional(),
              recommended: z.boolean().optional(),
            }),
          )
          .optional(),
        required: z.boolean().optional(),
        placeholder: z.string().optional(),
        allowOther: z.boolean().optional(),
        answer: z.union([z.string(), z.array(z.string())]).optional(),
      }),
    ),
    submitLabel: z.string().optional(),
  }) satisfies z.ZodType<QuestionFormData>,
  'custom-html': z.object({
    html: z.string(),
    css: z.string().optional(),
    caption: z.string().optional(),
  }) satisfies z.ZodType<CustomHtmlData>,
  // Deprecated tags stay parseable so old documents render.
  'code-tabs': z.object({
    tabs: z.array(
      z.object({
        id: z.string().optional(),
        label: z.string(),
        code: z.string().optional(),
        language: z.string().optional(),
        blocks: z.array(nestedBlockSchema).optional(),
      }),
    ),
  }),
  'visual-questions': z.object({
    questions: z.array(z.record(z.string(), z.unknown())),
    submitLabel: z.string().optional(),
  }),
};

/** One parsed block. `data` matches the type's schema; `invalid` blocks carry
 *  {@link InvalidBlockData} and render as a labeled placeholder card. */
export interface PlanBlock {
  type: string;
  id: string;
  data: Record<string, unknown>;
}

/** A parse/validation finding, viewer-bannered and CLI-reported. */
export interface PlanIssue {
  severity: 'error' | 'warning';
  message: string;
  /** 1-indexed line in the source file, when known. */
  line?: number;
}

/** Frontmatter of a visual-note document. Extra keys pass through untouched. */
export interface PlanFrontmatter {
  title?: string;
  /** Document posture. Known values `design | plan | review | note` are colored
   *  by the viewer; `note` is the neutral default. Any other string is accepted
   *  and rendered as a neutral pill — `kind` is optional and never warns. */
  kind?: string;
  [key: string]: unknown;
}

/** A fully parsed plan document. */
export interface PlanDocument {
  frontmatter: PlanFrontmatter;
  blocks: PlanBlock[];
  issues: PlanIssue[];
}
