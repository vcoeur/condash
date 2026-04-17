"""Wikilink resolution and rendering for note bodies.

Markdown note bodies use Obsidian-style ``[[target]]`` / ``[[target|label]]``
links. :func:`_preprocess_wikilinks` rewrites every match into a raw-HTML
anchor before pandoc sees the text — pandoc's GFM reader passes raw HTML
through unchanged, so the two-stage pipeline stays single-pass.

Currently reads ``BASE_DIR`` and the ``h`` escape helper from
:mod:`condash.core`; Phase 2 will replace both with an explicit
``RenderCtx`` parameter.
"""

from __future__ import annotations

import re

_WIKILINK_RE = re.compile(r"\[\[([^\]\|\n]+?)(?:\|([^\]\n]+?))?\]\]")

# Match short item slugs ("my-project") vs directory-name slugs
# ("2026-04-16-my-project"). Used by the wikilink resolver.
_DATE_SLUG_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-")

_ITEM_TYPE_NORMAL = {
    "project": "projects",
    "projects": "projects",
    "incident": "incidents",
    "incidents": "incidents",
    "document": "documents",
    "documents": "documents",
}

_MONTH_DIR_RE = re.compile(r"^\d{4}-\d{2}$")


def _find_item_dir(type_plural: str, target: str) -> str | None:
    """Look up a single item directory by exact name or short-name match.

    Scans both the type's top-level and any ``YYYY-MM/`` archive folders.
    Prefers the most recent directory when several short-names collide.
    """
    from . import core as legacy

    root = legacy.BASE_DIR / type_plural
    if not root.is_dir():
        return None
    candidates: list[str] = []
    for child in root.iterdir():
        if not child.is_dir():
            continue
        if child.name == target or (_DATE_SLUG_RE.match(child.name) and child.name[11:] == target):
            candidates.append(child.name)
        if _MONTH_DIR_RE.match(child.name):
            for grand in child.iterdir():
                if not grand.is_dir():
                    continue
                if grand.name == target or (
                    _DATE_SLUG_RE.match(grand.name) and grand.name[11:] == target
                ):
                    candidates.append(f"{child.name}/{grand.name}")
    if not candidates:
        return None
    return max(candidates)  # sorts by date thanks to the YYYY-MM[-DD] prefix


def _resolve_wikilink(target: str) -> str | None:
    """Resolve a ``[[target]]`` to a conception-relative path, if it exists.

    Resolution order:
    1. Prefixed item reference: ``project/<slug>``, ``incidents/<slug>``, etc.
    2. Knowledge path: ``knowledge/topics/foo`` or ``knowledge/foo``.
    3. Short slug across all three item kinds — most recent wins.
    4. Short knowledge page across ``topics/``, ``external/``, ``internal/`` and
       the root ``apps.md`` / ``conventions.md``.
    """
    from . import core as legacy

    target = target.strip()
    if not target:
        return None

    if "/" in target:
        head, _, tail = target.partition("/")
        type_pl = _ITEM_TYPE_NORMAL.get(head)
        if type_pl:
            found = _find_item_dir(type_pl, tail)
            if found:
                return f"{type_pl}/{found}/README.md"
        if head == "knowledge":
            path = target if target.endswith(".md") else f"{target}.md"
            if (legacy.BASE_DIR / path).is_file():
                return path

    for type_pl in ("projects", "incidents", "documents"):
        found = _find_item_dir(type_pl, target)
        if found:
            return f"{type_pl}/{found}/README.md"

    for sub in ("topics", "external", "internal"):
        candidate = legacy.BASE_DIR / "knowledge" / sub / f"{target}.md"
        if candidate.is_file():
            return f"knowledge/{sub}/{target}.md"
    for root_file in ("apps.md", "conventions.md"):
        if target == root_file.removesuffix(".md"):
            candidate = legacy.BASE_DIR / "knowledge" / root_file
            if candidate.is_file():
                return f"knowledge/{root_file}"

    return None


def _preprocess_wikilinks(text: str) -> str:
    """Rewrite ``[[target]]`` / ``[[target|label]]`` into raw-HTML anchors.

    Pandoc GFM passes raw HTML through unchanged, so emitting the final
    ``<a>`` here keeps the rendering pipeline single-pass. Resolved links
    get class ``wikilink``; misses get ``wikilink-missing`` and no href so
    the webview doesn't try to navigate.
    """
    from .core import h

    def repl(match: re.Match) -> str:
        target = match.group(1).strip()
        label = (match.group(2) or target).strip()
        resolved = _resolve_wikilink(target)
        if resolved:
            return (
                f'<a class="wikilink" href="{h(resolved)}" '
                f'data-wikilink-target="{h(target)}">{h(label)}</a>'
            )
        return (
            f'<a class="wikilink-missing" '
            f'title="Wikilink target not found: {h(target)}">{h(label)}</a>'
        )

    return _WIKILINK_RE.sub(repl, text)
