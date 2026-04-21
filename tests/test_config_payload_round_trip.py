"""Schema-level round-trip for the editor's JSON payload.

``config_to_payload`` and ``payload_to_config`` are the boundary between
the in-app gear modal and the typed :class:`CondashConfig`. They live in
``condash.config`` (alongside the YAML / TOML readers) so the
``parse_repo_entries`` validator runs once over every input shape.

The round-trip we care about: any config that survives a ``save`` →
``load`` cycle should also survive ``config_to_payload`` →
``payload_to_config``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from condash import config as cfg_mod
from condash.config import (
    CondashConfig,
    OpenWithSlot,
    RepoRunCommand,
    TerminalConfig,
)


def _build_full_config(tmp_path: Path) -> CondashConfig:
    """A non-trivial config exercising every payload field, including
    submodule entries with per-sub run templates and slashed repo names."""
    return CondashConfig(
        conception_path=tmp_path / "conception",
        workspace_path=tmp_path / "workspace",
        worktrees_path=tmp_path / "worktrees",
        repositories_primary=["alpha", "myorg/backend"],
        repositories_secondary=["beta"],
        repo_submodules={"myorg/backend": ["apps/web", "apps/api"]},
        terminal=TerminalConfig(
            shell="/bin/zsh",
            shortcut="Ctrl+Shift+T",
            screenshot_dir="/tmp/shots",
            screenshot_paste_shortcut="Ctrl+V",
            launcher_command="claude --resume",
            move_tab_left_shortcut="Ctrl+Alt+Left",
            move_tab_right_shortcut="Ctrl+Alt+Right",
        ),
        port=12345,
        native=False,
        open_with={
            "main_ide": OpenWithSlot(label="IDEA", commands=["idea {path}"]),
            "secondary_ide": OpenWithSlot(label="VSCode", commands=["code {path}"]),
            "terminal": OpenWithSlot(label="Term", commands=["xterm"]),
        },
        pdf_viewer=["evince {path}", "okular {path}"],
        repo_run={
            "alpha": RepoRunCommand(template="make dev"),
            "myorg/backend--apps/web": RepoRunCommand(template="pnpm dev"),
        },
    )


def test_payload_round_trip_preserves_typed_fields(tmp_path: Path) -> None:
    cfg = _build_full_config(tmp_path)

    payload = cfg_mod.config_to_payload(cfg)
    rebuilt = cfg_mod.payload_to_config(payload)

    assert rebuilt.conception_path == cfg.conception_path
    assert rebuilt.workspace_path == cfg.workspace_path
    assert rebuilt.worktrees_path == cfg.worktrees_path
    assert rebuilt.repositories_primary == cfg.repositories_primary
    assert rebuilt.repositories_secondary == cfg.repositories_secondary
    assert rebuilt.repo_submodules == cfg.repo_submodules
    assert rebuilt.port == cfg.port
    assert rebuilt.native == cfg.native
    assert rebuilt.pdf_viewer == cfg.pdf_viewer
    assert rebuilt.terminal == cfg.terminal
    assert {k: (v.label, v.commands) for k, v in rebuilt.open_with.items()} == {
        k: (v.label, v.commands) for k, v in cfg.open_with.items()
    }
    assert {k: v.template for k, v in rebuilt.repo_run.items()} == {
        k: v.template for k, v in cfg.repo_run.items()
    }


def test_payload_to_config_rejects_bad_port() -> None:
    with pytest.raises(cfg_mod.ConfigIncompleteError, match="port"):
        cfg_mod.payload_to_config({"port": 99999})


def test_payload_to_config_rejects_bad_repo_shape() -> None:
    with pytest.raises(cfg_mod.ConfigIncompleteError, match="primary"):
        cfg_mod.payload_to_config({"repositories_primary": "not-a-list"})


def test_payload_parse_uses_submodule_entries_for_per_sub_runs() -> None:
    """``submodule_entries`` (rich form) wins over ``submodules`` (plain)
    when both are present, and per-sub ``run`` round-trips."""
    payload = {
        "repositories_primary": [
            {
                "name": "myorg/backend",
                "submodules": ["apps/web", "apps/api"],
                "submodule_entries": [
                    {"name": "apps/web", "run": "pnpm dev"},
                    "apps/api",
                ],
            }
        ],
    }
    cfg = cfg_mod.payload_to_config(payload)
    assert cfg.repositories_primary == ["myorg/backend"]
    assert cfg.repo_submodules == {"myorg/backend": ["apps/web", "apps/api"]}
    assert cfg.repo_run["myorg/backend--apps/web"].template == "pnpm dev"
    # apps/api had no per-sub run command — no entry created.
    assert "myorg/backend--apps/api" not in cfg.repo_run


def test_yaml_and_payload_share_the_same_repo_parser() -> None:
    """Same input shape (mapping with ``submodules: list[str|dict]``) should
    yield the same parsed (names, subs, runs) tuple regardless of whether
    it came from YAML or from a JSON payload."""
    file_shape = [
        {"name": "alpha"},
        {
            "name": "myorg/backend",
            "submodules": [
                "apps/web",
                {"name": "apps/api", "run": "uvicorn main:app"},
            ],
            "run": "make dev",
        },
    ]
    file_names, file_subs, file_runs = cfg_mod.parse_repo_entries(file_shape, "test.yml", "primary")
    payload_names, payload_subs, payload_runs = cfg_mod.parse_repo_entries(
        file_shape, "payload", "primary"
    )

    assert file_names == payload_names == ["alpha", "myorg/backend"]
    assert file_subs == payload_subs == {"myorg/backend": ["apps/web", "apps/api"]}
    assert (
        {k: v.template for k, v in file_runs.items()}
        == {k: v.template for k, v in payload_runs.items()}
        == {
            "myorg/backend": "make dev",
            "myorg/backend--apps/api": "uvicorn main:app",
        }
    )
