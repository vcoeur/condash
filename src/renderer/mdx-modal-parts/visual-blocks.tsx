import { createEffect, createResource, createSignal, createUniqueId, Show } from 'solid-js';
import type {
  CustomHtmlData,
  DiagramData,
  SvgData,
  WireframeData,
} from '@shared/plan-blocks/schemas';
import { injectIcons, sanitizeFragment, sanitizeSvg } from './sanitize';
import { kitNodesToHtml, scopeCss } from './data';
import { usePlanDoc } from './doc-context';
import { SvgLightbox, type SvgLightboxPayload } from './svg-lightbox';

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

/**
 * An inline SVG diagram on a light card. The markup goes through the SVG-only
 * sanitizer and the block's CSS is scoped per block like a diagram's; the card
 * pins the `--wf-*` tokens to their light values in both themes
 * (`plan-blocks.css`), so a token-coloured diagram and a literal-coloured one
 * both read. Clicking the card (or its zoom button) opens the lightbox with
 * Download .svg / Copy SVG.
 */
export function SvgBlockView(props: { data: SvgData; blockId: string }) {
  const docInfo = usePlanDoc();
  const scopeId = `plan-scope-${createUniqueId()}`;
  const [clean] = createResource(
    () => props.data.svg,
    (markup) => sanitizeSvg(markup),
  );
  const [open, setOpen] = createSignal(false);

  const title = (): string => props.data.caption ?? props.data.alt ?? 'Diagram';
  const defaultPath = (): string => {
    const notePath = docInfo?.notePath ?? '';
    const stem = notePath.replace(/\.[^./\\]*$/, '');
    return `${stem === '' ? 'diagram' : stem}-${props.blockId}.svg`;
  };
  const payload = (): SvgLightboxPayload | null => {
    const svg = clean();
    if (!svg) return null;
    return { svg, css: props.data.css, title: title(), defaultPath: defaultPath() };
  };
  const openLightbox = (): void => {
    if (payload()) setOpen(true);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openLightbox();
  };

  return (
    <figure class="plan-block plan-svg">
      <Show when={props.data.css}>
        <style>{scopeCss(props.data.css!, `#${scopeId}`)}</style>
      </Show>
      <div
        id={scopeId}
        class="plan-svg-card"
        role="button"
        tabIndex={0}
        aria-label={`${props.data.alt ?? title()} — open full size`}
        title="Open full size"
        onClick={openLightbox}
        onKeyDown={onKey}
      >
        <div class="plan-svg-body" innerHTML={clean() ?? ''} />
        <span class="plan-svg-zoom" aria-hidden="true">
          ⤢
        </span>
      </div>
      <Show when={props.data.caption}>
        <figcaption class="plan-caption">{props.data.caption}</figcaption>
      </Show>
      <Show when={open() && payload()} keyed>
        {(data) => <SvgLightbox payload={data} onClose={() => setOpen(false)} />}
      </Show>
    </figure>
  );
}
