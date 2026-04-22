//! Git-strip rendering — Rust port of render.py's peer-card / branch-row
//! / runner-button / open-with helpers.
//!
//! Phase 2 scope: the readers. Runner sessions don't exist yet in the
//! Rust build (Phase 4 territory), so `_render_runner_button` always
//! takes the "no session" branch (green "Start" button) and
//! `_render_runner_mount` returns an empty string. The fingerprint
//! layer already emits `|run:off` for configured rows — the rendered
//! HTML here matches what Python emits when `runners.registry()` is
//! empty, which is the Phase 2 invariant on both sides.
//!
//! The string-concat style mirrors Python's render.py one-for-one so
//! the byte-for-byte diff tool can prove they agree on the live
//! workspace.

use condash_state::{Checkout, Family, Group, Member, RenderCtx};

use crate::icons::Icons;
use crate::templating::embed_attr;

/// HTML-escape — mirror of Python's `html.escape(str(text), quote=True)`.
/// Kept separate from the minijinja formatter so raw string builders
/// (this module, `render_page`) can share it.
fn h(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            other => out.push(other),
        }
    }
    out
}

/// Canonical runner-registry key. Mirrors `_runner_key` in Python.
pub fn runner_key(repo_name: &str, sub_name: Option<&str>) -> String {
    match sub_name {
        None => repo_name.to_string(),
        Some(s) => format!("{repo_name}--{s}"),
    }
}

fn runner_key_for_member(family: &Family, member: &Member) -> String {
    if member.is_subrepo {
        runner_key(&family.name, Some(&member.name))
    } else {
        runner_key(&family.name, None)
    }
}

/// The "Open with …" split button — primary icon + caret → popover
/// picker. Phase 2 rendering is static; the interactive JS lives in
/// the bundled dashboard frontend.
pub fn render_open_with(ctx: &RenderCtx, path: &str) -> String {
    let js_path = embed_attr(&path);
    let primary_slot = "main_ide";
    let primary_title = ctx
        .open_with
        .get(primary_slot)
        .map(|s| s.label.clone())
        .unwrap_or_else(|| primary_slot.to_string());

    let mut picker_items = String::new();
    for slot_key in ["main_ide", "secondary_ide", "terminal"] {
        let label = ctx
            .open_with
            .get(slot_key)
            .map(|s| s.label.clone())
            .unwrap_or_else(|| slot_key.to_string());
        let icon = icon_for(slot_key);
        picker_items.push_str(&format!(
            "<button type=\"button\" class=\"open-popover-item\" \
             onclick=\"openPath(event,{js_path},'{slot_key}');gitClosePopovers()\">\
             <span class=\"open-popover-icon\">{icon}</span>\
             <span>{label_h}</span></button>",
            label_h = h(&label),
        ));
    }
    let integrated_title = "Open in integrated terminal";
    picker_items.push_str(&format!(
        "<button type=\"button\" class=\"open-popover-item\" \
         onclick=\"openInTerminal(event,{js_path});gitClosePopovers()\">\
         <span class=\"open-popover-icon\">{icon}</span>\
         <span>{title_h}</span></button>",
        icon = Icons::integrated_terminal,
        title_h = h(integrated_title),
    ));
    let popover = format!("<div class=\"open-popover\" role=\"menu\" hidden>{picker_items}</div>");
    format!(
        "<div class=\"open-grp\">\
         <button type=\"button\" class=\"open-primary\" title=\"{title_h}\" \
         aria-label=\"{title_h}\" \
         onclick=\"openPath(event,{js_path},'{primary_slot}')\">\
         {primary_icon}</button>\
         <button type=\"button\" class=\"open-caret\" title=\"Open with…\" \
         aria-haspopup=\"menu\" aria-label=\"Open with menu\" \
         onclick=\"gitToggleOpenPopover(event,this)\">\
         {caret}</button>\
         {popover}</div>",
        title_h = h(&primary_title),
        primary_icon = icon_for(primary_slot),
        caret = Icons::open_caret,
    )
}

