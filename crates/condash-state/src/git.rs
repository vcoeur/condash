//! Git repo discovery + status for the dashboard's Code tab.
//!
//! Rust port of `src/condash/git_scan.py`. Shells out to `git` via
//! `std::process::Command` — same binary, same `--porcelain` output —
//! so the parsed result is byte-for-byte identical to the Python side.
//! (Switching to libgit2 would be faster, but would risk subtle
//! divergence on porcelain flags, worktree-list formatting, and
//! sandbox-stub detection. Staying on the CLI is the conservative
//! move for a direct port.)
//!
//! The public surface:
//!
//! - [`collect_git_repos`] — the `groups = [(label, [family, ...])]`
//!   shape consumed by the render layer.
//! - [`git_fingerprint`] — cheap per-workspace hash driving the
//!   `/check-updates` long-poll. 30-second process-wide cache matches
//!   Python.
//! - [`compute_git_node_fingerprints`] — per-node hashes used by the
//!   dashboard's scoped-reload pipeline.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Instant, SystemTime};

use condash_parser::PyValue;
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};

use crate::RenderCtx;

/// Cache key for a single repo's ScannedRepo snapshot. Covers enough of
/// the repo's state that any change it detects triggers a re-scan; any
/// event it misses is corrected by the next legitimate user action
/// (which touches HEAD or index). Falls back to epoch on stat failures
/// so an unreadable `.git/` always rescans.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct RepoStamp {
    head: Option<SystemTime>,
    index: Option<SystemTime>,
    worktrees: Option<SystemTime>,
}

fn stamp_for(repo_dir: &Path) -> RepoStamp {
    let git = repo_dir.join(".git");
    let stat = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    RepoStamp {
        head: stat(&git.join("HEAD")),
        index: stat(&git.join("index")),
        worktrees: stat(&git.join("worktrees")),
    }
}

static REPO_CACHE: Mutex<Option<HashMap<PathBuf, (RepoStamp, ScannedRepo)>>> = Mutex::new(None);

/// One checkout (main repo or worktree) — shared shape used by both
/// worktree entries and the top-level repo dict. Python's dict always
/// carries a `missing` key on worktree entries returned by
/// `_parent_member` / `_subrepo_member`; matching that literally means
/// emitting `missing: false` on every row rather than omitting it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkout {
    pub key: String,
    pub path: String,
    pub branch: String,
    pub dirty: bool,
    pub changed: usize,
    pub changed_files: Vec<String>,
    pub missing: bool,
}

/// One member of a family — the parent repo or a promoted subrepo.
/// Matches Python's dict shape one-for-one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    pub name: String,
    pub is_subrepo: bool,
    pub path: String,
    pub branch: String,
    pub dirty: bool,
    pub changed: usize,
    pub changed_files: Vec<String>,
    pub missing: bool,
    pub worktrees: Vec<Checkout>,
}

/// A repo family — parent member plus its promoted subrepos (if any).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Family {
    pub name: String,
    pub has_subrepos: bool,
    pub members: Vec<Member>,
}

/// One bucket (primary / secondary / Others) of the Code tab.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Group {
    pub label: String,
    pub families: Vec<Family>,
}

/// Return `true` for harness-synthesized stub files that should not
/// count as real repo changes. Rust port of `_is_sandbox_stub`.
///
/// When condash runs inside a sandbox (Claude Code's bwrap harness),
/// the runtime binds zero-byte read-only copies of the user's home
/// dotfiles into every working directory. These show up as untracked
/// files in `git status` but aren't real changes.
fn is_sandbox_stub(repo_path: &Path, status: &str, rel: &str) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        use std::os::unix::fs::MetadataExt;

        if status.contains('D') {
            return false;
        }
        let full = repo_path.join(rel);
        let md = match std::fs::symlink_metadata(&full) {
            Ok(m) => m,
            Err(_) => return false,
        };
        let ft = md.file_type();
        if ft.is_char_device() {
            return true;
        }
        if ft.is_symlink() {
            return std::fs::read_link(&full)
                .map(|t| t.as_os_str() == std::ffi::OsStr::new("/dev/null"))
                .unwrap_or(false);
        }
        if status != "??" {
            return false;
        }
        if !ft.is_file() {
            return false;
        }
        if md.size() != 0 {
            return false;
        }
        // Writable? Python: `st.st_mode & 0o222` is truthy → real file.
        if md.mode() & 0o222 != 0 {
            return false;
        }
        true
    }
    #[cfg(not(unix))]
    {
        let _ = (repo_path, status, rel);
        false
    }
}

