#!/usr/bin/env python3
"""audit.py — audit conception/ for convention drift.

Read-only audit. Walks the conception tree and surrounding sibling apps,
checks the rules captured in conception/CLAUDE.md, and emits a JSON report
to stdout. Never writes to disk.

Consumed by `/knowledge verify` and `/projects worktree status`. Both shell
out with `--checks=<list>` to run a subset.

Usage:
    python3 .claude/scripts/audit.py                     # all checks, JSON
    python3 .claude/scripts/audit.py --pretty            # human-readable
    python3 .claude/scripts/audit.py --checks=stamps,lfs # subset, JSON

Requires Python 3 stdlib only.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
# audit.py lives at <conception>/.claude/scripts/audit.py, so the conception
# root is two parents up from the script directory:
#   scripts/ -> .claude/ -> <conception>/
CONCEPTION_ROOT = SCRIPT_DIR.parent.parent


def _load_configuration() -> dict:
    """Read configuration.json from the conception root. Empty dict on failure
    so the audit degrades to legacy defaults rather than crashing."""
    cfg = CONCEPTION_ROOT / "configuration.json"
    if not cfg.is_file():
        return {}
    try:
        return json.loads(cfg.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


_CONFIG = _load_configuration()


def _path_from_config(key: str, fallback: Path) -> Path:
    raw = _CONFIG.get(key)
    if not raw:
        return fallback
    return Path(str(raw)).expanduser()


# Sibling apps root: where this conception's siblings (apps, repos) live.
# `workspace_path` from configuration.json wins; fall back to the parent of
# CONCEPTION_ROOT so old layouts still work.
SIBLING_APPS_ROOT = _path_from_config("workspace_path", CONCEPTION_ROOT.parent)

# Worktrees root: where `/projects worktree setup` lays branches down.
# `worktrees_path` from configuration.json wins; fall back to ~/src/worktrees.
WORKTREES_ROOT = _path_from_config("worktrees_path", Path.home() / "src" / "worktrees")

STALE_DAYS = 30
LFS_LARGE_KB = 50

# Skip subtrees that aren't part of any conception scan:
#  - the conception checkout itself (skip self by name, not by literal "conception")
#  - VCS / build / cache scratch
#  - vendored sub-trees
SKIP_DIRS = {".git", "node_modules", "saved_steps", "actions", "alice", CONCEPTION_ROOT.name}


def _git_in_scope_files() -> set[str]:
    """Paths (rel to CONCEPTION_ROOT) git considers in-scope: tracked +
    untracked-not-gitignored. Gitignored files never appear in any check."""
    try:
        result = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
            cwd=CONCEPTION_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return set()
    if result.returncode != 0:
        return set()
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


_IN_SCOPE_CACHE: set[str] | None = None


def in_scope(rel_path: str) -> bool:
    global _IN_SCOPE_CACHE
    if _IN_SCOPE_CACHE is None:
        _IN_SCOPE_CACHE = _git_in_scope_files()
    return rel_path in _IN_SCOPE_CACHE


_LFS_CACHE: set[str] | None = None
_LFS_AVAILABLE: bool = True


def _git_lfs_files() -> set[str]:
    """Paths (rel to CONCEPTION_ROOT) tracked by git-lfs."""
    global _LFS_AVAILABLE
    try:
        result = subprocess.run(
            ["git", "lfs", "ls-files", "-n"],
            cwd=CONCEPTION_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        _LFS_AVAILABLE = False
        return set()
    if result.returncode != 0:
        _LFS_AVAILABLE = False
        return set()
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def lfs_files() -> set[str]:
    global _LFS_CACHE
    if _LFS_CACHE is None:
        _LFS_CACHE = _git_lfs_files()
    return _LFS_CACHE


def issue(
    check: str,
    severity: str,
    *,
    file: Path | None = None,
    line: int | None = None,
    message: str = "",
    auto_fix: bool = False,
    fix: dict | None = None,
) -> dict[str, Any]:
    return {
        "check": check,
        "severity": severity,
        "file": str(file.relative_to(CONCEPTION_ROOT)) if file and _under(file, CONCEPTION_ROOT) else (str(file) if file else None),
        "line": line,
        "message": message,
        "auto_fix": auto_fix,
        "fix": fix,
    }


def _under(p: Path, root: Path) -> bool:
    try:
        p.relative_to(root)
        return True
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# Check — Per-directory index.md tree ↔ knowledge/ files
# ---------------------------------------------------------------------------
# Every directory under knowledge/ carries an index.md listing its immediate
# children. Dangling entries (pointing at missing files) and orphan body files
# (present but unlisted) are both reported.
def check_knowledge_index() -> list[dict]:
    issues: list[dict] = []
    knowledge_dir = CONCEPTION_ROOT / "knowledge"
    if not knowledge_dir.is_dir():
        return [issue("knowledge_index", "error", file=knowledge_dir, message="knowledge/ directory missing")]

    root_index = knowledge_dir / "index.md"
    if not root_index.exists():
        return [issue("knowledge_index", "error", file=root_index, message="knowledge/index.md missing — run /knowledge index")]

    indexed_by_dir: dict[Path, set[str]] = {}

    for d in sorted([knowledge_dir] + [p for p in knowledge_dir.rglob("*") if p.is_dir()]):
        idx = d / "index.md"
        if not idx.exists():
            issues.append(
                issue(
                    "knowledge_index",
                    "warn",
                    file=idx,
                    message=f"Directory knowledge/{d.relative_to(knowledge_dir).as_posix() or '.'} has no index.md — run /knowledge index",
                    auto_fix=False,
                )
            )
            continue
        indexed_by_dir[d] = set()

    for d, entries in indexed_by_dir.items():
        idx = d / "index.md"
        text = idx.read_text()
        for m in re.finditer(r"\[(?P<label>[^\]]+)\]\((?P<path>[^)]+)\)", text):
            raw = m.group("path").split("#", 1)[0].split(" ", 1)[0]
            if not raw or raw.startswith(("http://", "https://", "mailto:")):
                continue
            if raw.startswith("../") or raw.startswith("/"):
                continue

            line_no = text.count("\n", 0, m.start()) + 1
            label = m.group("label")
            target = (d / raw).resolve()

            try:
                rel_to_d = target.relative_to(d)
            except ValueError:
                continue
            parts = rel_to_d.parts
            is_body = len(parts) == 1 and parts[0].endswith(".md") and parts[0] != "index.md"
            is_subindex = len(parts) == 2 and parts[1] == "index.md"
            if not (is_body or is_subindex):
                continue

            if not target.exists():
                issues.append(
                    issue(
                        "knowledge_index_dangling",
                        "warn",
                        file=idx,
                        line=line_no,
                        message=f"Index entry [{label}]({raw}) points to a file that does not exist",
                        auto_fix=True,
                        fix={
                            "action": "remove_index_line",
                            "index_file": str(idx.relative_to(CONCEPTION_ROOT)),
                            "path": raw,
                            "label": label,
                        },
                    )
                )
                continue

            entries.add(str(target.relative_to(CONCEPTION_ROOT)))

    for md in sorted(knowledge_dir.rglob("*.md")):
        if md.name == "index.md":
            continue
        parent = md.parent
        rel = str(md.relative_to(CONCEPTION_ROOT))
        if parent in indexed_by_dir and rel not in indexed_by_dir[parent]:
            issues.append(
                issue(
                    "knowledge_index_orphan",
                    "warn",
                    file=md,
                    message=f"Body file not referenced from {parent.relative_to(CONCEPTION_ROOT)}/index.md — run /knowledge index",
                    auto_fix=False,
                    fix={"action": "run_knowledge_index", "path": rel},
                )
            )

    return issues


# ---------------------------------------------------------------------------
# Check — Cross-repo CLAUDE.md → conception references
# ---------------------------------------------------------------------------
def find_app_claude_mds() -> list[Path]:
    found: list[Path] = []
    for app in sorted(SIBLING_APPS_ROOT.iterdir()):
        if not app.is_dir() or app.name in SKIP_DIRS or app.name.startswith("."):
            continue
        for candidate in (app / "CLAUDE.md", app / ".claude" / "CLAUDE.md"):
            if candidate.is_file():
                found.append(candidate)
        for sub in sorted(app.iterdir()) if app.is_dir() else []:
            if not sub.is_dir() or sub.name.startswith("."):
                continue
            for candidate in (sub / "CLAUDE.md", sub / ".claude" / "CLAUDE.md"):
                if candidate.is_file():
                    found.append(candidate)
    return found


def check_cross_repo_refs() -> list[dict]:
    issues: list[dict] = []
    pattern = re.compile(r"\(((?:\.\./)+conception/[^)\s]+)\)")
    for app_md in find_app_claude_mds():
        text = app_md.read_text()
        for m in pattern.finditer(text):
            ref = m.group(1)
            target = (app_md.parent / ref).resolve()
            if not target.exists():
                line_no = text[: m.start()].count("\n") + 1
                issues.append(
                    issue(
                        "cross_repo_dangling",
                        "warn",
                        file=app_md,
                        line=line_no,
                        message=f"Reference to {ref} does not resolve",
                        auto_fix=True,
                        fix={"action": "flag_for_user_edit", "ref": ref, "in_file": str(app_md)},
                    )
                )
    return issues


# ---------------------------------------------------------------------------
# Check — Item Branch field ↔ worktree existence
# ---------------------------------------------------------------------------
BRANCH_FIELD = re.compile(r"\*\*Branch\*\*:\s*`?([^`\n,]+)`?", re.MULTILINE)
STATUS_FIELD = re.compile(r"\*\*Status\*\*:\s*(\w+)", re.MULTILINE)


def _is_done_item(readme: Path) -> bool:
    """Items with Status: done do not need active worktrees."""
    try:
        text = readme.read_text()
    except OSError:
        return False
    m = STATUS_FIELD.search(text)
    return bool(m and m.group(1).lower() == "done")


def check_branch_worktrees() -> list[dict]:
    issues: list[dict] = []
    projects_dir = CONCEPTION_ROOT / "projects"
    if not projects_dir.exists():
        return issues
    for readme in sorted(projects_dir.rglob("README.md")):
        if "/notes/" in readme.as_posix():
            continue
        if _is_done_item(readme):
            continue
        text = readme.read_text()
        for m in BRANCH_FIELD.finditer(text):
            branch = m.group(1).strip().strip("`")
            if not branch or "(" in branch:
                continue
            wt = WORKTREES_ROOT / branch
            if not wt.exists():
                line_no = text[: m.start()].count("\n") + 1
                issues.append(
                    issue(
                        "branch_no_worktree",
                        "info",
                        file=readme,
                        line=line_no,
                        message=f"Item declares Branch '{branch}' but no worktree at {wt}",
                        auto_fix=False,
                        fix={"action": "offer_worktree_setup", "branch": branch},
                    )
                )
    return issues


# ---------------------------------------------------------------------------
# Check — Stale verification stamps
# ---------------------------------------------------------------------------
STAMP_VERIFIED = re.compile(r"\*\*Verified:\*\*\s*(\d{4}-\d{2}-\d{2})")


def check_stale_verification() -> list[dict]:
    issues: list[dict] = []
    cutoff = date.today() - timedelta(days=STALE_DAYS)
    for md in sorted((CONCEPTION_ROOT / "knowledge").rglob("*.md")):
        try:
            text = md.read_text()
        except OSError:
            continue
        for line_idx, line in enumerate(text.splitlines(), 1):
            m = STAMP_VERIFIED.search(line)
            if not m:
                continue
            try:
                stamp = datetime.strptime(m.group(1), "%Y-%m-%d").date()
            except ValueError:
                continue
            if stamp < cutoff:
                age_days = (date.today() - stamp).days
                issues.append(
                    issue(
                        "stale_verification",
                        "info",
                        file=md,
                        line=line_idx,
                        message=f"Verification stamp {m.group(1)} is {age_days} days old (> {STALE_DAYS}d threshold)",
                        auto_fix=False,
                        fix={"action": "refresh_verification", "date": m.group(1)},
                    )
                )
    return issues


# ---------------------------------------------------------------------------
# Check — LFS coverage for binary files under projects/
# ---------------------------------------------------------------------------
def check_lfs_coverage() -> list[dict]:
    tracked = lfs_files()
    if not _LFS_AVAILABLE:
        return [issue("lfs_coverage", "info", message="git-lfs not available; skipping LFS check")]

    issues: list[dict] = []
    d = CONCEPTION_ROOT / "projects"
    if not d.exists():
        return issues
    for ext in ("*.pdf", "*.png", "*.jpg", "*.jpeg"):
        for f in sorted(d.rglob(ext)):
            rel = f.relative_to(CONCEPTION_ROOT).as_posix()
            if not in_scope(rel):
                continue
            if rel not in tracked:
                try:
                    size_kb = f.stat().st_size / 1024
                except OSError:
                    size_kb = 0
                issues.append(
                    issue(
                        "lfs_uncovered",
                        "warn",
                        file=f,
                        message=f"{rel} ({size_kb:.0f} kB) is not tracked by git-lfs",
                        auto_fix=True,
                        fix={"action": "lfs_track_path", "path": rel, "size_kb": int(size_kb)},
                    )
                )
    return issues


# ---------------------------------------------------------------------------
# Check — Large binary review (> 50 kB AND not in git-lfs)
# ---------------------------------------------------------------------------
def check_large_binaries() -> list[dict]:
    issues: list[dict] = []
    tracked = lfs_files()
    d = CONCEPTION_ROOT / "projects"
    if not d.exists():
        return issues
    for ext in ("*.pdf", "*.png", "*.jpg", "*.jpeg"):
        for f in sorted(d.rglob(ext)):
            rel = f.relative_to(CONCEPTION_ROOT).as_posix()
            if not in_scope(rel):
                continue
            if rel in tracked:
                continue
            try:
                size_kb = f.stat().st_size / 1024
            except OSError:
                continue
            if size_kb > LFS_LARGE_KB:
                issues.append(
                    issue(
                        "large_binary",
                        "info",
                        file=f,
                        message=f"{rel} is {size_kb:.0f} kB (> {LFS_LARGE_KB} kB review threshold, not in git-lfs)",
                        auto_fix=False,
                    )
                )
    return issues


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------
# Check name aliases are what --checks=… accepts. Short names are the primary;
# long names remain accepted as aliases so existing invocations keep working.
CHECKS = {
    "index":       check_knowledge_index,
    "cross-repo":  check_cross_repo_refs,
    "worktrees":   check_branch_worktrees,
    "stamps":      check_stale_verification,
    "lfs":         check_lfs_coverage,
    "binaries":    check_large_binaries,
}


def run_selected(selected: list[str]) -> dict:
    all_issues: list[dict] = []
    for name in selected:
        fn = CHECKS.get(name)
        if fn is None:
            all_issues.append(issue(name, "error", message=f"unknown check: {name}"))
            continue
        try:
            all_issues.extend(fn())
        except Exception as exc:
            all_issues.append(
                issue(
                    name,
                    "error",
                    message=f"check crashed: {type(exc).__name__}: {exc}",
                )
            )

    by_severity: dict[str, int] = {}
    by_check: dict[str, int] = {}
    for i in all_issues:
        by_severity[i["severity"]] = by_severity.get(i["severity"], 0) + 1
        by_check[i["check"]] = by_check.get(i["check"], 0) + 1

    return {
        "summary": {
            "total": len(all_issues),
            "by_severity": by_severity,
            "by_check": by_check,
            "auto_fixable": sum(1 for i in all_issues if i["auto_fix"]),
            "conception_root": str(CONCEPTION_ROOT),
            "checks_run": selected,
        },
        "issues": all_issues,
    }


def render_pretty(report: dict) -> None:
    s = report["summary"]
    print("=== conception audit ===")
    print(f"Root:         {s['conception_root']}")
    print(f"Checks run:   {', '.join(s['checks_run'])}")
    print(f"Total:        {s['total']} issues")
    print(f"Auto-fixable: {s['auto_fixable']}")
    print(f"Severity:     {s['by_severity']}")
    print(f"By check:     {s['by_check']}")
    print()
    if not report["issues"]:
        print("No issues found.")
        return
    for i in report["issues"]:
        loc = i["file"] or "-"
        if i.get("line"):
            loc = f"{loc}:{i['line']}"
        af = " [auto-fix]" if i["auto_fix"] else ""
        print(f"[{i['severity']:5}] {i['check']:24} {loc}")
        print(f"        {i['message']}{af}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--pretty", action="store_true", help="Human-readable output instead of JSON")
    parser.add_argument(
        "--checks",
        default="",
        help=(
            "Comma-separated subset of checks to run. Known names: "
            + ", ".join(CHECKS.keys())
            + ". Default: all."
        ),
    )
    args = parser.parse_args()

    if args.checks:
        selected = [c.strip() for c in args.checks.split(",") if c.strip()]
    else:
        selected = list(CHECKS.keys())

    report = run_selected(selected)
    if args.pretty:
        render_pretty(report)
    else:
        json.dump(report, sys.stdout, indent=2, default=str)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
