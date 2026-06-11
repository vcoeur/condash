import { BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Print a self-contained HTML document to a PDF buffer.
 *
 * The document renders in a hidden, sandboxed BrowserWindow so `printToPDF`
 * captures only the exported note, never the app UI. It is loaded from a
 * temp file rather than a `data:` URL — Chromium caps `data:` navigations
 * well below a large note carrying inline mermaid SVGs. The window uses the
 * default session, so `condash-file://` image URLs in the document resolve
 * through the conception-bounded protocol handler exactly as they do in the
 * note view.
 */
export async function htmlToPdf(html: string): Promise<Buffer> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'condash-pdf-'));
  const file = join(dir, 'note.html');
  await fs.writeFile(file, html, 'utf8');
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadFile(file);
    return await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
  } finally {
    win.destroy();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
