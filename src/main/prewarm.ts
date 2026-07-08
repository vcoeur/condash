/**
 * Boot prewarms for the two cold scans that gate the default panes (review
 * finding S1).
 *
 * After first paint the Projects and Code panes show "Loading…" until (a) a cold
 * parse of every project README and (b) a git-status fan-out over the configured
 * repos complete — and neither starts until the renderer asks. Main already
 * knows the conception path before it creates the window, so we kick both scans
 * off there, in parallel with `createWindow`, filling the same process-wide
 * caches the renderer's first `listProjects` / `listRepos` calls read.
 *
 * Fire-and-forget by contract: a prewarm never blocks window creation and
 * swallows its own errors (a boot that can't prewarm still renders — the
 * renderer just pays the cold cost itself, exactly as before this optimisation).
 */
import { parseReadmeCached } from './parse-cache';
import { prewarmRepos } from './repos';
import { findProjectReadmes } from './walk';

/**
 * Warm the mtime-keyed `parseReadme` memo for every project README, via the same
 * `findProjectReadmes` + `parseReadmeCached` path `listProjects` uses. The memo
 * is a process-wide module singleton, so the renderer's first `listProjects`
 * hits it (a cache hit re-stats each unchanged README and skips the re-parse).
 * Per-file parse failures are swallowed so one bad README can't fail the warm.
 *
 * @param conceptionPath active conception root
 */
async function prewarmProjectReadmes(conceptionPath: string): Promise<void> {
  const readmes = await findProjectReadmes(conceptionPath);
  await Promise.all(readmes.map((readme) => parseReadmeCached(readme).catch(() => undefined)));
}

/**
 * Fire-and-forget both boot scans (S1) for `conceptionPath`. Returns
 * immediately; each scan runs to completion in the background and logs at most a
 * single `console.warn` on failure. Call from whenReady, before `createWindow`,
 * once a conception path is known.
 *
 * @param conceptionPath active conception root
 */
export function prewarmDefaultPanes(conceptionPath: string): void {
  void prewarmProjectReadmes(conceptionPath).catch((err) => {
    console.warn('[prewarm] project README scan failed:', err);
  });
  // prewarmRepos stashes the boot scan for the renderer's first listRepos to
  // reuse; the `.catch` here swallows a boot-scan failure (and marks the stashed
  // promise's rejection handled) so an unconsumed prewarm never trips the
  // unhandled-rejection guard.
  void prewarmRepos(conceptionPath).catch((err) => {
    console.warn('[prewarm] repo git-status scan failed:', err);
  });
}
