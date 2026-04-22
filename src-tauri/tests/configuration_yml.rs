//! build_ctx coverage — exercises the full `configuration.yml`
//! deserialisation surface: workspace paths (incl. tilde expansion),
//! primary + secondary repo buckets (bare string + mapping with
//! submodules + `run:` commands at both levels), open_with slot
//! labels, pdf_viewer chain, and terminal preferences (empty-string
//! normalisation → None).

use std::fs;
use std::path::PathBuf;

use condash_lib::config::{build_ctx, configuration_path};

const FIXTURE: &str = r#"
workspace_path: /tmp/vcoeur
worktrees_path: ~/worktrees-test
repositories:
  primary:
    - condash
    - name: vcoeur.com
      run: make dev
    - name: PaintingManager
      submodules:
        - name: app
          run: ls -al && pwd
        - docs
  secondary:
    - conception
open_with:
  main_ide:
    label: Open in main IDE
    commands:
      - idea {path}
  secondary_ide:
    label: Open in VS Code
    commands:
      - code {path}
pdf_viewer:
  - evince {path}
  - okular {path}
terminal:
  shell: /bin/zsh
  shortcut: Ctrl+T
  screenshot_dir: ''
  screenshot_paste_shortcut: Ctrl+Shift+V
  launcher_command: claude
  move_tab_left_shortcut: Ctrl+Left
  move_tab_right_shortcut: Ctrl+Right
"#;

#[test]
fn build_ctx_reads_every_top_level_field() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    let yaml_path = configuration_path(base);
    fs::write(&yaml_path, FIXTURE).unwrap();

    let ctx = build_ctx(base, String::new()).expect("build_ctx");

    assert_eq!(ctx.base_dir, base);
    assert_eq!(ctx.workspace, Some(PathBuf::from("/tmp/vcoeur")));
    // ~/ expansion hits whatever HOME is set to — just assert the
    // suffix rather than the absolute path.
    assert!(
        ctx.worktrees
            .as_ref()
            .map(|p| p.ends_with("worktrees-test"))
            .unwrap_or(false),
        "expected worktrees to end in worktrees-test, got {:?}",
        ctx.worktrees
    );

    // Two sections — primary + secondary.
    assert_eq!(ctx.repo_structure.len(), 2);
    let primary = &ctx.repo_structure[0];
    assert_eq!(primary.label, "Primary");
    let names: Vec<&str> = primary.repos.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, vec!["condash", "vcoeur.com", "PaintingManager"]);
    let pm = primary
        .repos
        .iter()
        .find(|r| r.name == "PaintingManager")
        .unwrap();
    assert_eq!(pm.submodules, vec!["app".to_string(), "docs".to_string()]);

    let secondary = &ctx.repo_structure[1];
    assert_eq!(secondary.label, "Secondary");
    assert_eq!(
        secondary
            .repos
            .iter()
            .map(|r| r.name.as_str())
            .collect::<Vec<_>>(),
        vec!["conception"]
    );

    // Runner configuration: repo-level run + submodule-level run both
    // land as keys; their templates carry the {path} placeholder for
    // the runner layer to substitute.
    assert!(ctx.repo_run_keys.contains("vcoeur.com"));
    assert_eq!(
        ctx.repo_run_templates.get("vcoeur.com").map(String::as_str),
        Some("make dev")
    );
    assert!(ctx.repo_run_keys.contains("PaintingManager--app"));
    assert_eq!(
        ctx.repo_run_templates
            .get("PaintingManager--app")
            .map(String::as_str),
        Some("ls -al && pwd")
    );
    // Bare submodule (`docs`) has no run command — must not appear.
    assert!(!ctx.repo_run_keys.contains("PaintingManager--docs"));

    // open_with — labels preserved, commands consumed by the mutations
    // layer so not surfaced on the ctx.
    assert_eq!(
        ctx.open_with.get("main_ide").map(|s| s.label.as_str()),
        Some("Open in main IDE")
    );
    assert_eq!(
        ctx.open_with.get("secondary_ide").map(|s| s.label.as_str()),
        Some("Open in VS Code")
    );

    // pdf_viewer — full fallback chain carried through.
    assert_eq!(
        ctx.pdf_viewer,
        vec!["evince {path}".to_string(), "okular {path}".to_string()]
    );

    // terminal prefs — empty strings (e.g. `screenshot_dir: ''`)
    // normalise to None so consumers fall back to their defaults.
    assert_eq!(ctx.terminal.shell.as_deref(), Some("/bin/zsh"));
    assert_eq!(ctx.terminal.shortcut.as_deref(), Some("Ctrl+T"));
    assert_eq!(ctx.terminal.screenshot_dir, None);
    assert_eq!(
        ctx.terminal.screenshot_paste_shortcut.as_deref(),
        Some("Ctrl+Shift+V")
    );
    assert_eq!(ctx.terminal.launcher_command.as_deref(), Some("claude"));
    assert_eq!(
        ctx.terminal.move_tab_left_shortcut.as_deref(),
        Some("Ctrl+Left")
    );
    assert_eq!(
        ctx.terminal.move_tab_right_shortcut.as_deref(),
        Some("Ctrl+Right")
    );
}

#[test]
fn build_ctx_without_configuration_yml_returns_minimal() {
    let tmp = tempfile::tempdir().unwrap();
    let ctx = build_ctx(tmp.path(), String::new()).unwrap();
    assert_eq!(ctx.base_dir, tmp.path());
    assert!(ctx.workspace.is_none());
    assert!(ctx.worktrees.is_none());
    assert!(ctx.repo_structure.is_empty());
    assert!(ctx.open_with.is_empty());
    assert!(ctx.pdf_viewer.is_empty());
    assert_eq!(ctx.terminal.shell, None);
}

#[test]
fn build_ctx_rejects_invalid_yaml() {
    let tmp = tempfile::tempdir().unwrap();
    fs::write(configuration_path(tmp.path()), "not: [valid").unwrap();
    let err = build_ctx(tmp.path(), String::new()).unwrap_err();
    assert!(
        err.to_string().to_lowercase().contains("yaml") || err.to_string().contains("parsing"),
        "unexpected error: {err}"
    );
}
