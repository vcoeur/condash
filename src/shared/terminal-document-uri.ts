/** Classify/decode local documents; file URLs still need native filesystem conversion. */
export function terminalDocumentPath(uri: string): string | null {
  if (!uri || uri.length > 8192 || /[\u0000-\u0020\u007f]/.test(uri)) return null;
  let pathname: string;
  try {
    if (/^file:/i.test(uri)) {
      const url = new URL(uri);
      if (url.hostname && url.hostname !== 'localhost') return null;
      if (url.username || url.password || url.port || url.search) return null;
      pathname = decodeURIComponent(url.pathname);
    } else {
      if (/^[a-z][a-z\d+.-]*:/i.test(uri) || uri.startsWith('//') || uri.includes('?')) return null;
      pathname = decodeURIComponent(uri.split('#', 1)[0]);
    }
  } catch {
    return null;
  }
  if (/[\u0000-\u001f\u007f\\]/.test(pathname) || pathname.startsWith('//')) return null;
  return /\.(md|mdx)$/i.test(pathname) ? pathname : null;
}
