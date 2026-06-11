import codeThemeCss from '../code-theme.css?inline';
import { renderMarkdownForExport } from '../markdown';
import exportCss from './export-pdf.css?inline';

/** Minimal escape for text dropped into the export document's <title>. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the self-contained HTML document `exportNotePdf` prints in a hidden
 * window. Carries everything inline: the freshly-rendered note body (mermaid
 * pre-rendered to SVG — the hidden window runs no scripts), the code-fence
 * palette, and the print stylesheet. `data-theme="light"` pins the bundled
 * code-theme palette to its light arm regardless of OS dark preference (its
 * dark arms key on `[data-theme='dark']` or `prefers-color-scheme: dark`
 * without a `light` override).
 */
export async function buildNotePdfHtml(
  markdown: string,
  opts: { baseDir?: string; title: string },
): Promise<string> {
  const body = await renderMarkdownForExport(markdown, { baseDir: opts.baseDir });
  return [
    '<!doctype html>',
    '<html data-theme="light">',
    '<head>',
    '<meta charset="utf-8" />',
    `<title>${escapeHtml(opts.title)}</title>`,
    `<style>${codeThemeCss}\n${exportCss}</style>`,
    '</head>',
    '<body>',
    `<article class="md-rendered">${body}</article>`,
    '</body>',
    '</html>',
  ].join('\n');
}