fn icon_for(slot_key: &str) -> &'static str {
    match slot_key {
        "main_ide" => Icons::main_ide,
        "secondary_ide" => Icons::secondary_ide,
        "terminal" => Icons::terminal,
        _ => "",
    }
}

/// Per-checkout Run / Stop / Switch pill. Phase 2 always takes the
/// "no session" branch → green Start button.
fn render_runner_button(key: &str, checkout_key: &str, checkout_path: &str) -> String {
    let js_key = embed_attr(&key);
    let js_checkout = embed_attr(&checkout_key);
    let js_path = embed_attr(&checkout_path);
    let title = "Start dev runner";
    let cls = "git-action-runner-run";
    let icon = Icons::runner_run;
    let onclick = format!("runnerStart(event,{js_key},{js_checkout},{js_path})");
    format!(
        "<button class=\"git-action-btn git-action-runner {cls}\" \
         title=\"{t}\" aria-label=\"{t}\" \
         onclick=\"{onclick}\">{icon}</button>",
        t = h(title),
    )
}

/// Inline runner mount — in Phase 2 we have no live sessions, so this
/// always returns the empty string (matches Python's `if session is
/// None: return ""` branch).
fn render_runner_mount(_key: &str, _checkout_key: &str) -> String {
    String::new()
}

fn branch_status_cell(info: &Checkout) -> String {
    if info.missing {
        "<span class=\"branch-missing\">missing</span>".into()
    } else if info.dirty {
        format!("<span class=\"branch-dirty\">{}</span>", info.changed)
    } else {
        "<span class=\"branch-clean\">\u{2713}</span>".into()
    }
}

fn branch_status_cell_member(info: &Member) -> String {
    // Python shares `_branch_status_cell` across Member + Checkout via
    // dict-key access — our two types differ, so mirror the logic
    // against `Member` explicitly.
    if info.missing {
        "<span class=\"branch-missing\">missing</span>".into()
    } else if info.dirty {
        format!("<span class=\"branch-dirty\">{}</span>", info.changed)
    } else {
        "<span class=\"branch-clean\">\u{2713}</span>".into()
    }
}

fn branch_dot(info_missing: bool, info_dirty: bool, is_live: bool) -> String {
    let cls = if is_live {
        "live"
    } else if info_missing {
        "missing"
    } else if info_dirty {
        "dirty"
    } else {
        "clean"
    };
    format!("<span class=\"b-dot b-dot-{cls}\"></span>")
}

/// One branch row inside a peer-card. `info_*` carries the per-row
/// state; `is_main=true` picks up the parent-checkout quirks.
#[allow(clippy::too_many_arguments)]
fn render_branch_row_inner(
    ctx: &RenderCtx,
    family: &Family,
    member: &Member,
    info_branch: &str,
    info_path: &str,
    info_missing: bool,
    info_dirty: bool,
    info_changed: usize,
    info_changed_files: &[String],
    branch_status_html: &str,
    checkout_key: &str,
    is_main: bool,
    node_id: &str,
) -> String {
    // Branch label: subrepo's main row inherits the parent's branch.
    let branch_label = if !info_branch.is_empty() {
        info_branch.to_string()
    } else if is_main && member.is_subrepo {
        family
            .members
            .first()
            .map(|p| p.branch.clone())
            .unwrap_or_default()
    } else {
        info_branch.to_string()
    };
    let kind_label = if is_main { "checkout" } else { "worktree" };

    // Runner pill — only for configured members that aren't missing.
    let mut runner_pill = String::new();
    let member_key = runner_key_for_member(family, member);
    let mut is_live = false; // Phase 2: no live sessions.
    if !info_missing && ctx.repo_run_keys.contains(&member_key) {
        runner_pill = render_runner_button(&member_key, checkout_key, info_path);
        // Python here re-checks runners_mod.get(); Phase 2 has no
        // sessions so is_live stays false.
        let _ = &mut is_live;
    }
    let _ = info_changed;
    let _ = info_changed_files;

    let open_cell = if info_missing {
        "<span class=\"open-grp open-grp-empty\" aria-hidden=\"true\"></span>".to_string()
    } else {
        render_open_with(ctx, info_path)
    };

    let mut row_cls = String::from("peer-row");
    if is_main {
        row_cls.push_str(" peer-row-main");
    }
    if info_missing {
        row_cls.push_str(" peer-row-missing");
    } else if is_live && info_dirty {
        row_cls.push_str(" peer-row-dirty peer-row-live");
    } else if is_live {
        row_cls.push_str(" peer-row-live");
    } else if info_dirty {
        row_cls.push_str(" peer-row-dirty");
    }

    let branch_display = if branch_label.is_empty() {
        "&mdash;".to_string()
    } else {
        h(&branch_label)
    };

    format!(
        "<div class=\"{row_cls}\" data-node-id=\"{node_id_h}\" title=\"{path_h}\">\
         {dot}\
         <span class=\"b-name\">{branch}<span class=\"b-kind\">{kind}</span></span>\
         <span class=\"b-status\">{status}</span>\
         <span class=\"b-run\">{run}</span>\
         {open}</div>",
        node_id_h = h(node_id),
        path_h = h(info_path),
        dot = branch_dot(info_missing, info_dirty, is_live),
        branch = branch_display,
        kind = h(kind_label),
        status = branch_status_html,
        run = runner_pill,
        open = open_cell,
    )
}

