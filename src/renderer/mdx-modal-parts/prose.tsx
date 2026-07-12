import { createEffect, createResource, Show } from 'solid-js';
import { renderMarkdown, runMermaidIn } from '../markdown';
import type { MermaidData, RichTextData } from '@shared/plan-blocks/schemas';

/**
 * Prose + mermaid blocks. Prose renders through the same markdown-it engine
 * as `.md` notes (wikilinks, anchors, relative images, mermaid fences all
 * behave identically); link clicks bubble to the modal's shared router.
 */

export function RichTextBlock(props: { data: RichTextData; baseDir: string }) {
  let bodyRef: HTMLDivElement | undefined;
  const [html] = createResource(
    () => props.data.markdown,
    (markdown) => renderMarkdown(markdown, { baseDir: props.baseDir }),
  );
  // Prose can carry ```mermaid fences of its own — render them in place.
  createEffect(() => {
    void html();
    if (bodyRef) void runMermaidIn(bodyRef);
  });
  return <div ref={bodyRef} class="md-rendered plan-prose" innerHTML={html() ?? ''} />;
}

export function MermaidBlock(props: { data: MermaidData }) {
  let bodyRef: HTMLDivElement | undefined;
  createEffect(() => {
    void props.data.source;
    if (bodyRef) void runMermaidIn(bodyRef);
  });
  return (
    <figure class="plan-block plan-mermaid" ref={bodyRef}>
      <pre class="mermaid">{props.data.source}</pre>
      <Show when={props.data.caption}>
        <figcaption class="plan-caption">{props.data.caption}</figcaption>
      </Show>
    </figure>
  );
}
