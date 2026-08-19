import appCss from '../styles.css?inline';
import codeThemeCss from '../code-theme.css?inline';
import noteExportCss from '../note-modal-parts/export-pdf.css?inline';
import planBlocksCss from './plan-blocks.css?inline';
import mdxExportCss from './mdx-export.css?inline';
import { renderMermaidForExportIn } from '../markdown';

/**
 * Visual-note PDF export: builds the self-contained document `exportNotePdf`
 * prints in its hidden window, the same IPC and print module the markdown
 * note viewer uses. The one difference is where the body comes from — the
 * note path re-renders markdown to a string, whereas the MDX viewer's blocks
 * are live Solid components, so the exporter serialises the rendered document
 * (`serializePlanDoc`) and ships it with every stylesheet it needs inline:
 * the app's light design tokens, the code palette, the note print sheet (the
 * prose blocks are `.md-rendered`), the block sheet, and the print additions.
 *
 * Loaded lazily by the mdx modal on the first export click — `styles.css`
 * rides along as a string, and there is no reason to pay for it at boot.
 */

/** Minimal escape for text dropped into the export document's <title>. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Lift the first top-level `:root { … }` block out of a stylesheet. In
 * `styles.css` that block is the light theme: every colour token plus the
 * typography, radius and font tokens `plan-blocks.css` consumes. The dark
 * arms live in later blocks (`@media (prefers-color-scheme: dark)` scoped to
 * `:root:not([data-theme])`, and `[data-theme='dark']`) and are deliberately
 * left behind — the export document stamps `data-theme="light"`, so even an
 * OS-dark machine prints light. Returns an empty string when no block is
 * found, which the drift test in `export-pdf.test.ts` turns into a failure.
 */
export function extractRootTokens(css: string): string {
  // Walk the sheet tracking brace depth: the block wanted is a `:root {`
  // selector at depth 0 (not the `:root` inside a dark-arm `@media`), and in
  // the production bundle the CSS is minified onto one line, so nothing can
  // rely on newlines or indentation.
  let depth = 0;
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    } else if (depth === 0 && ch === ':' && /^:root\s*\{/.test(css.slice(i, i + 12))) {
      const open = css.indexOf('{', i);
      let inner = 0;
      for (let j = open; j < css.length; j += 1) {
        if (css[j] === '{') inner += 1;
        else if (css[j] === '}') {
          inner -= 1;
          if (inner === 0) return css.slice(i, j + 1).trim();
        }
      }
      return '';
    }
    i += 1;
  }
  return '';
}

/** Every `--name` a stylesheet reads through `var(--name …)`. */
export function cssVarsConsumed(css: string): Set<string> {
  const out = new Set<string>();
  for (const match of css.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) out.add(match[1]);
  return out;
}

/** Every `--name:` a stylesheet defines. */
export function cssVarsDefined(css: string): Set<string> {
  const out = new Set<string>();
  for (const match of css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) out.add(match[1]);
  return out;
}

/** The stylesheet bundle the export document inlines, in cascade order.
 *  Throws when the app tokens cannot be found — an unstyled PDF that looks
 *  like success is worse than a visible export error. */
export function exportStylesheet(): string {
  const tokens = extractRootTokens(appCss);
  if (tokens === '') throw new Error('PDF export: the app design tokens were not found');
  return [tokens, codeThemeCss, noteExportCss, planBlocksCss, mdxExportCss].join('\n');
}

/**
 * Serialise the live `.plan-doc` for printing. `cloneNode` copies attributes,
 * not properties, and Solid drives form controls through properties — so a
 * radio the reader ticked would print unticked. The clone is walked in
 * lockstep with the live tree and every control's current state is written
 * back as attributes (`checked`, `value`, textarea text). Mermaid blocks are
 * reset to their source and re-rendered with the light theme — a dark SVG is
 * unreadable on paper, the same treatment the note export gives them.
 * On-screen-only affordances are removed here rather than hidden by CSS where
 * they would still take part in layout.
 */
export async function serializePlanDoc(root: HTMLElement): Promise<string> {
  const clone = root.cloneNode(true) as HTMLElement;
  const liveControls = root.querySelectorAll<HTMLElement>('input, textarea, select');
  const cloneControls = clone.querySelectorAll<HTMLElement>('input, textarea, select');
  liveControls.forEach((live, index) => {
    const copy = cloneControls[index];
    if (!copy) return;
    if (live instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
      if (live.type === 'checkbox' || live.type === 'radio') {
        if (live.checked) copy.setAttribute('checked', '');
        else copy.removeAttribute('checked');
      } else {
        copy.setAttribute('value', live.value);
      }
    } else if (live instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) {
      copy.textContent = live.value;
    } else if (live instanceof HTMLSelectElement && copy instanceof HTMLSelectElement) {
      copy.value = live.value;
      for (const option of copy.options) {
        if (option.value === live.value) option.setAttribute('selected', '');
        else option.removeAttribute('selected');
      }
    }
  });
  for (const el of clone.querySelectorAll('.plan-svg-zoom, [data-export-skip]')) el.remove();
  await renderMermaidForExportIn(clone);
  return clone.outerHTML;
}

/**
 * Assemble the print document around an already-serialised `.plan-doc`.
 * Mirrors `buildNotePdfHtml`: `data-theme="light"` pins the light palette
 * (the code theme's dark arm keys on `[data-theme-kind='dark']`, which only
 * the live renderer stamps; the app tokens' dark arms key on
 * `:root:not([data-theme])` / `[data-theme='dark']`), and the CSP locks the
 * document down — no scripts run, images and fonts resolve only over the
 * conception-bounded `condash-file:` scheme or inline `data:`.
 */
export function buildMdxPdfHtml(planDocHtml: string, opts: { title: string }): string {
  return [
    '<!doctype html>',
    '<html data-theme="light">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src condash-file: data:; font-src condash-file: data:; style-src \'unsafe-inline\'" />',
    `<title>${escapeHtml(opts.title)}</title>`,
    `<style>${exportStylesheet()}</style>`,
    '</head>',
    '<body>',
    planDocHtml,
    '</body>',
    '</html>',
  ].join('\n');
}