fn render_branch_row_main(
    ctx: &RenderCtx,
    family: &Family,
    member: &Member,
    node_id: &str,
) -> String {
    let status_html = branch_status_cell_member(member);
    render_branch_row_inner(
        ctx,
        family,
        member,
        &member.branch,
        &member.path,
        member.missing,
        member.dirty,
        member.changed,
        &member.changed_files,
        &status_html,
        "main",
        true,
        node_id,
    )
}

fn render_branch_row_worktree(
    ctx: &RenderCtx,
    family: &Family,
    member: &Member,
    wt: &Checkout,
    node_id: &str,
) -> String {
    let status_html = branch_status_cell(wt);
    render_branch_row_inner(
        ctx,
        family,
        member,
        &wt.branch,
        &wt.path,
        wt.missing,
        wt.dirty,
        wt.changed,
        &wt.changed_files,
        &status_html,
        &wt.key,
        false,
        node_id,
    )
}

/// One peer card (parent or promoted subrepo). Port of
/// `_render_peer_card`.
fn render_peer_card(ctx: &RenderCtx, family: &Family, member: &Member, member_id: &str) -> String {
    let is_subrepo = member.is_subrepo;
    let is_missing = member.missing;

    let mut dirty_branches = 0usize;
    if member.dirty {
        dirty_branches += 1;
    }
    for wt in &member.worktrees {
        if wt.dirty {
            dirty_branches += 1;
        }
    }

    let head_tag = if is_missing {
        "<span class=\"peer-tag peer-tag-missing\">missing</span>".to_string()
    } else if dirty_branches > 0 {
        let noun = if dirty_branches == 1 {
            "branch"
        } else {
            "branches"
        };
        format!("<span class=\"peer-tag peer-tag-dirty\">{dirty_branches} {noun} dirty</span>")
    } else {
        "<span class=\"peer-tag peer-tag-clean\">clean</span>".to_string()
    };
    // Phase 2: no live runner sessions, so never append the "live" tag.
    let live = false;
    let head_tag = if live {
        format!("{head_tag}<span class=\"peer-tag peer-tag-live\">live</span>")
    } else {
        head_tag
    };

    let kind_label = if is_subrepo { "sub-repo" } else { "repo" };

    let mut card_cls = String::from("peer-card");
    if is_subrepo {
        card_cls.push_str(" peer-card-sub");
    } else {
        card_cls.push_str(" peer-card-parent");
    }
    if dirty_branches > 0 {
        card_cls.push_str(" peer-card-dirty");
    }
    if live {
        card_cls.push_str(" peer-card-live");
    }
    if is_missing {
        card_cls.push_str(" peer-card-missing");
    }

    let mut parts: Vec<String> = Vec::new();
    parts.push(format!(
        "<div class=\"{card_cls}\" data-node-id=\"{id_h}\">",
        id_h = h(member_id)
    ));
    parts.push("<div class=\"peer-head\">".into());
    parts.push(format!(
        "<span class=\"peer-name\">{name}</span>",
        name = h(&member.name)
    ));
    parts.push(head_tag);
    parts.push(format!(
        "<span class=\"peer-kind\">{kind}</span>",
        kind = h(kind_label)
    ));
    parts.push("</div>".into());
    parts.push("<div class=\"peer-rows\">".into());

    parts.push(render_branch_row_main(
        ctx,
        family,
        member,
        &format!("{member_id}/b:main"),
    ));
    for wt in &member.worktrees {
        let wt_id = format!("{member_id}/wt:{}", wt.key);
        parts.push(render_branch_row_worktree(ctx, family, member, wt, &wt_id));
    }
    parts.push("</div>".into()); // /peer-rows

    // Inline runner terminal mount — only present when a live session
    // is running. Phase 2: never.
    if live {
        let member_key = runner_key_for_member(family, member);
        let mount = render_runner_mount(&member_key, "main");
        if !mount.is_empty() {
            parts.push(format!("<div class=\"peer-term\">{mount}</div>"));
        }
    }

    let foot_path = &member.path;
    let mut foot = format!(
        "<span class=\"peer-foot-path\">{p}</span>",
        p = h(foot_path)
    );
    if live {
        foot.push_str(&format!(
            "<button type=\"button\" class=\"peer-jump\" \
             title=\"Jump to live terminal\" aria-label=\"Jump to live terminal\" \
             onclick=\"runnerJump(event,this)\">{icon}</button>",
            icon = Icons::peer_jump,
        ));
    }
    parts.push(format!("<div class=\"peer-foot\">{foot}</div>"));

    parts.push("</div>".into()); // /peer-card
    parts.join("\n")
}

