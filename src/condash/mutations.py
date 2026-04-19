"""File-mutation helpers — the write side of the dashboard.

Every handler here mutates a Markdown file in place under ``ctx.base_dir``:
flipping checkboxes, inserting new steps, renaming notes. Paths must already
be validated (via :mod:`condash.paths`) before these functions see them —
they do not re-check the sandbox.
"""

from __future__ import annotations

import datetime as _dt
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any, BinaryIO

from .context import RenderCtx
from .parser import (
    CHECKBOX_RE,
    HEADING2_RE,
    HEADING3_RE,
    KINDS,
    METADATA_RE,
    PRIORITIES,
    STATUS_RE,
    VALID_SLUG_RE,
    _note_kind,
)
from .paths import (
    _VALID_ITEM_NOTES_FILE_RE,
    _VALID_NOTE_FILENAME_RE,
    _validate_path,
    validate_note_path,
)


def read_note_raw(ctx: RenderCtx, full_path: Path) -> dict[str, Any]:
    """Return the plain bytes + mtime + kind for the edit surface."""
    stat_res = full_path.stat()
    content = full_path.read_text(encoding="utf-8", errors="replace")
    return {
        "path": str(full_path.relative_to(ctx.base_dir)),
        "content": content,
        "mtime": stat_res.st_mtime,
        "kind": _note_kind(full_path),
    }


