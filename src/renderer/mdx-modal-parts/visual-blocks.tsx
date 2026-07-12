import { createEffect, createResource, createUniqueId, Show } from 'solid-js';
import type { CustomHtmlData, DiagramData, WireframeData } from '@shared/plan-blocks/schemas';
import { injectIcons, sanitizeFragment } from './sanitize';
import { kitNodesToHtml, scopeCss } from './data';

/**
 * Visual blocks: wireframe screens, HTML diagrams, and the custom-html escape
 * hatch. All three render author-supplied HTML through the sanitizer into a
 * scoped container; block-supplied CSS is selector-prefixed so it cannot leak
 * into the app shell. The `--wf-*` / `.wf-*` / `.diagram-*` vocabulary is
 * themed by `plan-blocks.css` off condash's own tokens, so screens read
 * correctly in both themes.
 */

function SanitizedHtml(props: { html: string; css?: string; scopeClass: string }) {
  let containerRef: HTMLDivElement | undefined;
  const scopeId = `plan-scope-${createUniqueId()}`;
  const [clean] = createResource(
    () => props.html,
    (html) => sanitizeFragment(html),
  );
  createEffect(() => {
    void clean();
    if (containerRef) injectIcons(containerRef);
  });
  return (
    <>
      <Show when={props.css}>
        <style>{scopeCss(props.css!, `#${scopeId}`)}</style>
      </Show>
      <div id={scopeId} class={props.scopeClass} ref={containerRef} innerHTML={clean() ?? ''} />
    </>
  );
}

/** Frame chrome per surface preset; the fragment renders inside. */
export function WireframeBlockView(props: { data: WireframeData }) {
  const html = (): string =>
    props.data.html ?? (props.data.kit ? kitNodesToHtml(props.data.kit) : '');
  const framed = (): boolean => props.data.frame !== 'hide';
  return (
    <figure class="plan-block plan-wireframe" data-surface={props.data.surface}>
      <div
        class="wf-frame"
        classList={{
          'wf-frame-borderless': !framed(),
          'wf-skeleton': props.data.skeleton === true,
        }}
      >
        <Show when={props.data.surface === 'browser'}>
          <div class="wf-chrome">
            <span class="wf-chrome-dot" />
            <span class="wf-chrome-dot" />
            <span class="wf-chrome-dot" />
            <span class="wf-chrome-address" />
          </div>
        </Show>
        <Show when={props.data.surface === 'mobile'}>
          <div class="wf-statusbar">
            <span>9:41</span>
            <span class="wf-statusbar-right" />
          </div>
        </Show>
        <SanitizedHtml html={html()} css={props.data.css} scopeClass="wf-screen" />
      </div>
      <Show when={props.data.caption}>
        <figcaption class="plan-caption">{props.data.caption}</figcaption>
      </Show>
    </figure>
  );
}

export function DiagramBlockView(props: { data: DiagramData }) {
  return (
    <figure
      class="plan-block plan-diagram"
      classList={{ 'plan-diagram-framed': props.data.frame === 'show' }}
    >
      <Show
        when={props.data.html}
        fallback={<div class="plan-issue-warning">diagram carries no html payload</div>}
      >
        <SanitizedHtml
          html={props.data.html!}
          css={props.data.css}
          scopeClass="plan-diagram-body"
        />
      </Show>
      <Show when={props.data.caption}>
        <figcaption class="plan-caption">{props.data.caption}</figcaption>
      </Show>
    </figure>
  );
}

export function CustomHtmlBlockView(props: { data: CustomHtmlData }) {
  return (
    <figure class="plan-block plan-custom-html">
      <SanitizedHtml html={props.data.html} css={props.data.css} scopeClass="plan-custom-body" />
      <Show when={props.data.caption}>
        <figcaption class="plan-caption">{props.data.caption}</figcaption>
      </Show>
    </figure>
  );
}