/// One family → bucket-grid wrapper. Port of `_render_flat_group`.
fn render_flat_group(ctx: &RenderCtx, family: &Family, group_id: &str) -> String {
    let family_id = format!("{group_id}/{}", family.name);
    let is_compound = family.members.len() > 1;
    let cls = if is_compound {
        "flat-group flat-group-compound"
    } else {
        "flat-group flat-group-solo"
    };
    let mut parts: Vec<String> = Vec::new();
    parts.push(format!(
        "<div class=\"{cls}\" data-node-id=\"{id}\">",
        id = h(&family_id)
    ));
    if is_compound {
        parts.push(format!(
            "<div class=\"flat-group-ornament\">{name}</div>",
            name = h(&family.name)
        ));
    }
    for member in &family.members {
        let member_id = format!("{family_id}/m:{}", member.name);
        parts.push(render_peer_card(ctx, family, member, &member_id));
    }
    parts.push("</div>".into());
    parts.join("\n")
}

/// Fragment for a single family — `/fragment?id=code/<label>/<family>`.
/// Returns `None` when the node-id doesn't resolve.
pub fn render_git_repo_fragment(
    ctx: &RenderCtx,
    groups: &[Group],
    node_id: &str,
) -> Option<String> {
    let rest = node_id.strip_prefix("code/")?;
    let (group_label, family_name) = rest.split_once('/')?;
    for group in groups {
        if group.label != group_label {
            continue;
        }
        for family in &group.families {
            if family.name == family_name {
                return Some(render_flat_group(
                    ctx,
                    family,
                    &format!("code/{group_label}"),
                ));
            }
        }
    }
    None
}

/// Render the full Code tab given the list of discovered groups.
/// Port of `_render_git_repos`.
pub fn render_git_repos(ctx: &RenderCtx, groups: &[Group]) -> String {
    if groups.is_empty() {
        return String::new();
    }
    let mut parts: Vec<String> = Vec::new();
    for group in groups {
        let group_id = format!("code/{}", group.label);
        parts.push(format!(
            "<section class=\"flat-bucket\" data-node-id=\"{id}\">\
             <h3 class=\"flat-bucket-heading\">{label}</h3>\
             <div class=\"flat-bucket-body\">",
            id = h(&group_id),
            label = h(&group.label),
        ));
        for family in &group.families {
            parts.push(render_flat_group(ctx, family, &group_id));
        }
        parts.push("</div></section>".into());
    }
    parts.join("\n")
}