/// `(branch, dirty, changed_count, changed_files)` for a repo/worktree.
/// Shell-out to `git rev-parse` and `git status --porcelain`, same as
/// Python. Failures collapse to `("?", false, 0, [])`.
fn git_status(path: &Path) -> (String, bool, usize, Vec<String>) {
    let Ok(branch_out) = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
    else {
        return ("?".into(), false, 0, Vec::new());
    };
    let Ok(status_out) = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["status", "--porcelain"])
        .output()
    else {
        return ("?".into(), false, 0, Vec::new());
    };
    let branch = String::from_utf8_lossy(&branch_out.stdout)
        .trim()
        .to_string();
    let status_text = String::from_utf8_lossy(&status_out.stdout).into_owned();

    let mut changed_files: Vec<String> = Vec::new();
    for ln in status_text.lines() {
        if ln.len() < 4 {
            continue;
        }
        let status = &ln[..2];
        let mut rest = &ln[3..];
        if let Some(idx) = rest.find(" -> ") {
            rest = &rest[idx + 4..];
        }
        if is_sandbox_stub(path, status, rest) {
            continue;
        }
        changed_files.push(rest.to_string());
    }
    let dirty = !changed_files.is_empty();
    let changed = changed_files.len();
    (branch, dirty, changed, changed_files)
}