def write_note(full_path: Path, content: str, expected_mtime: float | None) -> dict[str, Any]:
    """Atomically rewrite ``full_path`` with ``content``.

    Refuses when the on-disk mtime doesn't match ``expected_mtime`` so
    a stale editor never silently overwrites out-of-band edits.
    Returns ``{ok, mtime | reason}``.
    """
    try:
        current_mtime = full_path.stat().st_mtime
    except FileNotFoundError:
        return {"ok": False, "reason": "file vanished"}
    if expected_mtime is not None and abs(current_mtime - float(expected_mtime)) > 1e-6:
        return {"ok": False, "reason": "file changed on disk", "mtime": current_mtime}
    tmp = full_path.with_suffix(full_path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(full_path)
    return {"ok": True, "mtime": full_path.stat().st_mtime}


def rename_note(ctx: RenderCtx, rel_path: str, new_stem: str) -> dict[str, Any]:
    """Rename a file under ``<item>/notes/`` while preserving its extension."""
    full = validate_note_path(ctx, rel_path)
    if full is None:
        return {"ok": False, "reason": "invalid path"}
    if not _VALID_ITEM_NOTES_FILE_RE.match(rel_path):
        return {"ok": False, "reason": "only files under <item>/notes/ can be renamed"}
    new_stem = (new_stem or "").strip()
    if not new_stem or not re.match(r"^[\w.-]+$", new_stem) or new_stem in (".", ".."):
        return {"ok": False, "reason": "invalid filename"}
    new_filename = new_stem + full.suffix
    if not _VALID_NOTE_FILENAME_RE.match(new_filename):
        return {"ok": False, "reason": "invalid filename"}
    new_path = full.parent / new_filename
    if new_path.exists() and new_path.resolve() != full.resolve():
        return {"ok": False, "reason": "target already exists"}
    if new_path == full:
        return {"ok": True, "path": rel_path, "mtime": full.stat().st_mtime}
    full.rename(new_path)
    return {
        "ok": True,
        "path": str(new_path.relative_to(ctx.base_dir)),
        "mtime": new_path.stat().st_mtime,
    }


_VALID_SUBDIR_RE = re.compile(r"^[\w.-]+(/[\w.-]+)*$")


def _resolve_under_item(item_dir: Path, subdir: str) -> Path | None:
    """Resolve ``subdir`` (relative to ``item_dir``) and verify the result
    stays inside the item directory. Empty subdir resolves to item_dir
    itself. Returns ``None`` on traversal / regex failure."""
    sub = (subdir or "").strip().strip("/")
    if not sub:
        return item_dir
    if ".." in sub.split("/") or not _VALID_SUBDIR_RE.match(sub):
        return None
    target = item_dir / sub
    try:
        target.resolve().relative_to(item_dir.resolve())
    except ValueError:
        return None
    return target


def create_note(
    ctx: RenderCtx,
    item_readme_rel: str,
    filename: str,
    subdir: str = "",
) -> dict[str, Any]:
    """Create an empty note file under ``<item>/[subdir]/<filename>``.

    ``subdir`` is relative to the item directory ("" places the file at
    the item root, alongside ``README.md`` / ``notes/`` etc). The subdir
    must already exist when non-empty — ``+ folder`` is a separate
    action.
    """
    item = _validate_path(ctx, item_readme_rel)
    if item is None or item.name != "README.md":
        return {"ok": False, "reason": "invalid item"}
    if not _VALID_NOTE_FILENAME_RE.match(filename):
        return {"ok": False, "reason": "invalid filename"}
    target_dir = _resolve_under_item(item.parent, subdir)
    if target_dir is None:
        return {"ok": False, "reason": "invalid subdirectory"}
    if subdir and not target_dir.exists():
        return {"ok": False, "reason": "subdirectory does not exist"}
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / filename
    if target.exists():
        return {"ok": False, "reason": "file exists"}
    target.write_text("", encoding="utf-8")
    return {
        "ok": True,
        "path": str(target.relative_to(ctx.base_dir)),
        "mtime": target.stat().st_mtime,
    }


def _disambiguate(target: Path) -> Path:
    """Pick a non-colliding sibling name by suffixing ``" (2)"``, ``" (3)"`` …
    Mirrors Finder/Nautilus when the user drops a file with the same name."""
    if not target.exists():
        return target
    stem = target.stem
    suffix = target.suffix
    parent = target.parent
    n = 2
    while True:
        candidate = parent / f"{stem} ({n}){suffix}"
        if not candidate.exists():
            return candidate
        n += 1


_VALID_UPLOAD_FILENAME_RE = re.compile(r"^[\w. \-()]+\.[A-Za-z0-9]+$")


def store_uploads(
    ctx: RenderCtx,
    item_readme_rel: str,
    subdir: str,
    uploads: Iterable[tuple[str, BinaryIO]],
    *,
    max_bytes_per_file: int = 50 * 1024 * 1024,
) -> dict[str, Any]:
    """Persist one or more uploaded files under ``<item>/[subdir]/``.

    ``subdir`` is relative to the item directory ("" uploads to the item
    root, alongside ``README.md`` / ``notes/``). Each entry in ``uploads``
    is ``(filename, stream)``. Filenames are validated against
    ``_VALID_UPLOAD_FILENAME_RE`` (more permissive than the note regex —
    accepts spaces and parentheses for typical Camera/PDF exports). Name
    collisions auto-suffix ``(2)``, ``(3)``… Files larger than
    ``max_bytes_per_file`` are rejected without partial writes. Returns
    ``{ok, stored: [rel_path, ...], rejected: [...]}``.
    """
    item = _validate_path(ctx, item_readme_rel)
    if item is None or item.name != "README.md":
        return {"ok": False, "reason": "invalid item"}
    target_dir = _resolve_under_item(item.parent, subdir)
    if target_dir is None:
        return {"ok": False, "reason": "invalid subdirectory"}
    if subdir and not target_dir.exists():
        return {"ok": False, "reason": "subdirectory does not exist"}
    target_dir.mkdir(parents=True, exist_ok=True)

    stored: list[str] = []
    rejected: list[dict[str, str]] = []
    for filename, stream in uploads:
        name = (filename or "").strip()
        if not name or not _VALID_UPLOAD_FILENAME_RE.match(name) or name in (".", ".."):
            rejected.append({"filename": name, "reason": "invalid filename"})
            continue
        target = _disambiguate(target_dir / name)
        # Stream the upload to disk via a temp file, enforcing the size
        # cap as we go. A copy that exceeds the cap is removed before any
        # caller sees it.
        tmp = target.with_suffix(target.suffix + ".part")
        try:
            written = 0
            with tmp.open("wb") as out:
                while True:
                    chunk = stream.read(64 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > max_bytes_per_file:
                        out.close()
                        tmp.unlink(missing_ok=True)
                        rejected.append({"filename": name, "reason": "exceeds size limit"})
                        break
                    out.write(chunk)
                else:
                    pass
            if tmp.exists():
                tmp.replace(target)
                stored.append(str(target.relative_to(ctx.base_dir)))
        except OSError as exc:
            tmp.unlink(missing_ok=True)
            rejected.append({"filename": name, "reason": f"write failed: {exc}"})

    return {"ok": True, "stored": stored, "rejected": rejected}


def create_notes_subdir(ctx: RenderCtx, item_readme_rel: str, subpath: str) -> dict[str, Any]:
    """Create a (possibly nested) directory under the item directory.

    ``subpath`` is relative to the item root (``<item>/<subpath>``), so
    a folder created at the root level becomes a sibling of ``notes/``.
    Errors with ``exists`` when the directory is already there. Returns
    the relative path on success so the client can pre-open the new
    group.
    """
    item = _validate_path(ctx, item_readme_rel)
    if item is None or item.name != "README.md":
        return {"ok": False, "reason": "invalid item"}
    sub = (subpath or "").strip().strip("/")
    if not sub:
        return {"ok": False, "reason": "invalid subdirectory name"}
    target = _resolve_under_item(item.parent, sub)
    if target is None:
        return {"ok": False, "reason": "invalid subdirectory name"}
    if target.exists():
        return {"ok": False, "reason": "exists"}
    target.mkdir(parents=True, exist_ok=False)
    return {
        "ok": True,
        "rel_dir": sub,
        "subdir_key": f"{item.parent.name}/{sub}",
    }


def _set_priority(full_path, priority):
    if priority not in PRIORITIES:
        return False
    lines = full_path.read_text(encoding="utf-8").split("\n")
    for i, line in enumerate(lines):
        if STATUS_RE.match(line):
            if " : " in line:
                lines[i] = f"**Status** : {priority}"
            else:
                lines[i] = f"**Status**: {priority}"
            full_path.write_text("\n".join(lines), encoding="utf-8")
            return True
    insert_at = 1
    for i in range(1, len(lines)):
        if HEADING2_RE.match(lines[i]):
            break
        if METADATA_RE.match(lines[i]):
            insert_at = i + 1
    if insert_at > 1 and " : " in lines[insert_at - 1]:
        lines.insert(insert_at, f"**Status** : {priority}")
    else:
        lines.insert(insert_at, f"**Status**: {priority}")
    full_path.write_text("\n".join(lines), encoding="utf-8")
    return True


def _toggle_checkbox(full_path, line_num):
    lines = full_path.read_text(encoding="utf-8").split("\n")
    if not (0 <= line_num < len(lines)):
        return None
    line = lines[line_num]
    if "- [ ]" in line:
        lines[line_num] = line.replace("- [ ]", "- [x]", 1)
        new_status = "done"
    elif re.search(r"- \[[xX]\]", line):
        lines[line_num] = re.sub(r"- \[[xX]\]", "- [~]", line, count=1)
        new_status = "progress"
    elif "- [~]" in line:
        lines[line_num] = line.replace("- [~]", "- [-]", 1)
        new_status = "abandoned"
    elif "- [-]" in line:
        lines[line_num] = line.replace("- [-]", "- [ ]", 1)
        new_status = "open"
    else:
        return None
    full_path.write_text("\n".join(lines), encoding="utf-8")
    return new_status


def _remove_step(full_path, line_num):
    lines = full_path.read_text(encoding="utf-8").split("\n")
    if not (0 <= line_num < len(lines)):
        return False
    if not CHECKBOX_RE.match(lines[line_num]):
        return False
    lines.pop(line_num)
    full_path.write_text("\n".join(lines), encoding="utf-8")
    return True


def _edit_step(full_path, line_num, new_text):
    new_text = new_text.replace("\n", " ").replace("\r", "")
    lines = full_path.read_text(encoding="utf-8").split("\n")
    if not (0 <= line_num < len(lines)):
        return False
    m = CHECKBOX_RE.match(lines[line_num])
    if not m:
        return False
    lines[line_num] = f"{m.group(1)}- [{m.group(2)}] {new_text}"
    full_path.write_text("\n".join(lines), encoding="utf-8")
    return True


def _add_step(full_path, text, section_heading=None):
    text = text.replace("\n", " ").replace("\r", "")
    lines = full_path.read_text(encoding="utf-8").split("\n")

    if section_heading:
        target_line = None
        target_level = 0
        for i, line in enumerate(lines):
            m = re.match(r"^(#{2,})\s+(.+)$", line)
            if m and m.group(2).strip() == section_heading:
                target_line = i
                target_level = len(m.group(1))
                break

        if target_line is not None:
            end = len(lines)
            for i in range(target_line + 1, len(lines)):
                m = re.match(r"^(#{2,})\s+", lines[i])
                if m and len(m.group(1)) <= target_level:
                    end = i
                    break
            insert_at = end
            while insert_at > target_line + 1 and lines[insert_at - 1].strip() == "":
                insert_at -= 1
            lines.insert(insert_at, f"- [ ] {text}")
            full_path.write_text("\n".join(lines), encoding="utf-8")
            return insert_at

    ns_line = None
    for i, line in enumerate(lines):
        if re.match(r"^##\s+Steps", line, re.IGNORECASE):
            ns_line = i
            break

    if ns_line is None:
        insert_before = len(lines)
        for i, line in enumerate(lines):
            if re.match(r"^##\s+(Notes|Timeline|Chronologie)\b", line, re.IGNORECASE):
                insert_before = i
                break
        lines[insert_before:insert_before] = ["", "## Steps", "", f"- [ ] {text}", ""]
        full_path.write_text("\n".join(lines), encoding="utf-8")
        return insert_before + 3

    else:
        end = len(lines)
        for i in range(ns_line + 1, len(lines)):
            if HEADING2_RE.match(lines[i]):
                end = i
                break
        insert_end = end
        for i in range(ns_line + 1, end):
            if HEADING3_RE.match(lines[i]):
                insert_end = i
                break
        insert_at = insert_end
        while insert_at > ns_line + 1 and lines[insert_at - 1].strip() == "":
            insert_at -= 1
        lines.insert(insert_at, f"- [ ] {text}")

    full_path.write_text("\n".join(lines), encoding="utf-8")
    return insert_at


_ENVIRONMENTS = ("PROD", "STAGING", "DEV")
_SEVERITIES = ("low", "medium", "high")


def _render_apps(apps_raw: str) -> str:
    """Turn a comma-separated free-text apps string into the backtick-wrapped
    form the README header uses (`app1`, `app2/sub`)."""
    parts = [p.strip().strip("`") for p in (apps_raw or "").split(",")]
    parts = [p for p in parts if p]
    return ", ".join(f"`{p}`" for p in parts)


def _render_item_template(
    *,
    kind: str,
    title: str,
    date: str,
    status: str,
    apps_line: str,
    environment: str = "",
    severity: str = "",
    languages: str = "",
) -> str:
    """Build the seed README body for a new item.

    The header is the minimal set of fields condash's parser relies on;
    optional kind-specific rows (Environment/Severity on incidents,
    Languages on documents) are emitted only when the caller supplies a
    non-empty value. Body sections stay intentionally sparse — the user
    fleshes them out in their editor after the dashboard writes the file.
    """
    header = [
        f"# {title}",
        "",
        f"**Date**: {date}",
        f"**Kind**: {kind}",
        f"**Status**: {status}",
    ]
    if apps_line:
        header.append(f"**Apps**: {apps_line}")
    if kind == "incident":
        if environment:
            header.append(f"**Environment**: {environment}")
        if severity:
            header.append(f"**Severity**: {severity}")
    if kind == "document" and languages:
        header.append(f"**Languages**: {languages}")

    if kind == "project":
        body = [
            "## Goal",
            "",
            "_Describe the user-facing outcome this project aims to achieve._",
            "",
            "## Scope",
            "",
            "_What is in scope; what is explicitly out of scope._",
            "",
            "## Steps",
            "",
            "- [ ] First milestone",
            "",
            "## Timeline",
            "",
            f"- {date} — Project created.",
            "",
            "## Notes",
            "",
        ]
    elif kind == "incident":
        body = [
            "## Description",
            "",
            "_Observable symptoms, scope, when it started._",
            "",
            "## Symptoms",
            "",
            "- _Error messages, user-facing effects, log patterns._",
            "",
            "## Analysis",
            "",
            "_Investigation findings, hypotheses, references to `notes/`._",
            "",
            "## Root cause",
            "",
            "_Not yet identified._",
            "",
            "## Steps",
            "",
            "- [ ] Reproduce",
            "",
            "## Timeline",
            "",
            f"- {date} — Incident opened.",
            "",
            "## Notes",
            "",
        ]
    else:  # document
        body = [
            "## Goal",
            "",
            "_What this document is for and who the audience is._",
            "",
            "## Steps",
            "",
            "- [ ] Collect sources",
            "- [ ] Draft",
            "- [ ] Review",
            "",
            "## Deliverables",
            "",
            "**Audience**: _who the PDF is for_",
            "**Key elements**: _structural spec — what sections must appear_",
            "**Sources**: _where to read from to produce the deliverable_",
            "**Current summary**: _Not yet generated._",
            "",
            "## Timeline",
            "",
            f"- {date} — Created.",
            "",
            "## Notes",
            "",
        ]

    return "\n".join(header + [""] + body)


def create_item(
    ctx: RenderCtx,
    *,
    title: str,
    slug: str,
    kind: str,
    status: str,
    apps: str = "",
    environment: str = "",
    severity: str = "",
    languages: str = "",
    today: _dt.date | None = None,
) -> dict[str, Any]:
    """Scaffold a new conception item under ``projects/YYYY-MM/YYYY-MM-DD-<slug>/``.

    Writes a minimal-but-valid ``README.md`` seeded from :func:`_render_item_template`,
    creates an empty ``notes/`` sibling, and touches
    ``projects/.index-dirty`` so the index-refresh skill knows to run.
    Returns ``{ok, rel_path, slug, priority, month}`` on success or
    ``{ok: False, reason}`` with a machine-readable reason the caller can
    surface inline. Never creates partial state — every failure short-
    circuits before any write hits disk.
    """
    title = (title or "").strip()
    # Preserve slug casing so the regex can reject uppercase (the folder
    # name must be lowercase — silent mangling would mask typos).
    slug = (slug or "").strip()
    kind = (kind or "").strip().lower()
    status = (status or "").strip().lower()
    apps_raw = (apps or "").strip()
    environment = (environment or "").strip().upper()
    severity = (severity or "").strip().lower()
    languages = (languages or "").strip().lower()

    if not title:
        return {"ok": False, "reason": "title required"}
    if kind not in KINDS:
        return {"ok": False, "reason": f"kind must be one of {list(KINDS)}"}
    if status not in PRIORITIES:
        return {"ok": False, "reason": f"status must be one of {list(PRIORITIES)}"}
    if not VALID_SLUG_RE.match(slug):
        return {
            "ok": False,
            "reason": "slug must be lowercase letters, digits, and single hyphens",
        }
    if kind == "incident" and environment and environment not in _ENVIRONMENTS:
        return {"ok": False, "reason": f"environment must be one of {list(_ENVIRONMENTS)}"}
    if kind == "incident" and severity and severity not in _SEVERITIES:
        return {"ok": False, "reason": f"severity must be one of {list(_SEVERITIES)}"}

    day = today or _dt.date.today()
    month = f"{day.year:04d}-{day.month:02d}"
    date_str = day.isoformat()
    folder_name = f"{date_str}-{slug}"

    projects_root = ctx.base_dir / "projects"
    month_dir = projects_root / month
    item_dir = month_dir / folder_name

    try:
        item_dir.resolve().relative_to(projects_root.resolve())
    except ValueError:
        return {"ok": False, "reason": "resolved path escapes projects/"}
    if item_dir.exists():
        return {"ok": False, "reason": "item with this slug already exists today"}

    body = _render_item_template(
        kind=kind,
        title=title,
        date=date_str,
        status=status,
        apps_line=_render_apps(apps_raw),
        environment=environment,
        severity=severity,
        languages=languages,
    )

    item_dir.mkdir(parents=True, exist_ok=False)
    (item_dir / "notes").mkdir(exist_ok=False)
    (item_dir / "README.md").write_text(body, encoding="utf-8")

    # Touch projects/.index-dirty so /projects index picks up the new
    # folder. Best-effort — failure here doesn't roll back the write.
    try:
        (projects_root / ".index-dirty").touch()
    except OSError:
        pass

    return {
        "ok": True,
        "rel_path": str((item_dir / "README.md").relative_to(ctx.base_dir)),
        "slug": slug,
        "folder_name": folder_name,
        "priority": status,
        "month": month,
    }


def _reorder_all(full_path, order):
    lines = full_path.read_text(encoding="utf-8").split("\n")
    for ln in order:
        if not (0 <= ln < len(lines)) or not CHECKBOX_RE.match(lines[ln]):
            return False
    contents = [lines[ln] for ln in order]
    sorted_positions = sorted(order)
    for pos, content in zip(sorted_positions, contents):
        lines[pos] = content
    full_path.write_text("\n".join(lines), encoding="utf-8")
    return True
