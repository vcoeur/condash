"""Jinja2 environment for :mod:`condash.render`.

Templates live under ``src/condash/templates/`` and are resolved through
``importlib.resources`` so they ship inside the wheel without any
``include`` ceremony in ``pyproject.toml``.

The ``embed`` filter replaces the
``json.dumps(x).replace("'", "\\'").replace('"', "'")`` dance that
repeats 20+ times in the legacy string-concatenation renderer. Output is
marked :class:`markupsafe.Markup` so Jinja's autoescape doesn't re-escape
the single quotes that make the encoded literal safe to embed inside a
double-quoted HTML attribute — e.g. ``onclick="foo({{ path | embed }})"``.
"""

from __future__ import annotations

import json
from functools import lru_cache
from importlib.resources import files as _package_files
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup


def _embed_data(obj) -> Markup:
    """Return ``obj`` as a JSON literal safe to drop into an HTML attribute.

    Matches the exact output of the legacy inline helper so already-rendered
    fragments bit-match the pre-migration string-concat output. The
    :class:`Markup` wrapper tells Jinja to leave the single quotes intact
    under autoescape.
    """
    return Markup(json.dumps(obj).replace("'", "\\'").replace('"', "'"))


def _subtree_count(group: dict) -> int:
    """Total file count under ``group``, recursing into nested groups."""
    return len(group.get("files") or []) + sum(_subtree_count(g) for g in group.get("groups") or [])


@lru_cache(maxsize=1)
def env() -> Environment:
    """Return the process-wide Jinja environment, built on first access."""
    template_dir = Path(str(_package_files("condash") / "templates"))
    environment = Environment(
        loader=FileSystemLoader(str(template_dir)),
        autoescape=select_autoescape(["html", "j2"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    environment.filters["embed"] = _embed_data
    environment.filters["subtree_count"] = _subtree_count
    return environment


def render(template_name: str, **context) -> str:
    """Small shorthand for ``env().get_template(name).render(**context)``."""
    return env().get_template(template_name).render(**context)
