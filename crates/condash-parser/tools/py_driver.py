"""Python driver for the Phase 1 parser diff harness.

Invoked by `parser-diff` (the Rust bin in the same crate). For each
README path given on stdin (one per line, or `--` terminator), parses
the README via `condash.parser.parse_readme` and emits the resulting
dict as JSON on stdout — one JSON object per line, keyed `{path, data}`.

The `files` field is dropped before serialisation: the Rust port does
not currently build the files-tree (that's a Phase 2 filesystem concern),
so diffing that field would be noise.

Usage:
    python3 py_driver.py --condash-src <path> --base-dir <path>

Paths are read one per line from stdin until EOF. Each path must be an
absolute path to a README.md under `--base-dir`.

Stdout is newline-delimited JSON so the Rust consumer can stream-parse.
Stderr carries warnings and summary lines.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--condash-src", required=True, help="path to condash's src/ directory")
    ap.add_argument("--base-dir", required=True, help="conception base_dir for RenderCtx")
    args = ap.parse_args()

    sys.path.insert(0, args.condash_src)

    # Imports deferred until after sys.path is set so we pick up the
    # condash package under `--condash-src`.
    from condash.context import RenderCtx  # noqa: E402
    from condash.parser import parse_readme  # noqa: E402

    base_dir = Path(args.base_dir).resolve()
    ctx = RenderCtx(
        base_dir=base_dir,
        workspace=None,
        worktrees=None,
        repo_structure=[],
    )

    count = 0
    for raw in sys.stdin:
        path_str = raw.strip()
        if not path_str:
            continue
        path = Path(path_str).resolve()
        try:
            result = parse_readme(ctx, path)
        except Exception as exc:  # noqa: BLE001 — driver surface only
            print(f"driver: error parsing {path}: {exc}", file=sys.stderr)
            result = None
        if result is not None:
            result.pop("files", None)
        rel = str(path.relative_to(base_dir))
        sys.stdout.write(json.dumps({"path": rel, "data": result}, ensure_ascii=False))
        sys.stdout.write("\n")
        sys.stdout.flush()
        count += 1

    print(f"driver: parsed {count} READMEs", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
