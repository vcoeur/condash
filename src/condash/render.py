"""HTML rendering for the conception dashboard.

Entry point is :func:`render_page`, which reads the dashboard template
and stamps it with the card list, git repo strip, knowledge tree, and
summary counts. Smaller helpers render individual cards, notes,
deliverables, steps, wikilinks-rewritten markdown, and the git repo
action buttons.
"""

from __future__ import annotations

import html as html_mod
import json
import logging
import re
import subprocess
from datetime import datetime
from itertools import groupby
from pathlib import Path
from typing import TYPE_CHECKING

from . import __version__
from . import runners as runners_mod
from .context import RenderCtx
from .git_scan import _collect_git_repos
from .parser import (
    PRI_ORDER,
    PRIORITIES,
    _knowledge_title_and_desc,
    _note_kind,
    collect_knowledge,
)
from .templating import _subtree_count
from .templating import render as _render_template
from .wikilinks import _preprocess_wikilinks

if TYPE_CHECKING:
    from .cache import WorkspaceCache

log = logging.getLogger(__name__)


def h(text):
    """HTML-escape."""
    return html_mod.escape(str(text))


_IMG_SRC_RE = re.compile(r'(<img\b[^>]*?\bsrc=")([^"]+)(")', re.IGNORECASE)


def _rewrite_img_src(html, note_dir_rel):
    def sub(m):
        src = m.group(2)
        if (
            src.startswith("http://")
            or src.startswith("https://")
            or src.startswith("//")
            or src.startswith("/")
            or src.startswith("data:")
        ):
            return m.group(0)
        return f"{m.group(1)}/asset/{note_dir_rel}/{src}{m.group(3)}"

    return _IMG_SRC_RE.sub(sub, html)


