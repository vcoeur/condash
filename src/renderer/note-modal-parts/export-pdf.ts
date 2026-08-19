import codeThemeCss from '../code-theme.css?inline';
import { renderMarkdownForExport } from '../markdown';
import { escapeHtml } from '../mdx-modal-parts/data';
import exportCss from './export-pdf.css?inline';

/**
 * The print-document shell every PDF export shares — the markdown note
 * exporter here and the visual-note exporter in `mdx-modal-parts/export-pdf.ts`
 * both wrap their body with it, so the light-theme pin and the CSP live in
 * one place. `data-theme="light"` pins the bundled code-theme palette to its
 * light arm (the dark arm keys on `[data-theme-kind='dark']`, an attribute
 * only the live renderer stamps) and the app tokens' dark arms key on
 * `:root:not([data-theme])` / `[data-theme='dark']`, so the document prints
 * light regardless of OS preference. The CSP locks it down: it is
 * condash-generated and runs no scripts, so a strict policy costs nothing
 * while it neutralises any beaconing from a crafted note — images and fonts
 * resolve only over the conception-bounded `condash-file:` scheme or inline
 * `data:`, stylesheets are inline.
 */
export function wrapPrintDocument(opts: { title: string; styles: string; body: string }): string {
  return [
    '<!doctype html>',
    '<html data-theme="light">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src condash-file: data:; font-src condash-file: data:; style-src \'unsafe-inline\'" />',
    `<title>${escapeHtml(opts.title)}</title>`,
    `<style>${opts.styles}</style>`,
    '</head>',
    '<body>',
    opts.body,
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * Build the self-contained HTML document `exportNotePdf` prints in a hidden
 * window. Carries everything inline: the freshly-rendered note body (mermaid
 * pre-rendered to SVG — the hidden window runs no scripts), the code-fence
 * palette, and the print stylesheet.
 */
export async function buildNotePdfHtml(
  markdown: string,
  opts: { baseDir?: string; title: string },
): Promise<string> {
  const body = await renderMarkdownForExport(markdown, { baseDir: opts.baseDir });
  return wrapPrintDocument({
    title: opts.title,
    styles: `${codeThemeCss}\n${exportCss}`,
    body: `<article class="md-rendered">${body}</article>`,
  });
}
