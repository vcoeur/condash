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
 * code-theme palette to its light arm: the dark arm keys on
 * `[data-theme-kind='dark']`, an attribute only the live renderer stamps, so
 * this document can never match it regardless of OS dark preference.
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
    // Lock the print document down: it is condash-generated (rendered note
    // body + inline app CSS) and runs no scripts, so a strict CSP costs
    // nothing here while it neutralises any beaconing from a crafted note.
    // Images/fonts resolve over the conception-bounded condash-file: scheme
    // (or inline data:); the code + print stylesheets are inline.
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src condash-file: data:; font-src condash-file: data:; style-src \'unsafe-inline\'" />',
    `<title>${escapeHtml(opts.title)}</title>`,
    `<style>${codeThemeCss}\n${exportCss}</style>`,
    '</head>',
    '<body>',
    `<article class="md-rendered">${body}</article>`,
    '</body>',
    '</html>',
  ].join('\n');
}