def _render_markdown(ctx: RenderCtx, full_path, note_dir_rel, cache: WorkspaceCache | None = None):
    try:
        text = full_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        log.warning("render_markdown: could not read %s: %s", full_path, exc)
        return '<p class="note-error">Unable to read note.</p>'
    text = _preprocess_wikilinks(ctx, text, cache=cache)
    try:
        out = subprocess.run(
            ["pandoc", "--from=gfm", "--to=html", "--no-highlight"],
            input=text,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if out.returncode == 0 and out.stdout.strip():
            return _rewrite_img_src(out.stdout, note_dir_rel)
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("render_markdown: pandoc failed for %s: %s", full_path, exc)
    return f'<pre class="note-raw">{h(text)}</pre>'


def _render_note(ctx: RenderCtx, full_path: Path, cache: WorkspaceCache | None = None) -> str:
    """Dispatch preview rendering by file kind — see ``_note_kind``."""
    kind = _note_kind(full_path)
    try:
        note_dir_rel = str(full_path.parent.relative_to(ctx.base_dir))
    except ValueError:
        return '<p class="note-error">Path outside conception tree.</p>'
    file_rel = str(full_path.relative_to(ctx.base_dir))

    if kind == "md":
        return _render_markdown(ctx, full_path, note_dir_rel, cache=cache)

    if kind == "pdf":
        # Mount point for the custom PDF.js viewer defined in dashboard.html.
        # We don't rely on the webview's built-in PDF handler: QtWebEngine
        # ships with PdfViewerEnabled=false and pywebview doesn't flip it,
        # so the native-window modal would otherwise just show Chromium's
        # "Open file externally" card. The dashboard JS picks up any
        # .note-pdf-host element that appears in the view pane and wires
        # the vendored pdf.mjs against /file/... for rendering.
        return (
            f'<div class="note-pdf-host" '
            f'data-pdf-src="/file/{h(file_rel)}" '
            f'data-pdf-filename="{h(full_path.name)}"></div>'
        )

    if kind == "image":
        return (
            f'<img class="note-preview-image" src="/file/{h(file_rel)}" alt="{h(full_path.name)}">'
        )

    if kind == "text":
        try:
            text = full_path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            log.warning("render_note: could not read %s: %s", full_path, exc)
            return '<p class="note-error">Unable to read file.</p>'
        return f'<pre class="note-raw note-preview-text">{h(text)}</pre>'

    # Anything else — offer the OS default viewer as a fallback. The
    # anchor gets picked up by _wireNoteLinks and routed to /open-doc.
    return (
        '<div class="note-preview-binary">'
        "<p>No inline preview available for this file.</p>"
        f'<p><a href="{h(file_rel)}">Open externally</a></p>'
        "</div>"
    )


def _next_step(item):
    """First pending step across all sections, or None.

    "Pending" means status is ``open`` or ``progress`` — ``abandoned``
    steps aren't "next", they're intentionally parked. Used on the
    collapsed card so users can see what the project is blocked on
    without expanding each one.
    """
    for sec in item["sections"]:
        for step in sec["items"]:
            if step["status"] in ("open", "progress"):
                return step
    return None


def _render_card(item):
    """Render one project card via ``card.html.j2``.

    Computed view data (next-pending step, file tree total, icon SVGs)
    is pre-derived here so the template stays free of filesystem and
    registry lookups.
    """
    tree = item.get("files") or {"files": [], "groups": []}
    files = tree.get("files") or []
    groups = tree.get("groups") or []
    total = len(files) + sum(_subtree_count(g) for g in groups)
    return _render_template(
        "card.html.j2",
        item=item,
        priorities=PRIORITIES,
        next_step=_next_step(item),
        files_tree={"files": files, "groups": groups},
        files_total=total,
        icons=_ICON_SVGS,
    )


def _render_knowledge(root: dict | None) -> str:
    """Render the knowledge tree returned by ``collect_knowledge``."""
    return _render_template("knowledge_tree.html.j2", root=root)


def _index_entry(ctx: RenderCtx, idx_path: Path) -> dict | None:
    """Shape ``idx_path`` into the dict the index-badge renderer wants."""
    if not idx_path.is_file():
        return None
    title, desc = _knowledge_title_and_desc(idx_path)
    return {
        "path": str(idx_path.relative_to(ctx.base_dir)),
        "title": title,
        "desc": desc,
    }


def _render_history(ctx: RenderCtx, items: list[dict]) -> str:
    """Render ``projects/`` as the on-disk tree: month buckets + items.

    Mirrors the knowledge-tree affordances — ``projects/index.md`` and each
    ``projects/YYYY-MM/index.md`` become clickable badges next to their
    heading, and items inside each month appear in creation order (newest
    first). The whole list is a direct reflection of disk state; no
    filtering by priority or status.
    """
    root_dir = ctx.base_dir / "projects"
    if not root_dir.is_dir():
        return _render_template("history.html.j2", no_projects_dir=True)
    by_month: dict[str, list[dict]] = {}
    for item in items:
        parts = item["path"].split("/")
        if len(parts) >= 2 and parts[0] == "projects":
            by_month.setdefault(parts[1], []).append(item)
    months = []
    for name in sorted(by_month.keys(), reverse=True):
        month_items = sorted(by_month[name], key=lambda x: x["slug"], reverse=True)
        months.append(
            {
                "name": name,
                "items": month_items,
                "index": _index_entry(ctx, root_dir / name / "index.md"),
            }
        )
    return _render_template(
        "history.html.j2",
        no_projects_dir=False,
        root_index=_index_entry(ctx, root_dir / "index.md"),
        months=months,
    )


_ICON_SVGS = {
    # Generic "code editor window" — title bar with two horizontal code lines.
    "main_ide": (
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" '
        'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" '
        'stroke-linejoin="round" aria-hidden="true">'
        '<rect x="3" y="4" width="18" height="16" rx="2"/>'
        '<line x1="3" y1="9" x2="21" y2="9"/>'
        '<line x1="7" y1="14" x2="13" y2="14"/>'
        '<line x1="7" y1="17" x2="11" y2="17"/></svg>'
    ),
    # Generic "code" chevrons — < / >.
    "secondary_ide": (
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" '
        'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" '
        'stroke-linejoin="round" aria-hidden="true">'
        '<polyline points="16 18 22 12 16 6"/>'
        '<polyline points="8 6 2 12 8 18"/></svg>'
    ),
    # Generic "terminal" — prompt arrow + cursor underline.
    "terminal": (
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" '
        'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" '
        'stroke-linejoin="round" aria-hidden="true">'
        '<polyline points="4 17 10 11 4 5"/>'
        '<line x1="12" y1="19" x2="20" y2="19"/></svg>'
    ),
    # "Integrated terminal" — window frame with prompt arrow + cursor
    # inside, signalling "open terminal inside the dashboard" rather
    # than the external-terminal slot above.
    "integrated_terminal": (
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" '
        'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" '
        'stroke-linejoin="round" aria-hidden="true">'
        '<rect x="3" y="4" width="18" height="16" rx="2"/>'
        '<polyline points="7 11 10 14 7 17"/>'
        '<line x1="12" y1="17" x2="16" y2="17"/></svg>'
    ),
    # "Work on" — terminal window with a play triangle inside, signalling
    # "send the `work on <slug>` command to the focused terminal tab".
    "work_on": (
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" '
        'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" '
        'stroke-linejoin="round" aria-hidden="true">'
        '<rect x="3" y="4" width="18" height="16" rx="2"/>'
        '<polygon points="10 9 16 12 10 15" fill="currentColor" stroke="none"/></svg>'
    ),
    # Filled play triangle — "start inline dev-server runner".
    "runner_run": (
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" '
        'aria-hidden="true">'
        '<polygon points="7 5 19 12 7 19"/></svg>'
    ),
    # Filled square — "stop inline dev-server runner".
    "runner_stop": (
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" '
        'aria-hidden="true">'
        '<rect x="6" y="6" width="12" height="12" rx="1"/></svg>'
    ),
    # Down arrow — "a runner is active below, jump to it".
    "runner_jump": (
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" '
        'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" '
        'stroke-linejoin="round" aria-hidden="true">'
        '<polyline points="6 9 12 15 18 9"/></svg>'
    ),
    # Chevron that flips between down (expanded) and up (collapsed) via
    # the .runner-collapsed parent class. Used on the inline-terminal
    # header so the user can hide the output area without stopping the
    # child process.
    "runner_collapse": (
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" '
        'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" '
        'stroke-linejoin="round" aria-hidden="true">'
        '<polyline points="6 15 12 9 18 15"/></svg>'
    ),
    # Diagonal arrow out of a box — "pop the inline terminal into a modal".
    "runner_popout": (
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" '
        'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" '
        'stroke-linejoin="round" aria-hidden="true">'
        '<path d="M14 4h6v6"/>'
        '<line x1="10" y1="14" x2="20" y2="4"/>'
        '<path d="M20 14v6H4V4h6"/></svg>'
    ),
    # Folder outline — opens the item directory in the OS file manager.
    "folder": (
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" '
        'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" '
        'stroke-linejoin="round" aria-hidden="true">'
        '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
    ),
    # Small down chevron — caret on the split open-with button.
    "open_caret": (
        '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" '
        'stroke="currentColor" stroke-width="3" stroke-linecap="round" '
        'stroke-linejoin="round" aria-hidden="true">'
        '<polyline points="6 9 12 15 18 9"/></svg>'
    ),
    # Diagonal arrow — "jump to this peer-card's live runner terminal".
    "peer_jump": (
        '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" '
        'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" '
        'stroke-linejoin="round" aria-hidden="true">'
        '<line x1="7" y1="17" x2="17" y2="7"/>'
        '<polyline points="7 7 17 7 17 17"/></svg>'
    ),
}


def _render_open_with(ctx: RenderCtx, path: str) -> str:
    """Split "Open with" button — primary icon + caret → popover picker.

    The primary icon opens with the first configured slot (``main_ide``).
    The caret reveals a small menu listing every slot plus an entry for
    the integrated terminal so keyboard-only or infrequent targets are
    still reachable without cluttering the row.
    """
    js_path = json.dumps(path).replace("'", "\\'").replace('"', "'")
    primary_slot = "main_ide"
    primary = ctx.open_with.get(primary_slot)
    primary_title = primary.label if primary is not None else primary_slot
    picker_items: list[str] = []
    for slot_key in ("main_ide", "secondary_ide", "terminal"):
        slot = ctx.open_with.get(slot_key)
        label = slot.label if slot is not None else slot_key
        picker_items.append(
            f'<button type="button" class="open-popover-item" '
            f"onclick=\"openPath(event,{js_path},'{slot_key}');gitClosePopovers()\">"
            f'<span class="open-popover-icon">{_ICON_SVGS[slot_key]}</span>'
            f"<span>{h(label)}</span></button>"
        )
    integrated_title = "Open in integrated terminal"
    picker_items.append(
        f'<button type="button" class="open-popover-item" '
        f'onclick="openInTerminal(event,{js_path});gitClosePopovers()">'
        f'<span class="open-popover-icon">{_ICON_SVGS["integrated_terminal"]}</span>'
        f"<span>{h(integrated_title)}</span></button>"
    )
    popover = '<div class="open-popover" role="menu" hidden>' + "".join(picker_items) + "</div>"
    return (
        '<div class="open-grp">'
        f'<button type="button" class="open-primary" title="{h(primary_title)}" '
        f'aria-label="{h(primary_title)}" '
        f"onclick=\"openPath(event,{js_path},'{primary_slot}')\">"
        f"{_ICON_SVGS[primary_slot]}</button>"
        '<button type="button" class="open-caret" title="Open with…" '
        'aria-haspopup="menu" aria-label="Open with menu" '
        'onclick="gitToggleOpenPopover(event,this)">'
        f"{_ICON_SVGS['open_caret']}</button>"
        f"{popover}</div>"
    )


def _runner_key(repo_name: str, sub_name: str | None = None) -> str:
    """Canonical runner-registry key. Mirrors ``config._parse_repo_list``."""
    if sub_name is None:
        return repo_name
    return f"{repo_name}--{sub_name}"


def _runner_key_for_member(family: dict, member: dict) -> str:
    return _runner_key(family["name"], member["name"] if member.get("is_subrepo") else None)


def _render_runner_button(
    key: str,
    checkout_key: str,
    checkout_path: str,
) -> str:
    """Render the per-checkout Run / Stop / Switch affordance.

    Button state is resolved by looking up the live session in
    ``runners_mod.registry()``:

    - no session           → green Run button
    - session on this row  → red Stop button
    - session elsewhere    → amber Switch button (triggers confirm dialog)
    """
    session = runners_mod.get(key)
    js_key = json.dumps(key).replace("'", "\\'").replace('"', "'")
    js_checkout = json.dumps(checkout_key).replace("'", "\\'").replace('"', "'")
    js_path = json.dumps(checkout_path).replace("'", "\\'").replace('"', "'")
    if session is None or session.exit_code is not None:
        # Off or exited — exited gets the same Run affordance; clicking
        # starts a fresh session (replacing the stale record).
        title = "Start dev runner"
        cls = "git-action-runner-run"
        icon = _ICON_SVGS["runner_run"]
        onclick = f"runnerStart(event,{js_key},{js_checkout},{js_path})"
    elif session.checkout_key == checkout_key:
        title = "Stop dev runner"
        cls = "git-action-runner-stop"
        icon = _ICON_SVGS["runner_stop"]
        onclick = f"runnerStop(event,{js_key})"
    else:
        title = f"Switch runner from {session.checkout_key} to this checkout"
        cls = "git-action-runner-switch"
        icon = _ICON_SVGS["runner_run"]
        onclick = f"runnerSwitch(event,{js_key},{js_checkout},{js_path})"
    return (
        f'<button class="git-action-btn git-action-runner {cls}" '
        f'title="{h(title)}" aria-label="{h(title)}" '
        f'onclick="{onclick}">{icon}</button>'
    )


def _render_runner_mount(key: str, checkout_key: str) -> str:
    """Inline terminal mount point, rendered under the checkout that owns
    the live session. The JS side picks this up on DOM insertion and
    opens a WebSocket to ``/ws/runner/<key>``.
    """
    session = runners_mod.get(key)
    if session is None or session.checkout_key != checkout_key:
        return ""
    exited_attr = f' data-exit-code="{session.exit_code}"' if session.exit_code is not None else ""
    js_label = h(f"{key} @ {checkout_key}")
    # Fresh mounts start collapsed — the user clicks the header (or the
    # runner_jump arrow on the repo row) to reveal the output. Expanded
    # state is per-mount and not persisted across reloads.
    return (
        f'<div class="runner-term-mount runner-collapsed" '
        f'data-runner-key="{h(key)}" '
        f'data-runner-checkout="{h(checkout_key)}"{exited_attr}>'
        f'<div class="runner-term-header" '
        f'title="Click to collapse / expand (keeps process running)" '
        f'onclick="runnerToggleCollapse(this)">'
        f'<span class="runner-term-label">{js_label}</span>'
        f'<span class="runner-term-status" aria-live="polite"></span>'
        f'<button class="runner-control runner-collapse" '
        f'aria-label="Collapse terminal" tabindex="-1" '
        f'onclick="event.stopPropagation();runnerToggleCollapse(this)">'
        f"{_ICON_SVGS['runner_collapse']}</button>"
        f'<button class="runner-control runner-popout" '
        f'title="Pop out" aria-label="Pop out" '
        f'onclick="event.stopPropagation();runnerPopout(this)">{_ICON_SVGS["runner_popout"]}</button>'
        f'<button class="runner-control runner-stop-inline" '
        f'title="Stop" aria-label="Stop" '
        f'onclick="event.stopPropagation();runnerStopInline(this)">{_ICON_SVGS["runner_stop"]}</button>'
        f"</div>"
        f'<div class="runner-term-host"></div>'
        f"</div>"
    )


def _family_has_live_runner(ctx: RenderCtx, family: dict) -> bool:
    """True if any configured runner key anchored at any family member is live."""
    for member in family["members"]:
        key = _runner_key_for_member(family, member)
        if key in ctx.repo_run:
            session = runners_mod.get(key)
            if session is not None and session.exit_code is None:
                return True
    return False


def _status_badge(member_or_wt: dict) -> str:
    if member_or_wt.get("missing"):
        return '<span class="git-missing">missing</span>'
    if member_or_wt.get("dirty"):
        return f'<span class="git-changes">{member_or_wt["changed"]} changed</span>'
    return '<span class="git-clean">\u2713</span>'


def _member_live_runner(ctx: RenderCtx, family: dict, member: dict):
    """Return the live :class:`runners.Session` for this member, or ``None``.

    "Live" = the member has a configured runner key AND the session exists
    AND the session has not exited. Callers use this to decide whether to
    emit a jump-to-terminal arrow on the peer-card foot or surface the
    inline runner mount.
    """
    if member.get("missing"):
        return None
    key = _runner_key_for_member(family, member)
    if key not in ctx.repo_run:
        return None
    session = runners_mod.get(key)
    if session is None or session.exit_code is not None:
        return None
    return session


def _branch_status_cell(info: dict) -> str:
    """Status cell content for a branch row — ✓ / dirty pill / missing pill."""
    if info.get("missing"):
        return '<span class="branch-missing">missing</span>'
    if info.get("dirty"):
        return f'<span class="branch-dirty">{info["changed"]}</span>'
    return '<span class="branch-clean">\u2713</span>'


def _branch_dot(info: dict, is_live: bool) -> str:
    """State dot that leads every branch row — clean / dirty / live / missing."""
    if is_live:
        cls = "live"
    elif info.get("missing"):
        cls = "missing"
    elif info.get("dirty"):
        cls = "dirty"
    else:
        cls = "clean"
    return f'<span class="b-dot b-dot-{cls}"></span>'


def _render_branch_row(
    ctx: RenderCtx,
    family: dict,
    member: dict,
    *,
    info: dict,
    checkout_key: str,
    is_main: bool,
    node_id: str,
) -> str:
    """Render one branch row inside a peer-card.

    ``info`` is either the member dict itself (main checkout) or one of
    its ``worktrees`` entries. ``checkout_key`` is ``"main"`` for the
    parent checkout of the family or the worktree ``key`` otherwise — it
    matches :func:`_render_runner_button` / :func:`_render_runner_mount`.
    """
    # Branch label resolution: the main row of a subrepo has no branch of
    # its own (it inherits the parent checkout's branch), so fall back to
    # the parent member's branch.
    if info.get("branch"):
        branch_label = info["branch"]
    elif is_main and member.get("is_subrepo"):
        parent = family["members"][0] if family["members"] else {}
        branch_label = parent.get("branch", "")
    else:
        branch_label = info.get("branch", "")
    kind_label = "checkout" if is_main else "worktree"

    # Runner pill — only when this member has a configured runner.
    runner_pill = ""
    member_key = _runner_key_for_member(family, member)
    is_live = False
    if not info.get("missing") and member_key in ctx.repo_run:
        runner_pill = _render_runner_button(member_key, checkout_key, info["path"])
        session = runners_mod.get(member_key)
        is_live = (
            session is not None
            and session.exit_code is None
            and session.checkout_key == checkout_key
        )

    # Open-with split button (hidden cell when the checkout is missing).
    if info.get("missing"):
        open_cell = '<span class="open-grp open-grp-empty" aria-hidden="true"></span>'
    else:
        open_cell = _render_open_with(ctx, info["path"])

    row_cls = "peer-row"
    if is_main:
        row_cls += " peer-row-main"
    if info.get("missing"):
        row_cls += " peer-row-missing"
    elif is_live and info.get("dirty"):
        row_cls += " peer-row-dirty peer-row-live"
    elif is_live:
        row_cls += " peer-row-live"
    elif info.get("dirty"):
        row_cls += " peer-row-dirty"

    return (
        f'<div class="{row_cls}" data-node-id="{h(node_id)}" '
        f'title="{h(info.get("path", ""))}">'
        f"{_branch_dot(info, is_live)}"
        f'<span class="b-name">{h(branch_label) or "&mdash;"}'
        f'<span class="b-kind">{h(kind_label)}</span></span>'
        f'<span class="b-status">{_branch_status_cell(info)}</span>'
        f'<span class="b-run">{runner_pill}</span>'
        f"{open_cell}</div>"
    )


def _render_peer_card(
    ctx: RenderCtx,
    family: dict,
    member: dict,
    member_id: str,
) -> str:
    """Render one peer card — either the parent repo or a promoted sub-repo.

    Contains a head (name + kind badge + status pill), N branch rows (main
    checkout + one per worktree), an optional inline runner mount, and a
    foot (path + optional jump-to-terminal arrow).
    """
    is_subrepo = bool(member.get("is_subrepo"))
    live_session = _member_live_runner(ctx, family, member)
    is_missing = bool(member.get("missing"))

    # Overall state tag shown in the head.
    dirty_branches = 0
    if member.get("dirty"):
        dirty_branches += 1
    for wt in member.get("worktrees") or []:
        if wt.get("dirty"):
            dirty_branches += 1
    if is_missing:
        head_tag = '<span class="peer-tag peer-tag-missing">missing</span>'
    elif dirty_branches:
        noun = "branch" if dirty_branches == 1 else "branches"
        head_tag = f'<span class="peer-tag peer-tag-dirty">{dirty_branches} {noun} dirty</span>'
    else:
        head_tag = '<span class="peer-tag peer-tag-clean">clean</span>'
    if live_session is not None:
        head_tag += '<span class="peer-tag peer-tag-live">live</span>'

    kind_label = "sub-repo" if is_subrepo else "repo"

    card_cls = "peer-card"
    if is_subrepo:
        card_cls += " peer-card-sub"
    else:
        card_cls += " peer-card-parent"
    if dirty_branches:
        card_cls += " peer-card-dirty"
    if live_session is not None:
        card_cls += " peer-card-live"
    if is_missing:
        card_cls += " peer-card-missing"

    parts: list[str] = [
        f'<div class="{card_cls}" data-node-id="{h(member_id)}">',
        '<div class="peer-head">',
        f'<span class="peer-name">{h(member["name"])}</span>',
        f"{head_tag}",
        f'<span class="peer-kind">{h(kind_label)}</span>',
        "</div>",
        '<div class="peer-rows">',
    ]

    # Main checkout row first, then one row per worktree.
    parts.append(
        _render_branch_row(
            ctx,
            family,
            member,
            info=member,
            checkout_key="main",
            is_main=True,
            node_id=f"{member_id}/b:main",
        )
    )
    for wt in member.get("worktrees") or []:
        wt_id = f"{member_id}/wt:{wt['key']}"
        parts.append(
            _render_branch_row(
                ctx,
                family,
                member,
                info=wt,
                checkout_key=wt["key"],
                is_main=False,
                node_id=wt_id,
            )
        )
    parts.append("</div>")  # /peer-rows

    # Inline runner terminal mount — placed between rows and foot so the
    # card stays scannable even when the terminal is expanded.
    if live_session is not None:
        member_key = _runner_key_for_member(family, member)
        mount = _render_runner_mount(member_key, live_session.checkout_key)
        if mount:
            parts.append(f'<div class="peer-term">{mount}</div>')

    # Foot: repo path + jump-arrow if the card has a live runner.
    foot_path = member.get("path") or ""
    foot_bits: list[str] = [f'<span class="peer-foot-path">{h(foot_path)}</span>']
    if live_session is not None:
        foot_bits.append(
            f'<button type="button" class="peer-jump" '
            f'title="Jump to live terminal" aria-label="Jump to live terminal" '
            f'onclick="runnerJump(event,this)">{_ICON_SVGS["peer_jump"]}</button>'
        )
    parts.append(f'<div class="peer-foot">{"".join(foot_bits)}</div>')

    parts.append("</div>")  # /peer-card
    return "\n".join(parts)


def _render_flat_group(ctx: RenderCtx, family: dict, group_id: str) -> str:
    """Render one family into the bucket grid.

    Both solo and compound families use ``display: contents`` on the
    wrapper so their peer-cards become direct items of the bucket grid
    — preserving column alignment across solo and compound families
    (no sub-grid, no row span, no offset shift). Compound families
    prepend a full-row ornament label that sits above their cards to
    identify the grouping without framing it.
    """
    family_id = f"{group_id}/{family['name']}"
    members = family["members"]
    is_compound = len(members) > 1

    cls = "flat-group flat-group-compound" if is_compound else "flat-group flat-group-solo"
    parts: list[str] = [f'<div class="{cls}" data-node-id="{h(family_id)}">']
    if is_compound:
        parts.append(f'<div class="flat-group-ornament">{h(family["name"])}</div>')
    for member in members:
        member_id = f"{family_id}/m:{member['name']}"
        parts.append(_render_peer_card(ctx, family, member, member_id))
    parts.append("</div>")  # /flat-group
    return "\n".join(parts)


def render_git_repo_fragment(ctx: RenderCtx, node_id: str) -> str | None:
    """Return the HTML for the ``.flat-group`` block matching ``node_id``.

    ``node_id`` shape: ``code/<group-label>/<family-name>``. Returns
    ``None`` when the id doesn't match a known family — the ``/fragment``
    caller then falls back to a global reload.
    """
    prefix = "code/"
    if not node_id.startswith(prefix):
        return None
    rest = node_id[len(prefix) :]
    if "/" not in rest:
        return None
    group_label, family_name = rest.split("/", 1)
    for label, families in _collect_git_repos(ctx):
        if label != group_label:
            continue
        for family in families:
            if family["name"] == family_name:
                return _render_flat_group(ctx, family, f"code/{label}")
    return None


def _render_git_repos(ctx: RenderCtx, groups):
    """Render the Code tab.

    Each bucket (primary / secondary / Others) becomes a labelled section
    holding a grid of peer-cards. Solo families flow directly into the
    grid; compound families (parent + promoted sub-repos) tie their
    cards together under a small family ornament.
    """
    if not groups:
        return ""
    out = []
    for label, families in groups:
        group_id = f"code/{label}"
        out.append(
            f'<section class="flat-bucket" data-node-id="{h(group_id)}">'
            f'<h3 class="flat-bucket-heading">{h(label)}</h3>'
            f'<div class="flat-bucket-body">'
        )
        for family in families:
            out.append(_render_flat_group(ctx, family, group_id))
        out.append("</div></section>")
    return "\n".join(out)


def render_card_fragment(item) -> str:
    """HTML for one project card — used by the /fragment endpoint to
    serve a single card on local reload."""
    return _render_card(item)


def render_knowledge_card_fragment(entry: dict) -> str:
    """HTML for one knowledge card (file)."""
    return _render_template("knowledge_card.html.j2", entry=entry)


def render_knowledge_group_fragment(node: dict) -> str:
    """HTML for one knowledge directory (recursive, including children)."""
    return _render_template("knowledge_group.html.j2", node=node)


def render_page(ctx: RenderCtx, items, cache: WorkspaceCache | None = None):
    """Load the HTML template and inject rendered cards."""
    all_items = sorted(
        items,
        key=lambda x: (PRI_ORDER.get(x["priority"], 9), x["slug"][:10]),
    )
    ordered = []
    for _, group in groupby(all_items, key=lambda x: x["priority"]):
        ordered.extend(sorted(group, key=lambda x: x["slug"][:10], reverse=True))
    all_items = ordered

    labelled_priorities = {"now": "Now", "soon": "Soon", "later": "Later", "review": "Review"}
    parts = []
    seen = set()
    for item in all_items:
        pri = item["priority"]
        if pri in labelled_priorities and pri not in seen:
            parts.append(
                f'<div class="group-heading hidden" data-group="{pri}" '
                f'data-node-id="projects/{pri}">{labelled_priorities[pri]}</div>'
            )
            seen.add(pri)
        parts.append(_render_card(item))
    cards = "\n".join(parts)
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    count_current = sum(1 for i in all_items if i["priority"] in ("now", "review"))
    count_next = sum(1 for i in all_items if i["priority"] in ("soon", "later"))
    count_backlog = sum(1 for i in all_items if i["priority"] == "backlog")
    count_done = sum(1 for i in all_items if i["priority"] == "done")

    git_groups = _collect_git_repos(ctx)
    git_html = _render_git_repos(ctx, git_groups)
    count_repos = sum(len(repos) for _, repos in git_groups)

    knowledge_root = cache.get_knowledge(ctx) if cache is not None else collect_knowledge(ctx)
    knowledge_html = _render_knowledge(knowledge_root)
    count_knowledge = knowledge_root["count"] if knowledge_root else 0

    count_projects = len(all_items)

    history_html = _render_history(ctx, all_items)

    template = ctx.template
    template = template.replace("{{CARDS}}", cards)
    template = template.replace("{{GIT_REPOS}}", git_html)
    template = template.replace("{{KNOWLEDGE}}", knowledge_html)
    template = template.replace("{{HISTORY}}", history_html)
    return (
        template.replace("{{TIMESTAMP}}", now)
        .replace("{{COUNT_CURRENT}}", str(count_current))
        .replace("{{COUNT_NEXT}}", str(count_next))
        .replace("{{COUNT_BACKLOG}}", str(count_backlog))
        .replace("{{COUNT_DONE}}", str(count_done))
        .replace("{{COUNT_HISTORY}}", str(count_projects))
        .replace("{{COUNT_PROJECTS}}", str(count_projects))
        .replace("{{COUNT_REPOS}}", str(count_repos))
        .replace("{{COUNT_KNOWLEDGE}}", str(count_knowledge))
        .replace("{{VERSION}}", __version__)
    )
