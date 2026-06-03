// Terminal-log browsing: per-session file summaries, the read-session body +
// metadata payload, and the cross-pane "open this log" request.

/** Per-session log file summary — what the Logs pane's session selector
 * renders as one row per spawn. Pairs an absolute `.txt` path with
 * sidecar metadata. */
export interface TermLogSessionMeta {
  /** Absolute path to the `.txt` file. */
  path: string;
  /** Day directory this session lives in, `YYYY-MM-DD`. */
  day: string;
  /** Spawn-time HH:MM:SS, parsed from the filename prefix. */
  time: string;
  /** Total size of the `.txt` in bytes. */
  bytes: number;
  /** Session id (the `<sid>` suffix in the filename). */
  sid: string;
  /** Optional repo name from the spawn event. */
  repo?: string;
  /** Cwd captured at spawn. */
  cwd?: string;
  /** Spawn command argv joined (truncated to 80 chars in the renderer). */
  cmd?: string;
  /** Exit code, if `exit` was reached; undefined while a long-running
   * session is still alive; `null` when the boot-time orphan-seal pass
   * found a session without a footer (process gone before the footer
   * could flush) — UI renders this as "ended (unknown)" instead of
   * "running". */
  exitCode?: number | null;
  /** True when the footer was synthesised by the orphan-seal recovery
   * (i.e. condash exited before SessionLogger.exit() could flush). UI
   * uses this to render a distinct status pill. */
  exitSealed?: boolean;
}

/** Contents of a session — plain-text body + parsed metadata. Returned
 * by `logsReadSession`. */
export interface TermLogSessionRead {
  /** Rendered terminal buffer as plain UTF-8 text. Metadata header /
   * footer lines (`# condash: {...}`) have been stripped before return —
   * the renderer sees just the body. */
  text: string;
  /** Metadata parsed from the header line (and footer line, if the
   * session has exited). Best-effort — null if the file has no
   * recognisable header. */
  meta: TermLogSessionMeta | null;
}

/** External "open this log" request — posted by the global-search modal
 * when the user activates a log hit. The Logs pane reacts by swapping
 * day + session to point at `path`. The hit offset is informational
 * (future scroll-to-line); the search box is left as the user typed. */
export interface LogsOpenRequest {
  path: string;
  /** Identity nonce so the same path activated twice in a row still
   * fires the reaction effect. */
  nonce: number;
}
