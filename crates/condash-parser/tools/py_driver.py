"""Python driver for the parser diff harness.

Invoked by ``parser-diff`` (the Rust bin in the same crate) in two modes:

1. **per-README mode** (default): read README paths from stdin one per
   line, call :func:`condash.parser.parse_readme` for each, emit
   ``{path, data}`` JSON lines on stdout.

2. **collect mode** (``--mode=collect``): ignore stdin, call
   :func:`condash.parser.collect_items` and :func:`collect_knowledge`
   once, emit a single JSON document on stdout — keyed ``{items,
   knowledge}``.

Stdout is newline-delimited JSON for per-README mode so the Rust
consumer can stream-parse. Stderr carries warnings and summary lines.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _build_ctx(condash_src: str, base_dir: Path):
    """Import condash from ``condash_src`` and return a minimal RenderCtx."""
    sys.path.insert(0, condash_src)
    from condash.context import RenderCtx  # noqa: E402

    return RenderCtx(
        base_dir=base_dir,
        workspace=None,
        worktrees=None,
        repo_structure=[],
    )


def _run_per_readme(condash_src: str, base_dir: Path) -> int:
    ctx = _build_ctx(condash_src, base_dir)
    from condash.parser import parse_readme  # noqa: E402

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
        rel = str(path.relative_to(base_dir))
        sys.stdout.write(json.dumps({"path": rel, "data": result}, ensure_ascii=False))
        sys.stdout.write("\n")
        sys.stdout.flush()
        count += 1

    print(f"driver: parsed {count} READMEs", file=sys.stderr)
    return 0


def _run_collect(condash_src: str, base_dir: Path) -> int:
    ctx = _build_ctx(condash_src, base_dir)
    from condash.parser import collect_items, collect_knowledge  # noqa: E402

    items = collect_items(ctx)
    knowledge = collect_knowledge(ctx)
    out = {"items": items, "knowledge": knowledge}
    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()
    print(
        f"driver: collect items={len(items)} knowledge={'present' if knowledge else 'absent'}",
        file=sys.stderr,
    )
    return 0


def _load_full_ctx(condash_src: str, conception: Path):
    """Build a real RenderCtx with workspace + repo_structure populated.

    Reads the versioned ``config/repositories.yml`` under ``conception``
    so tests run against the exact same config condash does. When the
    YAML is missing, falls back to a minimal ctx (workspace=None).
    """
    sys.path.insert(0, condash_src)
    from condash.config import (  # noqa: E402
        CondashConfig,
        _apply_repositories_yaml,
        load_repositories_yaml,
        repositories_yaml_path,
    )
    from condash.context import build_ctx  # noqa: E402

    cfg = CondashConfig(conception_path=conception)
    yaml_target = repositories_yaml_path(conception)
    if yaml_target is not None and yaml_target.is_file():
        data = load_repositories_yaml(yaml_target)
        _apply_repositories_yaml(cfg, data, yaml_target)
    return build_ctx(cfg)


def _serialise_ctx(ctx) -> dict:
    """Serialise just the fields the Rust diff tool needs to rebuild
    an equivalent ctx: workspace, worktrees, repo_structure."""
    structure = []
    for label, entries in ctx.repo_structure:
        structure.append(
            {
                "label": label,
                "repos": [{"name": name, "submodules": list(subs)} for name, subs in entries],
            }
        )
    return {
        "workspace": str(ctx.workspace) if ctx.workspace else None,
        "worktrees": str(ctx.worktrees) if ctx.worktrees else None,
        "repo_structure": structure,
        # Runner keys for the node-fingerprint computation. Value side
        # of the dict isn't needed — just which keys carry a `run:`
        # config. The Rust port emits `|run:off` for every configured
        # key (no live session yet) which matches Python's behaviour.
        "repo_run_keys": sorted(ctx.repo_run.keys()),
    }


def _run_git(condash_src: str, conception: Path) -> int:
    """Emit resolved ctx + git_scan outputs for the Rust diff tool."""
    ctx = _load_full_ctx(condash_src, conception)
    from condash.git_scan import (  # noqa: E402
        _collect_git_repos,
        _git_fingerprint,
        compute_git_node_fingerprints,
    )

    groups = _collect_git_repos(ctx)
    # Python's tuple shape: list[(label, list[family_dict])]. Normalise
    # to a list of {label, families} dicts so the JSON round-trips
    # cleanly.
    groups_json = [
        {"label": label, "families": list(families)} for label, families in groups
    ]

    out = {
        "ctx": _serialise_ctx(ctx),
        "groups": groups_json,
        "fingerprint": _git_fingerprint(ctx),
        "node_fingerprints": compute_git_node_fingerprints(ctx),
    }
    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()
    n_repos = sum(len(g["families"]) for g in groups_json)
    print(
        f"driver: git groups={len(groups_json)} families={n_repos}"
        f" node_fingerprints={len(out['node_fingerprints'])}"
        f" fp={out['fingerprint']}",
        file=sys.stderr,
    )
    return 0


def _run_search(condash_src: str, conception: Path, query: str) -> int:
    """Emit ``search_items`` output for the given query."""
    ctx = _load_full_ctx(condash_src, conception)
    from condash.parser import collect_items  # noqa: E402
    from condash.search import search_items  # noqa: E402

    items = collect_items(ctx)
    results = search_items(ctx, items, query)
    out = {"query": query, "results": results}
    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()
    print(f"driver: search query={query!r} hits={len(results)}", file=sys.stderr)
    return 0


def _run_render(condash_src: str, base_dir: Path) -> int:
    """Emit rendered HTML for every card and knowledge node/card.

    Shape: ``{"cards": {slug: html}, "knowledge_groups": {rel_dir: html},
    "knowledge_cards": {path: html}}``. The Rust side reproduces the
    same keys and diffs byte-for-byte.
    """
    ctx = _build_ctx(condash_src, base_dir)
    from condash.parser import collect_items, collect_knowledge  # noqa: E402
    from condash.render import (  # noqa: E402
        _render_history,
        _render_knowledge,
        render_card_fragment,
        render_knowledge_card_fragment,
        render_knowledge_group_fragment,
    )

    items = collect_items(ctx)
    knowledge = collect_knowledge(ctx)

    cards = {item["slug"]: render_card_fragment(item) for item in items}

    knowledge_groups: dict[str, str] = {}
    knowledge_cards: dict[str, str] = {}

    def _walk(node):
        if node is None:
            return
        knowledge_groups[node["rel_dir"]] = render_knowledge_group_fragment(node)
        if node.get("index"):
            knowledge_cards[node["index"]["path"]] = render_knowledge_card_fragment(node["index"])
        for entry in node.get("body", []):
            knowledge_cards[entry["path"]] = render_knowledge_card_fragment(entry)
        for child in node.get("children", []):
            _walk(child)

    _walk(knowledge)

    # render_page substitution pipeline depends on git_scan (later
    # slice) + a pinned timestamp + pinned version. Instead of mocking
    # the whole chain here, we compare the two expensive sub-trees the
    # diff actually cares about — history and the knowledge-tree
    # render. The caller will diff render_page as a whole once
    # git_scan lands.
    history = _render_history(ctx, items)
    knowledge_tree = _render_knowledge(knowledge)

    out = {
        "cards": cards,
        "knowledge_groups": knowledge_groups,
        "knowledge_cards": knowledge_cards,
        "history": history,
        "knowledge_tree": knowledge_tree,
    }
    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()
    print(
        (
            f"driver: render cards={len(cards)}"
            f" knowledge_groups={len(knowledge_groups)}"
            f" knowledge_cards={len(knowledge_cards)}"
        ),
        file=sys.stderr,
    )
    return 0


def _run_fingerprints(condash_src: str, base_dir: Path) -> int:
    """Emit {overall, project_nodes, knowledge_nodes} for fingerprint diff.

    Python's fingerprint helpers all hash ``repr(data)`` bytes via MD5
    truncated to 16 hex chars. The Rust port reproduces Python's
    ``repr`` output verbatim for the limited value universe in use here
    (tuples, strings, ints). This mode lets the diff harness confirm
    the two sides emit byte-identical fingerprint dicts against the
    live corpus.
    """
    ctx = _build_ctx(condash_src, base_dir)
    from condash.parser import (  # noqa: E402
        _compute_fingerprint,
        collect_items,
        collect_knowledge,
        compute_knowledge_node_fingerprints,
        compute_project_node_fingerprints,
    )

    items = collect_items(ctx)
    knowledge = collect_knowledge(ctx)
    out = {
        "overall": _compute_fingerprint(items),
        "project_nodes": compute_project_node_fingerprints(items),
        "knowledge_nodes": compute_knowledge_node_fingerprints(knowledge),
    }
    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()
    print(
        (
            f"driver: fingerprints overall={out['overall']}"
            f" project_nodes={len(out['project_nodes'])}"
            f" knowledge_nodes={len(out['knowledge_nodes'])}"
        ),
        file=sys.stderr,
    )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--condash-src", required=True, help="path to condash's src/ directory")
    ap.add_argument("--base-dir", required=True, help="conception base_dir for RenderCtx")
    ap.add_argument(
        "--mode",
        choices=("per-readme", "collect", "fingerprints", "render", "git", "search"),
        default="per-readme",
        help=(
            "per-readme = stream one {path,data} per line; "
            "collect = emit a single {items,knowledge} doc; "
            "fingerprints = emit {overall, project_nodes, knowledge_nodes} hashes; "
            "render = emit {cards, knowledge_groups, knowledge_cards} HTML strings; "
            "git = emit resolved {ctx, groups, fingerprint, node_fingerprints}; "
            "search = emit {query, results} via search_items"
        ),
    )
    ap.add_argument("--query", default="", help="query string (search mode)")
    args = ap.parse_args()

    base_dir = Path(args.base_dir).resolve()
    if args.mode == "collect":
        return _run_collect(args.condash_src, base_dir)
    if args.mode == "fingerprints":
        return _run_fingerprints(args.condash_src, base_dir)
    if args.mode == "render":
        return _run_render(args.condash_src, base_dir)
    if args.mode == "git":
        return _run_git(args.condash_src, base_dir)
    if args.mode == "search":
        return _run_search(args.condash_src, base_dir, args.query)
    return _run_per_readme(args.condash_src, base_dir)


if __name__ == "__main__":
    raise SystemExit(main())
