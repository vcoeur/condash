"""Shell-size guard for dashboard.html.

F5 of the condash-frontend-split project (2026-04, shipped on branch
``condash-frontend-split``) reduced ``dashboard.html`` to a thin HTML
shell — DOM only, no inline JS/CSS beyond the pre-body theme-sync
IIFE that must run before <body> paints. This test asserts the shell
stays under the 500-line cap set by the project README; if it climbs
past that, something has started leaking inline code back in and
should be moved to the bundled modules under ``assets/src/``.
"""

from __future__ import annotations

from pathlib import Path

DASHBOARD = Path(__file__).resolve().parent.parent / "src" / "condash" / "assets" / "dashboard.html"
SHELL_LINE_CAP = 500


def test_dashboard_shell_under_line_cap():
    lines = DASHBOARD.read_text(encoding="utf-8").splitlines()
    assert len(lines) < SHELL_LINE_CAP, (
        f"dashboard.html has {len(lines)} lines (cap: {SHELL_LINE_CAP}). "
        "Move new inline JS/CSS into the bundled modules under "
        "src/condash/assets/src/{js,css}/ rather than back into the shell."
    )


def test_dashboard_shell_has_no_long_inline_script():
    """The only inline <script> permitted in the shell is the pre-body
    theme-sync IIFE (needed before <body> paints so dark-mode users
    don't see a light flash). Any other inline <script> block that
    grows past ~30 lines is a regression of F3/F4 and should move into
    assets/src/js/."""
    html = DASHBOARD.read_text(encoding="utf-8")
    lines = html.splitlines()
    in_block = False
    block_start = 0
    for i, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not in_block and stripped.startswith("<script"):
            # Self-closing / src-only tag — skip.
            if stripped.endswith("</script>") or "src=" in stripped:
                continue
            in_block = True
            block_start = i
            continue
        if in_block and stripped == "</script>":
            size = i - block_start - 1
            assert size <= 30, (
                f"Inline <script> block at line {block_start} is {size} lines "
                f"long (cap: 30). Move it into src/condash/assets/src/js/."
            )
            in_block = False


def test_dashboard_shell_has_no_inline_style():
    """All CSS moved to assets/src/css/ in F2. A re-introduced inline
    <style> block is a regression."""
    html = DASHBOARD.read_text(encoding="utf-8")
    # Match a <style> tag at the start of a line (ignoring indentation) so
    # the word appearing inside HTML comments / prose doesn't false-trip.
    for i, line in enumerate(html.splitlines(), start=1):
        stripped = line.lstrip()
        assert not stripped.startswith("<style"), (
            f"dashboard.html line {i} opens an inline <style> block; "
            "put CSS into src/condash/assets/src/css/ (one of themes, "
            "cards, modals, terminal, notes) and it will be bundled."
        )