fn resolve_str(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// Parse `git worktree list --porcelain` output into [`Checkout`]s.
/// Main checkout is elided (matches Python) — the caller already has
/// it from the top-level repo scan.
fn git_worktrees(repo_path: &Path) -> Vec<Checkout> {
    let Ok(out) = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["worktree", "list", "--porcelain"])
        .output()
    else {
        return Vec::new();
    };
    let body = String::from_utf8_lossy(&out.stdout).into_owned();
    let main_resolved = resolve_str(repo_path);

    let mut worktrees: Vec<Checkout> = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;

    let finalize = |current_path: &mut Option<String>,
                    current_branch: &mut Option<String>,
                    worktrees: &mut Vec<Checkout>| {
        if let Some(ref wt_path_str) = *current_path {
            if *wt_path_str != main_resolved {
                let wt_path = PathBuf::from(wt_path_str);
                let (branch, dirty, changed, changed_files) = git_status(&wt_path);
                // Prefer the full porcelain-branch (slash-preserving) key.
                // For detached HEAD or unknown, fall back to directory name.
                let raw_branch = current_branch.clone().unwrap_or_else(|| branch.clone());
                let key = if !raw_branch.is_empty() && raw_branch != "HEAD" {
                    raw_branch
                } else {
                    wt_path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string()
                };
                let eff_branch = if !branch.is_empty() {
                    branch
                } else {
                    current_branch.clone().unwrap_or_default()
                };
                worktrees.push(Checkout {
                    key,
                    path: wt_path_str.clone(),
                    branch: eff_branch,
                    dirty,
                    changed,
                    changed_files,
                    missing: false,
                });
            }
        }
        *current_path = None;
        *current_branch = None;
    };

    for line in body.lines() {
        if line.is_empty() {
            finalize(&mut current_path, &mut current_branch, &mut worktrees);
            continue;
        }
        if let Some(rest) = line.strip_prefix("worktree ") {
            current_path = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("branch ") {
            current_branch = Some(rest.trim_start_matches("refs/heads/").to_string());
        }
    }
    // Trailing block without blank-line terminator.
    finalize(&mut current_path, &mut current_branch, &mut worktrees);

    worktrees
}

/// Internal scan result before family-building. One entry per repo
/// directory that has a `.git/`.
#[derive(Debug, Clone)]
struct ScannedRepo {
    name: String,
    path: String,
    branch: String,
    dirty: bool,
    changed: usize,
    changed_files: Vec<String>,
    worktrees: Vec<Checkout>,
}

fn scan_one(repo_dir: &Path, display_name: &str) -> ScannedRepo {
    let key = repo_dir.to_path_buf();
    let stamp = stamp_for(repo_dir);
    {
        let guard = REPO_CACHE.lock().unwrap();
        if let Some(map) = guard.as_ref() {
            if let Some((cached_stamp, cached)) = map.get(&key) {
                if *cached_stamp == stamp {
                    let mut reused = cached.clone();
                    reused.name = display_name.to_string();
                    return reused;
                }
            }
        }
    }
    let (branch, dirty, changed, changed_files) = git_status(repo_dir);
    let scanned = ScannedRepo {
        name: display_name.to_string(),
        path: resolve_str(repo_dir),
        branch,
        dirty,
        changed,
        changed_files,
        worktrees: git_worktrees(repo_dir),
    };
    {
        let mut guard = REPO_CACHE.lock().unwrap();
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(key, (stamp, scanned.clone()));
    }
    scanned
}

fn parent_member(repo: &ScannedRepo) -> Member {
    Member {
        name: repo.name.clone(),
        is_subrepo: false,
        path: repo.path.clone(),
        branch: repo.branch.clone(),
        dirty: repo.dirty,
        changed: repo.changed,
        changed_files: repo.changed_files.clone(),
        missing: false,
        worktrees: repo
            .worktrees
            .iter()
            .map(|wt| Checkout {
                key: wt.key.clone(),
                path: wt.path.clone(),
                branch: wt.branch.clone(),
                dirty: wt.dirty,
                changed: wt.changed,
                changed_files: wt.changed_files.clone(),
                missing: false,
            })
            .collect(),
    }
}

fn subrepo_member(parent: &ScannedRepo, sub_name: &str) -> Member {
    let parent_path = PathBuf::from(&parent.path);
    let sub_path = parent_path.join(sub_name);
    let prefix = format!("{}/", sub_name.trim_end_matches('/'));
    let sub_changed_files: Vec<String> = parent
        .changed_files
        .iter()
        .filter_map(|f| f.strip_prefix(&prefix).map(|r| r.to_string()))
        .collect();
    let sub_is_dir = sub_path.is_dir();
    let sub_path_str = if sub_is_dir {
        resolve_str(&sub_path)
    } else {
        sub_path.to_string_lossy().into_owned()
    };

    let mut worktrees: Vec<Checkout> = Vec::new();
    for wt in &parent.worktrees {
        let wt_sub_path = PathBuf::from(&wt.path).join(sub_name);
        let wt_changed_files: Vec<String> = wt
            .changed_files
            .iter()
            .filter_map(|f| f.strip_prefix(&prefix).map(|r| r.to_string()))
            .collect();
        let wt_is_dir = wt_sub_path.is_dir();
        let wt_path_str = if wt_is_dir {
            resolve_str(&wt_sub_path)
        } else {
            wt_sub_path.to_string_lossy().into_owned()
        };
        worktrees.push(Checkout {
            key: wt.key.clone(),
            path: wt_path_str,
            branch: if wt_is_dir {
                wt.branch.clone()
            } else {
                String::new()
            },
            dirty: !wt_changed_files.is_empty(),
            changed: wt_changed_files.len(),
            changed_files: wt_changed_files,
            missing: !wt_is_dir,
        });
    }

    Member {
        name: sub_name.to_string(),
        is_subrepo: true,
        path: sub_path_str,
        branch: String::new(),
        dirty: !sub_changed_files.is_empty(),
        changed: sub_changed_files.len(),
        changed_files: sub_changed_files,
        missing: !sub_is_dir,
        worktrees,
    }
}

/// Find git repos under `ctx.workspace` and group them per the
/// configured repo structure. Returns `[]` when `workspace` is unset.
/// Port of `_collect_git_repos`.
pub fn collect_git_repos(ctx: &RenderCtx) -> Vec<Group> {
    let Some(workspace) = ctx.workspace.as_deref() else {
        return Vec::new();
    };
    // First pass: enumerate all repos (no scanning yet). Depth 1 is a
    // repo with `.git/`; depth 2 allows an org-style grouping directory.
    let mut targets: Vec<(PathBuf, String)> = Vec::new();
    if workspace.is_dir() {
        let mut children: Vec<PathBuf> = match std::fs::read_dir(workspace) {
            Ok(it) => it.flatten().map(|e| e.path()).collect(),
            Err(_) => Vec::new(),
        };
        children.sort();
        for child in &children {
            let name = match child.file_name().and_then(|n| n.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if !child.is_dir() || name.starts_with('.') {
                continue;
            }
            if child.join(".git").exists() {
                targets.push((child.clone(), name.to_string()));
                continue;
            }
            let mut grandchildren: Vec<PathBuf> = match std::fs::read_dir(child) {
                Ok(it) => it.flatten().map(|e| e.path()).collect(),
                Err(_) => continue,
            };
            grandchildren.sort();
            for grand in grandchildren {
                let gname = match grand.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                if !grand.is_dir() || gname.starts_with('.') {
                    continue;
                }
                if !grand.join(".git").exists() {
                    continue;
                }
                targets.push((grand, format!("{name}/{gname}")));
            }
        }
    }

    // Second pass: scan repos in parallel. Each worker shells out to
    // `git` independently; results are gathered and inserted sorted
    // afterward so the downstream ordering is identical to the serial
    // version.
    let scanned: Vec<(String, ScannedRepo)> = std::thread::scope(|scope| {
        let handles: Vec<_> = targets
            .iter()
            .map(|(dir, display)| scope.spawn(move || (display.clone(), scan_one(dir, display))))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let found: BTreeMap<String, ScannedRepo> = scanned.into_iter().collect();

    // Build submodule map from the configured repo structure.
    let mut submodule_map: HashMap<String, Vec<String>> = HashMap::new();
    for section in &ctx.repo_structure {
        for entry in &section.repos {
            submodule_map.insert(entry.name.clone(), entry.submodules.clone());
        }
    }

    let build_family = |repo_name: &str, found: &BTreeMap<String, ScannedRepo>| -> Family {
        let repo = &found[repo_name];
        let mut members = vec![parent_member(repo)];
        if let Some(subs) = submodule_map.get(repo_name) {
            for sub in subs {
                members.push(subrepo_member(repo, sub));
            }
        }
        Family {
            name: repo_name.to_string(),
            has_subrepos: members.len() > 1,
            members,
        }
    };

    let mut groups: Vec<Group> = Vec::new();
    let mut placed: std::collections::HashSet<String> = std::collections::HashSet::new();

    for section in &ctx.repo_structure {
        let bucket: Vec<Family> = section
            .repos
            .iter()
            .filter(|e| found.contains_key(&e.name))
            .map(|e| build_family(&e.name, &found))
            .collect();
        for e in &section.repos {
            if found.contains_key(&e.name) {
                placed.insert(e.name.clone());
            }
        }
        if !bucket.is_empty() {
            groups.push(Group {
                label: section.label.clone(),
                families: bucket,
            });
        }
    }

    let mut others: Vec<Family> = Vec::new();
    for name in found.keys() {
        if !placed.contains(name) {
            others.push(build_family(name, &found));
        }
    }
    if !others.is_empty() {
        groups.push(Group {
            label: "Others".to_string(),
            families: others,
        });
    }
    groups
}

/// `/check-updates` hint fingerprint. 30-second process-wide cache
/// keyed by nothing (assumes one active ctx per process — condash's
/// invariant). Port of `_git_fingerprint`.
pub fn git_fingerprint(ctx: &RenderCtx) -> String {
    static CACHE: Mutex<Option<(String, Instant)>> = Mutex::new(None);

    if let Ok(mut guard) = CACHE.lock() {
        if let Some((ref fp, ts)) = *guard {
            if ts.elapsed().as_secs() < 30 {
                return fp.clone();
            }
        }
        let fp = compute_git_fingerprint(ctx);
        *guard = Some((fp.clone(), Instant::now()));
        return fp;
    }
    compute_git_fingerprint(ctx)
}

fn compute_git_fingerprint(ctx: &RenderCtx) -> String {
    let Some(workspace) = ctx.workspace.as_deref() else {
        return "no-workspace".into();
    };
    if !workspace.is_dir() {
        return md5_16(b"");
    }

    let mut children: Vec<PathBuf> = match std::fs::read_dir(workspace) {
        Ok(it) => it.flatten().map(|e| e.path()).collect(),
        Err(_) => Vec::new(),
    };
    children.sort();

    let mut parts = String::new();
    for child in &children {
        let name = match child.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !child.is_dir() || name.starts_with('.') {
            continue;
        }
        if !child.join(".git").exists() {
            continue;
        }
        let head = Command::new("git")
            .arg("-C")
            .arg(child)
            .args(["rev-parse", "HEAD"])
            .output();
        let status = Command::new("git")
            .arg("-C")
            .arg(child)
            .args(["status", "--porcelain"])
            .output();
        match (head, status) {
            (Ok(h), Ok(s)) => {
                let head_text = String::from_utf8_lossy(&h.stdout).trim().to_string();
                let status_text = String::from_utf8_lossy(&s.stdout).into_owned();
                parts.push_str(&format!("{name}:{head_text}:{status_text}"));
            }
            _ => parts.push_str(&format!("{name}:error")),
        }
    }

    md5_16(parts.as_bytes())
}

/// MD5-truncated-to-16 of the bytes passed in. Shared helper used
/// throughout the node-fingerprint walk since Python's `_hash` lives
/// on `repr()` strings.
fn md5_16(bytes: &[u8]) -> String {
    let digest = Md5::digest(bytes);
    format!("{digest:x}")[..16].to_string()
}

/// Per-leaf hash — matches Python's `leaf_hash` closure. Written
/// inline (rather than via `PyValue::Tuple`) so we can emit the
/// bare-word `True` / `False` that Python's `repr(bool)` produces
/// without teaching `PyValue` a new variant.
fn leaf_hash(branch: &str, changed: usize, dirty: bool, missing: bool, files: &[String]) -> String {
    // Build the tuple's repr() manually since PyValue only models
    // strings/ints/tuples/lists. Python's tuple repr for
    // ("leaf", branch, changed, dirty, missing, files_tuple) is:
    //   ('leaf', 'branch', 3, True, False, ('a', 'b'))
    let mut sorted: Vec<String> = files.to_vec();
    sorted.sort();
    let files_tuple_repr = {
        let mut s = String::from("(");
        for (i, f) in sorted.iter().enumerate() {
            if i > 0 {
                s.push_str(", ");
            }
            s.push_str(&PyValue::Str(f.clone()).repr());
        }
        if sorted.len() == 1 {
            s.push(',');
        }
        s.push(')');
        s
    };
    let repr = format!(
        "('leaf', {}, {}, {}, {}, {})",
        PyValue::Str(branch.to_string()).repr(),
        changed,
        if dirty { "True" } else { "False" },
        if missing { "True" } else { "False" },
        files_tuple_repr,
    );
    md5_16(repr.as_bytes())
}

/// Per-node fingerprints for the Code tab hierarchy. Port of
/// `compute_git_node_fingerprints`.
pub fn compute_git_node_fingerprints(ctx: &RenderCtx) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let groups = collect_git_repos(ctx);

    let mut top_child_ids: Vec<String> = Vec::new();
    for group in &groups {
        let group_id = format!("code/{}", group.label);
        let mut family_ids: Vec<String> = Vec::new();
        for family in &group.families {
            let family_id = format!("{group_id}/{}", family.name);
            let mut member_ids: Vec<String> = Vec::new();
            for member in &family.members {
                let member_id = format!("{family_id}/m:{}", member.name);
                let mut wt_ids: Vec<String> = Vec::new();
                for wt in &member.worktrees {
                    let wt_id = format!("{member_id}/wt:{}", wt.key);
                    out.insert(
                        wt_id.clone(),
                        leaf_hash(
                            &wt.branch,
                            wt.changed,
                            wt.dirty,
                            wt.missing,
                            &wt.changed_files,
                        ),
                    );
                    wt_ids.push(wt_id);
                }
                wt_ids.sort();
                // Runner session state is Phase 4 territory (nothing starts
                // runners yet), but the fingerprint still has to agree
                // with Python. Python's `_runner_tokens_for` returns
                // `""` when the key isn't configured, and `|run:off`
                // when it is but no session is live — which is every
                // row in Phase 2. Mirror that exactly.
                let runner_key = if member.is_subrepo {
                    format!("{}--{}", family.name, member.name)
                } else {
                    family.name.clone()
                };
                let runner_token = if ctx.repo_run_keys.contains(&runner_key) {
                    "|run:off".to_string()
                } else {
                    String::new()
                };
                let member_leaf = leaf_hash(
                    &member.branch,
                    member.changed,
                    member.dirty,
                    member.missing,
                    &member.changed_files,
                );
                let member_data = {
                    // Python: ("member", leaf_hash(member), tuple(sorted(wt_ids)), runner_token)
                    let wt_tuple_repr = {
                        let mut s = String::from("(");
                        for (i, wid) in wt_ids.iter().enumerate() {
                            if i > 0 {
                                s.push_str(", ");
                            }
                            s.push_str(&PyValue::Str(wid.clone()).repr());
                        }
                        if wt_ids.len() == 1 {
                            s.push(',');
                        }
                        s.push(')');
                        s
                    };
                    format!(
                        "('member', {}, {}, {})",
                        PyValue::Str(member_leaf).repr(),
                        wt_tuple_repr,
                        PyValue::Str(runner_token.clone()).repr(),
                    )
                };
                out.insert(member_id.clone(), md5_16(member_data.as_bytes()));
                member_ids.push(member_id);
            }
            // Family hash mixes each member's hash.
            let family_data = {
                let mut s = String::from("('family', (");
                for (i, mid) in member_ids.iter().enumerate() {
                    if i > 0 {
                        s.push_str(", ");
                    }
                    s.push_str(&format!(
                        "({}, {})",
                        PyValue::Str(mid.clone()).repr(),
                        PyValue::Str(out[mid].clone()).repr(),
                    ));
                }
                if member_ids.len() == 1 {
                    s.push(',');
                }
                s.push_str("))");
                s
            };
            out.insert(family_id.clone(), md5_16(family_data.as_bytes()));
            family_ids.push(family_id);
        }
        family_ids.sort();
        let group_data = {
            let mut s = format!("('group', {}, (", PyValue::Str(group.label.clone()).repr());
            for (i, fid) in family_ids.iter().enumerate() {
                if i > 0 {
                    s.push_str(", ");
                }
                s.push_str(&PyValue::Str(fid.clone()).repr());
            }
            if family_ids.len() == 1 {
                s.push(',');
            }
            s.push_str("))");
            s
        };
        out.insert(group_id.clone(), md5_16(group_data.as_bytes()));
        top_child_ids.push(group_id);
    }

    top_child_ids.sort();
    let tab_data = {
        let mut s = String::from("('tab', 'code', (");
        for (i, gid) in top_child_ids.iter().enumerate() {
            if i > 0 {
                s.push_str(", ");
            }
            s.push_str(&PyValue::Str(gid.clone()).repr());
        }
        if top_child_ids.len() == 1 {
            s.push(',');
        }
        s.push_str("))");
        s
    };
    out.insert("code".to_string(), md5_16(tab_data.as_bytes()));

    out
}
