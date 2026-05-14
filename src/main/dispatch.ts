/**
 * Unified-binary dispatch (v2.24.0). Decides whether a `condash` invocation
 * targets the GUI or the CLI, given `process.argv`. Pure — no side effects;
 * the caller in `src/main/index.ts` does the actual mutate / spawn / exit.
 *
 * Rule C from `projects/2026-05/2026-05-13-condash-cli-reference/notes/
 * 02-unified-binary-design.md`:
 *   • no args        → GUI
 *   • `gui [args]`   → GUI with the `gui` token stripped (rest are Chromium switches)
 *   • anything else  → CLI
 */

export type DispatchDecision = { kind: 'gui'; argv: string[] } | { kind: 'cli'; cliArgs: string[] };

/**
 * `argv` is the full process.argv shape that Electron's main process sees
 * (`[binaryPath, ...userArgs]`). Returns the decision; the caller mutates
 * process.argv / spawns as needed.
 */
export function decideDispatch(argv: readonly string[]): DispatchDecision {
  const firstArg = argv[1];
  if (firstArg === undefined || firstArg === '') {
    return { kind: 'gui', argv: [...argv] };
  }
  if (firstArg === 'gui') {
    return { kind: 'gui', argv: [argv[0]!, ...argv.slice(2)] };
  }
  return { kind: 'cli', cliArgs: argv.slice(1) };
}
